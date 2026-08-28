import { spawn } from "child_process";

/**
 * Deployment-specific values (model IDs, host lifecycle commands, the host
 * user/path) are read from the environment (.env, gitignored) — never from
 * source. Only the structural runtime keys ("deepseek" | "qwen" | "glm")
 * and the public product labels are fixed here, so the API contract and
 * the tests stay independent of any deployment.
 */
const TARGET_KEYS = Object.freeze(["deepseek", "qwen", "glm"]);

// Neutral fallbacks derived from the structural runtime keys. Deployment
// profiles override these via LOCAL_LLM_LABEL_* in .env.
const TARGET_LABEL_FALLBACKS = Object.freeze({
  deepseek: "DeepSeek",
  qwen: "Qwen",
  glm: "GLM",
});

export function loadLocalLlmRuntimeConfig(env = process.env) {
  const missing = [];
  const read = (name) => {
    const value = String(env[name] ?? "").trim();
    if (!value) missing.push(name);
    return value;
  };
  const readOptional = (name, fallback) => {
    const value = String(env[name] ?? "").trim();
    return value || fallback;
  };
  const targets = {};
  const hostCommands = {};
  for (const key of TARGET_KEYS) {
    targets[key] = Object.freeze({
      modelId: read(`LOCAL_LLM_MODEL_${key.toUpperCase()}`),
      label: readOptional(`LOCAL_LLM_LABEL_${key.toUpperCase()}`, TARGET_LABEL_FALLBACKS[key]),
    });
    hostCommands[`stop-${key}`] = read(`LOCAL_LLM_CMD_STOP_${key.toUpperCase()}`);
    hostCommands[`start-${key}`] = read(`LOCAL_LLM_CMD_START_${key.toUpperCase()}`);
  }
  const hostUser = read("LOCAL_LLM_HOST_USER");
  const hostHome = read("LOCAL_LLM_HOST_HOME");
  if (missing.length > 0) {
    throw new Error(
      `Local LLM runtime switching is not configured; set ${missing.join(", ")} in .env (see .env.example)`
    );
  }
  return Object.freeze({
    hostUser,
    hostHome,
    targets: Object.freeze(targets),
    hostCommands: Object.freeze(hostCommands),
  });
}

let runtimeConfigCache = null;

function getRuntimeConfig() {
  if (!runtimeConfigCache) {
    // Retried on every call until it succeeds, so the dashboard keeps running
    // (with an unconfigured Local LLM panel) while .env is still missing.
    runtimeConfigCache = loadLocalLlmRuntimeConfig();
  }
  return runtimeConfigCache;
}

const LOG_LIMIT = 40;
const LOG_LINE_LIMIT = 500;
const API_PROBE_TIMEOUT_MS = 5000;
const STOP_POLL_INTERVAL_MS = 2000;
const ANSI_ESCAPE = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*[@-~])/g;
const SECRET_LINE = /(authorization|bearer|api[_ -]?key|hf[_ -]?token|token=)/i;

export function parseRollbackDisabledTargets(rawValue) {
  return new Set(
    String(rawValue ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => TARGET_KEYS.includes(entry))
  );
}

export function validateLocalLlmTarget(value) {
  if (!TARGET_KEYS.includes(value)) {
    throw new Error("target must be deepseek, qwen, or glm");
  }
  return value;
}

function isKnownRuntime(targets, runtime) {
  return Object.hasOwn(targets, runtime);
}

export function classifyProbe(probe, targets) {
  const reachable = Boolean(probe?.reachable);
  const modelId = typeof probe?.modelId === "string" && probe.modelId ? probe.modelId : null;
  if (!reachable) return { runtime: "stopped", modelId: null, health: "stopped" };
  for (const [runtime, target] of Object.entries(targets)) {
    if (modelId === target.modelId) {
      return { runtime, modelId, health: "healthy" };
    }
  }
  return { runtime: "unknown", modelId, health: "unknown" };
}

