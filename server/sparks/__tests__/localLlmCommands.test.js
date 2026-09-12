import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import test from "node:test";
import { buildHostCommandInvocation, probeRuntimeEndpoint, runHostProcess, safeLogLine, streamLines } from "../../localLlmCommands.js";
import { createOperationStore } from "../../localLlmState.js";

const node = { id: "fixture", hostUser: "fixture", hostHome: "/home/fixture", port: 8888 };

test("local lifecycle runs in host namespaces as the configured user with a host-side lock and timeout", () => {
  const result = buildHostCommandInvocation({ isLocal: true }, node, "exec /opt/models/start.sh", { timeoutMs: 1001 });
  assert.equal(result.file, "/usr/bin/nsenter");
  assert.deepEqual(result.args.slice(0, 12), ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "/usr/sbin/runuser", "-u", "fixture", "--"]);
  assert.ok(result.args.includes("/usr/bin/flock"));
  assert.ok(result.args.includes("-o"));
  assert.ok(result.args.includes("2s"));
  assert.ok(result.args.includes("-i"));
  assert.equal(result.args.at(-1), "exec /opt/models/start.sh");
});

test("worker lifecycle uses the registered SSH target and quotes the configured shell command once", () => {
  const command = "cd '/opt/model space' && exec ./start.sh --name \"$(literal)\"";
  const result = buildHostCommandInvocation({ id: "fixture", isLocal: false, lanIp: "192.168.10.20", ssh: { user: "fixture", auth: "key" } }, node, command, { timeoutMs: 1000 });
  assert.equal(result.file, "ssh");
  assert.ok(result.args.includes("fixture@192.168.10.20"));
  assert.match(result.args.at(-1), /'\/bin\/bash' '--noprofile' '--norc' '-c'/);
  assert.ok(result.args.at(-1).includes("'\\''/opt/model space'\\''"));
  assert.equal(result.args.some((arg) => arg.includes("ControlMaster=auto")), false);
  assert.throws(() => buildHostCommandInvocation({ ssh: { user: "different" } }, node, "true", { timeoutMs: 1000 }), /differ/);
});

test("endpoint inspection treats only connection refusal as stopped and includes node-specific API authentication", async () => {
  let observed;
  const spark = { isLocal: false, lanIp: "192.168.10.20", llmApiKeys: { 8888: "fixture-secret" } };
  const result = await probeRuntimeEndpoint(spark, node, async (url, options) => {
    observed = { url, options }; return { ok: true, json: async () => ({ data: [{ id: "fixture-model" }] }) };
  });
  assert.deepEqual(result, { reachable: true, modelId: "fixture-model" });
  assert.equal(observed.url, "http://192.168.10.20:8888/v1/models");
  assert.equal(observed.options.headers.Authorization, "Bearer fixture-secret");
  for (const code of ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"]) {
    const response = await probeRuntimeEndpoint(spark, node, async () => { throw { cause: { code } }; });
    assert.equal(response.reachable, code !== "ECONNREFUSED");
  }
  for (const response of [{ ok: false }, { ok: true, json: async () => ({ data: [{ id: "one" }, { id: "two" }] }) }])
    assert.deepEqual(await probeRuntimeEndpoint(spark, node, async () => response), { reachable: true, modelId: null });
});

test("process runner returns bounded stdout, redacts logs, and classifies uncertain SSH failures", async () => {
  for (const code of [0, 75, 124, 255]) {
    const lines = [];
    const spawnImpl = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end("fixture-container\n");
        child.stderr.end("Authorization: Bearer fixture-secret\n");
        setImmediate(() => child.emit("close", code, null));
      });
      return child;
    };
    const promise = runHostProcess({ file: "fixture", args: [] }, { timeoutMs: 1000, onLine: (line) => lines.push(line), spawnImpl });
    if (code === 0) assert.equal(await promise, "fixture-container");
    else await assert.rejects(promise, (error) => error.uncertain === (code === 255) && (code !== 75 || error.code === "BUSY"));
    assert.equal(lines.some((line) => line.includes("fixture-secret")), false);
  }
});

test("streaming logs handle split CRLF, long lines and secret-bearing output", async () => {
  const stream = new PassThrough(); const lines = [];
  streamLines(stream, (line) => lines.push(line));
  stream.write("first\r"); stream.write("\nsecond\rthird\n"); stream.write("x".repeat(900)); stream.end("tail\nlast");
  await new Promise((resolve) => stream.on("end", resolve));
  assert.deepEqual(lines, ["first", "second", "third", "[redacted overlong output]", "last"]);
  assert.equal(safeLogLine("HF_TOKEN=fixture"), "[redacted secret-bearing output]");
  assert.equal(safeLogLine("\x1b[31mready\x1b[0m"), "ready");
});

test("operation ownership survives store recreation, is exclusive, and cannot be released by another owner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-operation-"));
  try {
    const file = path.join(dir, "operation.json"); const store = createOperationStore(file);
    const record = store.acquire({ mode: "linked", runtime: "fixture" });
    const recreated = createOperationStore(file);
    assert.deepEqual(recreated.read(), record);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => recreated.acquire({}), (error) => error.code === "BUSY");
    assert.throws(() => recreated.release({ id: "someone-else" }), /ownership changed/);
    assert.equal(recreated.ownerAlive(record), true);
    recreated.release(record);
    assert.equal(store.read(), null);
    for (const invalid of ["{truncated", "null", "{}", '{"id":"x","pid":0}']) {
      fs.writeFileSync(file, invalid);
      assert.throws(() => store.read(), /unfinished runtime operation/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
