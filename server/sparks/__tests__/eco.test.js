import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  ECO_LEVELS,
  ecoKeyOk,
  ecoLevelArg,
  ecoRemoteCommand,
  ecoSet,
  ecoStatus,
  getEcoKey,
} from "../../eco.js";

test("ECO_LEVELS maps cap levels to -lgc clamps", () => {
  assert.deepEqual(ECO_LEVELS, {
    2300: "0,2300",
    2200: "0,2200",
    2000: "0,2000",
    1800: "0,1800",
  });
});

test("ecoKeyOk compares against SPARKDASH_ECO_KEY", () => {
  process.env.SPARKDASH_ECO_KEY = "s3cret";
  try {
    assert.equal(ecoKeyOk("s3cret"), true);
    assert.equal(ecoKeyOk("wrong"), false);
    assert.equal(ecoKeyOk("s3cret "), false);
    assert.equal(ecoKeyOk(""), false);
    assert.equal(ecoKeyOk(null), false);
    assert.equal(ecoKeyOk(undefined), false);
    assert.equal(ecoKeyOk(42), false);
  } finally {
    delete process.env.SPARKDASH_ECO_KEY;
  }
});

test("ecoKeyOk is false when no key is configured", async () => {
  delete process.env.SPARKDASH_ECO_KEY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eco-test-"));
  process.env.ECO_KEY_PATH = path.join(dir, "missing.txt");
  try {
    const mod = await import(`../../eco.js?nokey=${Date.now()}`);
    assert.equal(mod.getEcoKey(), null);
    assert.equal(mod.ecoKeyOk("anything"), false);
  } finally {
    delete process.env.ECO_KEY_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getEcoKey reads trimmed config/eco_key.txt via ECO_KEY_PATH", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eco-test-"));
  const keyPath = path.join(dir, "eco_key.txt");
  fs.writeFileSync(keyPath, "  file-key  \n");
  process.env.ECO_KEY_PATH = keyPath;
  try {
    const mod = await import(`../../eco.js?file=${Date.now()}`);
    assert.equal(mod.getEcoKey(), "file-key");
  } finally {
    delete process.env.ECO_KEY_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getEcoKey returns null for an empty or missing key file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eco-test-"));
  const keyPath = path.join(dir, "eco_key.txt");
  fs.writeFileSync(keyPath, "   \n");
  process.env.ECO_KEY_PATH = keyPath;
  try {
    const mod = await import(`../../eco.js?empty=${Date.now()}`);
    assert.equal(mod.getEcoKey(), null);
    process.env.ECO_KEY_PATH = path.join(dir, "missing.txt");
    const mod2 = await import(`../../eco.js?missing=${Date.now()}`);
    assert.equal(mod2.getEcoKey(), null);
  } finally {
    delete process.env.ECO_KEY_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SPARKDASH_ECO_KEY wins over the key file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eco-test-"));
  fs.writeFileSync(path.join(dir, "eco_key.txt"), "file-key");
  process.env.ECO_KEY_PATH = path.join(dir, "eco_key.txt");
  process.env.SPARKDASH_ECO_KEY = "env-key";
  try {
    const mod = await import(`../../eco.js?precedence=${Date.now()}`);
    assert.equal(mod.getEcoKey(), "env-key");
    assert.equal(mod.ecoKeyOk("env-key"), true);
    assert.equal(mod.ecoKeyOk("file-key"), false);
  } finally {
    delete process.env.SPARKDASH_ECO_KEY;
    delete process.env.ECO_KEY_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ecoLevelArg builds -lgc / -rgc argv", () => {
  assert.deepEqual(ecoLevelArg("2300"), ["-lgc", "0,2300"]);
  assert.deepEqual(ecoLevelArg("2200"), ["-lgc", "0,2200"]);
  assert.deepEqual(ecoLevelArg("2000"), ["-lgc", "0,2000"]);
  assert.deepEqual(ecoLevelArg("1800"), ["-lgc", "0,1800"]);
  assert.deepEqual(ecoLevelArg("off"), ["-rgc"]);
});

test("ecoLevelArg rejects unknown levels", () => {
  for (const bad of ["1500", "3000", "banana", "", null, undefined]) {
    assert.equal(ecoLevelArg(bad), null, `level=${String(bad)}`);
  }
});

test("ecoRemoteCommand wraps the level in sudo nvidia-smi", () => {
  assert.equal(ecoRemoteCommand("2300"), "sudo nvidia-smi -lgc 0,2300");
  assert.equal(ecoRemoteCommand("off"), "sudo nvidia-smi -rgc");
  assert.equal(ecoRemoteCommand("1500"), null);
});

test("ecoSet returns error text for an invalid level without running anything", async () => {
  assert.equal(await ecoSet({ id: "s1", isLocal: true }, "1500"), "invalid level");
  assert.equal(await ecoSet({ id: "s1", isLocal: false }, "nope"), "invalid level");
});

test("ecoSet retries a failed local clock set via sudo -n", async () => {
  // eco.js reads execFile off the CJS exports at call time, so patching the
  // exports object intercepts the statically imported module.
  const require = createRequire(import.meta.url);
  const cp = require("child_process");
  const originalExecFile = cp.execFile;
  const calls = [];
  cp.execFile = (file, args, opts, cb) => {
    calls.push({ file, args });
    if (calls.length === 1) {
      const err = new Error("The current user does not have permission to change clocks");
      cb(err, "", err.message);
    } else {
      cb(null, "", "");
    }
  };
  try {
    assert.equal(await ecoSet({ id: "s1", isLocal: true }, "2300"), "ok");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].file, "/usr/bin/nvidia-smi");
    assert.deepEqual(calls[0].args, ["-lgc", "0,2300"]);
    assert.equal(calls[1].file, "sudo");
    assert.deepEqual(calls[1].args, ["-n", "/usr/bin/nvidia-smi", "-lgc", "0,2300"]);
  } finally {
    cp.execFile = originalExecFile;
  }
});

test("ecoSet surfaces SSH errors as error text, never throws", async () => {
  const spark = { id: "s1", isLocal: false, lanIp: "", ssh: { host: "", user: "" } };
  const out = await ecoSet(spark, "2300");
  assert.notEqual(out, "ok");
  assert.ok(out.length > 0);
});

test("ecoStatus reports 'no reply' for unreachable Sparks", async () => {
  const out = await ecoStatus([
    { id: "remote1", isLocal: false, lanIp: "", ssh: { host: "", user: "" } },
  ]);
  assert.equal(out.remote1, "no reply");
});

test("ecoStatus reads local nvidia-smi or reports no reply", async () => {
  const out = await ecoStatus([{ id: "local1", isLocal: true }]);
  // On a node with nvidia-smi this is the live "clock, temp, power" CSV line;
  // elsewhere (CI image without the mount) it must degrade to "no reply".
  assert.ok(
    out.local1 === "no reply" || (typeof out.local1 === "string" && out.local1.length > 0)
  );
});