export async function probeLocalLlmRuntime(fetchImpl = fetch) {
  try {
    const response = await fetchImpl("http://127.0.0.1:8888/v1/models", {
      signal: AbortSignal.timeout(API_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return { reachable: true, modelId: null };
    const body = await response.json();
    const modelId = Array.isArray(body?.data)
      ? body.data.find((entry) => typeof entry?.id === "string" && entry.id)?.id || null
      : null;
    return { reachable: true, modelId };
  } catch (error) {
    if (error?.cause?.code === "ECONNREFUSED") {
      return { reachable: false, modelId: null };
    }
    return { reachable: true, modelId: null };
  }
}

function safeLogLine(raw) {
  const line = String(raw ?? "").replace(ANSI_ESCAPE, "").trim();
  if (!line) return null;
  if (SECRET_LINE.test(line)) return "[redacted secret-bearing output]";
  return line.slice(0, LOG_LINE_LIMIT);
}

export function streamLines(stream, onLine) {
  let pending = "";
  let overlong = false;
  let skipLineFeed = false;

  const emitLine = () => {
    onLine(overlong ? "[redacted overlong output]" : pending);
    pending = "";
    overlong = false;
  };

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    for (const character of chunk) {
      if (skipLineFeed) {
        skipLineFeed = false;
        if (character === "\n") continue;
      }
      if (character === "\r") {
        emitLine();
        skipLineFeed = true;
      } else if (character === "\n") {
        emitLine();
      } else if (!overlong) {
        pending += character;
        if (pending.length > LOG_LINE_LIMIT) {
          pending = "";
          overlong = true;
        }
      }
    }
  });
  stream.on("end", () => {
    if (overlong) onLine("[redacted overlong output]");
    else if (pending) onLine(pending);
  });
}

export function buildHostCommandInvocation(command) {
  const { hostUser, hostHome, hostCommands } = getRuntimeConfig();
  const fixedCommand = hostCommands[command];
  if (!fixedCommand) throw new Error("host command is not allowlisted");
  const pathEnv =
    process.env.LOCAL_LLM_CMD_PATH ||
    `${hostHome}/.local/bin:/usr/local/cuda/bin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin`;
  return {
    file: "/usr/bin/nsenter",
    args: [
      "-t",
      "1",
      "-m",
      "-u",
      "-i",
      "-n",
      "-p",
      "--",
      "/usr/sbin/runuser",
      "-u",
      hostUser,
      "--",
      "/usr/bin/env",
      "-i",
      `HOME=${hostHome}`,
      `USER=${hostUser}`,
      `LOGNAME=${hostUser}`,
      "SHELL=/bin/bash",
      `PATH=${pathEnv}`,
      "LANG=C.UTF-8",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      fixedCommand,
    ],
    options: { stdio: ["ignore", "pipe", "pipe"] },
  };
}

export function createHostCommandRunner() {
  return (command, { onLine } = {}) =>
    new Promise((resolve, reject) => {
      let invocation;
      try {
        invocation = buildHostCommandInvocation(command);
      } catch (error) {
        reject(error);
        return;
      }
      const child = spawn(invocation.file, invocation.args, invocation.options);
      const emit = typeof onLine === "function" ? onLine : () => {};
      streamLines(child.stdout, emit);
      streamLines(child.stderr, emit);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`lifecycle command ${command} failed (${signal || `exit ${code}`})`));
      });
    });
}

function publicClone(status) {
  return {
    ...status,
    rollback: status.rollback ? { ...status.rollback } : null,
    failureLog: [...status.failureLog],
    log: [...status.log],
  };
}

