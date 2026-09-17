import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const prepare = spawn(process.execPath, [resolve(scriptsDir, "prepare-desktop-qa-workspace.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
});

prepare.on("error", (error) => {
  console.error(`QA 工作区准备失败: ${error.message}`);
  process.exitCode = 1;
});

prepare.on("exit", (code, signal) => {
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }

  const qaRoot = resolve(repoRoot, ".qa", "desktop-workspace");
  const tauri = spawn("npm", ["--prefix", "client", "run", "tauri", "--", "dev"], {
    cwd: repoRoot,
    env: { ...process.env, AICHIHONGSHU_QA_WORKSPACE: qaRoot },
    stdio: "inherit",
  });

  const forwardSignal = (name) => {
    if (!tauri.killed) tauri.kill(name);
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  tauri.on("exit", (tauriCode, tauriSignal) => {
    process.exitCode = tauriCode ?? (tauriSignal ? 1 : 0);
  });
});
