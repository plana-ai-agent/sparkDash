import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  LocalLlmSwitchManager,
  buildHostCommandInvocation,
  classifyProbe,
  loadLocalLlmRuntimeConfig,
  probeLocalLlmRuntime,
  registerLocalLlmRoutes,
  streamLines,
  validateLocalLlmTarget,
} from "../../localLlmSwitch.js";

// Deployment-private values now live in the environment (.env). Tests use
// fixture values so they never depend on a real deployment.
const FIXTURE_ENV = {
  LOCAL_LLM_HOST_USER: "sparkdash-test",
  LOCAL_LLM_HOST_HOME: "/home/sparkdash-test",
  LOCAL_LLM_MODEL_DEEPSEEK: "fixture-deepseek-model",
  LOCAL_LLM_MODEL_QWEN: "fixture-qwen-model",
  LOCAL_LLM_MODEL_GLM: "fixture-glm-model",
  LOCAL_LLM_MODEL_NVFP4: "fixture-nvfp4-model",
  LOCAL_LLM_LABEL_DEEPSEEK: "Fixture DeepSeek Label",
  LOCAL_LLM_LABEL_GLM: "Fixture GLM Label",
  LOCAL_LLM_LABEL_NVFP4: "Fixture NVFP4 Label",
  LOCAL_LLM_CMD_STOP_DEEPSEEK: "cd /opt/sparkdash-fixtures/deepseek && exec ./stop.sh",
  LOCAL_LLM_CMD_START_DEEPSEEK: "cd /opt/sparkdash-fixtures/deepseek && exec ./start.sh",
  LOCAL_LLM_CMD_STOP_QWEN: "cd /opt/sparkdash-fixtures/qwen && exec ./start.sh stop",
  LOCAL_LLM_CMD_START_QWEN: "cd /opt/sparkdash-fixtures/qwen && exec ./start.sh serve",
  LOCAL_LLM_CMD_STOP_GLM:
    "cd /opt/sparkdash-fixtures/glm && exec env WORKER_SSH=fixture-worker CONTAINER_HEAD=fixture-head CONTAINER_WORKER=fixture-worker ./stop.sh",
  LOCAL_LLM_CMD_START_GLM:
    "cd /opt/sparkdash-fixtures/glm && exec env HEAD_IP=10.0.0.10 WORKER_SSH=fixture-worker WORKER_IP=10.0.0.11 ./start.sh",
  LOCAL_LLM_CMD_STOP_NVFP4: "cd /opt/sparkdash-fixtures/nvfp4 && exec ./runtime.sh stop",
  LOCAL_LLM_CMD_START_NVFP4: "cd /opt/sparkdash-fixtures/nvfp4 && exec ./runtime.sh start",
};
for (const [name, value] of Object.entries(FIXTURE_ENV)) {
  process.env[name] = value;
}

const DEEPSEEK_ID = FIXTURE_ENV.LOCAL_LLM_MODEL_DEEPSEEK;
const QWEN_ID = FIXTURE_ENV.LOCAL_LLM_MODEL_QWEN;
const GLM_ID = FIXTURE_ENV.LOCAL_LLM_MODEL_GLM;
const NVFP4_ID = FIXTURE_ENV.LOCAL_LLM_MODEL_NVFP4;

function reachable(modelId) {
  return { reachable: true, modelId };
}

function stopped() {
  return { reachable: false, modelId: null };
}

function makeProbe(sequence) {
  const values = [...sequence];
  return async () => {
    assert.ok(values.length > 0, "probe sequence exhausted");
    return values.shift();
  };
}

function makeManager({ probes, failCommands = new Map(), runCommand, delay, maxStopPolls, disableRollbackTargets } = {}) {
  const commands = [];
  const runner =
    runCommand ||
    (async (command, { onLine } = {}) => {
      commands.push(command);
      onLine?.(`${command} complete`);
      if (failCommands.has(command)) throw new Error(failCommands.get(command));
    });
  const manager = new LocalLlmSwitchManager({
    probeRuntime: makeProbe(probes),
    runCommand: runner,
    now: (() => {
      let value = 1000;
      return () => value++;
    })(),
    delay: delay || (async () => {}),
    maxStopPolls,
    ...(disableRollbackTargets ? { disableRollbackTargets } : {}),
  });
  return { manager, commands };
}

