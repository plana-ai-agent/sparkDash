import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_PATH = fileURLToPath(new URL("../config/local-llm-operation.json", import.meta.url));

/** Exclusive, durable ownership; a restarted server must reconcile before taking over. */
export function createOperationStore(file = process.env.LOCAL_LLM_OPERATION_PATH || DEFAULT_PATH) {
  return {
    read() {
      try {
        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!record || typeof record.id !== "string" || !Number.isInteger(record.pid) || record.pid <= 0) throw new Error("Invalid operation record");
        return record;
      }
      catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error("Cannot read the unfinished runtime operation record");
      }
    },
    acquire(target) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const record = { id: randomUUID(), pid: process.pid, startedAt: Date.now(), target };
      let fd;
      try {
        fd = fs.openSync(file, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify(record));
        fs.fsyncSync(fd);
      } catch (error) {
        if (error.code === "EEXIST") throw Object.assign(new Error("An unfinished runtime operation must be reconciled first"), { code: "BUSY" });
        throw error;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      return record;
    },
    release(record) {
      if (this.read()?.id !== record.id) throw new Error("Runtime operation ownership changed");
      fs.unlinkSync(file);
    },
    ownerAlive(record) {
      try { process.kill(record.pid, 0); return true; }
      catch (error) { return error.code !== "ESRCH"; }
    },
  };
}
