import fs from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_PATH = fileURLToPath(new URL("../config/local-llm.json", import.meta.url));
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Local LLM configuration: ${message}`);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function duration(value, fallback, name) {
  const milliseconds = value ?? fallback;
  requireValue(Number.isInteger(milliseconds) && milliseconds >= 1000 && milliseconds <= 7_200_000,
    `${name} must be between 1000 and 7200000 milliseconds`);
  return milliseconds;
}

/** Deployment-owned commands are never accepted from HTTP requests. */
export function normalizeRuntimeConfig(input) {
  requireValue(object(input) && input.version === 2,
    "use version 2 with nodes and runtimes (see config/local-llm.example.json)");
  requireValue(object(input.nodes) && Object.keys(input.nodes).length === 2, "configure exactly two nodes");
  const nodes = {};
  for (const [id, entry] of Object.entries(input.nodes)) {
    requireValue(identifier.test(id) && object(entry), `invalid node ${id}`);
    const hostUser = entry.hostUser ?? input.hostUser;
    const hostHome = entry.hostHome ?? input.hostHome;
    const port = entry.port ?? 8888;
    requireValue(typeof hostUser === "string" && /^[a-z_][a-z0-9_-]*[$]?$/i.test(hostUser), `${id}: invalid hostUser`);
    requireValue(typeof hostHome === "string" && hostHome.startsWith("/") && !/[\r\n\0]/.test(hostHome), `${id}: invalid hostHome`);
    requireValue(Number.isInteger(port) && port > 0 && port <= 65535, `${id}: invalid port`);
    nodes[id] = Object.freeze({ id, hostUser, hostHome, port });
  }
  requireValue(object(input.runtimes) && Object.keys(input.runtimes).length > 0, "configure at least one runtime");
  const runtimes = {};
  const containers = new Set();
  const modelIds = new Set();
  const disabledRollback = new Set(String(process.env.LOCAL_LLM_DISABLE_ROLLBACK_TARGETS ?? "").split(",").map((s) => s.trim()));
  for (const [id, entry] of Object.entries(input.runtimes)) {
    requireValue(identifier.test(id) && object(entry), `invalid runtime ${id}`);
    requireValue(Object.hasOwn(nodes, entry.apiNode), `${id}: apiNode must be a configured node`);
    requireValue(object(entry.containers), `${id}: containers must map nodes to container names`);
    const nodeIds = Object.keys(entry.containers);
    requireValue(nodeIds.length >= 1 && nodeIds.length <= 2 && nodeIds.includes(entry.apiNode), `${id}: invalid members`);
    for (const [nodeId, name] of Object.entries(entry.containers)) {
      requireValue(Object.hasOwn(nodes, nodeId) && typeof name === "string" && identifier.test(name), `${id}: invalid container`);
      const key = `${nodeId}/${name}`;
      requireValue(!containers.has(key), `container ${key} is assigned to multiple runtimes`);
      containers.add(key);
    }
    for (const field of ["label", "modelId", "start", "stop"]) {
      requireValue(typeof entry[field] === "string" && entry[field].trim(), `${id}: ${field} is required`);
    }
    requireValue(entry.preflight === undefined || (typeof entry.preflight === "string" && entry.preflight.trim()), `${id}: invalid preflight`);
    requireValue(entry.rollback === undefined || typeof entry.rollback === "boolean", `${id}: rollback must be a boolean`);
    requireValue(entry.disabledReason === undefined || (typeof entry.disabledReason === "string" && entry.disabledReason.trim()), `${id}: invalid disabledReason`);
    const modelKey = `${entry.apiNode}/${entry.modelId}`;
    requireValue(!modelIds.has(modelKey), `${id}: modelId is ambiguous on this node`);
    modelIds.add(modelKey);
    runtimes[id] = Object.freeze({
      id, label: entry.label, modelId: entry.modelId, apiNode: entry.apiNode,
      nodeIds: Object.freeze(nodeIds), mode: nodeIds.length === 2 ? "linked" : "independent",
      containers: Object.freeze({ ...entry.containers }), start: entry.start, stop: entry.stop,
      preflight: entry.preflight || "true",
      startupTimeoutMs: duration(entry.startupTimeoutMs, 1_800_000, `${id}.startupTimeoutMs`),
      stopTimeoutMs: duration(entry.stopTimeoutMs, 90_000, `${id}.stopTimeoutMs`),
      rollback: entry.rollback !== false && !disabledRollback.has(id),
      disabledReason: entry.disabledReason || null,
    });
  }
  return Object.freeze({ nodes: Object.freeze(nodes), runtimes: Object.freeze(runtimes) });
}

export function loadLocalLlmRuntimeConfig(filePath = process.env.LOCAL_LLM_CONFIG_PATH || DEFAULT_PATH) {
  try {
    return normalizeRuntimeConfig(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Local LLM switching is not configured; create config/local-llm.json");
    throw error;
  }
}

let cached;
export function getRuntimeConfig() {
  return cached ??= loadLocalLlmRuntimeConfig();
}

export function publicRuntimeConfig(config, getSpark) {
  return {
    nodes: Object.values(config.nodes).map(({ id, port }) => ({ id, port, name: getSpark(id)?.name || id })),
    runtimes: Object.values(config.runtimes).map(({ id, label, modelId, nodeIds, apiNode, mode, disabledReason }) =>
      ({ id, label, modelId, nodeIds, apiNode, mode, disabledReason })),
  };
}