test("overlong unterminated lifecycle output is redacted as one bounded line", async () => {
  const stream = new PassThrough();
  const lines = [];
  streamLines(stream, (line) => lines.push(line));
  const ended = new Promise((resolve) => stream.once("end", resolve));
  stream.end("x".repeat(2001));
  await ended;
  assert.deepEqual(lines, ["[redacted overlong output]"]);
});

test("overlong unterminated secret lines cannot leak across the log fragment boundary", async () => {
  const prefix = "boundary-prefix-";
  const output = `${prefix}${"x".repeat(499 - prefix.length)}Authorization: Bearer boundary-secret`;
  const { manager } = makeManager({
    probes: [stopped(), stopped(), stopped()],
    runCommand: async (command, { onLine }) => {
      if (command !== "start-qwen") return;
      const stream = new PassThrough();
      streamLines(stream, onLine);
      const ended = new Promise((resolve) => stream.once("end", resolve));
      stream.end(output);
      await ended;
      throw new Error("qwen boot failed");
    },
  });

  await manager.beginSwitch("qwen");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  for (const log of [status.log, status.failureLog]) {
    assert.equal(log.some((line) => line.includes(prefix)), false);
    assert.equal(log.some((line) => line.includes("boundary-secret")), false);
  }
});

test("host lifecycle invocation clears container environment before running as hermes", () => {
  const invocation = buildHostCommandInvocation("start-qwen");
  assert.equal(invocation.file, "/usr/bin/nsenter");
  const envIndex = invocation.args.indexOf("/usr/bin/env");
  assert.ok(envIndex > 0);
  assert.deepEqual(invocation.args.slice(envIndex, envIndex + 6), [
    "/usr/bin/env",
    "-i",
    "HOME=/home/sparkdash-test",
    "USER=sparkdash-test",
    "LOGNAME=sparkdash-test",
    "SHELL=/bin/bash",
  ]);
  assert.ok(invocation.args.includes("PATH=/home/sparkdash-test/.local/bin:/usr/local/cuda/bin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"));
  assert.equal(invocation.args.includes("PORT=5555"), false);
  assert.match(invocation.args.at(-1), /sparkdash-fixtures\/qwen/);
  assert.throws(() => buildHostCommandInvocation("shell"), /allowlisted/);
});

test("classifyProbe distinguishes all exact IDs, stopped, and unknown", () => {
  const { targets } = loadLocalLlmRuntimeConfig(process.env);
  assert.deepEqual(classifyProbe(reachable(DEEPSEEK_ID), targets), {
    runtime: "deepseek",
    modelId: DEEPSEEK_ID,
    health: "healthy",
  });
  assert.deepEqual(classifyProbe(reachable(QWEN_ID), targets), {
    runtime: "qwen",
    modelId: QWEN_ID,
    health: "healthy",
  });
  assert.deepEqual(classifyProbe(reachable(GLM_ID), targets), {
    runtime: "glm",
    modelId: GLM_ID,
    health: "healthy",
  });
  assert.deepEqual(classifyProbe(reachable(NVFP4_ID), targets), {
    runtime: "nvfp4",
    modelId: NVFP4_ID,
    health: "healthy",
  });
  assert.deepEqual(classifyProbe(stopped(), targets), {
    runtime: "stopped",
    modelId: null,
    health: "stopped",
  });
  assert.deepEqual(classifyProbe(reachable("some-other-model"), targets), {
    runtime: "unknown",
    modelId: "some-other-model",
    health: "unknown",
  });
});

