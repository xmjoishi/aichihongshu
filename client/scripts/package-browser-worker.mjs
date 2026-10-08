import assert from "node:assert/strict";
import { access, chmod, copyFile, cp, lstat, mkdir, readFile, readlink, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const clientRoot = path.resolve(import.meta.dirname, "..");
const workerRoot = path.join(clientRoot, "browser-worker");
const workerTarget = path.join(clientRoot, "src-tauri", "resources", "browser-worker");
const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
const target = targetArg?.slice("--target=".length) ?? process.env.AICHIHONGSHU_TAURI_TARGET;
const platformMap = {
  "aarch64-apple-darwin": ["darwin", "arm64", "node"],
  "x86_64-apple-darwin": ["darwin", "x64", "node"],
  "x86_64-pc-windows-msvc": ["win32", "x64", "node.exe"],
  "x86_64-unknown-linux-gnu": ["linux", "x64", "node"],
};

function parseMajor(version) {
  return Number(version.replace(/^v/, "").split(".")[0]);
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directorySize(fullPath) : (await stat(fullPath)).size;
  }
  return total;
}

function isInsideDirectory(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function relocateInternalSymlinks(sourceRoot, targetRoot) {
  const resolvedSourceRoot = await realpath(sourceRoot);
  const sourceRootPath = path.resolve(sourceRoot);

  async function visit(sourcePath, targetPath) {
    if (
      path.resolve(sourcePath) !== sourceRootPath &&
      path.basename(sourcePath) === ".local-browsers"
    ) {
      return;
    }
    const details = await lstat(sourcePath);
    if (details.isSymbolicLink()) {
      const sourceTarget = await realpath(sourcePath);
      assert.ok(
        isInsideDirectory(resolvedSourceRoot, sourceTarget),
        `Browser runtime symlink escapes its source tree: ${sourcePath} -> ${sourceTarget}`,
      );
      const targetRelativePath = path.relative(resolvedSourceRoot, sourceTarget);
      const copiedTarget = path.join(targetRoot, targetRelativePath);
      await access(copiedTarget);
      const copiedTargetDetails = await stat(copiedTarget);
      const relativeLink = path.relative(path.dirname(targetPath), copiedTarget) || ".";
      await rm(targetPath, { force: true });
      await symlink(relativeLink, targetPath, copiedTargetDetails.isDirectory() ? "dir" : "file");
      return;
    }
    if (!details.isDirectory()) return;

    for (const entry of await readdir(sourcePath)) {
      await visit(path.join(sourcePath, entry), path.join(targetPath, entry));
    }
  }

  await visit(sourceRoot, targetRoot);
}

async function assertNoExternalSymlinks(directory) {
  const root = await realpath(directory);

  async function visit(currentPath) {
    const details = await lstat(currentPath);
    if (details.isSymbolicLink()) {
      const target = await realpath(currentPath);
      assert.ok(
        isInsideDirectory(root, target),
        `Packaged browser runtime has an external symlink: ${currentPath} -> ${target}`,
      );
      return;
    }
    if (!details.isDirectory()) return;
    for (const entry of await readdir(currentPath)) {
      await visit(path.join(currentPath, entry));
    }
  }

  await visit(directory);
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function smokeTest() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(workerTarget, ".local-browsers");
  const playwrightEntry = path.join(workerTarget, "node_modules", "playwright", "index.mjs");
  const { chromium } = await import(pathToFileURL(playwrightEntry).href);
  const chromiumExecutable = chromium.executablePath();
  const profile = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "aichihongshu-browser-runtime-qa-")),
  );
  try {
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await context.newPage();
      await page.setContent("<!doctype html><title>browser-worker-fixture</title><main>runtime-ready</main>");
      assert.equal(await page.title(), "browser-worker-fixture");
      assert.equal(await page.locator("main").textContent(), "runtime-ready");
    } finally {
      await context.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
  return path.relative(workerTarget, chromiumExecutable).split(path.sep).join("/");
}

