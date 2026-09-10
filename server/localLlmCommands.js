import { spawn } from "node:child_process";
import { getRuntimeConfig } from "./localLlmConfig.js";

export const LOG_LINE_LIMIT = 500;

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

export function buildHostCommandInvocation(command) {
  const { hostUser, hostHome, hostCommands } = getRuntimeConfig();
  const fixedCommand = Object.hasOwn(hostCommands, command) ? hostCommands[command] : null;
  if (!fixedCommand) throw new Error("host command is not allowlisted");
  const pathEnv =
    process.env.LOCAL_LLM_CMD_PATH ||
    `${hostHome}/.local/bin:/usr/local/cuda/bin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin`;
  return {
    file: "/usr/bin/nsenter",
    args: [
      "-t",
      "1",
      "-m",
      "-u",
      "-i",
      "-n",
      "-p",
      "--",
      "/usr/sbin/runuser",
      "-u",
      hostUser,
      "--",
      "/usr/bin/env",
      "-i",
      `HOME=${hostHome}`,
      `USER=${hostUser}`,
      `LOGNAME=${hostUser}`,
      "SHELL=/bin/bash",
      `PATH=${pathEnv}`,
      "LANG=C.UTF-8",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      fixedCommand,
    ],
    options: { stdio: ["ignore", "pipe", "pipe"] },
  };
}

export function createHostCommandRunner(spawnImpl = spawn) {
  return (command, { onLine } = {}) =>
    new Promise((resolve, reject) => {
      const { file, args, options } = buildHostCommandInvocation(command);
      const child = spawnImpl(file, args, options);
      const emit = typeof onLine === "function" ? onLine : () => {};
      streamLines(child.stdout, emit);
      streamLines(child.stderr, emit);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`lifecycle command ${command} failed (${signal || `exit ${code}`})`));
      });
    });
}