test("probe treats malformed live responses as unknown and only connection refusal as stopped", async () => {
  assert.deepEqual(
    await probeLocalLlmRuntime(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("invalid json");
      },
    })),
    { reachable: true, modelId: null }
  );

  const reset = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
  assert.deepEqual(
    await probeLocalLlmRuntime(async () => {
      throw reset;
    }),
    { reachable: true, modelId: null }
  );

  const refused = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  assert.deepEqual(
    await probeLocalLlmRuntime(async () => {
      throw refused;
    }),
    { reachable: false, modelId: null }
  );
});

test("label overrides come from the environment with neutral fallbacks", () => {
  const labels = loadLocalLlmRuntimeConfig(process.env).targets;
  assert.equal(labels.deepseek.label, "Fixture DeepSeek Label");
  assert.equal(labels.qwen.label, "Qwen");
  assert.equal(labels.glm.label, "Fixture GLM Label");
  assert.equal(labels.nvfp4.label, "Fixture NVFP4 Label");
  assert.equal(labels.deepseek.modelId, "fixture-deepseek-model");
});

test("target validation admits only the fixed runtime enum", () => {
  assert.equal(validateLocalLlmTarget("deepseek"), "deepseek");
  assert.equal(validateLocalLlmTarget("qwen"), "qwen");
  assert.equal(validateLocalLlmTarget("glm"), "glm");
  assert.equal(validateLocalLlmTarget("nvfp4"), "nvfp4");
  for (const value of ["", "GLM", "fixture-glm-model", "deepseek; rm -rf /", null, 3]) {
    assert.throws(() => validateLocalLlmTarget(value), /target must be one of/);
  }
});

test("glm host commands pass the configured dual-node env through the env -i boundary", () => {
  const boundaryBeforeEnv = [
    "/usr/sbin/runuser",
    "-u",
    "sparkdash-test",
    "--",
  ];
  for (const command of ["start-glm", "stop-glm"]) {
    const invocation = buildHostCommandInvocation(command);
    assert.equal(invocation.file, "/usr/bin/nsenter");
    const envIndex = invocation.args.indexOf("/usr/bin/env");
    assert.ok(envIndex > 0);
    assert.deepEqual(invocation.args.slice(envIndex - 4, envIndex), boundaryBeforeEnv);
    assert.match(invocation.args.at(-1), /^cd \/opt\/sparkdash-fixtures\/glm && exec env /);
  }

  const startCommand = buildHostCommandInvocation("start-glm").args.at(-1);
  assert.match(
    startCommand,
    / env HEAD_IP=10\.0\.0\.10 WORKER_SSH=fixture-worker WORKER_IP=10\.0\.0\.11 \.\/start\.sh$/
  );

  const stopCommand = buildHostCommandInvocation("stop-glm").args.at(-1);
  assert.match(
    stopCommand,
    / env WORKER_SSH=fixture-worker CONTAINER_HEAD=fixture-head CONTAINER_WORKER=fixture-worker \.\/stop\.sh$/
  );

  assert.throws(() => buildHostCommandInvocation("start-glm-extra"), /allowlisted/);
});

test("unknown service on port 8888 is rejected without lifecycle commands", async () => {
  const { manager, commands } = makeManager({ probes: [reachable("rogue-model")] });
  await assert.rejects(
    manager.beginSwitch("qwen"),
    (error) => error?.code === "UNSAFE_STATE" && /unknown service/.test(error.message)
  );
  assert.deepEqual(commands, []);
});

test("same-target healthy switch is an idempotent no-op", async () => {
  const { manager, commands } = makeManager({ probes: [reachable(DEEPSEEK_ID)] });
  const result = await manager.beginSwitch("deepseek");
  assert.equal(result.started, false);
  assert.equal(result.status.state, "idle");
  assert.equal(result.status.current, "deepseek");
  assert.deepEqual(commands, []);
});

test("only one switch may be in flight", async () => {
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const { manager } = makeManager({
    probes: [reachable(DEEPSEEK_ID), stopped(), reachable(QWEN_ID)],
    runCommand: async () => blocker,
  });
  const first = await manager.beginSwitch("qwen");
  assert.equal(first.started, true);
  await assert.rejects(manager.beginSwitch("deepseek"), (error) => error?.code === "BUSY");
  release();
  await manager.waitForIdle();
});

