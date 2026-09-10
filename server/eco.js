/**
 * GPU clock ECO mode — cap (nvidia-smi -lgc) or uncap (-rgc) GPU clocks on a
 * Spark, inspired by The-Sparky-Command-Center "Clock ECO Mode".
 *
 * Writes require an ECO key (env SPARKDASH_ECO_KEY, else config/eco_key.txt);
 * the status readout is open like the rest of the dashboard.
 */
import { sshExec } from "./collectors/ssh.js";
import { collectEcoStatus, ECO_TIMEOUT_MS, runEcoCommand } from "./ecoCommon.js";

/** Clock cap levels (MHz) → `-lgc` clamp argument (min,max). */
export const ECO_LEVELS = Object.freeze({
  2300: "0,2300",
  2200: "0,2200",
  2000: "0,2000",
  1800: "0,1800",
});

/** The privileged container mounts /usr/bin/nvidia-smi. */
const NVIDIA_SMI = "/usr/bin/nvidia-smi";
/** nvidia-smi query for the status readout (clocks.gr, temp, power). */
const ECO_STATUS_QUERY_ARGS = [
  "--query-gpu=clocks.gr,temperature.gpu,power.draw",
  "--format=csv,noheader",
];
const ECO_STATUS_QUERY_CMD =
  "nvidia-smi --query-gpu=clocks.gr,temperature.gpu,power.draw --format=csv,noheader";
/**
 * Local `nvidia-smi` argv for a level ("off" → -rgc, cap → -lgc 0,LEVEL).
 * Returns null for an unknown level.
 */
export function ecoLevelArg(level) {
  if (level === "off") return ["-rgc"];
  const clamp = Object.hasOwn(ECO_LEVELS, level) ? ECO_LEVELS[level] : null;
  if (!clamp) return null;
  return ["-lgc", clamp];
}

/** Remote shell command for a level (sudo, like the local privileged exec). */
export function ecoRemoteCommand(level) {
  const args = ecoLevelArg(level);
  if (!args) return null;
  return `sudo -n nvidia-smi ${args.join(" ")}`;
}

/** Read GPU clocks, temperature and power independently for each Spark. */
export function ecoStatus(sparks) {
  return collectEcoStatus(sparks, (spark) => spark.isLocal
    ? runEcoCommand(NVIDIA_SMI, ECO_STATUS_QUERY_ARGS)
    : sshExec(spark, ECO_STATUS_QUERY_CMD, { timeoutMs: ECO_TIMEOUT_MS }));
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
        await runEcoCommand(NVIDIA_SMI, args);
      } catch {
        await runEcoCommand("sudo", ["-n", NVIDIA_SMI, ...args]);
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
