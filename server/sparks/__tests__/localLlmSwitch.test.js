import assert from "node:assert/strict";
import test from "node:test";
import { LocalLlmSwitchManager, inspectRuntimes, registerLocalLlmRoutes, validateSwitchRequest } from "../../localLlmSwitch.js";
import { normalizeRuntimeConfig, publicRuntimeConfig } from "../../localLlmConfig.js";

function configInput() {
  const runtime = (id, nodeIds) => ({ label: `Model ${id}`, modelId: id, apiNode: nodeIds[0],
    containers: Object.fromEntries(nodeIds.map((node) => [node, `${id}-${node}`])),
    start: `start-${id}`, stop: `stop-${id}`, startupTimeoutMs: 1000, stopTimeoutMs: 1000 });
  return { version: 2, hostUser: "fixture", hostHome: "/home/fixture", nodes: { a: {}, b: {} }, runtimes: {
    a1: runtime("a1", ["a"]), a2: runtime("a2", ["a"]), b1: runtime("b1", ["b"]), b2: runtime("b2", ["b"]),
    joined: runtime("joined", ["a", "b"]), joined2: runtime("joined2", ["a", "b"]),
  } };
}
const pair = (a = "a1", b = "b1") => ({ mode: "independent", selections: { a, b } });
const linked = (runtime = "joined") => ({ mode: "linked", runtime });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function fixture(initial = ["a1", "b1"], input = configInput()) {
  const config = normalizeRuntimeConfig(input);
  let clock = 0;
  let record = null;
  const h = { config, calls: [], roles: [], observations: Object.fromEntries(["a", "b"].map((id) =>
    [id, { reachable: false, modelId: null, running: [], error: null }])), onRun: null, onObserve: null, onCheck: null };
  h.activate = (id) => {
    const runtime = config.runtimes[id];
    for (const node of runtime.nodeIds) {
      const running = h.observations[node].running;
      if (!running.includes(runtime.containers[node])) running.push(runtime.containers[node]);
    }
    Object.assign(h.observations[runtime.apiNode], { reachable: true, modelId: runtime.modelId });
  };
  h.deactivate = (id) => {
    const runtime = config.runtimes[id];
    for (const node of runtime.nodeIds) h.observations[node].running = h.observations[node].running.filter((name) => name !== runtime.containers[node]);
    const api = h.observations[runtime.apiNode];
    if (api.modelId === runtime.modelId) Object.assign(api, { reachable: false, modelId: null });
  };
  initial.forEach(h.activate);
  h.store = {
    read: () => record,
    acquire: (target) => {
      if (record) throw Object.assign(new Error("Unfinished operation"), { code: "BUSY" });
      return record = { id: "operation", pid: process.pid, target };
    },
    release: (owner) => { assert.equal(owner.id, record.id); record = null; },
    ownerAlive: () => false,
  };
  h.executor = {
    observe: async () => { await h.onObserve?.(); return structuredClone(h.observations); },
    checkNode: async (node) => { await h.onCheck?.(node); },
    run: async (runtime, action, onLine) => {
      h.calls.push(`${runtime.id}:${action}`);
      onLine?.(`${action} fixture`);
      if (await h.onRun?.(runtime.id, action)) return;
      if (action === "start") h.activate(runtime.id);
      if (action === "stop") h.deactivate(runtime.id);
    },
  };
  h.manager = new LocalLlmSwitchManager({ getConfig: () => config, getSpark: (id) => ({ id, name: id }),
    executor: h.executor, store: h.store, now: () => clock, delay: async (ms) => { clock += ms; }, pollIntervalMs: 100,
    onTopology: (roles) => { h.roles.push(roles); } });
  h.switch = async (selection) => { await h.manager.beginSwitch(selection); return h.manager.waitForIdle(); };
  h.mutations = () => h.calls.filter((call) => !call.endsWith(":preflight"));
  return h;
}

test("independent to linked stops both models before starting and publishes a head/worker pair", async () => {
  const h = fixture();
  const stoppedA = deferred();
  let sawOtherStop = false;
  h.onRun = async (id, action) => {
    if (id === "a1" && action === "stop") await stoppedA.promise;
    if (id === "b1" && action === "stop") { sawOtherStop = true; stoppedA.resolve(); }
    if (id === "joined" && action === "start") assert.deepEqual(h.observations.a.running.concat(h.observations.b.running), []);
  };
  const result = await h.switch(linked());
  assert.equal(sawOtherStop, true);
  assert.equal(result.state, "idle");
  assert.deepEqual(result.current, linked());
  assert.equal(h.roles.at(-1).a.role, "head");
  assert.deepEqual(h.roles.at(-1).b, { role: "worker", workerHeadId: "a" });
  assert.equal(h.store.read(), null);
});

