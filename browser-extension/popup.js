// 数据抓取弹窗：预解析当前页 → 查询当前账号归属 → 选择收藏或更新数据。
// 查询与回传均走 Native Messaging；本地查询只决定默认页，不自动入库。
const PROTOCOL_VERSION = 3;
const NATIVE_HOST = "com.aichihongshu.host";

const versionEl = document.getElementById("extension-version");
const connectionStatusEl = document.getElementById("connection-status");
const connectionStatusLabelEl = document.getElementById("connection-status-label");
const statusEl = document.getElementById("status");
const captureBtn = document.getElementById("capture");
const pageTypeEl = document.getElementById("page-type");
const previewMeta = document.getElementById("preview-meta");
const previewFields = document.getElementById("preview-fields");
const destinationEl = document.getElementById("destination");
const contextHint = document.getElementById("context-hint");
const collectTab = document.getElementById("tab-collect");
const dataTab = document.getElementById("tab-data");
const collectPanel = document.getElementById("collect-panel");
const dataPanel = document.getElementById("data-panel");
const wrapMetrics = document.getElementById("wrap-metrics");
const wrapPublished = document.getElementById("wrap-published");

const manifest = chrome.runtime.getManifest?.();
if (manifest?.version && versionEl) {
  versionEl.textContent = `v${manifest.version}`;
}

let parsed = null;
let restricted = false;
let pageContext = null;
let activeMode = "collect";
let contextLookupAvailable = false;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setConnectionStatus(state, label) {
  connectionStatusEl.className = `connection-status ${state}`;
  connectionStatusLabelEl.textContent = label;
}

function updateConnectionStatus(response, runtimeError = "") {
  const responseError = typeof response?.error === "string" ? response.error : "";
  if (responseError.startsWith("无法投递到爱吃红薯")) {
    setConnectionStatus("offline", "桌面端未连接");
  } else if (runtimeError) {
    setConnectionStatus("error", "连接异常");
  } else if (response) {
    // 即使业务查询返回错误，只要桌面端有响应，socket 链路就是连通的。
    setConnectionStatus("connected", "桌面端已连接");
  } else {
    setConnectionStatus("error", "连接状态未知");
  }
}

function setMode(mode) {
  if (mode === "data" && pageTypeEl.value === "web") return;
  activeMode = mode;
  collectTab.setAttribute("aria-selected", String(mode === "collect"));
  dataTab.setAttribute("aria-selected", String(mode === "data"));
  collectPanel.hidden = mode !== "collect";
  dataPanel.hidden = mode !== "data";
  renderPreview();
}

function sendNativeRequest(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      resolve({
        response: response ?? null,
        runtimeError: chrome.runtime.lastError?.message || "",
      });
    });
  });
}

async function lookupPageContext(page) {
  const { response, runtimeError } = await sendNativeRequest({
    action: "lookup_page_context",
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    sourceUrl: page.sourceUrl,
    pageType: page.pageType || "web",
  });
  updateConnectionStatus(response, runtimeError);
  if (!response?.context) return null;
  contextLookupAvailable = response.ok === true;
  return response.context;
}

async function checkDesktopConnection() {
  const { response, runtimeError } = await sendNativeRequest({
    action: "ping",
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
  });
  updateConnectionStatus(response, runtimeError);
}

function applyDefaultMode() {
  const update = pageContext?.defaultAction === "update_data";
  if (update && pageContext.pageType && pageContext.pageType !== "web") {
    pageTypeEl.value = pageContext.pageType;
  }
  document.getElementById("m-titleBody").checked = !update;
  document.getElementById("m-authorSource").checked = !update;
  document.getElementById("m-metrics").checked = update;
  document.getElementById("m-published").checked = false;
  setMode(update ? "data" : "collect");

  if (!contextLookupAvailable) {
    contextHint.textContent = "本地归属查询不可用，默认收藏内容；可手动切换到更新数据。";
    return;
  }
  if (update) {
    const target = pageContext.matchType === "own_note"
      ? "当前账号笔记"
      : pageContext.matchType.startsWith("reference_")
        ? "已跟踪的榜样内容"
        : pageContext.matchType.startsWith("saved_")
          ? "已收藏的笔记/主页"
        : "已有数据记录";
    const lastSeen = pageContext.lastSnapshotAt
      ? `上次采集：${pageContext.lastSnapshotAt}`
      : "尚无历史快照，将记录首次数据";
    contextHint.textContent = `已匹配${target}${pageContext.matchedTitle ? `「${pageContext.matchedTitle}」` : ""}。${lastSeen}`;
  } else {
    contextHint.textContent = "当前链接未匹配到本账号笔记或榜样，默认收藏内容；也可手动记录数据。";
  }
}

