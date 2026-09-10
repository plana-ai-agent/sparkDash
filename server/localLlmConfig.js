import fs from "fs";
import { fileURLToPath } from "url";

const LOCAL_LLM_CONFIG_FILENAME = fileURLToPath(new URL("../config/local-llm.json", import.meta.url));

/** Config path resolved at call time so tests can redirect it via env. */
function defaultConfigPath() {
  return process.env.LOCAL_LLM_CONFIG_PATH || LOCAL_LLM_CONFIG_FILENAME;
}

/**
 * Deployment-private Local LLM runtime config (model IDs, display labels, the
 * host lifecycle commands, the host user/path) lives in config/local-llm.json
 * (gitignored) — never in source. Only the structural runtime keys
 * ("deepseek" | "qwen" | "glm") are fixed here, so the API contract and the
 * tests stay independent of any deployment.
 *
 * LOCAL_LLM_* env vars remain as a deprecated fallback: values present in the
 * environment still load (file > env per key), so existing deployments keep
 * working and can migrate gradually.
 */
export const TARGET_KEYS = Object.freeze(["deepseek", "qwen", "glm"]);

// Neutral fallbacks derived from the structural runtime keys. Deployment
// profiles override these via each target's "label" in config/local-llm.json.
const TARGET_LABEL_FALLBACKS = Object.freeze({
  deepseek: "DeepSeek",
  qwen: "Qwen",
  glm: "GLM",
});

function readJsonConfigFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `config/local-llm.json is not valid JSON (${error.message}); fix or remove the file (see config/local-llm.example.json)`
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("config/local-llm.json must contain a JSON object");
  }
  return data;
}

/** JSON values take precedence; deprecated env vars fill omitted fields. */
function readTarget(fileData, env, key, missing) {
  const upper = key.toUpperCase();
  const rawFile = fileData?.[key];
  const hasFileEntry = typeof rawFile === "object" && rawFile !== null;
  const rawEnv = env[`LOCAL_LLM_MODEL_${upper}`];
  const envOnly = !hasFileEntry && rawEnv !== undefined;

  const value = (name, envPrefix, fallback) => {
    const text = String(rawFile?.[name] ?? env[`${envPrefix}_${upper}`] ?? "").trim();
    if (!text && fallback === undefined) missing.push(`${key}.${name}`);
    return text || fallback || "";
  };
  const target = {
    modelId: value("modelId", "LOCAL_LLM_MODEL"),
    label: value("label", "LOCAL_LLM_LABEL", TARGET_LABEL_FALLBACKS[key]),
    start: value("start", "LOCAL_LLM_CMD_START"),
    stop: value("stop", "LOCAL_LLM_CMD_STOP"),
  };
  // Warn once per key when a target is configured only through deprecated
  // LOCAL_LLM_* env vars — the deployment should move into the JSON file.
  if (envOnly && missing.length === 0) {
    console.warn(
      `[localLlmConfig] ${key}: LOCAL_LLM_* env vars are deprecated; move this target into ${defaultConfigPath()} (see config/local-llm.example.json)`
    );
  }
  return target;
}

export function loadLocalLlmRuntimeConfig(env = process.env) {
  const fileData = readJsonConfigFile(defaultConfigPath());
  const missing = [];
  const unknownKeys = Object.keys(fileData ?? {}).filter(
    (key) => key !== "hostUser" && key !== "hostHome" && !TARGET_KEYS.includes(key)
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `config/local-llm.json has unknown keys: ${unknownKeys.join(", ")} (expected: ${TARGET_KEYS.join(", ")})`
    );
  }
  const targets = {};
  const hostCommands = {};
  for (const key of TARGET_KEYS) {
    targets[key] = Object.freeze(readTarget(fileData, env, key, missing));
    hostCommands[`stop-${key}`] = targets[key].stop;
    hostCommands[`start-${key}`] = targets[key].start;
  }
  const readEnv = (name) => {
    const value = String(env[name] ?? "").trim();
    if (!value) missing.push(name);
    return value;
  };
  const hostUser =
    String(fileData?.hostUser ?? "").trim() || readEnv("LOCAL_LLM_HOST_USER");
  const hostHome =
    String(fileData?.hostHome ?? "").trim() || readEnv("LOCAL_LLM_HOST_HOME");
  if (missing.length > 0) {
    throw new Error(
      `Local LLM runtime switching is not configured; set ${missing.join(", ")} in config/local-llm.json (see config/local-llm.example.json)`
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

export function getRuntimeConfig() {
  if (!runtimeConfigCache) {
    // Retried on every call until it succeeds, so the dashboard keeps running
    // (with an unconfigured Local LLM panel) while the config is still missing.
    runtimeConfigCache = loadLocalLlmRuntimeConfig();
  }
  return runtimeConfigCache;
}
