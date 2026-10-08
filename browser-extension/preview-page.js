const storageApi = chrome.storage?.session;
const statusElement = document.getElementById("preview-status");
const identityElement = document.getElementById("preview-identity");
const contentElement = document.getElementById("preview-content");
let sessionRecord = null;
let viewerTabId = null;
let sessionKey = "";
let invalidated = false;

function clearSensitivePageState() {
  sessionRecord = null;
  contentElement.replaceChildren();
  if (sessionKey && storageApi) void chrome.storage.session.remove(sessionKey).catch(() => {});
}

function invalidatePreview(reason) {
  if (invalidated) return;
  invalidated = true;
  clearSensitivePageState();
  identityElement.textContent = "来源标签页已失效";
  statusElement.textContent = reason;
}

async function checkSourceStillMatches() {
  if (!sessionRecord || invalidated) return false;
  try {
    const source = await chrome.tabs.get(sessionRecord.sourceTabId);
    if (!source?.url || source.url !== sessionRecord.sourceUrl) {
      invalidatePreview("原采集来源已关闭或导航。请回到原页面重新打开插件并解析；本页不会改用当前活动标签页。 ");
      return false;
    }
    return true;
  } catch {
    invalidatePreview("原采集来源标签页已关闭或当前授权已失效。请回到原页面重新解析。 ");
    return false;
  }
}

async function loadPreviewSession() {
  if (!storageApi) {
    statusElement.textContent = "浏览器未提供 session 临时存储；请更新 Chrome/Edge 后重试。";
    return;
  }
  try {
    const viewer = await chrome.tabs.getCurrent();
    if (!viewer?.id) throw new Error("无法读取当前预览标签页身份");
    viewerTabId = viewer.id;
    sessionKey = globalThis.AichiPreviewSession.storageKey(viewerTabId);
    if (!sessionKey) throw new Error("当前预览标签页身份无效");
    const stored = await chrome.storage.session.get(sessionKey);
    const candidate = stored?.[sessionKey];
    await chrome.storage.session.remove(sessionKey);
    const result = globalThis.AichiPreviewSession.validate(candidate, { previewTabId: viewerTabId });
    if (!result.ok) throw new Error(result.reason);
    sessionRecord = result.record;
    if (!(await checkSourceStillMatches())) return;
    const model = globalThis.AichiCapturePreview.buildModel(sessionRecord.parsed, {
      pageType: sessionRecord.pageType,
      clipKind: sessionRecord.clipKind,
      modules: sessionRecord.modules,
      selectedImageIndexes: sessionRecord.selectedImageIndexes,
      activeImageIndex: sessionRecord.activeImageIndex,
      selectedCommentIndexes: sessionRecord.selectedCommentIndexes,
      pageContext: sessionRecord.pageContext,
      batchId: sessionRecord.parseBatchId,
    });
    globalThis.AichiCapturePreview.render(contentElement, model, {
      interactive: false,
      activeImageIndex: sessionRecord.activeImageIndex,
    });
    identityElement.textContent = `来源标签页 ${sessionRecord.sourceTabId} · 解析批次 ${sessionRecord.parseBatchId.slice(0, 8)} · 展开页只读`;
    statusElement.textContent = "一次性临时预览已打开；关闭此页后页面内容会清除。切换活动标签页不会改变绑定来源。";
  } catch (error) {
    clearSensitivePageState();
    identityElement.textContent = "未能验证来源身份";
    statusElement.textContent = error?.message || String(error);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (sessionRecord && tabId === sessionRecord.sourceTabId
    && (changeInfo.status === "loading" || (changeInfo.url && changeInfo.url !== sessionRecord.sourceUrl))) {
    invalidatePreview("原采集来源标签页已导航；为防止预览旧页面或采集新页面，本预览已清除。请回到来源页重新解析。 ");
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === sessionRecord?.sourceTabId) invalidatePreview("原采集来源标签页已关闭；本预览已清除。请重新解析来源页面。 ");
  if (tabId === viewerTabId && sessionKey && storageApi) void chrome.storage.session.remove(sessionKey).catch(() => {});
});

window.addEventListener("pagehide", clearSensitivePageState, { once: true });
document.getElementById("close-preview").addEventListener("click", async () => {
  clearSensitivePageState();
  if (viewerTabId != null) await chrome.tabs.remove(viewerTabId).catch(() => {});
});
void loadPreviewSession();