test("stale status refresh cannot overwrite a switch that started during its probe", async () => {
  let resolveRefresh;
  const refreshProbe = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  let releaseCommand;
  const commandBlocker = new Promise((resolve) => {
    releaseCommand = resolve;
  });
  const laterProbes = [stopped(), stopped(), reachable(QWEN_ID)];
  let probeCalls = 0;
  const manager = new LocalLlmSwitchManager({
    probeRuntime: async () => {
      probeCalls += 1;
      if (probeCalls === 1) return refreshProbe;
      assert.ok(laterProbes.length > 0, "probe sequence exhausted");
      return laterProbes.shift();
    },
    runCommand: async () => commandBlocker,
    delay: async () => {},
  });

  const refresh = manager.getStatus();
  assert.equal(probeCalls, 1);
  const started = await manager.beginSwitch("qwen");
  assert.equal(started.status.state, "switching");

  resolveRefresh(reachable(DEEPSEEK_ID));
  const staleStatus = await refresh;
  assert.equal(staleStatus.state, "switching");
  assert.equal(staleStatus.current, "stopped");
  assert.equal((await manager.getStatus({ refresh: false })).state, "switching");

  releaseCommand();
  await manager.waitForIdle();
});

test("stale status refresh cannot overwrite a completed same-target no-op", async () => {
  let resolveRefresh;
  const refreshProbe = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  let probeCalls = 0;
  const manager = new LocalLlmSwitchManager({
    probeRuntime: async () => {
      probeCalls += 1;
      return probeCalls === 1 ? refreshProbe : reachable(DEEPSEEK_ID);
    },
    delay: async () => {},
  });

  const refresh = manager.getStatus();
  assert.equal(probeCalls, 1);
  const noOp = await manager.beginSwitch("deepseek");
  assert.equal(noOp.started, false);
  resolveRefresh(stopped());

  const staleStatus = await refresh;
  assert.equal(staleStatus.state, "idle");
  assert.equal(staleStatus.phase, "complete");
  assert.equal(staleStatus.current, "deepseek");
  assert.equal(staleStatus.health, "healthy");
  assert.equal(staleStatus.message, "Fixture DeepSeek Label is already healthy");
});

test("stop wait terminates and reports the still-running source as restored", async () => {
  let delays = 0;
  const { manager, commands } = makeManager({
    probes: [
      reachable(DEEPSEEK_ID),
      reachable(DEEPSEEK_ID),
      reachable(DEEPSEEK_ID),
      reachable(DEEPSEEK_ID),
    ],
    maxStopPolls: 2,
    delay: async () => {
      delays += 1;
    },
  });
  await manager.beginSwitch("qwen");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.deepEqual(commands, ["stop-deepseek", "stop-qwen"]);
  assert.equal(delays, 1);
  assert.equal(status.state, "error");
  assert.match(status.error, /timed out waiting for port 8888/);
  assert.equal(status.current, "deepseek");
  assert.deepEqual(status.rollback, { attempted: true, succeeded: true, error: null });
});

test("successful switch waits for the source API to stop before starting the target", async () => {
  let delays = 0;
  const { manager, commands } = makeManager({
    probes: [reachable(DEEPSEEK_ID), reachable(DEEPSEEK_ID), stopped(), reachable(QWEN_ID)],
    delay: async () => {
      delays += 1;
    },
  });
  const result = await manager.beginSwitch("qwen");
  assert.equal(result.started, true);
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.deepEqual(commands, ["stop-deepseek", "start-qwen"]);
  assert.equal(delays, 1);
  assert.equal(status.state, "idle");
  assert.equal(status.phase, "complete");
  assert.equal(status.current, "qwen");
  assert.equal(status.currentModelId, QWEN_ID);
});

