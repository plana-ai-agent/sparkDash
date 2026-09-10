/**
 * CPU clock ECO mode — clamp (or release) the per-CPU CPPC `max_perf` ceiling
 * on a Spark, mirroring the GPU ECO module in this directory.
 *
 * Writes require the same ECO key (env SPARKDASH_ECO_KEY, else
 * config/eco_key.txt); the status readout is open like the rest of the
 * dashboard. `scaling_max_freq` is a placebo on GB10 (reported clocks follow
 * the cap but hardware clocks do not), so this module drives `max_perf`,
 * which measurably changes fixed-work throughput and package heat.
 *
 * The dashboard runs privileged with the host PID namespace, so local writes
 * go through `nsenter -t1` into the host mount namespace; worker nodes run
 * the same one-liner over SSH with passwordless sudo. A stock max_perf
 * snapshot is taken once per node (settings.json `cpuEcoSnapshots`) before
 * the first cap; "off" restores it.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { sshExec } from "./collectors/ssh.js";
import { getSettings, updateSettings } from "./settings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

/** CPU cap levels (kHz) — UI-facing values, quantized by the hardware. */
export const CPU_ECO_LEVELS = Object.freeze({
  2500: "2500000",
  2250: "2250000",
  2000: "2000000",
  1750: "1750000",
  1500: "1500000",
});

/** ECO key file (gitignored). Env override follows config.js path conventions. */
const ECO_KEY_PATH = process.env.ECO_KEY_PATH || path.join(ROOT, "config", "eco_key.txt");
const ECO_TIMEOUT_MS = 8000;
/** Host-namespace sysfs paths for max_perf reads/writes. */
const MAX_PERF_GLOB = "/sys/devices/system/cpu/cpu*/cpufreq/max_perf";
/** Readback + hottest CPU-zone temperature for the status line. */
const CPU_STATUS_CMD =
  `cat ${MAX_PERF_GLOB}; echo ---; ` +
  `for z in /sys/class/thermal/thermal_zone*; do cat $z/type >/dev/null 2>&1 || continue; ` +
  `t=$(cat $z/temp 2>/dev/null) || continue; case $(cat $z/type) in acpitz) echo $t;; esac; done`;
/** One-shot apply: set (LEVEL_KHZ) or restore-from-snapshot ("off").
 * For restore the snapshot is passed as base64 (argv B64) because the
 * container /tmp is not visible inside the host mount namespace. */
function applyScript(levelKhz, snapshotPath, snapshotB64) {
  const restore = levelKhz === null;
  const setAll = `for p in ${MAX_PERF_GLOB}; do echo ${levelKhz} > $p; done`;
  const restoreFromSnapshot =
    `python3 -c 'import base64,json; ` +
    `snap=json.loads(base64.b64decode("${snapshotB64}").decode())["max_perf_khz"]; ` +
    `[open("/sys/devices/system/cpu/%s/cpufreq/max_perf" % c, "w").write(str(v) + chr(10)) ` +
    `for c, v in sorted(snap.items())]'`;
  return (
    `set -e; ` +
    (restore ? restoreFromSnapshot : setAll) +
    `; printf '%s\\n' $(cat ${MAX_PERF_GLOB} | sort -u | tr '\n' ' ')`
  );
}

/**
 * Resolve the ECO key: SPARKDASH_ECO_KEY env wins, else config/eco_key.txt
 * (trimmed) if present. Returns null when neither exists. Shared with the
 * GPU ECO module by design — one key guards both controls.
 */
