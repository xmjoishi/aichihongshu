import { appendFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const commands = ["python", "python2", "python2.7", "python3", "pythonw", "pythonw3", "pythonw2.7", "py", "pypy", "pypy2", "pypy3", "pypy2.7", "pip", "pip2", "pip2.7", "pip3", "uv", "uvx"];
for (let minor = 0; minor <= 30; minor += 1) {
  commands.push(`python3.${minor}`, `pythonw3.${minor}`, `pypy3.${minor}`, `pip3.${minor}`);
}

async function main() {
  const runnerTemp = process.env.RUNNER_TEMP;
  const githubPath = process.env.GITHUB_PATH;
  const githubEnv = process.env.GITHUB_ENV;
  if (!runnerTemp || !githubPath || !githubEnv) {
    throw new Error("Python denylist installer requires RUNNER_TEMP, GITHUB_PATH and GITHUB_ENV");
  }

  const binDirectory = path.join(runnerTemp, `aichihongshu-python-denylist-${process.pid}`);
  const logPath = path.join(runnerTemp, `aichihongshu-python-command-attempts-${process.pid}.log`);
  const auditHook = path.join(path.dirname(fileURLToPath(import.meta.url)), "python-command-audit.cjs");
  await mkdir(binDirectory, { recursive: true });
  const windows = process.platform === "win32";
  for (const command of commands) {
    const filename = path.join(binDirectory, windows ? `${command}.cmd` : command);
    const content = windows
      ? `@echo off\r\n>>"%AICHIHONGSHU_PYTHON_DENY_LOG%" echo ${command}\r\nexit /b 97\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$AICHIHONGSHU_PYTHON_DENY_LOG"\nexit 97\n`;
    await writeFile(filename, content, { mode: 0o755 });
  }
  const nodeShim = path.join(binDirectory, windows ? "node.cmd" : "node");
  const nodeCommand = windows
    ? `@echo off\r\n"${process.execPath}" --require "${auditHook}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' --require '${auditHook.replace(/'/g, "'\\''")}' "$@"\n`;
  await writeFile(nodeShim, nodeCommand, { mode: 0o755 });

  if (/[\r\n]/.test(logPath)) {
    throw new Error("runner temp path cannot contain GitHub environment-file delimiters");
  }
  await appendFile(githubPath, `${binDirectory}${os.EOL}`);
  await appendFile(githubEnv, `AICHIHONGSHU_PYTHON_DENY_LOG=${logPath}${os.EOL}`);
  process.stdout.write(`Python runtime audit installed for: ${commands.join(", ")} and Node child processes\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
