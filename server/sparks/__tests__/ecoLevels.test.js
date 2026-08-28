import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Persisted ECO levels live in settings.json under `ecoLevels`
 * (sparkId → "off" | level). The /api/eco/status endpoint surfaces it as
 * `eco_levels` so the UI can restore the selection after a reload, and
 * /api/eco/set updates it only for sparks whose clock set succeeded.
 */

function withSettingsFile(file, fn) {
  process.env.SETTINGS_JSON_PATH = file;
  return Promise.resolve()
    .then(async () => {
      const mod = await import(`../../settings.js?eco=${Date.now()}-${Math.random()}`);
      await fn(mod);
    })
    .finally(() => {
      delete process.env.SETTINGS_JSON_PATH;
    });
}

test("loadSettings defaults ecoLevels to an empty object", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-settings-"));
  const file = path.join(dir, "settings.json");
  return withSettingsFile(file, async (mod) => {
    const s = mod.loadSettings();
    assert.deepEqual(s.ecoLevels, {});
    // Missing settings.json must have been created with defaults.
    assert.ok(fs.existsSync(file));
  }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test("loadSettings clamps a malformed ecoLevels to {} without losing other settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-settings-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ density: "comfortable", ecoLevels: "banana" }));
  return withSettingsFile(file, async (mod) => {
    const s = mod.loadSettings();
    assert.deepEqual(s.ecoLevels, {});
    assert.equal(s.density, "comfortable");
  }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test("loadSettings keeps a valid persisted ecoLevels map", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-settings-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ ecoLevels: { "dgx-spark-1": "2200" } }));
  return withSettingsFile(file, async (mod) => {
    const s = mod.loadSettings();
    assert.deepEqual(s.ecoLevels, { "dgx-spark-1": "2200" });
  }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test("updateSettings persists ecoLevels to disk and back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-settings-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ pollIntervalMs: 3000 }));
  return withSettingsFile(file, async (mod) => {
    mod.loadSettings(); // index.js calls this at boot; seed in-memory state
    const s = mod.updateSettings({ ecoLevels: { "spark-a": "2000", "spark-b": "off" } });
    assert.deepEqual(s.ecoLevels, { "spark-a": "2000", "spark-b": "off" });
    // On-disk file must contain the map (this is what survives a container
    // restart / browser reload).
    const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.deepEqual(onDisk.ecoLevels, { "spark-a": "2000", "spark-b": "off" });
    assert.equal(onDisk.pollIntervalMs, 3000);
  }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test("updateSettings replaces rather than merges ecoLevels (full-map patch)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-settings-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ ecoLevels: { "spark-a": "2200", "spark-b": "off" } }));
  return withSettingsFile(file, async (mod) => {
    mod.loadSettings();
    const s = mod.updateSettings({ ecoLevels: { "spark-b": "off" } });
    // The endpoint sends the full recomputed map, so a removed spark must
    // disappear — not linger from the previous save.
    assert.deepEqual(s.ecoLevels, { "spark-b": "off" });
  }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
});