function fmtCount(n) {
  if (n == null) return "未识别";
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
  return String(n);
}

function renderPreview() {
  if (!parsed) return;

  // 主页不展示赞藏评块；网页隐藏更新数据区。
  const isProfile = pageTypeEl.value === "profile";
  const isWeb = pageTypeEl.value === "web";
  dataTab.disabled = isWeb;
  wrapMetrics.style.display = isWeb ? "none" : "";
  wrapPublished.style.display = isWeb ? "none" : "";
  if (isWeb) {
    document.getElementById("m-metrics").checked = false;
    document.getElementById("m-published").checked = false;
    activeMode = "collect";
  }
  collectPanel.hidden = activeMode !== "collect";
  dataPanel.hidden = activeMode !== "data" || isWeb;
  collectTab.setAttribute("aria-selected", String(activeMode === "collect"));
  dataTab.setAttribute("aria-selected", String(activeMode === "data" && !isWeb));

  const lines = [];
  lines.push(`<div><strong>标题</strong>：${escapeHtml(parsed.title || "（无）")}</div>`);
  if (document.getElementById("m-authorSource").checked) {
    lines.push(
      `<div><strong>作者/来源</strong>：${escapeHtml(parsed.author || "未识别")} · <span class="muted">${escapeHtml(truncate(parsed.sourceUrl, 48))}</span></div>`,
    );
  }
  if (document.getElementById("m-titleBody").checked) {
    lines.push(`<div class="muted">${escapeHtml(truncate(parsed.bodyExcerpt || parsed.body, 80))}</div>`);
  }
  if (!isWeb && document.getElementById("m-metrics").checked) {
    const m = parsed.metrics || {};
    if (isProfile) {
      lines.push(
        `<div><strong>主页数据</strong>：粉丝 ${fmtCount(m.followers)} · 笔记 ${fmtCount(m.noteCount)}</div>`,
      );
    } else {
      lines.push(
        `<div><strong>互动</strong>：赞 ${fmtCount(m.like)} · 藏 ${fmtCount(m.collect)} · 评 ${fmtCount(m.comment)}</div>`,
      );
    }
  }
  previewFields.innerHTML = lines.join("");

  const collect = document.getElementById("m-titleBody").checked
    || document.getElementById("m-authorSource").checked;
  const updateData = !isWeb && document.getElementById("m-metrics").checked;
  const dest = [];
  if (collect) dest.push("素材库（收集素材）");
  if (updateData) dest.push("快照表（更新数据）");
  destinationEl.textContent = dest.length
    ? `本次去向：${dest.join(" + ")}`
    : "请至少勾选一个模块";
  captureBtn.disabled = restricted || dest.length === 0;
  captureBtn.textContent = collect && updateData
    ? "收藏内容并记录数据"
    : updateData
      ? (pageContext?.lastSnapshotAt ? "更新数据快照" : "记录首次数据")
      : "收藏到素材库";

  previewMeta.textContent = restricted
    ? "当前页不可抓取（受限页面）"
    : `识别为「${typeLabel(pageTypeEl.value)}」· 可切换操作页，保存前会再次确认`;
}

function typeLabel(t) {
  return t === "note" ? "笔记页" : t === "profile" ? "主页 / 账号" : "网页素材";
}

