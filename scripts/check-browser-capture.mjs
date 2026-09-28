import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const checks = [
  ["client/src/lib/browserCapture.ts", ["validateBrowserCapture", "ACCOUNT_MISMATCH", "MAX_MESSAGE_BYTES", "dedupeKey", "BrowserCaptureEnvelope", "pending_confirmation", "readBrowserCaptureQueue", "removeBrowserCaptureQueueEntry", "markBrowserCaptureSaving", "markBrowserCaptureFailed", "requestId"]],
  ["client/src/components/BrowserCaptureBridge.tsx", ["validateBrowserCapture", "saveLocalInspiration", "savePageSnapshot", "LOCAL_INSPIRATIONS_UPDATED_EVENT", "browser-capture://message"]],
  ["client/src/components/BrowserCollectionPanel.tsx", ["readBrowserCaptureQueue", "旧剪藏迁入失败", "LOCAL_INSPIRATIONS_UPDATED_EVENT", "已收藏内容", "搜索标题、正文、作者、来源", "最近收藏", "打开原文"]],
  ["browser-extension/manifest.json", ["nativeMessaging", "scripting", "activeTab"]],
  ["browser-extension/host/host.cjs", ["browser-capture.sock", "AICHIHONGSHU_CAPTURE_SOCKET"]],
  ["browser-extension/install-host.mjs", ["com.aichihongshu.host", "NativeMessagingHosts", "allowed_origins"]],
  ["browser-extension/popup.js", ["collectionSaved", "已直接保存到网页收藏", "请看应用内保存结果"]],
  ["client/src-tauri/src/browser_capture.rs", ["browser-capture://message", "target_account_id", "MAX_WIRE_BYTES", "save_local_inspiration", "collectionSaved"]],
];
const failures = [];
for (const [file, markers] of checks) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const marker of markers) if (!source.includes(marker)) failures.push(`${file}: missing ${marker}`);
}
if (failures.length) { console.error(failures.join("\n")); process.exit(2); }
console.log(JSON.stringify({ ok: true, scope: "browser-capture-host-validation", files: checks.length }));