export function registerLocalLlmRoutes(app, { manager, keyOk, writesEnabled }) {
  app.get("/api/local-llm/status", async (_req, res) => {
    try {
      const status = await manager.getStatus();
      const labels = Object.fromEntries(
        Object.entries(manager.targets()).map(([key, target]) => [key, target.label])
      );
      res.json({ ...status, labels, writesEnabled: Boolean(writesEnabled()) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/local-llm/switch", async (req, res) => {
    let target;
    try {
      target = validateLocalLlmTarget(req.body?.target);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (!keyOk(req.body?.key)) {
      return res.status(403).json({ error: "Invalid or missing ECO key" });
    }
    try {
      const result = await manager.beginSwitch(target);
      return res.status(result.started ? 202 : 200).json({
        success: true,
        started: result.started,
        writesEnabled: Boolean(writesEnabled()),
        ...result.status,
      });
    } catch (error) {
      if (error?.code === "BUSY" || error?.code === "UNSAFE_STATE") {
        return res.status(409).json({ error: error.message });
      }
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export class LocalLlmSwitchManager {
  constructor({
    probeRuntime = probeLocalLlmRuntime,
    runCommand = createHostCommandRunner(),
    now = Date.now,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    maxStopPolls = 30,
    disableRollbackTargets = parseRollbackDisabledTargets(
      process.env.LOCAL_LLM_DISABLE_ROLLBACK_TARGETS
    ),
  } = {}) {
    this.probeRuntime = probeRuntime;
    this.runCommand = runCommand;
    this.now = now;
    this.delay = delay;
    this.maxStopPolls = maxStopPolls;
    this.rollbackDisabledTargets = disableRollbackTargets instanceof Set
      ? disableRollbackTargets
      : parseRollbackDisabledTargets(disableRollbackTargets);
    this._starting = false;
    this._operationPromise = null;
    this.status = {
      state: "idle",
      phase: "idle",
      current: "unknown",
      currentModelId: null,
      health: "unknown",
      source: null,
      target: null,
      startedAt: null,
      finishedAt: null,
      message: "Checking runtime",
      error: null,
      rollback: null,
      failureLog: [],
      log: [],
    };
  }

  get busy() {
    return this._starting || Boolean(this._operationPromise);
  }

  targets() {
    return getRuntimeConfig().targets;
  }

  _appendLog(raw) {
    const line = safeLogLine(raw);
    if (!line) return;
    this.status.log.push(line);
    if (this.status.log.length > LOG_LIMIT) {
      this.status.log.splice(0, this.status.log.length - LOG_LIMIT);
    }
  }

  _applyDetected(detected) {
    this.status.current = detected.runtime;
    this.status.currentModelId = detected.modelId;
    this.status.health = detected.health;
  }

  async _detect() {
    return classifyProbe(await this.probeRuntime(), this.targets());
  }

  async getStatus({ refresh = true } = {}) {
    if (refresh && !this.busy) {
      const statusBeforeRefresh = this.status;
      const detected = await this._detect();
      if (this.busy || this.status !== statusBeforeRefresh) {
        return publicClone(this.status);
      }
      this._applyDetected(detected);
      if (this.status.state !== "error") {
        this.status.state = "idle";
        if (this.status.phase === "idle") {
          this.status.message =
            detected.runtime === "stopped"
              ? "No Local LLM runtime is running"
              : detected.runtime === "unknown"
                ? "An unknown service is responding on port 8888"
                : `${this.targets()[detected.runtime].label} is healthy`;
        }
      }
    }
    return publicClone(this.status);
  }

  async beginSwitch(rawTarget) {
    const target = validateLocalLlmTarget(rawTarget);
    if (this.busy) {
      const error = new Error("a Local LLM switch is already in progress");
      error.code = "BUSY";
      throw error;
    }

    this._starting = true;
    try {
      const sourceDetected = await this._detect();
      if (sourceDetected.runtime === "unknown") {
        const error = new Error("an unknown service is responding on port 8888; refusing to stop or replace it");
        error.code = "UNSAFE_STATE";
        throw error;
      }
      if (sourceDetected.runtime === target && sourceDetected.health === "healthy") {
        this.status = {
          state: "idle",
          phase: "complete",
          current: sourceDetected.runtime,
          currentModelId: sourceDetected.modelId,
          health: sourceDetected.health,
          source: target,
          target,
          startedAt: null,
          finishedAt: this.now(),
          message: `${this.targets()[target].label} is already healthy`,
          error: null,
          rollback: null,
          failureLog: [],
          log: [...this.status.log],
        };
        return { started: false, status: publicClone(this.status) };
      }

      this.status = {
        state: "switching",
        phase: "stopping",
        current: sourceDetected.runtime,
        currentModelId: sourceDetected.modelId,
        health: sourceDetected.health,
        source: isKnownRuntime(this.targets(), sourceDetected.runtime) ? sourceDetected.runtime : null,
        target,
        startedAt: this.now(),
        finishedAt: null,
        message:
          isKnownRuntime(this.targets(), sourceDetected.runtime)
            ? `Stopping the current runtime before starting ${this.targets()[target].label}`
            : `Starting ${this.targets()[target].label}`,
        error: null,
        rollback: null,
        failureLog: [],
        log: [],
      };

      const operation = this._executeSwitch(target, sourceDetected);
      this._operationPromise = operation.finally(() => {
        this._operationPromise = null;
      });
      return { started: true, status: publicClone(this.status) };
    } finally {
      this._starting = false;
    }
  }

  async waitForIdle() {
    if (this._operationPromise) await this._operationPromise;
    return publicClone(this.status);
  }

  async _run(command) {
    this._appendLog(`> ${command}`);
    await this.runCommand(command, { onLine: (line) => this._appendLog(line) });
  }

  async _waitForStopped({ allowRuntime = null } = {}) {
    for (let poll = 1; poll <= this.maxStopPolls; poll += 1) {
      const detected = await this._detect();
      this._applyDetected(detected);
      if (detected.runtime === "stopped" || detected.runtime === allowRuntime) return detected;
      if (detected.runtime === "unknown") {
        throw new Error("port 8888 is still occupied by an unknown or unresponsive service");
      }
      if (poll === this.maxStopPolls) {
        throw new Error(`timed out waiting for port 8888 to be released after ${this.maxStopPolls} checks`);
      }
      this.status.message = `Waiting for ${this.targets()[detected.runtime].label} API to stop`;
      this._appendLog(this.status.message);
      await this.delay(STOP_POLL_INTERVAL_MS);
    }
    throw new Error("timed out waiting for port 8888 to be released");
  }

  async _executeSwitch(target, sourceDetected) {
    const source = isKnownRuntime(this.targets(), sourceDetected.runtime) ? sourceDetected.runtime : null;
    try {
      if (source) {
        this.status.phase = "stopping";
        this.status.message = `Stopping ${this.targets()[source].label}`;
        await this._run(`stop-${source}`);
      }
      await this._waitForStopped();

      this.status.phase = "starting";
      this.status.message = `Starting ${this.targets()[target].label}`;
      await this._run(`start-${target}`);

      this.status.phase = "verifying";
      this.status.message = `Verifying ${this.targets()[target].modelId}`;
      const verified = await this._detect();
      this._applyDetected(verified);
      if (verified.runtime !== target || verified.modelId !== this.targets()[target].modelId) {
        throw new Error(
          `runtime verification failed: expected ${this.targets()[target].modelId}, got ${verified.modelId || "no model"}`
        );
      }

      this.status.state = "idle";
      this.status.phase = "complete";
      this.status.finishedAt = this.now();
      this.status.message = `${this.targets()[target].label} is healthy`;
      this.status.error = null;
      this.status.rollback = null;
      this.status.failureLog = [];
    } catch (error) {
      const originalError = error instanceof Error ? error.message : String(error);
      const rollbackDisabled = this.rollbackDisabledTargets.has(target);
      this._appendLog(`Switch failed: ${originalError}`);
      this.status.failureLog = [...this.status.log];
      this.status.phase = rollbackDisabled ? "cleaning-up" : "rolling-back";
      this.status.message = rollbackDisabled
        ? "Switch failed; cleaning up the target runtime (rollback disabled)"
        : source
          ? `Switch failed; restoring ${this.targets()[source].label}`
          : "Switch failed; cleaning up the target runtime";

      let cleanupDetected = null;
      let cleanupFailure = null;
      try {
        await this._run(`stop-${target}`);
        cleanupDetected = await this._waitForStopped(rollbackDisabled ? {} : { allowRuntime: source });
      } catch (cleanupError) {
        cleanupFailure = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        this._appendLog(`Target cleanup failed: ${cleanupFailure}`);
      }

      let rollback = null;
      if (!rollbackDisabled && source && source !== target) {
        rollback = { attempted: true, succeeded: false, error: null };
        if (cleanupFailure) {
          rollback.error = cleanupFailure;
          this._appendLog(`Rollback failed: ${rollback.error}`);
        } else if (
          cleanupDetected.runtime === source &&
          cleanupDetected.modelId === this.targets()[source].modelId
        ) {
          rollback.succeeded = true;
          this._appendLog(`Rollback restored ${this.targets()[source].label}`);
        } else {
          try {
            await this._run(`start-${source}`);
            const restored = await this._detect();
            this._applyDetected(restored);
            if (restored.runtime !== source || restored.modelId !== this.targets()[source].modelId) {
              throw new Error(
                `rollback verification failed: expected ${this.targets()[source].modelId}, got ${restored.modelId || "no model"}`
              );
            }
            rollback.succeeded = true;
            this._appendLog(`Rollback restored ${this.targets()[source].label}`);
          } catch (rollbackError) {
            rollback.error = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            this._appendLog(`Rollback failed: ${rollback.error}`);
          }
        }
      }

      this.status.state = "error";
      this.status.phase = "error";
      this.status.finishedAt = this.now();
      this.status.error = originalError;
      this.status.rollback = rollback;
      this.status.message = rollbackDisabled
        ? cleanupFailure
          ? "Switch and target cleanup failed and rollback is disabled; manual recovery is required"
          : `Switch failed; the target runtime was cleaned up but the previous runtime was not restored because rollback is disabled`
        : rollback?.succeeded
          ? `Switch failed; ${this.targets()[source].label} was restored`
          : rollback?.attempted
            ? "Switch and rollback failed; manual recovery is required"
            : "Switch failed and no previous runtime was available to restore";
    }
  }
}
