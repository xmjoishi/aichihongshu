// 爱吃红薯浏览器剪藏（N12 + 数据抓取）。
// 权限边界：仅 nativeMessaging + scripting + activeTab + storage。
// 主入口是 popup（预览+模块勾选）；打开插件只做只读连接检测。
// 扩展只做消息传输，业务校验与账号盖章在 Tauri Rust 侧完成。
// The popup is the sole capture entry point. Opening the extension performs
// read-only connection checks; this worker only cleans one-time preview state.
const PREVIEW_SESSION_PREFIX = "aichi-capture-preview:";

if (typeof importScripts === "function") importScripts("capture-image-fetch.js");

chrome.runtime.onConnect?.addListener((port) => {
  if (port.name === "aichi.capture-image-transfer") {
    globalThis.AichiCaptureImageFetchWorker.handlePort(port);
  }
});

if (chrome.storage?.session?.setAccessLevel) {
  void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const key = Number.isInteger(tabId) && tabId > 0 ? `${PREVIEW_SESSION_PREFIX}${tabId}` : "";
  if (key && chrome.storage?.session) void chrome.storage.session.remove(key).catch(() => {});
});
