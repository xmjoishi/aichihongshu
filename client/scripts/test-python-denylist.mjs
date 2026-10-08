import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(scriptsDirectory, "install-python-denylist.mjs");
const reporter = path.join(scriptsDirectory, "report-python-denylist.mjs");
const pathFixture = path.join(scriptsDirectory, "python-denylist-path-fixture.mjs");
const propagationFixture = path.join(scriptsDirectory, "python-command-audit-propagation-fixture.mjs");
const auditHook = path.join(scriptsDirectory, "python-command-audit.cjs");
const root = await mkdtemp(path.join(os.tmpdir(), "aichihongshu-python-denylist-test-"));

try {
  const githubPath = path.join(root, "github-path");
  const githubEnv = path.join(root, "github-env");
  const installerResult = spawnSync(process.execPath, [installer], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_TEMP: root,
      GITHUB_PATH: githubPath,
      GITHUB_ENV: githubEnv,
    },
  });
  assert.equal(installerResult.status, 0, installerResult.stderr);

  const binDirectory = (await readFile(githubPath, "utf8")).trim();
  const nodeShim = path.join(binDirectory, process.platform === "win32" ? "node.cmd" : "node");
  await access(nodeShim);
  for (const command of ["python", "python2", "python2.7", "python3", "python3.0", "python3.30", "pythonw", "pythonw3", "pythonw3.0", "pythonw3.30", "py", "pypy", "pypy2", "pypy3", "pypy2.7", "pypy3.0", "pypy3.30", "pip", "pip2", "pip2.7", "pip3", "pip3.0", "pip3.30", "uv", "uvx"]) {
    const suffix = process.platform === "win32" ? ".cmd" : "";
    await access(path.join(binDirectory, `${command}${suffix}`));
  }
  const envLines = (await readFile(githubEnv, "utf8")).trim().split(/\r?\n/);
  const logEntry = envLines.find((line) => line.startsWith("AICHIHONGSHU_PYTHON_DENY_LOG="));
  assert.ok(logEntry, "installer must export the denial log path");
  const logPath = logEntry.slice("AICHIHONGSHU_PYTHON_DENY_LOG=".length);
  assert.ok(!envLines.some((line) => line.startsWith("NODE_OPTIONS=")), "installer must not set NODE_OPTIONS through GITHUB_ENV");
  const nodeRequire = `--require="${auditHook.replace(/\\/g, "/")}"`;
  const installedNodeOptions = [process.env.NODE_OPTIONS?.trim(), nodeRequire].filter(Boolean).join(" ");
  const cleanReport = spawnSync(process.execPath, [reporter], {
    encoding: "utf8",
    env: {
      ...process.env,
      AICHIHONGSHU_PYTHON_DENY_LOG: path.join(root, "no-attempts.log"),
    },
  });
  assert.equal(cleanReport.status, 0, cleanReport.stderr);
  assert.match(cleanReport.stdout, /No Python command attempts were recorded/);

  const pathFixtureResult = spawnSync(process.execPath, [pathFixture, binDirectory, logPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: "",
    },
  });
  assert.equal(pathFixtureResult.status, 0, pathFixtureResult.stderr);

  const propagationLog = path.join(root, "node-shim-python-attempts.log");
  const propagationResult = spawnSync(nodeShim, [propagationFixture], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      AICHIHONGSHU_PYTHON_DENY_LOG: propagationLog,
      AICHIHONGSHU_PYTHON_AUDIT_TARGET: path.join(root, process.platform === "win32" ? "python3.12.exe" : "python3.12"),
    },
    shell: process.platform === "win32",
  });
  assert.equal(propagationResult.status, 0, propagationResult.stderr);
  assert.match(propagationResult.stdout, /audit propagated to a grandchild/);
  assert.equal((await readFile(propagationLog, "utf8")).trim(), "python3.12");

  const absolutePython = path.join(root, process.platform === "win32" ? "python3.12.exe" : "python3.12");
  const windowsPython = "C:\\Python312\\python3.12.exe";
  const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
  const shellArguments = process.platform === "win32"
    ? ["/c", `"${absolutePython}" --version`]
    : ["-c", `"${absolutePython}" --version`];
  const auditCases = [
    {
      name: "spawn",
      script: `require("node:child_process").spawn(${JSON.stringify(absolutePython)}, ["--version"])`,
    },
    {
      name: "spawnSync",
      script: `require("node:child_process").spawnSync(${JSON.stringify(absolutePython)}, ["--version"])`,
    },
    {
      name: "windows-absolute-path",
      script: `require("node:child_process").spawnSync(${JSON.stringify(windowsPython)}, ["--version"])`,
    },
    {
      name: "versioned-pypy-absolute-path",
      blockedName: "pypy3.12",
      script: `require("node:child_process").spawnSync("D:\\\\PyPy\\\\pypy3.12.exe", ["--version"])`,
    },
    {
      name: "execFile",
      script: `require("node:child_process").execFile(${JSON.stringify(absolutePython)}, ["--version"])`,
    },
    {
      name: "execFileSync",
      script: `require("node:child_process").execFileSync(${JSON.stringify(absolutePython)}, ["--version"])`,
    },
    {
      name: "exec",
      script: `require("node:child_process").exec(${JSON.stringify(`${absolutePython} --version`)})`,
    },
    {
      name: "execSync",
      script: `require("node:child_process").execSync(${JSON.stringify(`${absolutePython} --version`)})`,
    },
    {
      name: "shell-spawnSync",
      script: `require("node:child_process").spawnSync(${JSON.stringify(shell)}, ${JSON.stringify(shellArguments)})`,
    },
  ];
  for (const testCase of auditCases) {
    const attemptLog = path.join(root, `${testCase.name}-python-attempts.log`);
    const result = spawnSync(process.execPath, ["-e", testCase.script], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: installedNodeOptions,
        AICHIHONGSHU_PYTHON_DENY_LOG: attemptLog,
      },
    });
    const blockedName = testCase.blockedName ?? "python3.12";
    assert.notEqual(result.status, 0, `${testCase.name} must block absolute Python paths before launch`);
    assert.ok(result.stderr.includes(`Blocked Python runtime command: ${blockedName}`));
    assert.equal((await readFile(attemptLog, "utf8")).trim(), blockedName);
  }

  const reportResult = spawnSync(process.execPath, [reporter], {
    encoding: "utf8",
    env: { ...process.env, AICHIHONGSHU_PYTHON_DENY_LOG: logPath },
  });
  assert.equal(reportResult.status, 1);
  assert.match(reportResult.stderr, /Python command attempts were blocked:\npython3/);
  process.stdout.write("Python runtime audit blocks PATH commands and absolute Node child-process launches.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
