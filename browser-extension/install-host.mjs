#!/usr/bin/env node
// 安装原生宿主 manifest 到用户级 NativeMessagingHosts 目录（macOS）。
// 由用户显式执行；本脚本只写入本机用户目录，不触碰仓库与正式数据：
//   node browser-extension/install-host.mjs
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.aichihongshu.host";
const ALLOWED_PERMISSIONS = new Set(["nativeMessaging", "scripting", "activeTab"]);

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(extensionRoot, "manifest.json");
const hostScript = path.join(extensionRoot, "host", "host.cjs");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

// 权限门禁：任何超出最小集合的权限都拒绝安装，避免静默扩权。
const permissions = manifest.permissions || [];
const unexpected = permissions.filter((item) => !ALLOWED_PERMISSIONS.has(item));
if (unexpected.length) {
  console.error(`扩展权限超出最小集合，拒绝安装：${unexpected.join(", ")}`);
  process.exit(2);
}
if ((manifest.host_permissions || []).length > 0) {
  console.error("扩展声明了 host_permissions，拒绝安装");
  process.exit(2);
}
if (manifest.content_scripts) {
  console.error("扩展声明了常驻 content_scripts，拒绝安装");
  process.exit(2);
}
if (!fs.existsSync(hostScript)) {
  console.error(`原生宿主脚本不存在：${hostScript}`);
  process.exit(2);
}

// 从 manifest.key（SPKI DER 的 base64）推导稳定扩展 ID。
const key = Buffer.from(manifest.key, "base64");
const extensionId = createHash("sha256")
  .update(key)
  .digest("hex")
  .slice(0, 32)
  .split("")
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join("");

const targetDir = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "NativeMessagingHosts",
);
const target = path.join(targetDir, `${HOST_NAME}.json`);

fs.mkdirSync(targetDir, { recursive: true });
fs.chmodSync(hostScript, 0o755);
fs.writeFileSync(
  target,
  `${JSON.stringify(
    {
      name: HOST_NAME,
      description: "爱吃红薯浏览器剪藏宿主（本地转发，无网络权限）",
      path: hostScript,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    null,
    2,
  )}\n`,
);

console.log(`原生宿主 manifest 已写入: ${target}`);
console.log(`扩展 ID: ${extensionId}`);
console.log("下一步：");
console.log("  1) Chrome → 扩展程序 → 打开开发者模式 → 加载已解压的扩展程序 → 选择 browser-extension/ 目录");
console.log("  2) 启动爱吃红薯桌面端并停留在「灵感」页");
console.log("  3) 在任意网页点击扩展按钮，回到灵感页确认剪藏");