function truncate(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function selectedModules() {
  return {
    collect: {
      titleBody: document.getElementById("m-titleBody").checked,
      authorSource: document.getElementById("m-authorSource").checked,
      images: false,
      comments: false,
    },
    data: {
      metrics: document.getElementById("m-metrics").checked,
      publishedAt: document.getElementById("m-published").checked,
    },
  };
}

async function loadPreview() {
  captureBtn.disabled = true;
  setConnectionStatus("checking", "正在检测");
  setStatus("解析中…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有活动标签页");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["extract.js"],
    });
    parsed = result?.result ?? null;
    if (!parsed || !parsed.title) {
      restricted = true;
      previewMeta.textContent = "当前页不可抓取（chrome:// 等受限页面）";
      captureBtn.disabled = true;
      await checkDesktopConnection();
      setStatus("");
      return;
    }
    restricted = false;
    pageTypeEl.value = parsed.pageType || "web";
    setStatus("正在查询当前账号中的页面归属…");
    pageContext = await lookupPageContext(parsed);
    applyDefaultMode();
    renderPreview();
    setStatus("");
  } catch (error) {
    restricted = true;
    previewMeta.textContent = "当前页不可抓取";
    captureBtn.disabled = true;
    await checkDesktopConnection();
    setStatus(String(error?.message || error), true);
  }
}

["m-titleBody", "m-authorSource", "m-metrics", "m-published"].forEach((id) => {
  document.getElementById(id).addEventListener("change", renderPreview);
});
collectTab.addEventListener("click", () => setMode("collect"));
dataTab.addEventListener("click", () => setMode("data"));
pageTypeEl.addEventListener("change", () => {
  if (pageTypeEl.value === "web") activeMode = "collect";
  renderPreview();
});

captureBtn.addEventListener("click", () => {
  if (!parsed || restricted) return;
  const modules = selectedModules();
  const type = pageTypeEl.value;
  const collectOn = modules.collect.titleBody || modules.collect.authorSource;
  const dataOn = modules.data.metrics;
  const contextKind = pageContext?.pageType === type ? pageContext.snapshotKind : null;
  const kind = type === "web" && !dataOn
    ? "clip"
    : contextKind || (type === "profile" ? "ref_snapshot" : type === "note" ? "note_snapshot" : "clip");

  const message = {
    kind,
    pageType: type,
    materialType:
      type === "note" ? "note_material" : type === "profile" ? "profile_material" : "web_material",
    title: parsed.title,
    sourceUrl: parsed.sourceUrl,
    body: modules.collect.titleBody ? parsed.body : "",
    bodyExcerpt: parsed.bodyExcerpt || "",
    author: modules.collect.authorSource ? parsed.author : "",
    like: modules.data.metrics ? (parsed.metrics?.like ?? null) : null,
    collect: modules.data.metrics ? (parsed.metrics?.collect ?? null) : null,
    comment: modules.data.metrics ? (parsed.metrics?.comment ?? null) : null,
    followers: modules.data.metrics ? (parsed.metrics?.followers ?? null) : null,
    noteCount: modules.data.metrics ? (parsed.metrics?.noteCount ?? null) : null,
    observedAt: parsed.observedAt,
    modules,
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
  };

  captureBtn.disabled = true;
  setStatus("回传中…");
  chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
    const runtimeError = chrome.runtime.lastError?.message || "";
    updateConnectionStatus(response, runtimeError);
    captureBtn.disabled = false;
    if (runtimeError || !response || response.ok !== true) {
      const detail = response?.error || runtimeError;
      setStatus(
        detail
          ? `回传失败：${detail}`
          : "回传失败：桌面端未运行，或需在设置→浏览器插件重新「安装/更新插件」后重启浏览器",
        true,
      );
      return;
    }
    if (collectOn && dataOn) {
      setStatus(response.collectionSaved === true
        ? "收藏已入库；数据快照结果请看桌面端提示 ✓"
        : "已送达桌面端；请看应用内保存结果");
    } else if (dataOn) {
      setStatus("已送达桌面端；请看应用内保存结果");
    } else {
      setStatus(response.collectionSaved === true ? "已直接保存到网页收藏 ✓" : "已送达桌面端");
    }
  });
});

void loadPreview();
