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
import { sshExec } from "./collectors/ssh.js";
import { getSettings, updateSettings } from "./settings.js";
import { collectEcoStatus, ECO_TIMEOUT_MS, runEcoCommand } from "./ecoCommon.js";

/** CPU cap levels (kHz) — UI-facing values, quantized by the hardware. */
export const CPU_ECO_LEVELS = Object.freeze({
  2500: "2500000",
  2250: "2250000",
  2000: "2000000",
  1750: "1750000",
  1500: "1500000",
});

/** Host-namespace sysfs paths for max_perf reads/writes. */
const MAX_PERF_GLOB = "/sys/devices/system/cpu/cpu*/cpufreq/max_perf";
/** Readback + hottest CPU-zone temperature for the status line. */
const CPU_STATUS_CMD =
  `cat ${MAX_PERF_GLOB}; echo ---; ` +
  `for z in /sys/class/thermal/thermal_zone*; do cat $z/type >/dev/null 2>&1 || continue; ` +
  `t=$(cat $z/temp 2>/dev/null) || continue; case $(cat $z/type) in acpitz) echo $t;; esac; done`;
/** One-shot apply: set (LEVEL_KHZ) or restore-from-snapshot ("off").
 * For restore the snapshot is embedded as base64 because the
 * container /tmp is not visible inside the host mount namespace. */
function applyScript(levelKhz, snapshotB64) {
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

/** Read scripts are unprivileged over SSH; writes run in the host namespace. */
function runCpuScript(spark, script, { write = false } = {}) {
  if (spark.isLocal) {
    return runEcoCommand("nsenter", ["-t", "1", "-m", "--", "sh", "-c", script]);
  }
  const quoted = script.replace(/'/g, "'\\''");
  return sshExec(spark, `${write ? "sudo -n " : ""}sh -c '${quoted}'`, {
    timeoutMs: ECO_TIMEOUT_MS,
  });
}

/**
 * A stock snapshot is plausible only when every CPU sits above the highest
 * cap level we offer (2.5 GHz): GB10's stock clusters start at 2.808 GHz, so
 * any value ≤ 2500000 kHz means the node was already clamped when read and
 * the snapshot would be poisoned ("off" could never restore stock).
 */
export function isPlausibleStock(snapshot) {
  const values = snapshot?.max_perf_khz;
  return values !== null && typeof values === "object" && !Array.isArray(values)
    && Object.keys(values).length > 0
    && Object.entries(values).every(([cpu, value]) =>
      /^cpu\d+$/.test(cpu) && Number.isSafeInteger(value) && value > 2500000);
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
 * Snapshot stock max_perf in the host namespace (locally or over SSH).
 * Returns {max_perf_khz: {...}}.
 */
export async function snapshotStock(spark) {
  const script =
    `python3 -c 'import glob,json,os; ` +
    `paths=sorted(glob.glob("/sys/devices/system/cpu/cpu*/cpufreq/max_perf")); ` +
    `d={os.path.basename(os.path.dirname(os.path.dirname(p))):int(open(p).read().strip()) for p in paths}; ` +
    `print(json.dumps({"max_perf_khz":d}))'`;
  const out = await runCpuScript(spark, script);
  const data = JSON.parse(out);
  if (!data?.max_perf_khz || !Object.keys(data.max_perf_khz).length) {
    throw new Error("empty max_perf snapshot");
  }
  return data;
}

export function cpuEcoStatus(sparks) {
  return collectEcoStatus(sparks, async (spark) => {
    const raw = await runCpuScript(spark, CPU_STATUS_CMD);
    return raw ? formatCpuStatus(raw) : "no reply";
  });
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
    if (level !== "off" && !Object.hasOwn(CPU_ECO_LEVELS, level)) {
      return "invalid level";
    }
    let snapshot = getStockSnapshot(spark.id);
    if (!isPlausibleStock(snapshot)) {
      snapshot = await snapshotStock(spark);
      if (!isPlausibleStock(snapshot)) {
        return "refusing to snapshot: node already clamped (max_perf ≤ 2.5 GHz); restore stock clocks first";
      }
      setStockSnapshot(spark.id, snapshot);
    }
    const khz = level === "off" ? null : CPU_ECO_LEVELS[level];
    const snapshotB64 = Buffer.from(JSON.stringify(snapshot)).toString("base64");
    await runCpuScript(spark, applyScript(khz, snapshotB64), { write: true });
    return "ok";
  } catch (err) {
    return err.message || String(err);
  }
}
