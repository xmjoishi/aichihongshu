import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CLI_COMMANDS = ["claude", "codex", "opencode"];
const VERSION_TIMEOUT_MS = 2_000;
const VERSION_PATTERN = /(?:^|\s)v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/;

const rustSource = readFileSync("client/src-tauri/src/lib.rs", "utf8");
const rustDbSource = readFileSync("client/src-tauri/src/db.rs", "utf8");
const localAiSource = readFileSync("client/src/lib/localAi.ts", "utf8");
for (const marker of [
  "probe_local_ai_providers",
  "start_local_ai",
  "cancel_local_ai",
  "--skip-git-repo-check",
  "local-ai://chunk",
  "local-ai://done",
  "local-ai://error",
  "save_local_ai_run",
  "read_local_ai_run",
  "ai_runs",
]) {
  if (!rustSource.includes(marker) && !rustDbSource.includes(marker) && !localAiSource.includes(marker)) {
    throw new Error(`本地 Provider 门禁缺少: ${marker}`);
  }
}
console.log("local provider adapter markers: probe, non-interactive run, event stream, cancel, and run metadata checked");

function extractVersion(stdout, stderr) {
  const match = `${stdout}\n${stderr}`.match(VERSION_PATTERN);
  return match?.[1] ?? "unknown";
}

function probe(command) {
  const result = spawnSync(command, ["--version"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: VERSION_TIMEOUT_MS,
    maxBuffer: 16 * 1024,
    windowsHide: true,
  });

  if (result.error?.code === "ENOENT") {
    return { command, state: "missing", failure: "not-installed" };
  }
  if (result.error?.code === "ETIMEDOUT") {
    return { command, state: "failed", failure: "timeout" };
  }
  if (result.signal) {
    return { command, state: "failed", failure: "terminated" };
  }
  if (result.status !== 0) {
    return { command, state: "failed", failure: "non-zero-exit" };
  }

  return {
    command,
    state: "present",
    version: extractVersion(result.stdout ?? "", result.stderr ?? ""),
  };
}

for (const result of CLI_COMMANDS.map(probe)) {
  if (result.state === "present") {
    console.log(`${result.command}: present version=${result.version}`);
  } else {
    console.log(`${result.command}: ${result.state} failure=${result.failure}`);
  }
}