export function getCpuEcoKey() {
  const env = process.env.SPARKDASH_ECO_KEY;
  if (env) return env;
  try {
    const raw = fs.readFileSync(ECO_KEY_PATH, "utf-8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** Constant-time-ish compare of a supplied key against the configured key. */
export function cpuEcoKeyOk(supplied) {
  const key = getCpuEcoKey();
  if (!key || typeof supplied !== "string" || supplied.length === 0) return false;
  const a = Buffer.from(key, "utf-8");
  const b = Buffer.from(supplied, "utf-8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** execFile helper returning a promise (matches eco.js conventions). */
function runCmd(file, args, timeoutMs = ECO_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

/** Where a node's stock snapshot is persisted (settings.json, gitignored runtime state). */
function snapshotKey(sparkId) {
  return `cpuEcoSnapshots.${sparkId}`;
}

/**
 * A stock snapshot is plausible only when every CPU sits above the lowest
 * cap level we offer (2.5 GHz): GB10's stock clusters start at 2.808 GHz, so
 * any value ≤ 2500000 kHz means the node was already clamped when read and
 * the snapshot would be poisoned ("off" could never restore stock).
 */
export function isPlausibleStock(snapshot) {
  const vals = Object.values(snapshot?.max_perf_khz ?? {});
  return vals.length > 0 && Math.min(...vals) > 2500000;
}

/** Read the stored stock snapshot JSON for a spark, or null. */
export function getStockSnapshot(sparkId) {
  const s = getSettings();
  return s?.cpuEcoSnapshots?.[sparkId] ?? null;
}

/** Persist the stock snapshot JSON for a spark. */
export function setStockSnapshot(sparkId, snapshot) {
  const s = getSettings();
  const snapshots = { ...(s.cpuEcoSnapshots ?? {}) };
  snapshots[sparkId] = snapshot;
  updateSettings({ cpuEcoSnapshots: snapshots });
}

/**
 * Snapshot the stock max_perf of every CPU on one node (root python via
 * nsenter locally, sudo over SSH remotely). Returns {max_perf_khz: {...}}.
 */
export async function snapshotStock(spark) {
  const script =
    `python3 -c 'import glob,json,os; ` +
    `paths=sorted(glob.glob("/sys/devices/system/cpu/cpu*/cpufreq/max_perf")); ` +
    `d={os.path.basename(os.path.dirname(os.path.dirname(p))):int(open(p).read().strip()) for p in paths}; ` +
    `print(json.dumps({"max_perf_khz":d}))'`;
  const out = spark.isLocal
    ? await runCmd("nsenter", ["-t", "1", "-m", "--", "sh", "-c", script])
    : await sshExec(spark, `sudo ${script}`, { timeoutMs: ECO_TIMEOUT_MS });
  const data = JSON.parse(out);
  if (!data?.max_perf_khz || !Object.keys(data.max_perf_khz).length) {
    throw new Error("empty max_perf snapshot");
  }
  return data;
}

/** Remote apply argv (sudo, mirrors local nsenter effect).
 * The snapshot rides as base64 in the script — no remote temp file. */
function remoteApplyCommand(levelKhz, snapshotB64) {
  const script = applyScript(levelKhz, null, snapshotB64).replace(/'/g, `'\\''`);
  // sudo sh -c: the worker's passwordless sudo covers the whole apply.
  return `sudo sh -c '${script}'`;
}

/**
 * Read live CPU state for every Spark, in parallel.
 * @param {Array<{id: string, isLocal: boolean}>} sparks
 * @returns {Promise<Record<string, string>>} sparkId → status line | "no reply"
 */
export async function cpuEcoStatus(sparks) {
  const nodes = {};
  const list = Array.isArray(sparks) ? sparks : [];
  await Promise.all(
    list.map(async (spark) => {
      try {
        const out = spark.isLocal
          ? await runCmd("nsenter", ["-t", "1", "-m", "--", "sh", "-c", CPU_STATUS_CMD])
          : await sshExec(spark, CPU_STATUS_CMD, { timeoutMs: ECO_TIMEOUT_MS });
        nodes[spark.id] = out ? formatCpuStatus(out) : "no reply";
      } catch {
        nodes[spark.id] = "no reply";
      }
    })
  );
  return nodes;
}

/** Shape the raw readback into "max GHz label · hottest acpitz °C". */
export function formatCpuStatus(raw) {
  const parts = String(raw).split("---");
  const appliedPart = parts[0] ?? "";
  const tempsPart = parts.length > 1 ? parts.slice(1).join("---") : "";
  const applied = [...new Set(appliedPart.split("\n").map((s) => s.trim()).filter(Boolean))]
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  // Temperature lines are millidegrees; an empty tail yields no temps.
  const temps = tempsPart
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => n / 1000);
  const hottest = temps.length ? `${Math.max(...temps).toFixed(1)}°C` : "n/a";
  const label =
    applied.length === 1
      ? `${(applied[0] / 1e6).toFixed(2).replace(/\.?0+$/, "")} GHz`
      : `${applied.length} values`;
  return `${label} · ${hottest}`;
}

/**
 * Apply a CPU clock level to one Spark. Returns "ok" or an error text.
 * Snapshots stock values once per node before the first cap so "off" restores.
 * @param {{id: string, isLocal: boolean}} spark
 * @param {string} level "off" or a key of CPU_ECO_LEVELS
 */
export async function cpuEcoSet(spark, level) {
  try {
    if (level !== "off" && !Object.prototype.hasOwnProperty.call(CPU_ECO_LEVELS, level)) {
      return "invalid level";
    }
    let snapshot = getStockSnapshot(spark.id);
    if (snapshot && !isPlausibleStock(snapshot)) {
      // Persisted snapshot is poisoned (node was clamped when first read).
      // Drop it and re-snapshot once the node is at stock — refusing silently
      // would leave "off" permanently unable to restore.
      snapshot = null;
      const s = getSettings();
      const snapshots = { ...(s.cpuEcoSnapshots ?? {}) };
      delete snapshots[spark.id];
      updateSettings({ cpuEcoSnapshots: snapshots });
    }
    if (!snapshot) {
      snapshot = await snapshotStock(spark);
      if (!isPlausibleStock(snapshot)) {
        return "refusing to snapshot: node already clamped (max_perf ≤ 2.5 GHz); restore stock clocks first";
      }
      setStockSnapshot(spark.id, snapshot);
    }
    const khz = level === "off" ? null : CPU_ECO_LEVELS[level];
    const snapshotB64 = Buffer.from(JSON.stringify(snapshot)).toString("base64");
    if (spark.isLocal) {
      // Pass the snapshot as a base64 argv item — no shared tmpfs needed, the
      // container /tmp is not visible in the host mount namespace.
      const script = applyScript(khz, null, snapshotB64);
      await runCmd("nsenter", ["-t", "1", "-m", "--", "sh", "-c", script]);
    } else {
      await sshExec(spark, remoteApplyCommand(khz, snapshotB64), { timeoutMs: ECO_TIMEOUT_MS });
    }
    return "ok";
  } catch (err) {
    return err.message || String(err);
  }
}