test("linked to independent starts both selected models concurrently after both containers stop", async () => {
  const h = fixture(["joined"]);
  const aStarted = deferred();
  h.onRun = async (id, action) => {
    if (id === "a1" && action === "start") await aStarted.promise;
    if (id === "b2" && action === "start") aStarted.resolve();
  };
  const result = await h.switch(pair("a1", "b2"));
  assert.deepEqual(result.current, pair("a1", "b2"));
  assert.deepEqual(h.mutations(), ["joined:stop", "a1:start", "b2:start"]);
  assert.equal(h.roles.at(-1).a.role, "head");
  assert.equal(h.roles.at(-1).b.role, "head");
});

test("one node switch leaves the peer running", async () => {
  const h = fixture();
  const result = await h.switch({ node: "b", target: "b2" });
  assert.deepEqual(h.mutations(), ["b1:stop", "b2:start"]);
  assert.deepEqual(result.current, pair("a1", "b2"));
});

test("batch independent switch skips unchanged nodes", async () => {
  const h = fixture();
  await h.switch(pair("a2", "b1"));
  assert.deepEqual(h.mutations(), ["a1:stop", "a2:start"]);
});

test("same healthy configuration is a command-free no-op and still corrects stale roles", async () => {
  const h = fixture();
  const result = await h.manager.beginSwitch(pair());
  assert.equal(result.started, false);
  assert.deepEqual(h.calls, []);
  assert.equal(h.roles.length, 1);
  assert.equal(h.store.read(), null);
});

test("independent failures restore only the failed node and retain a successful peer change", async () => {
  const h = fixture();
  h.onRun = (id, action) => { if (id === "a2" && action === "start") { h.activate(id); throw new Error("fixture startup failure"); } };
  const result = await h.switch(pair("a2", "b2"));
  assert.equal(result.state, "error");
  assert.deepEqual(result.current, pair("a1", "b2"));
  assert.equal(h.calls.includes("b2:stop"), false);
  assert.equal(result.recoveries[0].succeeded, true);
  assert.deepEqual(result.recoveries[0].nodeIds, ["a"]);
});

test("failed linked startup cleans up both members and restores the original independent pair", async () => {
  const h = fixture();
  h.onRun = (id, action) => { if (id === "joined" && action === "start") { h.activate(id); throw new Error("joined failed"); } };
  const result = await h.switch(linked());
  assert.equal(result.state, "error");
  assert.deepEqual(result.current, pair());
  assert.deepEqual(h.mutations(), ["a1:stop", "b1:stop", "joined:start", "joined:stop", "a1:start", "b1:start"]);
  assert.equal(result.recoveries[0].succeeded, true);
});

test("failed independent startup while leaving linked mode restores the original linked runtime", async () => {
  const h = fixture(["joined"]);
  h.onRun = (id, action) => { if (id === "b1" && action === "start") throw new Error("b1 failed"); };
  const result = await h.switch(pair());
  assert.deepEqual(result.current, linked());
  assert.equal(result.recoveries[0].succeeded, true);
  assert.ok(h.calls.indexOf("joined:start") > h.calls.indexOf("a1:stop"));
});

test("rollback-disabled target is cleaned up but does not restart previous runtimes", async () => {
  const input = configInput(); input.runtimes.joined.rollback = false;
  const h = fixture(undefined, input);
  h.onRun = (id, action) => { if (id === "joined" && action === "start") { h.activate(id); throw new Error("failed"); } };
  const result = await h.switch(linked());
  assert.equal(result.current.mode, "stopped");
  assert.equal(result.recoveries[0].attempted, false);
  assert.equal(h.calls.includes("a1:start"), false);
});

test("unknown worker state blocks the whole operation before any stop", async () => {
  const h = fixture(); h.observations.b.error = "SSH failed";
  await assert.rejects(h.manager.beginSwitch(linked()), /cannot inspect/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.store.read(), null);
});

test("unknown API and overlapping runtime ownership are rejected", async () => {
  for (const change of [
    (h) => { h.observations.b.modelId = "unmanaged-model"; },
    (h) => { h.activate("joined"); },
  ]) {
    const h = fixture(); change(h);
    await assert.rejects(h.manager.beginSwitch(linked()), /unknown|overlapping/);
    assert.deepEqual(h.calls, []);
  }
});

test("worker-only remnant of a linked runtime is detected and stopped", async () => {
  const h = fixture([]);
  h.observations.b.running = ["joined-b"];
  const before = await h.manager.getStatus();
  assert.deepEqual(before.current, linked());
  assert.equal(before.nodes[1].health, "degraded");
  assert.equal(h.roles.length, 0);
  const result = await h.switch(pair());
  assert.deepEqual(result.current, pair());
  assert.equal(h.mutations()[0], "joined:stop");
});

