import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const checks = [
  ["client/src/lib/browserCapture.ts", ["validateBrowserCapture", "ACCOUNT_MISMATCH", "MAX_MESSAGE_BYTES", "dedupeKey", "BrowserCaptureEnvelope", "pending_confirmation", "readBrowserCaptureQueue", "removeBrowserCaptureQueueEntry", "markBrowserCaptureSaving", "markBrowserCaptureFailed", "requestId"]],
  ["client/src/components/BrowserCaptureBridge.tsx", ["validateBrowserCapture", "saveLocalInspiration", "savePageSnapshot", "LOCAL_INSPIRATIONS_UPDATED_EVENT", "browser-capture://message"]],
  ["client/src/components/BrowserCollectionPanel.tsx", ["readBrowserCaptureQueue", "旧剪藏迁入失败", "LOCAL_INSPIRATIONS_UPDATED_EVENT", "已剪藏", "搜索标题、正文、作者、来源", "最近采集", "打开原文"]],
  ["browser-extension/manifest.json", ["nativeMessaging", "scripting", "activeTab", "storage"]],
  ["browser-extension/extract.js", ["IMAGE_CONTAINER_SELECTORS", "noteDetailScope", "imageRootForCurrentPage", "srcsetCandidates", "backgroundImageUrl", "container-not-found", "not-loaded", "unsupported-structure"]],
  ["browser-extension/background.js", ["PREVIEW_SESSION_PREFIX", "chrome.tabs.onRemoved", "TRUSTED_CONTEXTS"]],
  ["browser-extension/host/host.cjs", ["browser-capture.sock", "AICHIHONGSHU_CAPTURE_SOCKET"]],
  ["browser-extension/host/host.cjs", ["MAX_RESPONSE_BYTES = 160 * 1024"]],
  ["browser-extension/install-host.mjs", ["此旧版 Node 宿主安装脚本已停用"]],
  ["browser-extension/popup.js", ["PROTOCOL_VERSION = 12", "NATIVE_IMAGE_ACTION_TIMEOUT_MS = 15_000", "NATIVE_IMAGE_FINISH_TIMEOUT_MS = 35_000", "NATIVE_HOSTS", "list_capture_instances", "launch_capture_instance", "collectionSaved", "captureDetailsSaved", "snapshotSaved", "profileNotesSaved", "imageTransferProtocol", "begin_capture_image_upload", "write_capture_image_chunk", "read_image_chunk", "finish_capture_image_upload", "fail_capture_image_upload", "clipKind", "saveStagedCaptureBtn"]],
  ["browser-extension/popup.html", ["native-bridge.js", "capture-image-client.js", "capture-recovery.js", "connection-diagnostics.js", "advanced-connection", "dev-mode-toggle", "clip-type-label", "existing-actions", "update-content", "refresh-data", "stage-capture", "save-staged-capture", "cancel-staged-capture", "popup.js"]],
  ["browser-extension/capture-image-client.js", ["aichi.capture-image-transfer", "rejectPending", "captureRequestId", "expectedChannel", "expectedWorkspaceId", "defaultTimeoutMs"]],
  ["browser-extension/capture-image-fetch.js", ["fetch_selected_image", "credentials: \"omit\"", "referrerPolicy: \"no-referrer\"", "MAX_IMAGE_BYTES", "MAX_CHUNK_BYTES", "crypto.subtle.digest", "port.onDisconnect"]],
  ["browser-extension/connection-diagnostics.js", ["HOST_MISSING", "HOST_REGISTRATION_OLD", "HOST_START_FAILED", "INSTANCE_OFFLINE", "PROTOCOL_INCOMPATIBLE", "ACCOUNT_READ_FAILED", "UNKNOWN_TIMEOUT", "redactedRecord"]],
  ["browser-extension/capture-recovery.js", ["buildLookupRequest", "missingOutcomes", "matchesIdentity", "matchesRequest", "classifySaveResponse", "requestId: message.requestId", "targetAccountId: message.targetAccountId"]],
  ["browser-extension/profile-notes.js", ["MAX_NOTES = 30", "MAX_SCROLLS = 16", "verification-required", "login-required", "noteUrl: canonicalUrl"]],
  ["browser-extension/capture-preview.js", ["buildModel", "buildCaptureMessage", "lastSnapshotMetrics", "comment-disclosure", "image-stage", "material-image-grid", "imageSelection.has(index)", "commentSelection.has(index)"]],
  ["browser-extension/preview-session.js", ["storageKey", "sourceTabId", "parseBatchId", "MAX_AGE_MS"]],
  ["browser-extension/preview-page.js", ["chrome.storage.session.get", "chrome.storage.session.remove", "chrome.tabs.onUpdated", "chrome.tabs.onRemoved", "checkSourceStillMatches"]],
  ["browser-extension/native-bridge.js", ["Native Messaging 请求超时", "Native Messaging Port 请求超时", "rejectPending", "globalThis.AichiNativeBridge"]],
  ["browser-extension/creator-fill.js", ["creator.xiaohongshu.com", "data-placeholder*", "confirmReplace !== true", "MAX_IMAGE_CHUNK_BYTES", "MAX_VIDEO_CHUNK_BYTES", "creator-video-chunk", "crypto.subtle.digest", "new DataTransfer()", "input.dispatchEvent(new Event(\"change\""]],
  ["client/src-tauri/src/browser_capture.rs", ["browser-capture://message", "target_account_id", "PROTOCOL_VERSION: u16 = 12", "profileNotesState", "lookup_capture_request", "begin_capture_image_upload", "write_capture_image_chunk", "finish_capture_image_upload", "fail_capture_image_upload", "claim_browser_publish_fill_task", "read_browser_publish_fill_image_chunk", "read_publish_fill_video_chunk", "finish_browser_publish_fill_task", "MAX_WIRE_BYTES", "save_browser_capture_inspiration", "save_browser_page_snapshot", "captureDetailsSaved"]],
  ["client/src-tauri/src/browser_capture.rs", ["include_bytes!(\"../../../browser-extension/creator-fill.js\")", "profile-notes.js", "capture-recovery.js", "fn verify_extension_tree", "--native-messaging-host", "browser-extension.previous-", "com.aichihongshu.host.dev", "AICHIHONGSHU_CAPTURE_CHANNEL"]],
  ["client/src-tauri/src/native_host.rs", ["MAX_MESSAGE_BYTES: usize = 256 * 1024", "MAX_RESPONSE_BYTES: usize = 160 * 1024", "native_host_reads_a_persistent_port_until_clean_eof", "assert_eq!(MAX_RESPONSE_BYTES, 160 * 1024)"]],
  ["client/src-tauri/src/db/browser.rs", ["save_browser_capture_payload", "lookup_browser_capture_request", "capture_payload", "attach_browser_capture_assets"]],
  ["client/src-tauri/src/db/publish_fill.rs", ["claim_browser_publish_fill_task", "read_browser_publish_fill_image_chunk", "MAX_FILL_IMAGE_CHUNK_BYTES", "safe_fill_image_path", "validated_image_metadata", "fill_claim_token", "FILL_CLAIM_SECONDS"]],
];
const failures = [];
for (const [file, markers] of checks) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const marker of markers) if (!source.includes(marker)) failures.push(`${file}: missing ${marker}`);
}
if (failures.length) { console.error(failures.join("\n")); process.exit(2); }
const backgroundSource = fs.readFileSync(path.join(root, "browser-extension/background.js"), "utf8");
if (/chrome\.action\.onClicked|chrome\.scripting\.executeScript|chrome\.runtime\.(sendNativeMessage|connectNative)/.test(backgroundSource)) {
  failures.push("browser-extension/background.js: opening the extension must not start capture or launch a Native Host");
}
const popupSource = fs.readFileSync(path.join(root, "browser-extension/popup.js"), "utf8");
if ((popupSource.match(/launchSelectedDesktop\s*\(/g) ?? []).length !== 2
  || !popupSource.includes('launchDesktopBtn.addEventListener("click", () => void launchSelectedDesktop())')) {
  failures.push("browser-extension/popup.js: desktop launch must be reachable only through the explicit launch button");
}
if ((popupSource.match(/await retainStagedCapture\s*\(/g) ?? []).length !== 1
  || !popupSource.includes('stageCaptureBtn.addEventListener("click", async () =>')) {
  failures.push("browser-extension/popup.js: offline staging must require the explicit stage button");
}
if (failures.length) { console.error(failures.join("\n")); process.exit(2); }
for (const file of ["browser-extension/popup.js", "browser-extension/background.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  if (/chrome\.runtime\.(sendNativeMessage|connectNative)\s*\(/.test(source)) {
    failures.push(`${file}: Native Messaging calls must go through the bounded bridge`);
  }
}
if (failures.length) { console.error(failures.join("\n")); process.exit(2); }
execFileSync(process.execPath, [path.join(root, "scripts/browser-capture-fixtures.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/capture-preview-fixtures.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/capture-image-fetch-fixtures.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/popup-image-transfer-fixtures.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/preview-session-fixtures.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/popup-layout-fixtures.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/popup-race-fixtures.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/publish-fill-fixtures.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/native-bridge-fixtures.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/capture-recovery-fixtures.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/connection-diagnostics-fixtures.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/profile-notes-fixtures.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [path.join(root, "scripts/package-browser-extension.mjs")], { stdio: "inherit" });
console.log(JSON.stringify({ ok: true, scope: "browser-capture-host-validation", files: checks.length }));
