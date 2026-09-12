import { getRuntimeConfig, publicRuntimeConfig } from "./localLlmConfig.js";
import { createRuntimeExecutor, safeLogLine } from "./localLlmCommands.js";
import { createOperationStore } from "./localLlmState.js";

function failure(message, code = "UNSAFE_STATE") { return Object.assign(new Error(message), { code }); }
const messageOf = (error) => error instanceof Error ? error.message : String(error);

/** Recognize partial linked deployments too: a headless worker can still occupy its GPU. */
export function inspectRuntimes(config, observations) {
  const active = [];
  const healthy = {};
  const issues = [];
  for (const runtime of Object.values(config.runtimes)) {
    const api = observations[runtime.apiNode];
    const members = runtime.nodeIds.map((id) => observations[id]?.running?.includes(runtime.containers[id]));
    const matches = api?.reachable && api.modelId === runtime.modelId;
    if (matches || members.some(Boolean)) active.push(runtime.id);
    healthy[runtime.id] = Boolean(matches && members.every(Boolean)
      && runtime.nodeIds.every((id) => !observations[id]?.error
        && (id === runtime.apiNode || observations[id]?.reachable === false)));
  }
  for (const id of Object.keys(config.nodes)) {
    const observation = observations[id];
    if (!observation || observation.error) issues.push(`${id}: cannot inspect the node`);
    else if (observation.reachable && !active.some((key) => config.runtimes[key].apiNode === id
      && config.runtimes[key].modelId === observation.modelId)) issues.push(`${id}: unknown or unresponsive API`);
    if (active.filter((key) => config.runtimes[key].nodeIds.includes(id)).length > 1) issues.push(`${id}: overlapping runtimes`);
  }
  const linked = active.find((id) => config.runtimes[id].mode === "linked");
  const current = issues.length ? { mode: "unknown" }
    : linked ? { mode: "linked", runtime: linked }
      : { mode: active.length ? "independent" : "stopped", selections: Object.fromEntries(
        Object.keys(config.nodes).map((node) => [node, active.find((id) => config.runtimes[id].apiNode === node) || null])) };
  return { active, healthy, issues, current, observations };
}

export function validateSwitchRequest(request, config) {
  if (!request || typeof request !== "object") throw failure("A runtime selection is required", "INVALID");
  const selected = (id) => {
    const runtime = config.runtimes[id];
    if (runtime?.disabledReason) throw failure(`${runtime.label}: ${runtime.disabledReason}`, "INVALID");
    return runtime;
  };
  if (request.node !== undefined) {
    const runtime = selected(request.target);
    if (!Object.hasOwn(config.nodes, request.node) || !runtime || runtime.mode !== "independent"
      || runtime.apiNode !== request.node) throw failure("Select an independent runtime installed on this node", "INVALID");
    return { node: request.node, target: runtime.id };
  }
  // A previous client may still send {target}; only linked profiles are accepted there.
  if (request.mode === "linked" || (request.mode === undefined && typeof request.target === "string")) {
    const runtime = selected(request.runtime ?? request.target);
    if (!runtime || runtime.mode !== "linked") throw failure("Select a configured linked runtime", "INVALID");
    return { mode: "linked", runtime: runtime.id };
  }
  if (request.mode !== "independent" || !request.selections || Array.isArray(request.selections)
    || Object.keys(request.selections).length !== Object.keys(config.nodes).length) {
    throw failure("Select an independent runtime for each node", "INVALID");
  }
  const selections = {};
  for (const node of Object.keys(config.nodes)) {
    const runtime = selected(request.selections[node]);
    if (!runtime || runtime.mode !== "independent" || runtime.apiNode !== node) {
      throw failure(`Select an independent runtime installed on ${node}`, "INVALID");
    }
    selections[node] = runtime.id;
  }
  return { mode: "independent", selections };
}

async function together(promises) {
  const results = await Promise.allSettled(promises);
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw Object.assign(new Error(errors.map(messageOf).join("; ")), {
    code: errors[0].code,
    uncertain: errors.some((error) => error.uncertain),
  });
}