test("a per-node request is refused while a linked runtime owns either node", async () => {
  const h = fixture(["joined"]);
  await assert.rejects(h.manager.beginSwitch({ node: "b", target: "b1" }), /whole topology/);
  assert.deepEqual(h.calls, []);
});

test("preflight failure occurs before any runtime is stopped", async () => {
  const h = fixture();
  h.onRun = (_id, action) => { if (action === "preflight") throw new Error("model files missing"); };
  const result = await h.switch(linked());
  assert.equal(result.state, "error");
  assert.deepEqual(result.current, pair());
  assert.deepEqual(h.mutations(), []);
});

test("leftover worker container prevents starting the target after a nominally successful stop", async () => {
  const h = fixture(["joined"]);
  h.onRun = (id, action) => {
    if (id === "joined" && action === "stop") { h.observations.a = { reachable: false, modelId: null, running: [], error: null }; return true; }
  };
  const result = await h.switch(pair());
  assert.equal(result.state, "error");
  assert.equal(h.calls.includes("a1:start"), false);
  assert.equal(h.calls.includes("b1:start"), false);
  assert.match(result.recoveries[0].error, /stop/);
});

test("daemonized start waits for the advertised model ID before changing roles", async () => {
  const h = fixture([]);
  let probes = 0;
  h.onRun = (id, action) => {
    if (action === "start") {
      h.observations.a.running = ["a1-a"];
      h.onObserve = () => { if (++probes === 3) h.activate(id); };
      return true;
    }
  };
  const result = await h.switch({ node: "a", target: "a1" });
  assert.equal(result.state, "idle");
  assert.ok(probes >= 3);
  assert.equal(h.roles.length, 1);
});

test("readiness timeout triggers cleanup instead of reporting a successful daemon launch", async () => {
  const h = fixture([]);
  h.onRun = (_id, action) => action === "start" ? true : undefined;
  const result = await h.switch({ node: "a", target: "a1" });
  assert.equal(result.state, "error");
  assert.match(result.error, /Timed out waiting/);
  assert.ok(h.calls.includes("a1:stop"));
});

test("a failed cleanup does not launch a previous model onto an occupied node", async () => {
  const h = fixture();
  h.onRun = (id, action) => {
    if (id === "a2" && action === "start") { h.activate(id); throw new Error("start failed"); }
    if (id === "a2" && action === "stop") throw new Error("cleanup failed");
  };
  const result = await h.switch({ node: "a", target: "a2" });
  assert.equal(result.recoveries[0].succeeded, false);
  assert.match(result.recoveries[0].error, /cleanup failed/);
  assert.equal(h.calls.includes("a1:start"), false);
});

test("SSH loss leaves the durable operation pending and never launches automatic cleanup", async () => {
  const h = fixture();
  h.onRun = (id, action) => { if (id === "joined" && action === "start") throw Object.assign(new Error("SSH lost"), { uncertain: true }); };
  const result = await h.switch(linked());
  assert.equal(result.interrupted, true);
  assert.equal(h.calls.includes("joined:stop"), false);
  assert.equal(h.roles.length, 0);
  await assert.rejects(h.manager.beginSwitch(pair()), /Unfinished/);
  h.activate("joined");
  const reconciled = await h.manager.reconcile();
  assert.equal(reconciled.interrupted, false);
  assert.deepEqual(reconciled.current, linked());
});

test("reconciliation will not clear a pending operation while a host command is still running", async () => {
  const h = fixture(); h.store.acquire(pair());
  h.onCheck = () => { throw Object.assign(new Error("host lock held"), { code: "BUSY" }); };
  await assert.rejects(h.manager.reconcile(), /host lock/);
  assert.ok(h.store.read());
  assert.deepEqual(h.calls, []);
});

test("restarted server requires explicit reconciliation and does not change roles on GET", async () => {
  const h = fixture(); h.store.acquire(linked());
  const status = await h.manager.getStatus();
  assert.equal(status.interrupted, true);
  assert.equal(h.roles.length, 0);
  h.store.read().pid = process.pid + 100;
  h.store.ownerAlive = () => true;
  await assert.rejects(h.manager.reconcile(), /owner is still running/);
  h.store.ownerAlive = () => false;
  await h.manager.reconcile();
  assert.equal(h.store.read(), null);
  assert.equal(h.roles.at(-1).b.role, "head");
});

test("concurrent requests are rejected even while the initial probe is still pending", async () => {
  const h = fixture(); const waiting = deferred();
  h.onObserve = () => waiting.promise;
  const first = h.manager.beginSwitch(linked());
  await assert.rejects(h.manager.beginSwitch(pair()), /already in progress/);
  waiting.resolve();
  await first; await h.manager.waitForIdle();
});

