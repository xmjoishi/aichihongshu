const childProcess = require("node:child_process");
const { appendFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const blockedExecutable = /^(?:pythonw?(?:\d+(?:\.\d+)*)?|py|pypy(?:\d+(?:\.\d+)*)?|pip(?:\d+(?:\.\d+)*)?|uvx?)$/i;
const shellExecutable = /^(?:sh|bash|dash|zsh|cmd|powershell|pwsh)(?:\.exe)?$/i;
const wrapperExecutable = /^(?:env|command|exec|sudo|nohup)$/i;
const hookForNodeOptions = __filename.replace(/\\/g, "/");

if (!process.env.NODE_OPTIONS?.includes(hookForNodeOptions)) {
  const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
  process.env.NODE_OPTIONS = [
    existingNodeOptions,
    `--require="${hookForNodeOptions.replace(/"/g, "\\\"")}"`,
  ].filter(Boolean).join(" ");
}

function basename(value) {
  const normalized = String(value).trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  return normalized.split("/").at(-1).replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

function shellCommandNames(text) {
  const names = [];
  for (const segment of String(text).split(/(?:&&|\|\||[;|\n\r])/)) {
    let rest = segment.trim();
    while (rest) {
      const match = rest.match(/^(?:([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/);
      if (!match) break;
      const name = match[2] ?? match[3] ?? match[4];
      if (wrapperExecutable.test(basename(name))) {
        rest = rest.slice(match[0].length).trimStart();
        continue;
      }
      names.push(name);
      break;
    }
  }
  return names;
}

function findBlockedCommand(command, args, options, method) {
  const direct = basename(command);
  if (blockedExecutable.test(direct)) return direct;

  const commandIsShell = method === "exec"
    || method === "execSync"
    || shellExecutable.test(direct)
    || options?.shell === true
    || typeof options?.shell === "string";
  if (!commandIsShell) return null;

  const values = [command, ...(Array.isArray(args) ? args : [])];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string") continue;
    const previous = String(values[index - 1] ?? "").toLowerCase();
    const isShellSource = method === "exec"
      || method === "execSync"
      || options?.shell === true
      || (index > 0 && ["-c", "/c", "-command", "--command"].includes(previous));
    if (!isShellSource) continue;
    const match = shellCommandNames(value).map(basename).find((name) => blockedExecutable.test(name));
    if (match) return match;
  }
  return null;
}

function deny(name) {
  const logPath = process.env.AICHIHONGSHU_PYTHON_DENY_LOG;
  if (logPath) appendFileSync(logPath, `${name}\n`);
  const error = new Error(`Blocked Python runtime command: ${name}`);
  error.code = "AICHIHONGSHU_BLOCKED_PYTHON_COMMAND";
  throw error;
}

for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
  const original = childProcess[method];
  childProcess[method] = function auditedChildProcessCall(command, args, ...rest) {
    const options = [args, ...rest].find((value) => value && typeof value === "object" && !Array.isArray(value));
    const blocked = findBlockedCommand(command, args, options, method);
    if (blocked) deny(blocked);
    return Reflect.apply(original, this, [command, args, ...rest]);
  };
}

syncBuiltinESMExports();