export class LocalLlmSwitchManager {
  constructor({ getConfig = getRuntimeConfig, getSpark, onTopology = () => {}, executor,
    store = createOperationStore(), now = Date.now, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs = 2000 } = {}) {
    this.getConfig = getConfig;
    this.getSpark = getSpark || (() => null);
    this.onTopology = onTopology;
    this.executor = executor || createRuntimeExecutor({ getConfig, getSpark: this.getSpark });
    this.store = store;
    this.now = now;
    this.delay = delay;
    this.pollIntervalMs = pollIntervalMs;
    this._starting = false;
    this._operation = null;
    this._revision = 0;
    this.detected = null;
    this.status = { state: "idle", phase: "idle", target: null, startedAt: null, finishedAt: null,
      message: "", error: null, log: [], failureLog: [], progress: {}, recoveries: [] };
  }

  get busy() { return this._starting || Boolean(this._operation); }

  _log(text) {
    const line = safeLogLine(text);
    if (line) this.status.log = [...this.status.log, line].slice(-60);
  }

  _phase(nodes, phase, message, error = null) {
    for (const id of nodes) this.status.progress[id] = { phase, message, error };
  }

  async _observe() { return inspectRuntimes(this.getConfig(), await this.executor.observe()); }

  async _syncTopology(detected) {
    if (detected.issues.length || !detected.active.length || !detected.active.every((id) => detected.healthy[id])) return;
    const roles = {};
    const config = this.getConfig();
    for (const id of Object.keys(config.nodes)) roles[id] = { role: "head", workerHeadId: null, port: config.nodes[id].port };
    for (const id of detected.active) {
      const runtime = config.runtimes[id];
      for (const member of runtime.nodeIds) {
        if (member !== runtime.apiNode) roles[member] = { role: "worker", workerHeadId: runtime.apiNode };
      }
    }
    await this.onTopology(roles);
  }

  _snapshot() {
    const config = this.getConfig();
    const catalog = publicRuntimeConfig(config, this.getSpark);
    const interrupted = Boolean(!this.busy && this.store.read());
    return structuredClone({ ...this.status, interrupted,
      current: this.detected?.current || { mode: "unknown" },
      issues: this.detected?.issues || [], runtimes: catalog.runtimes,
      nodes: catalog.nodes.map((node) => {
        const runtime = this.detected?.active.find((id) => config.runtimes[id].nodeIds.includes(node.id));
        const observed = this.detected?.observations[node.id];
        return { ...node, runtime: runtime || null, modelId: observed?.modelId || null,
          health: runtime ? this.detected.healthy[runtime] ? "healthy" : "degraded"
            : observed?.reachable === false && !observed.error ? "stopped" : "unknown" };
      }),
    });
  }

  async getStatus({ refresh = true } = {}) {
    if (refresh && !this.busy) {
      const revision = this._revision;
      const detected = await this._observe();
      if (!this.busy && revision === this._revision) {
        this.detected = detected;
        if (!this.store.read()) await this._syncTopology(detected);
      }
    }
    return this._snapshot();
  }

  async beginSwitch(request) {
    if (this.busy) throw failure("A runtime switch is already in progress", "BUSY");
    const selection = validateSwitchRequest(request, this.getConfig());
    this._starting = true;
    this._revision++;
    let record;
    try {
      record = this.store.acquire(selection);
      const source = await this._observe();
      if (source.issues.length) throw failure(source.issues.join("; "));
      let target = selection;
      if (selection.node) {
        if (source.current.mode === "linked") throw failure("Switch the whole topology before changing one node");
        target = { mode: "independent", selections: { ...source.current.selections, [selection.node]: selection.target } };
      }
      this.detected = source;
      const desired = target.mode === "linked" ? [target.runtime] : Object.values(target.selections).filter(Boolean);
      const unchanged = desired.length === source.active.length
        && desired.every((id) => source.active.includes(id) && source.healthy[id]);
      this.status = { state: unchanged ? "idle" : "switching", phase: unchanged ? "complete" : "preparing",
        target, startedAt: unchanged ? null : this.now(), finishedAt: unchanged ? this.now() : null,
        message: unchanged ? "Selected configuration is already running" : "Preparing runtime switch",
        error: null, log: [], failureLog: [], progress: {}, recoveries: [] };
      if (unchanged) {
        await this._syncTopology(source);
        this.store.release(record);
        return { started: false, status: this._snapshot() };
      }
      this._operation = Promise.resolve().then(() => this._execute(source, desired, target, record))
        .finally(() => { this._operation = null; });
      return { started: true, status: this._snapshot() };
    } catch (error) {
      if (record) this.store.release(record);
      throw error;
    } finally { this._starting = false; }
  }

