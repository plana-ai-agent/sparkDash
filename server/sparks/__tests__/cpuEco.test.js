import test from "node:test";
import assert from "node:assert/strict";
import {
  CPU_ECO_LEVELS,
  cpuEcoKeyOk,
  formatCpuStatus,
  getCpuEcoKey,
} from "../../cpuEco.js";

test("CPU_ECO_LEVELS maps cap levels to kHz max_perf values", () => {
  assert.deepEqual(CPU_ECO_LEVELS, {
    2500: "2500000",
    2250: "2250000",
    2000: "2000000",
    1750: "1750000",
    1500: "1500000",
  });
});

test("cpuEcoKeyOk mirrors the shared ECO key rules", () => {
  process.env.SPARKDASH_ECO_KEY = "s3cret";
  try {
    assert.equal(cpuEcoKeyOk("s3cret"), true);
    assert.equal(cpuEcoKeyOk("wrong"), false);
    assert.equal(cpuEcoKeyOk("s3cret "), false);
    assert.equal(cpuEcoKeyOk(""), false);
    assert.equal(cpuEcoKeyOk(null), false);
    assert.equal(cpuEcoKeyOk(undefined), false);
  } finally {
    delete process.env.SPARKDASH_ECO_KEY;
  }
});

test("cpuEcoKeyOk is false when no key is configured", () => {
  delete process.env.SPARKDASH_ECO_KEY;
  assert.equal(cpuEcoKeyOk("anything"), false);
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
});

test("getCpuEcoKey falls back to ECO_KEY_PATH file", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  delete process.env.SPARKDASH_ECO_KEY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-eco-"));
  const keyPath = path.join(dir, "eco_key.txt");
  fs.writeFileSync(keyPath, "  file-key  \n");
  process.env.ECO_KEY_PATH = keyPath;
  try {
    const mod = await import(`../../cpuEco.js?filekey=${Date.now()}`);
    assert.equal(mod.getCpuEcoKey(), "file-key");
    assert.equal(mod.cpuEcoKeyOk("file-key"), true);
  } finally {
    delete process.env.ECO_KEY_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