test("wrong model ID after startup is failure, never success", async () => {
  const { manager } = makeManager({
    probes: [stopped(), stopped(), reachable("wrong-model"), stopped()],
  });
  await manager.beginSwitch("qwen");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.equal(status.state, "error");
  assert.match(status.error, new RegExp(`expected ${QWEN_ID}`));
  assert.equal(status.current, "stopped");
});

test("failed target startup waits for API release before restoring the known source", async () => {
  const { manager, commands } = makeManager({
    probes: [reachable(DEEPSEEK_ID), stopped(), stopped(), reachable(DEEPSEEK_ID)],
    failCommands: new Map([["start-qwen", "qwen boot failed"]]),
  });
  await manager.beginSwitch("qwen");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.deepEqual(commands, ["stop-deepseek", "start-qwen", "stop-qwen", "start-deepseek"]);
  assert.equal(status.state, "error");
  assert.equal(status.current, "deepseek");
  assert.deepEqual(status.rollback, { attempted: true, succeeded: true, error: null });
  assert.match(status.error, /qwen boot failed/);
});

test("cleanup timeout skips source restart and reports rollback failure", async () => {
  const { manager, commands } = makeManager({
    probes: [reachable(DEEPSEEK_ID), stopped(), reachable(QWEN_ID), reachable(QWEN_ID)],
    failCommands: new Map([["start-qwen", "qwen boot failed"]]),
    maxStopPolls: 2,
  });
  await manager.beginSwitch("qwen");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.deepEqual(commands, ["stop-deepseek", "start-qwen", "stop-qwen"]);
  assert.equal(status.current, "qwen");
  assert.equal(status.rollback.attempted, true);
  assert.equal(status.rollback.succeeded, false);
  assert.match(status.rollback.error, /timed out waiting for port 8888/);
  assert.equal(status.message, "Switch and rollback failed; manual recovery is required");
});

test("unknown cleanup state skips source restart and reports rollback failure", async () => {
  const { manager, commands } = makeManager({
    probes: [reachable(DEEPSEEK_ID), stopped(), reachable("rogue-model")],
    failCommands: new Map([["start-qwen", "qwen boot failed"]]),
  });
  await manager.beginSwitch("qwen");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.deepEqual(commands, ["stop-deepseek", "start-qwen", "stop-qwen"]);
  assert.equal(status.current, "unknown");
  assert.equal(status.rollback.attempted, true);
  assert.equal(status.rollback.succeeded, false);
  assert.match(status.rollback.error, /unknown or unresponsive service/);
});

test("wrong target verification remains visible when cleanup command fails", async () => {
  const wrongModelId = "rogue-target-model";
  const { manager, commands } = makeManager({
    probes: [reachable(DEEPSEEK_ID), stopped(), reachable(wrongModelId)],
    failCommands: new Map([["stop-qwen", "cleanup failed"]]),
  });
  await manager.beginSwitch("qwen");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.deepEqual(commands, ["stop-deepseek", "start-qwen", "stop-qwen"]);
  assert.equal(status.state, "error");
  assert.equal(status.current, "unknown");
  assert.equal(status.currentModelId, wrongModelId);
  assert.equal(status.rollback.succeeded, false);
  assert.match(status.rollback.error, /cleanup failed/);
});

test("failure output is preserved separately while rollback appends more logs", async () => {
  const { manager } = makeManager({
    probes: [reachable(DEEPSEEK_ID), stopped(), reachable(DEEPSEEK_ID)],
    runCommand: async (command, { onLine }) => {
      if (command === "start-qwen") {
        onLine("QWEN ROOT CAUSE: port still busy");
        throw new Error("qwen boot failed");
      }
      if (command === "start-deepseek") {
        for (let index = 0; index < 60; index += 1) onLine(`rollback line ${index}`);
      }
    },
  });
  await manager.beginSwitch("qwen");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.equal(status.state, "error");
  assert.ok(status.failureLog.some((line) => line.includes("QWEN ROOT CAUSE")));
  assert.ok(status.log.length <= 40);
});