async function main() {
  assert.ok(target, "必须指定 --target=<Rust target triple>");
  const expected = platformMap[target];
  assert.ok(expected, `不支持的 browser worker target: ${target}`);
  assert.equal(process.platform, expected[0], `当前 runner OS 与 target ${target} 不一致`);
  assert.equal(process.arch, expected[1], `当前 runner 架构与 target ${target} 不一致`);
  assert.ok(parseMajor(process.version) >= 22, `Node.js 22+ required; got ${process.version}`);
  assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, "0", "Playwright 必须安装到 node_modules/.local-browsers");

  const browserSource = path.join(workerRoot, "node_modules", "playwright-core", ".local-browsers");
  const browserInfo = await readdir(browserSource).catch(() => []);
  assert.ok(browserInfo.some((name) => name.startsWith("chromium-")), "缺少当前 Playwright 版本的 Chromium 下载");
  const nodeExecutable = path.resolve(process.execPath);
  const nodeName = expected[2];
  const runtimeRoot = path.join(workerTarget, "runtime");
  await rm(workerTarget, { recursive: true, force: true });
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(workerTarget, ".gitkeep"), "");
  await copyFile(nodeExecutable, path.join(runtimeRoot, nodeName));
  if (process.platform !== "win32") await chmod(path.join(runtimeRoot, nodeName), 0o755);

  for (const filename of ["worker.mjs", "service.mjs", "profile-capture.mjs", "package.json"]) {
    await copyFile(path.join(workerRoot, filename), path.join(workerTarget, filename));
  }
  await mkdir(path.join(workerTarget, "node_modules"), { recursive: true });
  for (const packageName of ["playwright", "playwright-core"]) {
    await cp(
      path.join(workerRoot, "node_modules", packageName),
      path.join(workerTarget, "node_modules", packageName),
      {
        recursive: true,
        filter: (source) => path.basename(source) !== ".local-browsers",
      },
    );
    await relocateInternalSymlinks(
      path.join(workerRoot, "node_modules", packageName),
      path.join(workerTarget, "node_modules", packageName),
    );
  }
  await mkdir(path.join(workerTarget, ".local-browsers"), { recursive: true });
  for (const directory of browserInfo.filter((name) => name.startsWith("chromium-"))) {
    await cp(
      path.join(browserSource, directory),
      path.join(workerTarget, ".local-browsers", directory),
      { recursive: true },
    );
  }
  await relocateInternalSymlinks(browserSource, path.join(workerTarget, ".local-browsers"));
  await assertNoExternalSymlinks(workerTarget);

  const nodeLicenseCandidates = [
    path.join(path.dirname(nodeExecutable), "LICENSE"),
    path.join(path.dirname(path.dirname(nodeExecutable)), "LICENSE"),
  ];
  let nodeLicense;
  for (const candidate of nodeLicenseCandidates) {
    if (await exists(candidate)) {
      nodeLicense = candidate;
      break;
    }
  }
  if (nodeLicense) await copyFile(nodeLicense, path.join(runtimeRoot, "LICENSE.node.txt"));
  const runtimeNode = path.join(runtimeRoot, nodeName);
  const nodeCheck = await import("node:child_process").then(({ execFileSync }) =>
    execFileSync(runtimeNode, ["--version"], { encoding: "utf8" }).trim(),
  );
  assert.equal(nodeCheck, process.version);
  const chromiumExecutable = await smokeTest();
  await writeFile(
    path.join(workerTarget, "runtime-manifest.json"),
    `${JSON.stringify({
      formatVersion: 1,
      target,
      nodeVersion: process.version,
      playwrightVersion: JSON.parse(await readFile(path.join(workerRoot, "node_modules", "playwright", "package.json"), "utf8")).version,
      browserDirectory: ".local-browsers",
      chromiumExecutable,
      executable: `runtime/${nodeName}`,
    }, null, 2)}\n`,
  );
  console.log(`Packaged ${target} browser worker runtime (${process.version}, ${formatBytes(await directorySize(workerTarget))}); Chromium fixture passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
