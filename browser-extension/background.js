// 爱吃红薯浏览器剪藏（N12 + 数据抓取）。
// 权限边界：仅 nativeMessaging + scripting + activeTab。
// 主入口是 popup（预览+模块勾选）；无弹窗点击工具栏时兜底全量抓取。
// 扩展只做消息传输，业务校验与账号盖章在 Tauri Rust 侧完成。

const NATIVE_HOST = "com.aichihongshu.host";
const PROTOCOL_VERSION = 3;

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

async function captureCurrentTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["extract.js"],
  });
  return result?.result ?? null;
}

async function sendCapture(tab) {
  setBadge("", undefined);
  if (!tab || !tab.id) return;
  let parsed;
  try {
    parsed = await captureCurrentTab(tab.id);
  } catch (error) {
    setBadge("!", "#d93025");
    return;
  }
  if (!parsed || !parsed.title) {
    setBadge("!", "#d93025");
    return;
  }
  const type = parsed.pageType === "profile" ? "ref_snapshot" : parsed.pageType === "note" ? "note_snapshot" : "clip";
  const message = {
    kind: type,
    pageType: parsed.pageType,
    materialType:
      parsed.pageType === "note"
        ? "note_material"
        : parsed.pageType === "profile"
          ? "profile_material"
          : "web_material",
    title: parsed.title,
    sourceUrl: parsed.sourceUrl,
    body: parsed.body,
    bodyExcerpt: parsed.bodyExcerpt || "",
    author: parsed.author || "",
    like: parsed.metrics?.like ?? null,
    collect: parsed.metrics?.collect ?? null,
    comment: parsed.metrics?.comment ?? null,
    followers: parsed.metrics?.followers ?? null,
    noteCount: parsed.metrics?.noteCount ?? null,
    observedAt: parsed.observedAt,
    modules: {
      collect: { titleBody: true, authorSource: true, images: false, comments: false },
      data: { metrics: true, publishedAt: false },
    },
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
  };
  chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
    if (chrome.runtime.lastError || !response || response.ok !== true) {
      setBadge("!", "#d93025");
      return;
    }
    setBadge("✓", "#1a7f37");
  });
}

chrome.action.onClicked.addListener((tab) => {
  void sendCapture(tab);
});