test("rollback source verification reports the detected wrong model", async () => {
  const wrongModelId = "rollback-wrong-model";
  const { manager, commands } = makeManager({
    probes: [reachable(DEEPSEEK_ID), stopped(), stopped(), reachable(wrongModelId)],
    failCommands: new Map([["start-qwen", "qwen boot failed"]]),
  });
  await manager.beginSwitch("qwen");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.deepEqual(commands, ["stop-deepseek", "start-qwen", "stop-qwen", "start-deepseek"]);
  assert.equal(status.state, "error");
  assert.equal(status.current, "unknown");
  assert.equal(status.currentModelId, wrongModelId);
  assert.equal(status.rollback.succeeded, false);
  assert.match(status.rollback.error, /rollback verification failed/);
});

test("rollback failure is reported without hiding the original failure", async () => {
  const { manager, commands } = makeManager({
    probes: [reachable(QWEN_ID), stopped(), stopped()],
    failCommands: new Map([
      ["start-deepseek", "deepseek boot failed"],
      ["start-qwen", "qwen rollback failed"],
    ]),
  });
  await manager.beginSwitch("deepseek");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.deepEqual(commands, ["stop-qwen", "start-deepseek", "stop-deepseek", "start-qwen"]);
  assert.equal(status.state, "error");
  assert.equal(status.current, "stopped");
  assert.equal(status.rollback.attempted, true);
  assert.equal(status.rollback.succeeded, false);
  assert.match(status.rollback.error, /qwen rollback failed/);
  assert.match(status.error, /deepseek boot failed/);
});

test("qwen-to-glm switch stops qwen, starts glm, and verifies the exact GLM model ID", async () => {
  let delays = 0;
  const { manager, commands } = makeManager({
    probes: [reachable(QWEN_ID), reachable(QWEN_ID), stopped(), reachable(GLM_ID)],
    delay: async () => {
      delays += 1;
    },
  });
  const result = await manager.beginSwitch("glm");
  assert.equal(result.started, true);
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.deepEqual(commands, ["stop-qwen", "start-glm"]);
  assert.equal(delays, 1);
  assert.equal(status.state, "idle");
  assert.equal(status.phase, "complete");
  assert.equal(status.current, "glm");
  assert.equal(status.currentModelId, GLM_ID);
  assert.equal(status.message, "Fixture GLM Label is healthy");
});

test("wrong GLM model ID after startup is failure with rollback to the qwen source", async () => {
  const wrongModelId = "rogue-glm-model";
  const { manager, commands } = makeManager({
    probes: [
      reachable(QWEN_ID),
      stopped(),
      reachable(wrongModelId),
      stopped(),
      reachable(QWEN_ID),
    ],
  });
  await manager.beginSwitch("glm");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.deepEqual(commands, ["stop-qwen", "start-glm", "stop-glm", "start-qwen"]);
  assert.equal(status.state, "error");
  assert.match(status.error, new RegExp(`expected ${GLM_ID.replace("/", "\\/")}`));
  assert.deepEqual(status.rollback, { attempted: true, succeeded: true, error: null });
});

test("glm failure with rollback disabled cleans up the target without restarting qwen", async () => {
  const { manager, commands } = makeManager({
    probes: [reachable(QWEN_ID), stopped(), stopped()],
    failCommands: new Map([["start-glm", "glm boot failed"]]),
    disableRollbackTargets: new Set(["glm"]),
  });
  await manager.beginSwitch("glm");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.deepEqual(commands, ["stop-qwen", "start-glm", "stop-glm"]);
  assert.equal(commands.includes("start-qwen"), false);
  assert.equal(status.state, "error");
  assert.equal(status.phase, "error");
  assert.equal(status.current, "stopped");
  assert.deepEqual(status.rollback, null);
  assert.match(status.error, /glm boot failed/);
  assert.match(status.message, /rollback is disabled/);
});

