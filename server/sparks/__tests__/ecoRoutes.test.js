import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eco-routes-"));
process.env.SETTINGS_JSON_PATH = path.join(directory, "settings.json");
process.env.SPARKDASH_ECO_KEY = "fixture-key";
const { registerEcoRoutes } = await import("../../ecoRoutes.js");
const { loadSettings, getSettings, updateSettings } = await import("../../settings.js");
loadSettings();
after(() => fs.rmSync(directory, { recursive: true, force: true }));

function setup(apply = async () => "ok", read = async () => ({ a: "telemetry", b: "no reply" })) {
  const routes = new Map();
  const app = {
    get: (url, handler) => routes.set(`GET ${url}`, handler),
    post: (url, handler) => routes.set(`POST ${url}`, handler),
  };
  const sparks = [{ id: "a" }, { id: "b" }];
  registerEcoRoutes(app, { sparks, getSpark: (id) => sparks.find((spark) => spark.id === id) }, [
    { path: "eco", label: "ECO", levels: { 2200: "0,2200" }, setting: "ecoLevels", response: "eco_levels", apply, read },
    { path: "cpu-eco", label: "CPU ECO", levels: { 2000: "2000000" }, setting: "cpuEcoLevels", response: "cpu_eco_levels", apply, read },
  ]);
  return async (route, body) => {
    const response = {
      code: 200, body: null,
      status(code) { this.code = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await routes.get(route)({ body }, response);
    return response;
  };
}

for (const [url, level, setting, field] of [
  ["eco", "2200", "ecoLevels", "eco_levels"],
  ["cpu-eco", "2000", "cpuEcoLevels", "cpu_eco_levels"],
]) {
  test(`${url}: rejects invalid keys, levels and targets before executing a command`, async () => {
    let calls = 0;
    const request = setup(async () => { calls++; return "ok"; });
    for (const [body, expected] of [
      [{ node: "a", level }, 403],
      [{ key: "wrong", node: "a", level }, 403],
      [{ key: "fixture-key", node: "a", level: "constructor" }, 400],
      [{ key: "fixture-key", node: "missing", level }, 400],
      [{ key: "fixture-key", node: "", level }, 400],
    ]) assert.equal((await request(`POST /api/${url}/set`, body)).code, expected);
    assert.equal(calls, 0);
  });

  test(`${url}: persists only successful fleet changes and exposes the existing status contract`, async () => {
    updateSettings({ [setting]: { a: "off", b: "off" } });
    const request = setup(async (spark) => spark.id === "a" ? "ok" : "command failed");
    const applied = await request(`POST /api/${url}/set`, { key: "fixture-key", node: "fleet", level });
    assert.equal(applied.code, 200);
    assert.deepEqual(applied.body, { ok: true, applied: level, nodes: { a: "ok", b: "command failed" } });
    assert.deepEqual(getSettings()[setting], { a: level, b: "off" });
    assert.deepEqual(JSON.parse(fs.readFileSync(process.env.SETTINGS_JSON_PATH))[setting], { a: level, b: "off" });
    const status = await request(`GET /api/${url}/status`);
    assert.deepEqual(status.body, { writes_enabled: true, nodes: { a: "telemetry", b: "no reply" }, [field]: { a: level, b: "off" } });
  });

  test(`${url}: concurrent requests on different nodes preserve both saved results`, async () => {
    updateSettings({ [setting]: {} });
    let finishA;
    const request = setup((spark) => spark.id === "a" ? new Promise((resolve) => { finishA = resolve; }) : "ok");
    const first = request(`POST /api/${url}/set`, { key: "fixture-key", node: "a", level });
    await request(`POST /api/${url}/set`, { key: "fixture-key", node: "b", level: "off" });
    finishA("ok");
    await first;
    assert.deepEqual(getSettings()[setting], { a: level, b: "off" });
  });
}

test("status failures return JSON errors", async () => {
  const request = setup(undefined, async () => { throw new Error("probe failed"); });
  const response = await request("GET /api/eco/status");
  assert.equal(response.code, 500);
  assert.deepEqual(response.body, { error: "probe failed" });
});
