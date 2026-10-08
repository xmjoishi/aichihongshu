import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { findForbiddenPythonResources } from "./python-resource-guard.mjs";

const root = path.resolve(process.cwd(), "..");

async function ensure(rel) {
  const target = path.join(root, rel);
  try {
    await access(target);
  } catch {
    throw new Error(`缺少打包资源: ${rel}`);
  }
}

async function validateBrowserWorkerRuntime() {
  if (process.env.AICHIHONGSHU_REQUIRE_BROWSER_RUNTIME !== "1") return;
  const expectedTarget = process.env.AICHIHONGSHU_TAURI_TARGET;
  if (!expectedTarget) throw new Error("release 必须设置 AICHIHONGSHU_TAURI_TARGET");
  const runtimeRoot = path.join(root, "client/src-tauri/resources/browser-worker");
  const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");
  await ensure("client/src-tauri/resources/browser-worker/runtime-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("browser worker runtime manifest 无效");
  }
  if (manifest.formatVersion !== 1 || manifest.target !== expectedTarget) {
    throw new Error(`browser worker runtime target 与发布目标不匹配: ${manifest.target} != ${expectedTarget}`);
  }
  if (!/^v(?:22|2[3-9]|[3-9]\d)\./.test(manifest.nodeVersion ?? "")) {
    throw new Error(`browser worker 要求随包 Node.js 22+，实际为 ${manifest.nodeVersion ?? "unknown"}`);
  }
  for (const relativePath of [manifest.executable, manifest.chromiumExecutable]) {
    if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
      throw new Error("browser worker runtime 清单缺少安全的相对可执行路径");
    }
    const resolved = path.resolve(runtimeRoot, relativePath);
    if (!resolved.startsWith(`${runtimeRoot}${path.sep}`)) {
      throw new Error(`browser worker runtime 路径越界: ${relativePath}`);
    }
    try {
      await access(resolved);
    } catch {
      throw new Error(`缺少 browser worker runtime 文件: ${relativePath}`);
    }
  }
  await ensure("client/src-tauri/resources/browser-worker/service.mjs");
  await ensure("client/src-tauri/resources/browser-worker/profile-capture.mjs");
  await ensure("client/src-tauri/resources/browser-worker/worker.mjs");
  await ensure("client/src-tauri/resources/browser-worker/node_modules/playwright/package.json");
  await ensure("client/src-tauri/resources/browser-worker/node_modules/playwright-core/package.json");
}

async function main() {
  await Promise.all([
    ensure("client/src-tauri/Cargo.toml"),
    ensure("client/core/Cargo.toml"),
    ensure("client/services/Cargo.toml"),
    ensure("client/src/main.tsx"),
  ]);

  const configPath = path.join(root, "client/src-tauri/tauri.conf.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const configuredResources = config.bundle?.resources ?? [];
  const pythonResources = await findForbiddenPythonResources(
    configuredResources,
    path.join(root, "client/src-tauri"),
  );
  if (pythonResources.length) {
    throw new Error(
      `Tauri bundle resources failed the Python-free audit: ${pythonResources.join(", ")}`,
    );
  }
  await validateBrowserWorkerRuntime();
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
