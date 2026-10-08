import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "browser-extension");
const files = ["manifest.json", "popup.html", "popup.css", "popup.js", "background.js", "extract.js", "creator-fill.js", "native-bridge.js", "capture-recovery.js", "capture-image-client.js", "capture-image-fetch.js", "connection-diagnostics.js", "profile-notes.js", "capture-preview.js", "preview-session.js", "preview.html", "preview.css", "preview-page.js"];
const permissions = ["nativeMessaging", "scripting", "activeTab", "storage"];
const sourceManifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
const devKey = fs.readFileSync(path.join(source, "dev-public-key.txt"), "utf8").trim();

if (sourceManifest.manifest_version !== 3 || JSON.stringify(sourceManifest.permissions) !== JSON.stringify(permissions)) {
  throw new Error("扩展 manifest 版本或 permissions 超出已批准的最小集合");
}
if ((sourceManifest.host_permissions ?? []).length !== 0 || sourceManifest.content_scripts !== undefined) {
  throw new Error("扩展不能声明 host_permissions 或常驻 content_scripts");
}
if (JSON.stringify(sourceManifest.optional_host_permissions ?? []) !== JSON.stringify(["https://*/*"])) {
  throw new Error("扩展只允许在保存时按精确 HTTPS 图源申请可选域权限");
}
for (const file of files) {
  if (!fs.statSync(path.join(source, file), { throwIfNoEntry: false })) throw new Error(`扩展清单所需文件缺失: ${file}`);
}
const popupSource = fs.readFileSync(path.join(source, "popup.js"), "utf8");
const previewSource = fs.readFileSync(path.join(source, "preview-page.js"), "utf8");
if (!popupSource.includes("chrome.storage.session.set") || !popupSource.includes('chrome.runtime.getURL("preview.html")')
  || popupSource.includes("localStorage") || popupSource.includes("sessionStorage")) {
  throw new Error("展开预览必须使用 session 临时数据，禁止写 localStorage/sessionStorage");
}
if (!previewSource.includes("chrome.storage.session.get") || !previewSource.includes("chrome.storage.session.remove")
  || !previewSource.includes("chrome.tabs.onUpdated") || !previewSource.includes("chrome.tabs.onRemoved")) {
  throw new Error("展开预览缺少一次性 session 消费或来源生命周期检查");
}
if (sourceManifest.key == null || !sourceManifest.version || !devKey) throw new Error("扩展缺少固定 key 或版本");
if (!popupSource.includes('const NATIVE_HOSTS = { prod: "com.aichihongshu.host", dev: "com.aichihongshu.host.dev" }')) {
  throw new Error("扩展必须按明确的正式/DEV 通道选择固定 Native Host 名称");
}

function extensionId(key) {
  return crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)
    .toString("hex").replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

function createVariant(channel) {
  const dev = channel === "dev";
  const key = dev ? devKey : sourceManifest.key;
  const nativeHostName = dev ? "com.aichihongshu.host.dev" : "com.aichihongshu.host";
  const manifest = structuredClone(sourceManifest);
  manifest.key = key;
  if (dev) {
    manifest.name = "爱吃红薯数据抓取 DEV";
    manifest.description = "开发通道 · 本地采集与创作页确认式填充（不自动发布）";
    manifest.action.default_title = "DEV 数据抓取（当前页）";
  }
  const contents = new Map(files.map((file) => {
    let bytes = fs.readFileSync(path.join(source, file));
    if (file === "manifest.json") bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    return [file, bytes];
  }));
  const id = extensionId(key);
  if (dev && id === extensionId(sourceManifest.key)) throw new Error("DEV 扩展 ID 必须与正式版不同");
  return { channel, manifest, extensionId: id, nativeHostName, contents };
}

const variants = [createVariant("prod"), createVariant("dev")];
for (const variant of variants) {
  for (const [file, bytes] of variant.contents) {
    if (!fs.statSync(path.join(source, file)).isFile()) throw new Error(`缺少扩展资源: ${file}`);
    if (file.endsWith(".js")) execFileSync(process.execPath, ["--check"], { input: bytes, stdio: ["pipe", "inherit", "inherit"] });
  }
}

if (!process.argv.includes("--build")) {
  console.log(JSON.stringify({
    ok: true,
    mode: "check",
    variants: variants.map(({ channel, manifest, extensionId: id, nativeHostName }) => ({
      channel, version: manifest.version, extensionId: id, nativeHostName,
    })),
    files,
  }, null, 2));
} else {
  const targetRoot = path.join(root, "client", "src-tauri", "target");
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const variant of variants) {
    const label = variant.channel === "dev" ? "browser-extension-dev" : "browser-extension";
    const destination = path.join(targetRoot, `${label}-v${variant.manifest.version}`);
    const stamp = `${process.pid}-${Date.now()}`;
    const staging = `${destination}.staging-${stamp}`;
    const backup = `${destination}.previous-${stamp}`;
    fs.mkdirSync(staging);
    const hashes = {};
    for (const [file, bytes] of variant.contents) {
      fs.writeFileSync(path.join(staging, file), bytes);
      hashes[file] = crypto.createHash("sha256").update(bytes).digest("hex");
    }
    const integrity = {
      channel: variant.channel,
      version: variant.manifest.version,
      extensionId: variant.extensionId,
      nativeHostName: variant.nativeHostName,
      files: hashes,
    };
    fs.writeFileSync(path.join(staging, "integrity.json"), `${JSON.stringify(integrity, null, 2)}\n`);
    const stagedManifest = JSON.parse(fs.readFileSync(path.join(staging, "manifest.json"), "utf8"));
    if (stagedManifest.version !== variant.manifest.version) throw new Error(`${variant.channel} 扩展版本不一致`);
    for (const file of files) {
      const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(staging, file))).digest("hex");
      if (actual !== hashes[file]) throw new Error(`${variant.channel} 扩展打包校验失败: ${file}`);
    }
    if (fs.existsSync(destination)) fs.renameSync(destination, backup);
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, destination);
      throw error;
    }
    console.log(JSON.stringify({ ok: true, channel: variant.channel, destination, version: variant.manifest.version, extensionId: variant.extensionId, nativeHostName: variant.nativeHostName }));
  }
}