test("a stale status probe cannot overwrite a newer completed switch or its roles", async () => {
  const h = fixture(); const pending = deferred(); const old = structuredClone(h.observations);
  let first = true;
  h.executor.observe = async () => {
    if (first) { first = false; await pending.promise; return old; }
    return structuredClone(h.observations);
  };
  const poll = h.manager.getStatus();
  await h.switch(linked());
  pending.resolve();
  assert.deepEqual((await poll).current, linked());
  assert.equal(h.roles.at(-1).b.role, "worker");
});

test("status adopts two healthy head roles without restarting models", async () => {
  const h = fixture();
  await h.manager.getStatus();
  assert.equal(h.roles.at(-1).b.role, "head");
  assert.deepEqual(h.calls, []);
});

test("request validation rejects incomplete selections, cross-node models, unknown profiles and injected commands", () => {
  const config = normalizeRuntimeConfig(configInput());
  for (const request of [null, {}, { mode: "independent", selections: { a: "a1" } },
    pair("b1", "a1"), pair("a1", null), linked("a1"), { node: "a", target: "b1" }, { target: "$(touch /tmp/x)" },
    { mode: "independent", selections: { a: "a1", b: "b1", extra: "b1" } }]) {
    assert.throws(() => validateSwitchRequest(request, config), (error) => error.code === "INVALID");
  }
  assert.deepEqual(validateSwitchRequest({ ...linked(), start: "arbitrary command" }, config), linked());
  assert.deepEqual(validateSwitchRequest({ target: "joined" }, config), linked());
});

test("configuration rejects ambiguous ownership and exposes only public profile metadata", () => {
  const config = normalizeRuntimeConfig(configInput());
  const catalog = publicRuntimeConfig(config, () => null);
  assert.equal(catalog.runtimes[0].start, undefined);
  assert.equal(catalog.nodes[0].hostUser, undefined);
  for (const change of [
    (input) => { input.version = 1; },
    (input) => { input.nodes.c = {}; },
    (input) => { input.runtimes.a2.containers.a = "a1-a"; },
    (input) => { input.runtimes.a2.modelId = "a1"; },
    (input) => { input.runtimes.a1.apiNode = "unknown"; },
    (input) => { input.runtimes.a1.startupTimeoutMs = -1; },
    (input) => { input.hostUser = "bad;user"; },
  ]) { const input = configInput(); change(input); assert.throws(() => normalizeRuntimeConfig(input), /configuration/); }
});

test("linked health requires both member containers and a stopped worker API", () => {
  const h = fixture(["joined"]);
  assert.equal(inspectRuntimes(h.config, h.observations).healthy.joined, true);
  h.observations.b.running = [];
  assert.equal(inspectRuntimes(h.config, h.observations).healthy.joined, false);
  h.observations.b.running = ["joined-b"];
  h.observations.b.reachable = true;
  assert.equal(inspectRuntimes(h.config, h.observations).healthy.joined, false);
});

test("unprepared profiles cannot be selected but their running containers remain recognized", async () => {
  const input = configInput(); input.runtimes.joined.disabledReason = "Image not installed";
  const h = fixture(["joined"], input);
  await assert.rejects(h.manager.beginSwitch(linked()), /Image not installed/);
  const result = await h.switch(pair());
  assert.deepEqual(result.current, pair());
  assert.equal(h.mutations()[0], "joined:stop");
});

test("HTTP routes authenticate writes, reject invalid requests, and distinguish accepted operations from no-ops", async () => {
  const h = fixture(); const routes = new Map();
  const app = { get: (path, handler) => routes.set(`GET ${path}`, handler), post: (path, handler) => routes.set(`POST ${path}`, handler) };
  registerLocalLlmRoutes(app, { manager: h.manager, keyOk: (key) => key === "fixture", writesEnabled: () => true });
  const request = async (path, body) => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    await routes.get(path)({ body }, res); return res;
  };
  assert.equal((await request("POST /api/local-llm/switch", linked())).code, 403);
  assert.equal((await request("POST /api/local-llm/reconcile", {})).code, 403);
  assert.equal((await request("POST /api/local-llm/switch", { key: "fixture", mode: "invalid" })).code, 400);
  assert.equal((await request("POST /api/local-llm/switch", { ...pair(), key: "fixture" })).code, 200);
  assert.equal((await request("POST /api/local-llm/switch", { ...linked(), key: "fixture" })).code, 202);
  await h.manager.waitForIdle();
  const result = await request("GET /api/local-llm/status");
  assert.equal(result.body.writesEnabled, true);
  assert.deepEqual(result.body.current, linked());
});