test("starting glm from a stopped port issues no stop command", async () => {
  const { manager, commands } = makeManager({
    probes: [stopped(), stopped(), reachable(GLM_ID)],
  });
  await manager.beginSwitch("glm");
  await manager.waitForIdle();
  assert.deepEqual(commands, ["start-glm"]);
  const status = await manager.getStatus({ refresh: false });
  assert.equal(status.state, "idle");
  assert.equal(status.current, "glm");
  assert.equal(status.currentModelId, GLM_ID);
});

test("routes enforce key, enum, busy, and async/no-op response codes", async () => {
  const routes = { get: new Map(), post: new Map() };
  const app = {
    get: (path, handler) => routes.get.set(path, handler),
    post: (path, handler) => routes.post.set(path, handler),
  };
  let beginResult = { started: true, status: { state: "switching" } };
  const manager = {
    getStatus: async () => ({ state: "idle", current: "deepseek" }),
    targets: () => ({
      deepseek: { modelId: "fixture-deepseek-model", label: "Fixture DeepSeek" },
      qwen: { modelId: "fixture-qwen-model", label: "Fixture Qwen" },
      glm: { modelId: "fixture-glm-model", label: "Fixture GLM" },
    }),
    beginSwitch: async (target) => {
      if (target === "qwen" && (beginResult === "busy" || beginResult === "unsafe")) {
        const error = new Error(beginResult);
        error.code = beginResult === "busy" ? "BUSY" : "UNSAFE_STATE";
        throw error;
      }
      return beginResult;
    },
  };
  registerLocalLlmRoutes(app, { manager, keyOk: (key) => key === "valid", writesEnabled: () => true });

  function response() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
  }

  const statusRes = response();
  await routes.get.get("/api/local-llm/status")({}, statusRes);
  assert.equal(statusRes.statusCode, 200);
  assert.equal(statusRes.body.writesEnabled, true);
  assert.equal(statusRes.body.current, "deepseek");
  assert.deepEqual(statusRes.body.labels, {
    deepseek: "Fixture DeepSeek",
    qwen: "Fixture Qwen",
    glm: "Fixture GLM",
  });

  const badTarget = response();
  await routes.post.get("/api/local-llm/switch")({ body: { target: "shell", key: "valid" } }, badTarget);
  assert.equal(badTarget.statusCode, 400);

  const badKey = response();
  await routes.post.get("/api/local-llm/switch")({ body: { target: "qwen", key: "bad" } }, badKey);
  assert.equal(badKey.statusCode, 403);

  const started = response();
  await routes.post.get("/api/local-llm/switch")({ body: { target: "qwen", key: "valid" } }, started);
  assert.equal(started.statusCode, 202);

  beginResult = { started: false, status: { state: "idle", current: "qwen" } };
  const noop = response();
  await routes.post.get("/api/local-llm/switch")({ body: { target: "qwen", key: "valid" } }, noop);
  assert.equal(noop.statusCode, 200);

  beginResult = "busy";
  const busy = response();
  await routes.post.get("/api/local-llm/switch")({ body: { target: "qwen", key: "valid" } }, busy);
  assert.equal(busy.statusCode, 409);

  beginResult = "unsafe";
  const unsafe = response();
  await routes.post.get("/api/local-llm/switch")({ body: { target: "qwen", key: "valid" } }, unsafe);
  assert.equal(unsafe.statusCode, 409);
});

test("lifecycle output is bounded and redacts secret-bearing lines", async () => {
  const lines = Array.from({ length: 60 }, (_, i) =>
    i === 31 ? "Authorization: Bearer secret-value" : `safe line ${i}`
  );
  const { manager } = makeManager({
    probes: [stopped(), stopped(), reachable(QWEN_ID)],
    runCommand: async (_command, { onLine }) => lines.forEach((line) => onLine(line)),
  });
  await manager.beginSwitch("qwen");
  await manager.waitForIdle();
  const status = await manager.getStatus({ refresh: false });
  assert.ok(status.log.length <= 40);
  assert.equal(status.log.some((line) => line.includes("secret-value")), false);
});
