import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

export const ECO_TIMEOUT_MS = 8000;
const DEFAULT_KEY_PATH = fileURLToPath(new URL("../config/eco_key.txt", import.meta.url));

/** One control key guards GPU/CPU ECO and Local LLM switching. */
export function getEcoKey() {
  if (process.env.SPARKDASH_ECO_KEY) return process.env.SPARKDASH_ECO_KEY;
  try {
    return fs.readFileSync(process.env.ECO_KEY_PATH || DEFAULT_KEY_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function ecoKeyOk(supplied) {
  const key = getEcoKey();
  if (!key || typeof supplied !== "string" || !supplied) return false;
  const expected = Buffer.from(key);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function runEcoCommand(file, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { timeout: ECO_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

/** A failed node must not prevent the rest of the fleet from reporting. */
export async function collectEcoStatus(sparks, read) {
  const list = Array.isArray(sparks) ? sparks : [];
  return Object.fromEntries(await Promise.all(list.map(async (spark) => {
    try {
      return [spark.id, await read(spark) || "no reply"];
    } catch {
      return [spark.id, "no reply"];
    }
  })));
}