  async waitForIdle() { if (this._operation) await this._operation; return this._snapshot(); }

  async _run(id, action) {
    const runtime = this.getConfig().runtimes[id];
    this._log(`${runtime.label}: ${action}`);
    await this.executor.run(runtime, action, (line) => this._log(`${runtime.label}: ${line}`));
  }

  async _waitStopped(nodes, timeoutMs) {
    const deadline = this.now() + timeoutMs;
    do {
      const observed = await this.executor.observe();
      const blocked = nodes.filter((node) => {
        const status = observed[node];
        if (!status || status.error) throw failure(`${node}: cannot verify that the runtime stopped`);
        const known = Object.values(this.getConfig().runtimes).some((runtime) =>
          runtime.containers[node] && status.running.includes(runtime.containers[node]));
        if (status.reachable && !Object.values(this.getConfig().runtimes).some((runtime) =>
          runtime.apiNode === node && runtime.modelId === status.modelId)) throw failure(`${node}: an unknown API is occupying the runtime port`);
        return known || status.reachable;
      });
      if (!blocked.length) return;
      if (this.now() >= deadline) break;
      await this.delay(this.pollIntervalMs);
    } while (true);
    throw new Error(`Timed out waiting for runtimes on ${nodes.join(", ")} to stop`);
  }

  async _start(id, phase = "starting") {
    const runtime = this.getConfig().runtimes[id];
    const deadline = this.now() + runtime.startupTimeoutMs;
    this._phase(runtime.nodeIds, phase, `Starting ${runtime.label}`);
    await this._run(id, "start");
    this._phase(runtime.nodeIds, phase === "rolling-back" ? phase : "verifying", `Waiting for ${runtime.label}`);
    do {
      const detected = await this._observe();
      if (detected.healthy[id]) return;
      const api = detected.observations[runtime.apiNode];
      if (api?.modelId && api.modelId !== runtime.modelId) throw failure(`Expected ${runtime.modelId}, received ${api.modelId}`);
      if (this.now() >= deadline) break;
      await this.delay(this.pollIntervalMs);
    } while (true);
    throw new Error(`Timed out waiting for ${runtime.label} and all its member containers`);
  }

  async _transition(source, desired, nodes) {
    const config = this.getConfig();
    const timeoutMs = Math.max(1000, ...[...source, ...desired].map((id) => config.runtimes[id].stopTimeoutMs));
    let attempted = [];
    try {
      this._phase(nodes, "stopping", "Stopping current runtime");
      await together(source.map((id) => this._run(id, "stop")));
      await this._waitStopped(nodes, timeoutMs);
      attempted = desired;
      await together(desired.map((id) => this._start(id)));
      this._phase(nodes, "complete", "Ready");
    } catch (error) {
      this._log(`Switch failed on ${nodes.join(", ")}: ${messageOf(error)}`);
      this.status.failureLog = [...this.status.log];
      const recovery = { nodeIds: nodes, attempted: false, succeeded: false, error: null };
      if (error.uncertain) recovery.error = "Command state is uncertain; reconcile before retrying";
      else {
        try {
          this._phase(nodes, "cleaning-up", "Cleaning up failed startup");
          await together(attempted.map((id) => this._run(id, "stop")));
          if (attempted.length) await this._waitStopped(nodes, timeoutMs);
          if (source.length && desired.every((id) => config.runtimes[id].rollback)) {
            recovery.attempted = true;
            const current = await this._observe();
            const issues = current.issues.filter((issue) => nodes.some((node) => issue.startsWith(`${node}:`)));
            if (issues.length) throw failure(issues.join("; "));
            const restore = source.filter((id) => !current.healthy[id]);
            await together(restore.filter((id) => current.active.includes(id)).map((id) => this._run(id, "stop")));
            const restoreNodes = [...new Set(restore.flatMap((id) => config.runtimes[id].nodeIds))];
            if (restoreNodes.length) await this._waitStopped(restoreNodes, timeoutMs);
            await together(restore.map((id) => this._start(id, "rolling-back")));
            recovery.succeeded = true;
          }
        } catch (restoreError) {
          recovery.error = messageOf(restoreError);
          if (restoreError.uncertain) error.uncertain = true;
        }
      }
      this.status.recoveries.push(recovery);
      this._phase(nodes, "error", recovery.succeeded ? "Previous runtime restored" : "Switch failed", messageOf(error));
      throw error;
    }
  }

