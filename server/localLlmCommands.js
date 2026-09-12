import { spawn } from "node:child_process";
import { sshCommandSpec } from "./collectors/ssh.js";
import { llmProbeHost } from "./collectors/llmHost.js";

export const LOG_LINE_LIMIT = 500;

export function safeLogLine(raw) {
  const line = String(raw ?? "").replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*[@-~])/g, "").trim();
  if (!line) return null;
  if (/(authorization|bearer|api[_ -]?key|hf[_ -]?token|token=)/i.test(line)) return "[redacted secret-bearing output]";
  return line.slice(0, LOG_LINE_LIMIT);
}

function quote(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }

export function buildHostCommandInvocation(spark, node, command, { timeoutMs, lock = true }) {
  const pathEnv = `${node.hostHome}/.local/bin:/usr/local/cuda/bin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin`;
  const args = ["/usr/bin/env", "-i", `HOME=${node.hostHome}`, `USER=${node.hostUser}`,
    `LOGNAME=${node.hostUser}`, "SHELL=/bin/bash", `PATH=${pathEnv}`, "LANG=C.UTF-8",
    // The launcher may leave a memory watchdog running; it must not inherit the lock.
    ...(lock ? ["/usr/bin/flock", "-n", "-o", "-E", "75", `${node.hostHome}/.cache/sparkdash-runtime.lock`] : []),
    "/usr/bin/timeout", "--kill-after=5s", `${Math.ceil(timeoutMs / 1000)}s`,
    "/bin/bash", "--noprofile", "--norc", "-c", command];
  if (spark.isLocal) {
    return { file: "/usr/bin/nsenter", args: ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--",
      "/usr/sbin/runuser", "-u", node.hostUser, "--", ...args] };
  }
  if (spark.ssh?.user !== node.hostUser) throw new Error(`SSH user and runtime hostUser differ for ${node.id}`);
  return sshCommandSpec(spark, { multiplex: false, remoteArgv: [args.map(quote).join(" ")] });
}

export function runHostProcess(invocation, { timeoutMs, onLine = () => {}, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(invocation.file, invocation.args, {
      detached: true, stdio: ["ignore", "pipe", "pipe"], ...(invocation.env ? { env: invocation.env } : {}),
    });
    let stdout = "";
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* transport already closed */ } }
      reject(Object.assign(new Error("Host command connection timed out; reconcile before retrying"), { uncertain: true }));
    }, timeoutMs + 10_000);
    const emit = (line) => { const safe = safeLogLine(line); if (safe) onLine(safe); };
    streamLines(child.stdout, (line) => { stdout = (stdout + line + "\n").slice(-65536); emit(line); });
    streamLines(child.stderr, emit);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      const error = new Error(code === 75 ? "A host runtime command is already running" : `Host command failed (${signal || `exit ${code}`})`);
      error.code = code === 75 ? "BUSY" : "COMMAND_FAILED";
      error.uncertain = code === 255 || Boolean(signal);
      reject(error);
    });
  });
}

export async function probeRuntimeEndpoint(spark, node, fetchImpl = fetch) {
  try {
    const key = spark.llmApiKeys?.[String(node.port)];
    const response = await fetchImpl(`http://${llmProbeHost(spark)}:${node.port}/v1/models`, {
      signal: AbortSignal.timeout(5000), ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
    });
    const body = response.ok ? await response.json() : null;
    const models = Array.isArray(body?.data) ? body.data.filter((entry) => typeof entry?.id === "string" && entry.id) : [];
    return { reachable: true, modelId: models.length === 1 ? models[0].id : null };
  } catch (error) {
    return { reachable: error?.cause?.code !== "ECONNREFUSED", modelId: null };
  }
}

export function createRuntimeExecutor({ getSpark, getConfig, spawnImpl = spawn, fetchImpl = fetch }) {
  const execute = (nodeId, command, options) => {
    const node = getConfig().nodes[nodeId];
    const spark = getSpark(nodeId);
    if (!node || !spark) throw new Error(`Runtime node ${nodeId} is not registered`);
    return runHostProcess(buildHostCommandInvocation(spark, node, command, options), { ...options, spawnImpl });
  };
  return {
    run(runtime, action, onLine) {
      if (!["start", "stop", "preflight"].includes(action)) throw new Error("Unknown lifecycle action");
      return execute(runtime.apiNode, runtime[action], {
        timeoutMs: action === "start" ? runtime.startupTimeoutMs : runtime.stopTimeoutMs, onLine,
      });
    },
    checkNode(nodeId) { return execute(nodeId, "true", { timeoutMs: 10_000 }); },
    async observe() {
      return Object.fromEntries(await Promise.all(Object.values(getConfig().nodes).map(async (node) => {
        const spark = getSpark(node.id);
        if (!spark) return [node.id, { reachable: true, modelId: null, running: [], error: "Node is not registered" }];
        try {
          const [api, output] = await Promise.all([
            probeRuntimeEndpoint(spark, node, fetchImpl),
            execute(node.id, "docker ps --format '{{.Names}}'", { timeoutMs: 10_000, lock: false }),
          ]);
          return [node.id, { ...api, running: output.split("\n").filter(Boolean), error: null }];
        } catch {
          return [node.id, { reachable: true, modelId: null, running: [], error: "Cannot inspect node containers" }];
        }
      })));
    },
  };
}

export function streamLines(stream, onLine) {
  let pending = "";
  let overlong = false;
  let skipLineFeed = false;

  const emitLine = () => {
    onLine(overlong ? "[redacted overlong output]" : pending);
    pending = "";
    overlong = false;
  };

  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    for (const character of chunk) {
      if (skipLineFeed) {
        skipLineFeed = false;
        if (character === "\n") continue;
      }
      if (character === "\r") {
        emitLine();
        skipLineFeed = true;
      } else if (character === "\n") {
        emitLine();
      } else if (!overlong) {
        pending += character;
        if (pending.length > LOG_LINE_LIMIT) {
          pending = "";
          overlong = true;
        }
      }
    }
  });
  stream.on("end", () => {
    if (overlong) onLine("[redacted overlong output]");
    else if (pending) onLine(pending);
  });
}
