// 爱吃红薯浏览器剪藏（N12 最小原型）。
// 权限边界：仅 nativeMessaging + scripting + activeTab。
// 不申请 tabs/cookies/history/host 权限，无常驻 content script；
// 只有用户点击扩展按钮时才对当前标签页注入一次抓取脚本。
// 扩展只做消息传输，不接触数据库、Cookie 或浏览器 profile；
// 业务校验与账号盖章在 Tauri Rust 侧完成（见 client/src-tauri/src/browser_capture.rs）。

const NATIVE_HOST = "com.aichihongshu.host";

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// 在页面上下文中执行：读取标题、地址、划词或正文。
// 保持自包含：MV3 executeScript 的 func 会被序列化后注入。
function extractCapture() {
  const selection = String((window.getSelection && window.getSelection()) || "").trim();
  const title = String(document.title || "").trim();
  const sourceUrl = String(location.href || "");
  let body = selection;
  if (!body) {
    const root = document.querySelector("main") || document.querySelector("article") || document.body;
    body = String((root && root.innerText) || "").trim();
  }
  return {
    title: title.slice(0, 200),
    sourceUrl: sourceUrl.slice(0, 2000),
    body: body.slice(0, 20000),
    reason: "",
    observedAt: new Date().toISOString(),
  };
}

chrome.action.onClicked.addListener(async (tab) => {
  setBadge("", undefined);
  if (!tab || !tab.id) return;
  let capture;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractCapture,
    });
    capture = result && result.result;
  } catch (error) {
    // chrome:// 等受限页面无法注入。
    setBadge("!", "#d93025");
    return;
  }
  if (!capture || !capture.title) {
    setBadge("!", "#d93025");
    return;
  }
  // requestId 让宿主重试保持幂等：同一页面重复剪藏会被队列去重。
  const message = { ...capture, requestId: crypto.randomUUID() };
  chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
    if (chrome.runtime.lastError || !response || response.ok !== true) {
      setBadge("!", "#d93025");
      return;
    }
    setBadge("✓", "#1a7f37");
  });
});
