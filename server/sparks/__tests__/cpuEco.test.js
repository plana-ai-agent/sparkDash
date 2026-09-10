import test, { after } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-eco-settings-"));
process.env.SETTINGS_JSON_PATH = path.join(directory, "settings.json");
const {
  CPU_ECO_LEVELS,
  cpuEcoSet,
  cpuEcoStatus,
  getStockSnapshot,
  formatCpuStatus,
} = await import("../../cpuEco.js");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("CPU_ECO_LEVELS maps cap levels to kHz max_perf values", () => {
  assert.deepEqual(CPU_ECO_LEVELS, {
    2500: "2500000",
    2250: "2250000",
    2000: "2000000",
    1750: "1750000",
    1500: "1500000",
  });
});

test("formatCpuStatus renders a single applied value plus hottest temp", () => {
  const raw = "2000000\n2000000\n---\n74100\n68500";
  assert.equal(formatCpuStatus(raw), "2 GHz · 74.1°C");
});

test("formatCpuStatus collapses mixed cluster values into a count", () => {
  const raw = "2808000\n3900000\n---\n80500";
  assert.equal(formatCpuStatus(raw), "2 values · 80.5°C");
});

test("formatCpuStatus tolerates missing temperature tail", () => {
  assert.equal(formatCpuStatus("2000000\n---"), "2 GHz · n/a");
});

test("isPlausibleStock rejects poisoned (clamped) snapshots", async () => {
  const { isPlausibleStock } = await import(`../../cpuEco.js?plausible=${Date.now()}`);
  const stock = { max_perf_khz: { cpu0: 2808000, cpu1: 3900000 } };
  const poisoned = { max_perf_khz: { cpu0: 1976000, cpu1: 1976000 } };
  const empty = { max_perf_khz: {} };
  assert.equal(isPlausibleStock(stock), true);
  assert.equal(isPlausibleStock(poisoned), false);
  assert.equal(isPlausibleStock(empty), false);
  assert.equal(isPlausibleStock(null), false);
  for (const values of [[3900000], { cpu0: "3900000" }, { cpu0: Infinity }, { "../../other": 3900000 }]) {
    assert.equal(isPlausibleStock({ max_perf_khz: values }), false);
  }
});

test("CPU cap saves stock values before applying and off restores the same per-CPU snapshot", async (t) => {
  const stock = { max_perf_khz: { cpu0: 2808000, cpu1: 3900000 } };
  const scripts = [];
  t.mock.method(childProcess, "execFile", (file, args, _options, callback) => {
    assert.equal(file, "nsenter");
    const script = args.at(-1);
    scripts.push(script);
    if (script.includes("import glob,json,os")) callback(null, JSON.stringify(stock), "");
    else {
      assert.deepEqual(getStockSnapshot("fixture"), stock, "stock is saved before touching clocks");
      callback(null, "2000000", "");
    }
  });
  const spark = { id: "fixture", isLocal: true };
  assert.equal(await cpuEcoSet(spark, "2000"), "ok");
  assert.equal(await cpuEcoSet(spark, "off"), "ok");
  assert.equal(scripts.length, 3, "off uses the saved snapshot instead of sampling capped clocks");
  assert.match(scripts[1], /echo 2000000/);
  const encoded = scripts[2].match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64")), stock);
});

test("CPU cap refuses an already-clamped snapshot without issuing any write", async (t) => {
  let calls = 0;
  t.mock.method(childProcess, "execFile", (_file, args, _options, callback) => {
    calls++;
    assert.match(args.at(-1), /import glob,json,os/);
    callback(null, JSON.stringify({ max_perf_khz: { cpu0: 2000000 } }), "");
  });
  const result = await cpuEcoSet({ id: "clamped", isLocal: true }, "2000");
  assert.match(result, /refusing to snapshot/);
  assert.equal(calls, 1);
  assert.equal(getStockSnapshot("clamped"), null);
});

test("remote CPU commands preserve shell quoting for status, snapshot, cap and restore", async (t) => {
  const stock = { max_perf_khz: { cpu0: 2808000, cpu1: 3900000 } };
  const commands = [];
  const mocked = t.mock.method(childProcess, "execFile", (file, args, _options, callback) => {
    assert.equal(file, "ssh");
    const command = args.at(-1);
    if (command === "true") return callback(null, "", "");
    // Parse the shell wrapper without executing sudo, SSH or sysfs writes.
    const argv = JSON.parse(childProcess.execFileSync("python3", ["-c",
      "import shlex,json,sys; print(json.dumps(shlex.split(sys.argv[1])))", command], { encoding: "utf8" }));
    commands.push(argv);
    const script = argv.at(-1);
    callback(null, script.includes("import glob,json,os") ? JSON.stringify(stock) : "2000000\n---\n74100", "");
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const spark = { id: "remote-fixture", isLocal: false, ssh: { host: "192.168.1.10", user: "fixture", auth: "key" } };
  assert.deepEqual(await cpuEcoStatus([spark]), { "remote-fixture": "2 GHz · 74.1°C" });
  assert.equal(await cpuEcoSet(spark, "2000"), "ok");
  assert.equal(await cpuEcoSet(spark, "off"), "ok");
  assert.equal(commands.length, 4);
  assert.deepEqual(commands[0].slice(0, -1), ["sh", "-c"]);
  assert.deepEqual(commands[1].slice(0, -1), ["sh", "-c"]);
  assert.deepEqual(commands[2].slice(0, -1), ["sudo", "-n", "sh", "-c"]);
  assert.match(commands[2].at(-1), /echo 2000000/);
  assert.deepEqual(commands[3].slice(0, -1), ["sudo", "-n", "sh", "-c"]);
  const encoded = commands[3].at(-1).match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64")), stock);
});
