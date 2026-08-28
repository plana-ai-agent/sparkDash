/**
 * GPU clock ECO mode — cap (nvidia-smi -lgc) or uncap (-rgc) GPU clocks on a
 * Spark, inspired by The-Sparky-Command-Center "Clock ECO Mode".
 *
 * Writes require an ECO key (env SPARKDASH_ECO_KEY, else config/eco_key.txt);
 * the status readout is open like the rest of the dashboard.
 */
import fs from "fs";
import path from "path";
import childProcess from "child_process";
import { fileURLToPath } from "url";
import { sshExec } from "./collectors/ssh.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

/** Clock cap levels (MHz) → `-lgc` clamp argument (min,max). */
export const ECO_LEVELS = Object.freeze({
  2300: "0,2300",
  2200: "0,2200",
  2000: "0,2000",
  1800: "0,1800",
});

/** ECO key file (gitignored). Env override follows config.js path conventions. */
const ECO_KEY_PATH = process.env.ECO_KEY_PATH || path.join(ROOT, "config", "eco_key.txt");
/** The privileged container mounts /usr/bin/nvidia-smi. */
const NVIDIA_SMI = "/usr/bin/nvidia-smi";
/** nvidia-smi query for the status readout (clocks.gr, temp, power). */
const ECO_STATUS_QUERY_ARGS = [
  "--query-gpu=clocks.gr,temperature.gpu,power.draw",
  "--format=csv,noheader",
];
const ECO_STATUS_QUERY_CMD =
  "nvidia-smi --query-gpu=clocks.gr,temperature.gpu,power.draw --format=csv,noheader";
/** Same order of magnitude as the host-command timeouts in SystemCollector. */
const ECO_TIMEOUT_MS = 8000;

/**
 * Resolve the ECO key: SPARKDASH_ECO_KEY env wins, else config/eco_key.txt
 * (trimmed) if present. Returns null when neither exists.
 */
export function getEcoKey() {
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
export function ecoKeyOk(supplied) {
  const key = getEcoKey();
  if (!key || typeof supplied !== "string" || supplied.length === 0) return false;
  const a = Buffer.from(key, "utf-8");
  const b = Buffer.from(supplied, "utf-8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Local `nvidia-smi` argv for a level ("off" → -rgc, cap → -lgc 0,LEVEL).
 * Returns null for an unknown level.
 */
export function ecoLevelArg(level) {
  if (level === "off") return ["-rgc"];
  const clamp = ECO_LEVELS[level];
  if (!clamp) return null;
  return ["-lgc", clamp];
}

/** Remote shell command for a level (sudo, like the local privileged exec). */
export function ecoRemoteCommand(level) {
  const args = ecoLevelArg(level);
  if (!args) return null;
  return `sudo nvidia-smi ${args.join(" ")}`;
}

/** Run nvidia-smi locally via execFile (no shell interpolation). */
function runLocalSmi(args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(NVIDIA_SMI, args, { timeout: ECO_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

/**
 * Same as runLocalSmi but via passwordless sudo (-n), for host runs where the
 * server user lacks permission to change clocks.
 */
function runLocalSmiSudo(args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      "sudo",
      ["-n", NVIDIA_SMI, ...args],
      { timeout: ECO_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve(String(stdout).trim());
      }
    );
  });
}

/**
 * Read live clock/temp/power for every Spark, in parallel.
 * @param {Array<{id: string, isLocal: boolean}>} sparks
 * @returns {Promise<Record<string, string>>} sparkId → "clock, temp, power" | "no reply"
 */
export async function ecoStatus(sparks) {
  const nodes = {};
  const list = Array.isArray(sparks) ? sparks : [];
  await Promise.all(
    list.map(async (spark) => {
      try {
        const out = spark.isLocal
          ? await runLocalSmi(ECO_STATUS_QUERY_ARGS)
          : await sshExec(spark, ECO_STATUS_QUERY_CMD, { timeoutMs: ECO_TIMEOUT_MS });
        nodes[spark.id] = out || "no reply";
      } catch {
        nodes[spark.id] = "no reply";
      }
    })
  );
  return nodes;
}

/**
 * Apply a clock level to one Spark. Returns "ok" or an error text.
 * @param {{id: string, isLocal: boolean}} spark
 * @param {string} level "off" or a key of ECO_LEVELS
 */
export async function ecoSet(spark, level) {
  try {
    if (spark.isLocal) {
      const args = ecoLevelArg(level);
      if (!args) return "invalid level";
      try {
        await runLocalSmi(args);
      } catch {
        await runLocalSmiSudo(args);
      }
    } else {
      const cmd = ecoRemoteCommand(level);
      if (!cmd) return "invalid level";
      await sshExec(spark, cmd, { timeoutMs: ECO_TIMEOUT_MS });
    }
    return "ok";
  } catch (err) {
    return err.message || String(err);
  }
}
