import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const checks = [
  ["client/src/lib/browserCapture.ts", ["validateBrowserCapture", "ACCOUNT_MISMATCH", "MAX_MESSAGE_BYTES", "dedupeKey", "BrowserCaptureEnvelope", "pending_confirmation", "enqueueBrowserCapture", "markBrowserCaptureSaving", "markBrowserCaptureFailed", "requestId"]],
  ["client/src/pages/Inspire.tsx", ["validateBrowserCapture", "targetAccountId", "transport: \"manual\"", "dedupeKey", "AICHIHONGSHU_BROWSER_CAPTURE", "aichihongshu-browser-capture", "browser-capture://message", "确认保存", "重试", "readBrowserCaptureQueue"]],
  ["browser-extension/manifest.json", ["nativeMessaging", "scripting", "activeTab"]],
  ["browser-extension/host/host.cjs", ["browser-capture.sock", "AICHIHONGSHU_CAPTURE_SOCKET"]],
  ["browser-extension/install-host.mjs", ["com.aichihongshu.host", "NativeMessagingHosts", "allowed_origins"]],
  ["client/src-tauri/src/browser_capture.rs", ["browser-capture://message", "target_account_id", "MAX_WIRE_BYTES"]],
];
const failures = [];
for (const [file, markers] of checks) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const marker of markers) if (!source.includes(marker)) failures.push(`${file}: missing ${marker}`);
}
if (failures.length) { console.error(failures.join("\n")); process.exit(2); }
console.log(JSON.stringify({ ok: true, scope: "browser-capture-host-validation", files: checks.length }));