  async _execute(source, desired, target, record) {
    let uncertain = false;
    try {
      const config = this.getConfig();
      await together(Object.keys(config.nodes).map((id) => this.executor.checkNode(id)));
      const changed = desired.filter((id) => !source.active.includes(id) || !source.healthy[id]);
      await together(changed.map((id) => this._run(id, "preflight")));
      this.status.phase = "switching";
      const linked = target.mode === "linked" || source.active.some((id) => config.runtimes[id].mode === "linked");
      if (linked) await this._transition(source.active, desired, Object.keys(config.nodes));
      else await together(Object.keys(config.nodes).map((node) => {
        const previous = source.active.filter((id) => config.runtimes[id].apiNode === node);
        const next = desired.filter((id) => config.runtimes[id].apiNode === node);
        if (previous.length === next.length && next.every((id) => previous.includes(id) && source.healthy[id])) return Promise.resolve();
        return this._transition(previous, next, [node]);
      }));
      this.status.state = "idle";
      this.status.phase = "complete";
      this.status.message = "Runtime configuration is ready";
    } catch (error) {
      uncertain = Boolean(error.uncertain);
      this.status.state = "error";
      this.status.phase = "error";
      this.status.message = "Runtime switch failed; review each node's result";
      this.status.error = messageOf(error);
      this._log(this.status.error);
    } finally {
      try {
        this.detected = await this._observe();
        if (!uncertain) await this._syncTopology(this.detected);
        if (!uncertain) this.store.release(record);
      } catch (error) {
        this.status.state = "error";
        this.status.phase = "error";
        this.status.error = messageOf(error);
      }
      this.status.finishedAt = this.now();
    }
  }

  async reconcile() {
    if (this.busy) throw failure("A runtime switch is still running", "BUSY");
    const record = this.store.read();
    if (!record) return this.getStatus();
    if (record.pid !== process.pid && this.store.ownerAlive(record)) throw failure("The runtime operation owner is still running", "BUSY");
    this._starting = true;
    this._revision++;
    try {
      await together(Object.keys(this.getConfig().nodes).map((id) => this.executor.checkNode(id)));
      const detected = await this._observe();
      if (detected.issues.length) throw failure(detected.issues.join("; "));
      this.detected = detected;
      await this._syncTopology(detected);
      this.store.release(record);
      this.status.state = "idle";
      this.status.phase = "idle";
      this.status.error = null;
      this.status.message = "Current runtime state reconciled";
    } finally { this._starting = false; }
    return this._snapshot();
  }
}

export function registerLocalLlmRoutes(app, { manager, keyOk, writesEnabled }) {
  const sendError = (res, error) => res.status(error.code === "INVALID" ? 400
    : ["BUSY", "UNSAFE_STATE"].includes(error.code) ? 409 : 500).json({ error: messageOf(error) });
  app.get("/api/local-llm/status", async (_req, res) => {
    try { res.json({ ...await manager.getStatus(), writesEnabled: Boolean(writesEnabled()) }); }
    catch (error) { sendError(res, error); }
  });
  app.post("/api/local-llm/switch", async (req, res) => {
    if (!keyOk(req.body?.key)) return res.status(403).json({ error: "Invalid or missing ECO key" });
    try {
      const result = await manager.beginSwitch(req.body);
      res.status(result.started ? 202 : 200).json({ ...result.status, success: true, started: result.started,
        writesEnabled: Boolean(writesEnabled()) });
    } catch (error) { sendError(res, error); }
  });
  app.post("/api/local-llm/reconcile", async (req, res) => {
    if (!keyOk(req.body?.key)) return res.status(403).json({ error: "Invalid or missing ECO key" });
    try { res.json({ ...await manager.reconcile(), writesEnabled: Boolean(writesEnabled()) }); }
    catch (error) { sendError(res, error); }
  });
}
