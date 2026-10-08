// 数据抓取弹窗：预解析当前页 → 查询当前账号归属 → 选择收藏或更新数据。
// 查询与回传均走 Native Messaging；本地查询只决定默认页，不自动入库。
const PROTOCOL_VERSION = 12;
const NATIVE_HOSTS = { prod: "com.aichihongshu.host", dev: "com.aichihongshu.host.dev" };
const NATIVE_IMAGE_ACTION_TIMEOUT_MS = 15_000;
const NATIVE_IMAGE_FINISH_TIMEOUT_MS = 35_000;

const versionEl = document.getElementById("extension-version");
const connectionStatusEl = document.getElementById("connection-status");
const connectionStatusLabelEl = document.getElementById("connection-status-label");
const connectionDetailEl = document.getElementById("connection-detail");
const retryConnectionBtn = document.getElementById("retry-connection");
const launchDesktopBtn = document.getElementById("launch-desktop");
const connectionRemedyEl = document.getElementById("connection-remedy");
const advancedConnectionEl = document.getElementById("advanced-connection");
const devModeToggle = document.getElementById("dev-mode-toggle");
const instancePickerRow = document.getElementById("instance-picker-row");
const instancePicker = document.getElementById("instance-picker");
const connectInstanceBtn = document.getElementById("connect-instance");
const instancePickerStatusEl = document.getElementById("instance-picker-status");
const statusEl = document.getElementById("status");
const captureBtn = document.getElementById("capture");
const pageTypeEl = document.getElementById("page-type");
const clipKindEl = document.getElementById("clip-kind");
const targetAccountEl = document.getElementById("target-account");
const targetAccountRowEl = document.getElementById("target-account-row");
const accountStatusEl = document.getElementById("account-status");
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
const imageSelectionCountEl = document.getElementById("image-selection-count");
const commentSelectionCountEl = document.getElementById("comment-selection-count");
const expandPreviewBtn = document.getElementById("expand-preview");
const clipTypeLabelEl = document.getElementById("clip-type-label");
const existingActionsEl = document.getElementById("existing-actions");
const existingContentLabelEl = document.getElementById("existing-content-label");
const updateContentBtn = document.getElementById("update-content");
const refreshDataBtn = document.getElementById("refresh-data");
const creatorFillPanel = document.getElementById("creator-fill-panel");
const creatorClaimBtn = document.getElementById("creator-claim");
const creatorTaskPreview = document.getElementById("creator-task-preview");
const creatorFillBtn = document.getElementById("creator-fill");
const creatorRetryBtn = document.getElementById("creator-retry");
const creatorCancelBtn = document.getElementById("creator-cancel");
const creatorConfirmFill = document.getElementById("creator-confirm-fill");
const creatorFillResult = document.getElementById("creator-fill-result");
const creatorFillMeta = document.getElementById("creator-fill-meta");
const creatorImageList = document.getElementById("creator-image-list");
const verifyCaptureBtn = document.getElementById("verify-capture");
const retryCaptureBtn = document.getElementById("retry-capture");
const stageCaptureBtn = document.getElementById("stage-capture");
const saveStagedCaptureBtn = document.getElementById("save-staged-capture");
const cancelStagedCaptureBtn = document.getElementById("cancel-staged-capture");

const manifest = chrome.runtime.getManifest?.();
const extensionChannel = manifest?.name?.endsWith("DEV") ? "dev" : "prod";
let expectedChannel = extensionChannel;
let devModeEnabled = extensionChannel === "dev";
let selectedWorkspaceByChannel = { prod: "", dev: "" };
let availableInstances = [];
let stagedCaptureMessage = null;
let stagedCaptureChannel = "";
let stagedCaptureWorkspaceId = "";
let sessionAccounts = [];
let verifiedAccountsWorkspaceId = "";
let connectionFailureCode = "";
if (manifest?.version && versionEl) {
  versionEl.textContent = `v${manifest.version}`;
}
if (expectedChannel === "dev") {
  document.getElementById("popup-title").textContent = "爱吃红薯数据抓取 DEV";
}

let parsed = null;
let parseBatchId = "";
let sourceTabId = null;
let sourceTabUrl = "";
let selectedImageSet = new Set();
let selectedCommentSet = new Set();
let commentsOpen = false;
let profileNotesOpen = false;
let activeImageIndex = 0;
let restricted = false;
let pageContext = null;
let activeMode = "collect";
let contextLookupAvailable = false;
let creatorTabId = null;
let creatorPageUrl = "";
let creatorClaim = null;
let creatorTaskBody = "";
let creatorPreviewCurrent = null;
let creatorBusy = false;
let creatorCancelRequested = false;
let desktopConnected = false;
let pageEpoch = 0;
let lookupEpoch = 0;
let configurationEdited = false;
let savingCapture = false;
let preparingCapture = false;
let verifyingCapture = false;
let pendingCaptureMessage = null;
let connectedWorkspaceId = "";
const PENDING_CAPTURE_KEY = "aichi-capture-pending";

async function retainPendingCapture(message) {
  if (!chrome.storage?.session) throw new Error("临时恢复存储不可用，尚未发送；请重载扩展后重试");
  await chrome.storage.session.set({ [PENDING_CAPTURE_KEY]: {
    message, workspaceId: connectedWorkspaceId, channel: expectedChannel, createdAt: Date.now(),
  } });
}

const CONNECTION_PREF_KEY = "aichi-capture-connection-preference";
const STAGED_CAPTURE_KEY = "aichi-capture-staged";
const SESSION_UI_KEY = "aichi-capture-ui-state";
const SESSION_ACCOUNTS_KEY = "aichi-capture-known-accounts";

function nativeHostName() {
  return NATIVE_HOSTS[expectedChannel];
}

async function readConnectionPreference() {
  const stored = await chrome.storage?.local?.get(CONNECTION_PREF_KEY);
  const value = stored?.[CONNECTION_PREF_KEY] || {};
  devModeEnabled = extensionChannel === "dev" || value.devMode === true;
  expectedChannel = devModeEnabled ? "dev" : "prod";
  selectedWorkspaceByChannel = {
    prod: typeof value.selectedWorkspaceByChannel?.prod === "string" ? value.selectedWorkspaceByChannel.prod : "",
    dev: typeof value.selectedWorkspaceByChannel?.dev === "string" ? value.selectedWorkspaceByChannel.dev : "",
  };
  connectedWorkspaceId = selectedWorkspaceByChannel[expectedChannel] || "";
  devModeToggle.checked = devModeEnabled;
  document.getElementById("popup-title").textContent = expectedChannel === "dev"
    ? "爱吃红薯数据抓取 DEV"
    : "爱吃红薯数据抓取";
}

async function saveConnectionPreference() {
  await chrome.storage?.local?.set({ [CONNECTION_PREF_KEY]: {
    devMode: devModeEnabled,
    selectedWorkspaceByChannel,
  } });
}

async function clearPendingCapture() {
  await chrome.storage?.session?.remove(PENDING_CAPTURE_KEY);
  pendingCaptureMessage = null;
  updateConnectionControls();
}

async function restorePendingCapture() {
  if (!chrome.storage?.session) return;
  const stored = (await chrome.storage.session.get(PENDING_CAPTURE_KEY))?.[PENDING_CAPTURE_KEY];
  if (!stored) return;
  if (stored.channel !== expectedChannel) return;
  const age = Date.now() - Number(stored.createdAt);
  if (!Number.isFinite(age) || age < 0
    || !stored.workspaceId || !globalThis.AichiCaptureRecovery.buildLookupRequest(stored.message, PROTOCOL_VERSION)) {
    await chrome.storage.session.remove(PENDING_CAPTURE_KEY);
    return;
  }
  pendingCaptureMessage = stored.message;
  connectedWorkspaceId = stored.workspaceId;
  selectedWorkspaceByChannel[expectedChannel] = stored.workspaceId;
  await saveConnectionPreference();
  verifyCaptureBtn.hidden = false;
  setStatus(`检测到账号 ${stored.message.targetAccountId} 的未确认保存；连接后将按原请求核实，不会自动重发。`);
}

async function retainStagedCapture(message) {
  if (!chrome.storage?.session) throw new Error("临时恢复存储不可用，采集内容尚未暂存");
  const record = {
    message,
    channel: expectedChannel,
    workspaceId: connectedWorkspaceId || selectedWorkspaceByChannel[expectedChannel] || "",
    createdAt: Date.now(),
    stage: "user_requested_offline",
  };
  await chrome.storage.session.set({ [STAGED_CAPTURE_KEY]: record });
  stagedCaptureMessage = message;
  stagedCaptureChannel = record.channel;
  stagedCaptureWorkspaceId = record.workspaceId;
}

async function restoreStagedCapture() {
  if (!chrome.storage?.session) return;
  const stored = (await chrome.storage.session.get(STAGED_CAPTURE_KEY))?.[STAGED_CAPTURE_KEY];
  if (!stored) return;
  if (stored.channel !== expectedChannel) return;
  const age = Date.now() - Number(stored.createdAt);
  if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000
    || !stored.message?.requestId || !Number.isInteger(Number(stored.message?.targetAccountId))) {
    await chrome.storage.session.remove(STAGED_CAPTURE_KEY);
    return;
  }
  stagedCaptureMessage = stored.message;
  stagedCaptureChannel = stored.channel;
  stagedCaptureWorkspaceId = stored.workspaceId || "";
  if (stored.workspaceId) {
    connectedWorkspaceId = stored.workspaceId;
    selectedWorkspaceByChannel[expectedChannel] = stored.workspaceId;
    await saveConnectionPreference();
  }
  setStatus("已暂存到浏览器会话；尚未保存到桌面端。连接后请核对目标账号，再点击保存。");
}

async function clearStagedCapture() {
  await chrome.storage?.session?.remove(STAGED_CAPTURE_KEY);
  stagedCaptureMessage = null;
  stagedCaptureChannel = "";
  stagedCaptureWorkspaceId = "";
  updateConnectionControls();
}

function isCreatorPublishUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "creator.xiaohongshu.com"
      && (url.pathname === "/publish" || url.pathname.startsWith("/publish/"));
  } catch {
    return false;
  }
}

function setCreatorWorkflowVisible(visible) {
  document.body.classList.toggle("creator-mode", visible);
  creatorFillPanel.hidden = !visible;
  document.querySelector(".mode-tabs").hidden = visible;
  contextHint.hidden = visible;
  collectPanel.hidden = visible;
  dataPanel.hidden = visible;
  destinationEl.hidden = visible;
  captureBtn.hidden = visible;
  document.getElementById("page-type-row").hidden = visible;
  expandPreviewBtn.disabled = visible || !parsed || restricted;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setConnectionStatus(state, label) {
  connectionStatusEl.className = `connection-status ${state}`;
  connectionStatusLabelEl.textContent = label;
}

function reportConnectionFailure({ response = null, runtimeError = "", timedOut = false, step = "desktop_instance", action = "" } = {}) {
  const diagnostic = globalThis.AichiConnectionDiagnostics.classify({ response, runtimeError, timedOut, step, action });
  connectionFailureCode = diagnostic.code;
  desktopConnected = false;
  setConnectionStatus(diagnostic.code === "PROTOCOL_INCOMPATIBLE" ? "error" : "offline", diagnostic.label);
  connectionDetailEl.textContent = `失败步骤：${step === "host" ? "浏览器宿主" : step === "account_read" ? "本地账号读取" : step === "version_handshake" ? "版本握手" : "桌面实例"} · ${diagnostic.code}`;
  connectionRemedyEl.textContent = diagnostic.action;
  advancedConnectionEl.open = true;
  retryConnectionBtn.hidden = false;
  launchDesktopBtn.hidden = diagnostic.code !== "INSTANCE_OFFLINE" && diagnostic.code !== "INSTANCE_START_FAILED";
  if (creatorTabId !== null) creatorClaimBtn.disabled = true;
  if (parsed) renderPreview();
  return false;
}

function updateConnectionStatus(response, runtimeError = "", timedOut = false) {
  const identityMatches = globalThis.AichiCaptureRecovery.matchesIdentity(response, expectedChannel, connectedWorkspaceId);
  const protocol = Number(response?.protocolVersion || 0);
  if (runtimeError || timedOut || !response) {
    return reportConnectionFailure({ response, runtimeError, timedOut, step: "host", action: "ping" });
  }
  if (response?.errorCode) {
    return reportConnectionFailure({ response, step: response.errorCode === "ACCOUNT_READ_FAILED" ? "account_read" : "desktop_instance", action: "ping" });
  }
  if (response.channel !== expectedChannel) {
    return reportConnectionFailure({ response: { ...response, errorCode: "CHANNEL_MISMATCH" }, step: "version_handshake", action: "ping" });
  }
  if (!identityMatches) {
    return reportConnectionFailure({ response: { ...response, errorCode: "INSTANCE_MISMATCH" }, step: "desktop_instance", action: "ping" });
  }
  if (protocol !== PROTOCOL_VERSION) {
    return reportConnectionFailure({ response: { ...response, errorCode: "PROTOCOL_INCOMPATIBLE" }, step: "version_handshake", action: "ping" });
  }
  desktopConnected = response?.ok === true;
  connectionFailureCode = desktopConnected ? "" : "UNKNOWN_ERROR";
  if (desktopConnected) {
    selectedWorkspaceByChannel[expectedChannel] = connectedWorkspaceId;
    void saveConnectionPreference();
    setConnectionStatus("connected", expectedChannel === "dev" ? "DEV 已连接" : "正式版已连接");
    connectionDetailEl.textContent = `工作区 ${response.workspaceId} · 应用 v${response.appVersion || "?"} · 协议 v${protocol}`;
    connectionRemedyEl.textContent = "插件、Native Host、桌面实例和协议握手已连通。";
    advancedConnectionEl.open = false;
    retryConnectionBtn.hidden = true;
    launchDesktopBtn.hidden = true;
  } else {
    reportConnectionFailure({ response, step: "desktop_instance", action: "ping" });
  }
  if (creatorTabId !== null) {
    creatorClaimBtn.disabled = !targetAccountEl.value || !desktopConnected || Boolean(creatorClaim);
  }
  if (parsed) renderPreview();
  return identityMatches;
}

function setMode(mode, manual = true) {
  if (mode === "data" && pageTypeEl.value === "web") return;
  if (manual) configurationEdited = true;
  activeMode = mode;
  if (updateContentBtn) updateContentBtn.setAttribute("aria-pressed", String(mode === "collect"));
  if (refreshDataBtn) refreshDataBtn.setAttribute("aria-pressed", String(mode === "data"));
  collectTab.setAttribute("aria-selected", String(mode === "collect"));
  dataTab.setAttribute("aria-selected", String(mode === "data"));
  collectTab.tabIndex = mode === "collect" ? 0 : -1;
  dataTab.tabIndex = mode === "data" ? 0 : -1;
  collectPanel.hidden = mode !== "collect";
  dataPanel.hidden = mode !== "data";
  renderPreview();
  void persistUiSelection();
}

function diagnosticStepForAction(action) {
  return action === "list_capture_accounts" || action === "lookup_page_context" ? "account_read" : "version_handshake";
}

function sendNativeRequest(message, { includeWorkspace = true, timeoutMs = 5_000 } = {}) {
  const step = diagnosticStepForAction(message.action);
  return globalThis.AichiNativeBridge.sendRequest(nativeHostName(), {
    ...message,
    expectedChannel,
    ...(includeWorkspace ? { expectedWorkspaceId: connectedWorkspaceId } : {}),
    diagnostic: { step, startedAtMs: Date.now() },
  }, timeoutMs);
}

function responseMatchesExpectedIdentity(response) {
  return globalThis.AichiCaptureRecovery.matchesIdentity(response, expectedChannel, connectedWorkspaceId);
}

function openNativePort() {
  const port = globalThis.AichiNativeBridge.openPort(nativeHostName(), 5_000);
  const workspaceId = connectedWorkspaceId;
  return { close: port.close, request: (message, timeoutMs) => port.request({
    ...message, expectedChannel, expectedWorkspaceId: workspaceId,
  }, timeoutMs) };
}

function imagePermissionOrigins(images) {
  const origins = new Set();
  for (const image of images || []) {
    let url;
    try { url = new URL(String(image?.url || "")); } catch { throw new Error("所选原图链接无效；请回到页面重新识别"); }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const hostParts = host.split(".");
    const numericHost = hostParts.every((part) => /^\d+$/.test(part));
    const octets = hostParts.map((part) => /^\d+$/.test(part) ? Number(part) : NaN);
    const validIpv4 = numericHost && octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
    const privateIpv4 = validIpv4 && (
      octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || (octets[0] === 192 && octets[1] === 0 && [0, 2].includes(octets[2]))
      || (octets[0] === 198 && [18, 19].includes(octets[1]))
      || (octets[0] === 198 && octets[1] === 51 && octets[2] === 100)
      || (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
    );
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
      || !host.includes(".") || host.length > 253 || host.includes(":") || privateIpv4
      || (numericHost && !validIpv4)
      || hostParts.some((part) => !part || part.length > 63 || part.startsWith("-") || part.endsWith("-"))
      || ["test", "example", "invalid", "localhost"].includes(hostParts.at(-1))) {
      throw new Error("仅支持安全 HTTPS 公网图片来源；未向本地或非标准来源申请权限");
    }
    origins.add(`${url.origin}/*`);
  }
  if (origins.size > 12) throw new Error("所选图片涉及过多图源；请先缩小选择范围");
  return Array.from(origins);
}

function requestSelectedImagePermissions(message) {
  if (!message?.imageTransferProtocol || !Array.isArray(message.images) || message.images.length === 0) {
    return Promise.resolve(true);
  }
  const origins = imagePermissionOrigins(message.images);
  if (!chrome.permissions?.request) return Promise.reject(new Error("浏览器不支持按需申请图片来源权限"));
  return new Promise((resolve, reject) => {
    chrome.permissions.request({ origins }, (granted) => {
      const error = chrome.runtime.lastError?.message;
      if (error) reject(new Error(`图片来源权限请求失败：${error}`));
      else if (!granted) reject(new Error("未获图片来源权限；正文未保存，所选原图也未保存"));
      else resolve(true);
    });
  });
}

function requestSelectedImagePermissionsFromPreview() {
  if (activeMode !== "collect" || !parsed || !document.getElementById("m-images").checked) return Promise.resolve(true);
  const images = selectedImageIndexes().map((index) => parsed.images?.[index]).filter(Boolean);
  return requestSelectedImagePermissions({ imageTransferProtocol: images.length > 0, images });
}

async function transferSelectedCaptureImages(message, inspirationId) {
  if (!message.imageTransferProtocol || !message.images?.length) return;
  if (!desktopConnected || !connectedWorkspaceId) {
    throw new Error("剪藏目标桌面连接已变化；请恢复原工作区后按原 requestId 重试");
  }
  const source = await assertCaptureSource();
  const channel = expectedChannel;
  const workspaceId = connectedWorkspaceId;
  const accountId = Number(message.targetAccountId);
  if (source.id !== sourceTabId || channel !== expectedChannel || accountId !== Number(message.targetAccountId)
    || accountId !== Number(targetAccountEl.value)
    || workspaceId !== (connectedWorkspaceId || selectedWorkspaceByChannel[channel] || "")) {
    throw new Error("来源页面或目标账号已变化；请按原 requestId 核实后重试");
  }
  const nativePort = openNativePort();
  let imagePort = null;
  let totalCollectionBytes = 0;
  const maxCollectionBytes = 32 * 1024 * 1024;
  const maxImageBytes = 25 * 1024 * 1024;
  const maxChunkBytes = 64 * 1024;
  const failures = [];
  let nativeUnavailable = false;
  const send = async (action, fields) => {
    let response;
    try {
      response = await nativePort.request({
        action,
        protocolVersion: PROTOCOL_VERSION,
        imageTransferProtocol: true,
        targetAccountId: accountId,
        inspirationId,
        requestId: message.requestId,
        extensionVersion: manifest?.version || "",
        ...fields,
      }, action === "finish_capture_image_upload"
        ? NATIVE_IMAGE_FINISH_TIMEOUT_MS
        : NATIVE_IMAGE_ACTION_TIMEOUT_MS);
    } catch (error) {
      nativeUnavailable = true;
      throw error;
    }
    if (!responseMatchesExpectedIdentity(response)) throw new Error("图片传输回执来自不同通道或工作区");
    if (Number(response?.protocolVersion) !== PROTOCOL_VERSION) {
      nativeUnavailable = true;
      throw new Error(`剪藏协议版本不兼容：扩展需要 v${PROTOCOL_VERSION}，桌面返回 v${Number(response?.protocolVersion || 0)}`);
    }
    if (response?.ok !== true) throw new Error(response?.error || "桌面端未接受图片分块");
    return response;
  };
  const assertTransferIdentity = async () => {
    const current = await assertCaptureSource();
    if (current.id !== source.id || current.url !== source.url || channel !== expectedChannel
      || workspaceId !== connectedWorkspaceId || accountId !== Number(message.targetAccountId)
      || accountId !== Number(targetAccountEl.value)) {
      throw new Error("传输期间原来源页面、目标账号或通道/工作区发生变化；请按原 requestId 核实");
    }
  };
  const closeImageTransfer = async (identity, transferId, action = "cancel_image_transfer") => {
    if (!imagePort || !transferId) return;
    await imagePort.request(action, { ...identity, transferId }).catch(() => {});
  };
  try {
    imagePort = globalThis.AichiCaptureImageFetchClient.open({
      captureRequestId: message.requestId,
      targetAccountId: accountId,
      expectedChannel: channel,
      expectedWorkspaceId: workspaceId,
      sourceTabId: source.id,
      sourceUrl: source.url,
      position: 0,
    });
    for (let position = 0; position < message.images.length; position += 1) {
      await assertTransferIdentity();
      setStatus(`正在读取并保存原图 ${position + 1}/${message.images.length}…`);
      const identity = {
        captureRequestId: message.requestId,
        targetAccountId: accountId,
        expectedChannel: channel,
        expectedWorkspaceId: workspaceId,
        sourceTabId: source.id,
        sourceUrl: source.url,
        position,
      };
      let transferId = "";
      try {
        const sourceImage = message.images[position];
        const fetched = await imagePort.request("fetch_selected_image", {
          ...identity,
          imageUrl: String(sourceImage?.url || ""),
        });
        transferId = String(fetched.transferId || "");
        const totalBytes = Number(fetched.totalBytes);
        const sha256 = String(fetched.sha256 || "");
        const mimeType = String(fetched.mimeType || "");
        if (!transferId || !Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > maxImageBytes
          || !/^[0-9a-f]{64}$/i.test(sha256) || !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType)) {
          throw new Error("图片 service worker 返回的摘要、长度或格式无效");
        }
        totalCollectionBytes += totalBytes;
        if (totalCollectionBytes > maxCollectionBytes) throw new Error("所选原图总量超过 32MB，请减少图片后重试");
        await assertTransferIdentity();
        const begin = await send("begin_capture_image_upload", {
          position,
          totalBytes,
          sha256,
          mimeType,
        });
        let offset = Number(begin.upload?.nextOffset);
        if (begin.upload?.alreadyReady === true) {
          await closeImageTransfer(identity, transferId, "finish_image_transfer");
          continue;
        }
        if (typeof begin.upload?.alreadyReady !== "boolean"
          || !Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) throw new Error("桌面续传位置无效");
        while (offset < totalBytes) {
          await assertTransferIdentity();
          const chunkResult = await imagePort.request("read_image_chunk", {
            ...identity,
            transferId,
            offset,
          });
          const rawLength = Number(chunkResult.byteLength);
          const encoded = String(chunkResult.dataBase64 || "");
          if (Number(chunkResult.offset) !== offset || !Number.isSafeInteger(rawLength)
            || rawLength < 1 || rawLength > maxChunkBytes || encoded.length > 88 * 1024
            || encoded.length !== Math.ceil(rawLength / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
            throw new Error("service worker 返回的图片分块无效");
          }
          const written = await send("write_capture_image_chunk", {
            position,
            offset,
            dataBase64: encoded,
          });
          const nextOffset = Number(written.upload?.nextOffset);
          if (!Number.isSafeInteger(nextOffset) || nextOffset !== offset + rawLength) {
            throw new Error("桌面续传偏移与原图顺序不一致");
          }
          offset = nextOffset;
        }
        const finished = await send("finish_capture_image_upload", { position });
        if (finished.status !== "ready") throw new Error("桌面端尚未确认图片已本地落地");
        await closeImageTransfer(identity, transferId, "finish_image_transfer");
      } catch (error) {
        const detail = String(error?.message || error).slice(0, 500);
        failures.push({ position, error: detail });
        if (!nativeUnavailable && !/回执来自不同通道|身份不匹配/.test(detail)) {
          // The capture request has already persisted every selected-image row;
          // make an unreadable image visible so the user can retry that item.
          await send("fail_capture_image_upload", { position, error: detail }).catch(() => {});
        }
        await closeImageTransfer(identity, transferId);
        if (nativeUnavailable || /回执来自不同通道|身份不匹配/.test(detail)) break;
      }
    }
    if (failures.length) {
      const details = failures
        .map((item) => `第 ${item.position + 1} 张：${item.error}`)
        .join("；")
        .slice(0, 1_200);
      throw new Error(`原图完成 ${message.images.length - failures.length}/${message.images.length} 张；${details}。可按原 requestId 核实并重试。`);
    }
  } finally {
    imagePort?.close();
    nativePort.close();
  }
}

function renderInstancePicker() {
  const show = availableInstances.length > 1 || (expectedChannel === "dev" && availableInstances.length > 0);
  instancePickerRow.hidden = !show;
  instancePicker.replaceChildren();
  for (const instance of availableInstances) {
    const option = document.createElement("option");
    option.value = instance.workspaceId;
    option.textContent = `${instance.displayName || instance.workspaceId} · ${instance.online ? "在线" : "离线"}`;
    instancePicker.append(option);
  }
  const selected = selectedWorkspaceByChannel[expectedChannel] || connectedWorkspaceId;
  if (selected && availableInstances.some((item) => item.workspaceId === selected)) instancePicker.value = selected;
  connectInstanceBtn.hidden = !show;
  devModeToggle.checked = devModeEnabled;
  instancePickerStatusEl.textContent = availableInstances.length > 1 && !selected
    ? "发现多个实例；请先选择一个，账号读取与数据访问会等到选择后才开始。"
    : expectedChannel === "dev" ? "开发模式只连接明确选择的 DEV 工作区。" : "日常连接使用正式通道。";
  updateConnectionControls();
}

function updateConnectionControls() {
  const locked = preparingCapture || savingCapture || Boolean(pendingCaptureMessage) || Boolean(stagedCaptureMessage);
  devModeToggle.disabled = Boolean(locked);
  instancePicker.disabled = Boolean(locked);
  connectInstanceBtn.disabled = Boolean(locked) || connectInstanceBtn.hidden;
  targetAccountEl.disabled = Boolean(locked) || sessionAccounts.length < 2;
}

async function connectToInstance(workspaceId) {
  if (!workspaceId) return false;
  connectedWorkspaceId = workspaceId;
  selectedWorkspaceByChannel[expectedChannel] = workspaceId;
  await saveConnectionPreference();
  setConnectionStatus("checking", "正在验证桌面实例");
  connectionRemedyEl.textContent = "正在检查浏览器宿主、目标桌面实例和协议版本…";
  const result = await sendNativeRequest({
    action: "ping",
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    extensionVersion: manifest?.version || "",
  });
  updateConnectionStatus(result.response, result.runtimeError, result.timedOut);
  return desktopConnected;
}

async function discoverAndConnect() {
  const start = performance.now();
  setConnectionStatus("checking", "正在检测");
  connectionDetailEl.textContent = `正在检测 ${expectedChannel === "dev" ? "DEV" : "正式版"} 插件连接…`;
  connectionRemedyEl.textContent = "只读检查，不会启动桌面 APP 或写入网页内容。";
  launchDesktopBtn.hidden = true;
  const result = await sendNativeRequest({
    action: "list_capture_instances",
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    extensionVersion: manifest?.version || "",
  }, { includeWorkspace: false });
  const discoveryMs = Math.max(0, Math.round(performance.now() - start));
  if (result.runtimeError || result.timedOut || !result.response) {
    reportConnectionFailure({ ...result, step: "host", action: "list_capture_instances" });
    return false;
  }
  if (result.response.channel !== expectedChannel) {
    reportConnectionFailure({ response: { ...result.response, errorCode: "CHANNEL_MISMATCH" }, step: "version_handshake", action: "list_capture_instances" });
    return false;
  }
  if (result.response.errorCode) {
    reportConnectionFailure({ response: result.response, step: "host", action: "list_capture_instances" });
    return false;
  }
  if (Number(result.response.protocolVersion) !== PROTOCOL_VERSION) {
    reportConnectionFailure({ response: { ...result.response, errorCode: "PROTOCOL_INCOMPATIBLE" }, step: "version_handshake", action: "list_capture_instances" });
    return false;
  }
  if (!Array.isArray(result.response.instances)) {
    reportConnectionFailure({ response: result.response, step: "host", action: "list_capture_instances" });
    return false;
  }
  availableInstances = result.response.instances.filter((item) => item
    && item.channel === expectedChannel && typeof item.workspaceId === "string" && item.workspaceId);
  renderInstancePicker();
  const preferred = selectedWorkspaceByChannel[expectedChannel];
  if (preferred) {
    if (!availableInstances.some((item) => item.workspaceId === preferred)) {
      availableInstances = [...availableInstances, {
        workspaceId: preferred, displayName: preferred, channel: expectedChannel, online: false,
      }];
      renderInstancePicker();
    }
    instancePickerStatusEl.textContent = `已綁定 ${preferred}；连接失败时不会自动转投其他实例。`;
    const connected = await connectToInstance(preferred);
    if (connected) connectionRemedyEl.textContent = `插件、浏览器宿主、${expectedChannel === "dev" ? "DEV" : "正式"}桌面实例和协议握手已连通（检测 ${discoveryMs} ms）。`;
    return connected;
  }
  if (availableInstances.length === 1) {
    selectedWorkspaceByChannel[expectedChannel] = availableInstances[0].workspaceId;
    await saveConnectionPreference();
    return connectToInstance(availableInstances[0].workspaceId);
  }
  if (availableInstances.length > 1) {
    connectedWorkspaceId = "";
    desktopConnected = false;
    setConnectionStatus("error", "选择桌面实例");
    connectionDetailEl.textContent = "检测到多个匹配实例";
    connectionRemedyEl.textContent = "请选择要使用的工作区，再点“连接所选实例”。";
    instancePickerRow.hidden = false;
    connectInstanceBtn.hidden = false;
    return false;
  }
  reportConnectionFailure({ response: { ...result.response, errorCode: "INSTANCE_OFFLINE" }, step: "desktop_instance", action: "list_capture_instances" });
  return false;
}

async function launchSelectedDesktop() {
  const workspaceId = selectedWorkspaceByChannel[expectedChannel] || connectedWorkspaceId || instancePicker.value;
  if (!workspaceId) {
    reportConnectionFailure({ response: { errorCode: "INSTANCE_SELECTION_REQUIRED" }, step: "desktop_instance" });
    return;
  }
  launchDesktopBtn.disabled = true;
  try {
    const result = await sendNativeRequest({
      action: "launch_capture_instance",
      targetWorkspaceId: workspaceId,
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: manifest?.version || "",
      requestId: crypto.randomUUID(),
    }, { includeWorkspace: false });
    if (result.runtimeError || result.timedOut || result.response?.ok !== true) {
      reportConnectionFailure({ ...result, step: "desktop_instance", action: "launch_capture_instance" });
      return;
    }
    setConnectionStatus("checking", "正在启动桌面端");
    connectionDetailEl.textContent = `已按你的点击请求启动 ${workspaceId}`;
    connectionRemedyEl.textContent = "桌面 APP 启动后点击“重试连接”。";
    retryConnectionBtn.hidden = false;
    launchDesktopBtn.hidden = true;
  } finally {
    launchDesktopBtn.disabled = false;
  }
}

async function lookupPageContext(page, targetAccountId, pageType) {
  const { response, runtimeError, timedOut } = await sendNativeRequest({
    action: "lookup_page_context",
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    extensionVersion: manifest?.version || "",
    ...(targetAccountId ? { targetAccountId: Number(targetAccountId) } : {}),
    sourceUrl: page.sourceUrl,
    pageType: pageType || page.pageType || "web",
  });
  return {
    response, runtimeError, timedOut,
    context: responseMatchesExpectedIdentity(response) ? response?.context || null : null,
    available: response?.ok === true && responseMatchesExpectedIdentity(response),
    error: runtimeError || response?.error || "",
  };
}

async function loadCaptureAccounts(epoch = pageEpoch) {
  accountStatusEl.textContent = "正在读取本地账号…";
  const { response, runtimeError, timedOut } = await sendNativeRequest({
    action: "list_capture_accounts",
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    extensionVersion: manifest?.version || "",
  });
  if (epoch !== pageEpoch) return false;
  updateConnectionStatus(response, runtimeError, timedOut);
  if (response?.ok !== true || !responseMatchesExpectedIdentity(response)
    || !Array.isArray(response.accounts) || response.accounts.length === 0) {
    targetAccountRowEl.hidden = false;
    targetAccountEl.replaceChildren();
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "桌面账号暂不可用";
    targetAccountEl.append(option);
    targetAccountEl.disabled = true;
    const failure = globalThis.AichiConnectionDiagnostics.classify({
      response, runtimeError, timedOut, step: "account_read", action: "list_capture_accounts",
    });
    connectionFailureCode = failure.code;
    reportConnectionFailure({ response, runtimeError, timedOut, step: "account_read", action: "list_capture_accounts" });
    accountStatusEl.textContent = `${failure.label}：${failure.code}。${failure.action}`;
    connectionRemedyEl.textContent = failure.action;
    return false;
  }
  targetAccountRowEl.hidden = false;
  targetAccountEl.replaceChildren();
  for (const account of response.accounts) {
    const option = document.createElement("option");
    option.value = String(account.id);
    option.textContent = `${account.displayName || account.alias || `账号 ${account.id}`}${account.isActive ? "（桌面当前）" : ""}`;
    targetAccountEl.append(option);
  }
  sessionAccounts = response.accounts.map((account) => ({
    id: Number(account.id), displayName: String(account.displayName || ""), alias: String(account.alias || ""), isActive: Boolean(account.isActive),
  }));
  const selection = await chrome.storage?.session?.get(SESSION_UI_KEY);
  const savedUi = selection?.[SESSION_UI_KEY];
  const stagedTargetId = stagedCaptureMessage?.targetAccountId ?? pendingCaptureMessage?.targetAccountId;
  const savedTargetId = savedUi?.channel === expectedChannel
    && (!savedUi.workspaceId || savedUi.workspaceId === connectedWorkspaceId)
    ? savedUi.targetAccountId
    : null;
  const desiredId = [stagedTargetId, savedTargetId, response.activeAccountId, response.accounts[0].id]
    .map((value) => Number(value)).find((id) => response.accounts.some((account) => Number(account.id) === id));
  targetAccountEl.value = String(desiredId || response.activeAccountId || response.accounts[0].id);
  targetAccountEl.disabled = response.accounts.length < 2;
  verifiedAccountsWorkspaceId = connectedWorkspaceId;
  accountStatusEl.textContent = `已读取 ${response.accounts.length} 个可用账号`;
  await chrome.storage?.session?.set({ [SESSION_ACCOUNTS_KEY]: {
    channel: expectedChannel,
    workspaceId: connectedWorkspaceId,
    activeAccountId: Number(response.activeAccountId || response.accounts[0].id),
    accounts: sessionAccounts,
  } });
  await persistUiSelection();
  return true;
}

async function restoreSessionAccounts() {
  if (!chrome.storage?.session) return;
  const stored = (await chrome.storage.session.get(SESSION_ACCOUNTS_KEY))?.[SESSION_ACCOUNTS_KEY];
  if (!stored || stored.channel !== expectedChannel
    || (selectedWorkspaceByChannel[expectedChannel] && stored.workspaceId !== selectedWorkspaceByChannel[expectedChannel])
    || !Array.isArray(stored.accounts)) return;
  sessionAccounts = stored.accounts.filter((account) => Number.isInteger(Number(account.id)));
  targetAccountEl.replaceChildren();
  for (const account of sessionAccounts) {
    const option = document.createElement("option");
    option.value = String(account.id);
    option.textContent = `${account.displayName || account.alias || `账号 ${account.id}`}${account.isActive ? "（上次桌面当前）" : ""}`;
    targetAccountEl.append(option);
  }
  targetAccountRowEl.hidden = false;
  targetAccountEl.disabled = sessionAccounts.length < 2;
  const ui = (await chrome.storage.session.get(SESSION_UI_KEY))?.[SESSION_UI_KEY];
  const requestedId = stagedCaptureMessage?.targetAccountId || ui?.targetAccountId || stored.activeAccountId;
  if (requestedId != null && sessionAccounts.some((account) => Number(account.id) === Number(requestedId))) {
    targetAccountEl.value = String(requestedId);
  }
  accountStatusEl.textContent = "桌面未连接；暂时显示本次浏览器会话中上次读取的账号。保存前会重新核对。";
}

async function persistUiSelection() {
  if (!chrome.storage?.session) return;
  await chrome.storage.session.set({ [SESSION_UI_KEY]: {
    channel: expectedChannel,
    workspaceId: connectedWorkspaceId || selectedWorkspaceByChannel[expectedChannel] || "",
    targetAccountId: targetAccountEl.value ? Number(targetAccountEl.value) : null,
    pageType: pageTypeEl.value,
    clipKind: clipKindEl.value,
    mode: activeMode,
    modules: selectedModules(),
    selectedImageIndexes: selectedImageIndexes(),
    selectedCommentIndexes: selectedCommentIndexes(),
    sourceUrl: parsed?.sourceUrl || "",
    savedAt: Date.now(),
  } });
}

async function restoreUiSelectionForPage() {
  if (!chrome.storage?.session || !parsed) return;
  const saved = (await chrome.storage.session.get(SESSION_UI_KEY))?.[SESSION_UI_KEY];
  if (!saved || Date.now() - Number(saved.savedAt) > 24 * 60 * 60 * 1000
    || saved.channel !== expectedChannel || saved.sourceUrl !== parsed.sourceUrl
    || (saved.workspaceId && connectedWorkspaceId && saved.workspaceId !== connectedWorkspaceId)) return;
  if (["note", "profile", "web"].includes(saved.pageType)) pageTypeEl.value = saved.pageType;
  if (["auto", "note", "account", "material"].includes(saved.clipKind)) clipKindEl.value = saved.clipKind;
  if (["collect", "data"].includes(saved.mode)) activeMode = saved.mode;
  const moduleValues = {
    "m-titleBody": saved.modules?.collect?.titleBody,
    "m-authorSource": saved.modules?.collect?.authorSource,
    "m-images": saved.modules?.collect?.images,
    "m-comments": saved.modules?.collect?.comments,
    "m-metrics": saved.modules?.data?.metrics,
    "m-published": saved.modules?.data?.publishedAt,
  };
  for (const [id, value] of Object.entries(moduleValues)) {
    if (typeof value === "boolean") document.getElementById(id).checked = value;
  }
  if (Array.isArray(saved.selectedImageIndexes)) {
    selectedImageSet = new Set(saved.selectedImageIndexes.filter((index) => Number.isInteger(index) && index >= 0 && index < (parsed.images || []).length));
  }
  selectedCommentSet = new Set((saved.selectedCommentIndexes || []).filter((index) => Number.isInteger(index) && index >= 0 && index < (parsed.comments || []).length));
  activeImageIndex = Number.isInteger(saved.activeImageIndex)
    ? Math.max(0, Math.min(Math.max(0, (parsed.images || []).length - 1), saved.activeImageIndex)) : 0;
  if (saved.targetAccountId != null && Array.from(targetAccountEl.options).some((option) => option.value === String(saved.targetAccountId))) {
    targetAccountEl.value = String(saved.targetAccountId);
  }
  configurationEdited = true;
  renderCaptureOptions();
}

async function refreshLookupForSelectedAccount(epoch = pageEpoch) {
  if (!parsed || epoch !== pageEpoch) return;
  const lookup = ++lookupEpoch;
  const accountId = targetAccountEl.value;
  const page = parsed;
  const pageType = pageTypeEl.value;
  pageContext = null;
  contextLookupAvailable = false;
  renderPreview();
  const result = await lookupPageContext(page, accountId, pageType);
  if (epoch !== pageEpoch || lookup !== lookupEpoch || accountId !== targetAccountEl.value
    || page !== parsed || pageType !== pageTypeEl.value) return;
  updateConnectionStatus(result.response, result.runtimeError, result.timedOut);
  pageContext = result.context;
  contextLookupAvailable = result.available;
  accountStatusEl.textContent = result.available
    ? `已读取 ${targetAccountEl.options.length} 个账号，并完成当前页归属查询`
    : `已读取账号；页面归属查询失败：${result.error || "暂不可用"}。本页预览仍可查看`;
  applyDefaultMode();
  renderPreview();
}

async function checkDesktopConnection() {
  if (!connectedWorkspaceId) return discoverAndConnect();
  const { response, runtimeError, timedOut } = await sendNativeRequest({
    action: "ping",
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    extensionVersion: manifest?.version || "",
  });
  updateConnectionStatus(response, runtimeError, timedOut);
  return desktopConnected;
}

async function loadAccountsAndContext(epoch) {
  const loaded = await loadCaptureAccounts(epoch);
  if (epoch !== pageEpoch) return;
  if (loaded) {
    await refreshLookupForSelectedAccount(epoch);
    if (pendingCaptureMessage && epoch === pageEpoch) await verifyPendingCapture();
    return;
  }
  pageContext = null;
  contextLookupAvailable = false;
  applyDefaultMode();
  renderPreview();
}

function applyDefaultMode() {
  if (!configurationEdited) {
    document.getElementById("m-titleBody").checked = pageTypeEl.value !== "profile";
    document.getElementById("m-authorSource").checked = true;
    document.getElementById("m-images").checked = (pageTypeEl.value === "note" || selectedClipKind() === "material")
      && selectedImageIndexes().length > 0;
    document.getElementById("m-comments").checked = false;
    const refreshByDefault = contextLookupAvailable && pageContext?.defaultAction === "update_data"
      && pageTypeEl.value !== "web";
    document.getElementById("m-metrics").checked = refreshByDefault;
    document.getElementById("m-published").checked = refreshByDefault;
    setMode(refreshByDefault ? "data" : "collect", false);
  }

  if (!contextLookupAvailable) {
    contextHint.textContent = desktopConnected
      ? "本地归属查询不可用，默认收藏内容；可手动切换到更新数据。"
      : "桌面连接或账号查询不可用；页面预览保留，保存操作暂不可用。连接恢复后可重试。";
    return;
  }
  const existing = Boolean(pageContext && pageContext.matchType && pageContext.matchType !== "unknown");
  contextHint.textContent = existing
    ? `已找到 ${pageContext.matchedTitle || "当前内容"}。可更新剪藏内容或刷新数据快照。`
    : "将保存为笔记剪藏；标题、作者和来源默认保留。";
}

function fmtCount(n) {
  if (n == null) return "未识别";
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
  return String(n);
}

function renderPreview() {
  if (!parsed) return;
  const staged = Boolean(stagedCaptureMessage);
  pageTypeEl.disabled = staged;
  renderCaptureOptions();
  for (const id of ["m-titleBody", "m-authorSource", "m-metrics", "m-published"]) {
    document.getElementById(id).disabled = staged;
  }

  // 主页不展示赞藏评块；网页隐藏更新数据区。
  const isProfile = pageTypeEl.value === "profile";
  const isWeb = pageTypeEl.value === "web";
  const clipKind = selectedClipKind();
  const hasKnownMatch = Boolean(contextLookupAvailable && pageContext?.matchType && pageContext.matchType !== "unknown");
  const kindLabel = clipKind === "account" ? "账号剪藏" : clipKind === "material" ? "素材剪藏" : "笔记剪藏";
  const sourceLabel = isProfile ? "小红书作者主页" : isWeb ? "普通网页文章" : "小红书笔记";
  clipTypeLabelEl.textContent = `${kindLabel} · ${sourceLabel}`;
  existingActionsEl.hidden = !hasKnownMatch || restricted || staged;
  existingContentLabelEl.textContent = hasKnownMatch
    ? `已存在：${truncate(pageContext.matchedTitle || "当前页面", 42)}`
    : "";
  if (contextLookupAvailable && !hasKnownMatch) {
    contextHint.textContent = clipKind === "material" ? "将保存所选图片为新的素材剪藏；不会自动导入创作素材。"
      : clipKind === "account" ? "将保存作者主页资料为账号剪藏；不会自动设为榜样或运营账号。"
        : "将保存为笔记剪藏；标题、作者和来源默认保留。";
  }
  updateContentBtn.setAttribute("aria-pressed", String(activeMode === "collect"));
  refreshDataBtn.setAttribute("aria-pressed", String(activeMode === "data"));
  refreshDataBtn.hidden = isWeb;
  collectTab.disabled = staged;
  dataTab.disabled = isWeb || staged;
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

  const modules = selectedModules();
  const selectedImages = selectedImageIndexes().length;
  const selectedComments = selectedCommentIndexes().length;
  imageSelectionCountEl.textContent = `已选 ${selectedImages} 张`;
  commentSelectionCountEl.textContent = `已选 ${selectedComments} 条`;
  const model = globalThis.AichiCapturePreview.buildModel(parsed, {
    pageType: pageTypeEl.value,
    clipKind,
    modules,
    selectedImageIndexes: selectedImageIndexes(),
    selectedCommentIndexes: selectedCommentIndexes(),
    pageContext,
    batchId: parseBatchId,
  });
  globalThis.AichiCapturePreview.render(previewFields, model, {
    interactive: !restricted && !staged,
    commentsOpen,
    onCommentsToggle(open) { commentsOpen = open; },
    profileNotesOpen,
    onProfileNotesToggle(open) { profileNotesOpen = open; },
    activeImageIndex,
    onImageNavigate(delta) {
      const imageCount = parsed?.images?.length || 0;
      if (!imageCount) return;
      activeImageIndex = (activeImageIndex + delta + imageCount) % imageCount;
      renderPreview();
      void persistUiSelection();
    },
    onImageActive(index) {
      activeImageIndex = index;
      renderPreview();
      void persistUiSelection();
    },
    onSelectAllImages() {
      selectedImageSet = new Set((parsed?.images || []).slice(0, 12).map((_, index) => index));
      document.getElementById("m-images").checked = selectedImageSet.size > 0;
      renderCaptureOptions();
      renderPreview();
      void persistUiSelection();
    },
    onClearImages() {
      selectedImageSet.clear();
      document.getElementById("m-images").checked = false;
      renderCaptureOptions();
      renderPreview();
      void persistUiSelection();
    },
    onProfileNoteOpen(noteUrl) {
      let url;
      try { url = new URL(String(noteUrl || "")); } catch { return; }
      if (url.protocol !== "https:" || url.hostname !== "www.xiaohongshu.com"
        || !/^\/(?:explore|discovery\/item)\//.test(url.pathname)) return;
      void chrome.tabs.create({ url: url.href, active: true });
    },
    onImageToggle(index, checked) {
      if (checked) selectedImageSet.add(index);
      else selectedImageSet.delete(index);
      document.getElementById("m-images").checked = selectedImageSet.size > 0;
      renderPreview();
      void persistUiSelection();
    },
    onCommentToggle(index, checked) {
      if (checked) selectedCommentSet.add(index);
      else selectedCommentSet.delete(index);
      renderPreview();
      void persistUiSelection();
    },
  });

  const collectionModules = activeMode === "collect";
  const imageOnly = collectionModules && clipKind === "material";
  const collect = collectionModules && (!imageOnly && (document.getElementById("m-titleBody").checked
    || document.getElementById("m-authorSource").checked)
    || (document.getElementById("m-images").checked && selectedImages > 0)
    || (document.getElementById("m-comments").checked && selectedComments > 0));
  const updateData = !isWeb && (document.getElementById("m-metrics").checked || document.getElementById("m-published").checked);
  const dest = [];
  if (collect) dest.push(clipKind === "account" ? "剪藏 · 账号" : clipKind === "material" ? `剪藏 · ${selectedImages} 张素材` : "剪藏 · 笔记");
  if (updateData) dest.push("快照表（更新数据）");
  destinationEl.textContent = dest.length
    ? `本次去向：${dest.join(" + ")}`
    : "请至少勾选一个模块";
  captureBtn.disabled = restricted || dest.length === 0 || !desktopConnected || !targetAccountEl.value
    || savingCapture || preparingCapture || Boolean(pendingCaptureMessage) || Boolean(stagedCaptureMessage);
  captureBtn.textContent = updateData
    ? (pageContext?.lastSnapshotAt ? "刷新数据" : "记录数据")
    : clipKind === "account" ? "保存账号到剪藏"
      : clipKind === "material" ? `保存 ${selectedImages} 张素材到剪藏`
        : selectedImages ? `保存笔记和 ${selectedImages} 张图片` : "保存到剪藏 · 笔记";

  stageCaptureBtn.hidden = restricted || Boolean(stagedCaptureMessage) || desktopConnected
    || !targetAccountEl.value || dest.length === 0 || savingCapture || preparingCapture
    || Boolean(pendingCaptureMessage) || isCreatorPublishUrl(sourceTabUrl);
  stageCaptureBtn.disabled = stageCaptureBtn.hidden;
  saveStagedCaptureBtn.hidden = !stagedCaptureMessage;
  cancelStagedCaptureBtn.hidden = !stagedCaptureMessage || Boolean(pendingCaptureMessage) || savingCapture;
  if (stagedCaptureMessage) {
    const stageAccountId = Number(stagedCaptureMessage.targetAccountId);
    const selectedAccountId = Number(targetAccountEl.value);
    const accountMatches = Boolean(targetAccountEl.value) && selectedAccountId === stageAccountId;
    const sourceMatches = parsed.sourceUrl === stagedCaptureMessage.sourceUrl;
    const accountVerified = desktopConnected && verifiedAccountsWorkspaceId === connectedWorkspaceId
      && sessionAccounts.some((account) => account.id === stageAccountId);
    saveStagedCaptureBtn.disabled = !desktopConnected || !accountVerified || !accountMatches
      || !sourceMatches || savingCapture || preparingCapture || Boolean(pendingCaptureMessage);
    saveStagedCaptureBtn.title = !sourceMatches
      ? "请在原来源页面重新打开插件"
      : !accountVerified || !accountMatches
        ? `此请求绑定账号 ${stageAccountId}；请连接原工作区并核对同一账号`
        : "已核对原桌面实例与目标账号；点击后才会保存到桌面";
    stageCaptureBtn.hidden = true;
    destinationEl.textContent = `浏览器暂存 · 尚未保存到桌面 · 目标账号 ${stageAccountId}`;
  }

  const parseWarnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter(Boolean).join("；") : "";
  previewMeta.textContent = restricted
    ? "当前页不可抓取（受限页面）"
    : `识别为「${typeLabel(pageTypeEl.value)}」· 可切换操作页，保存前会再次确认${parseWarnings ? ` · ${parseWarnings}` : ""}`;
  expandPreviewBtn.disabled = restricted || !parsed || sourceTabId == null || isCreatorPublishUrl(sourceTabUrl);
  updateConnectionControls();
}

function selectedImageIndexes() {
  return Array.from(selectedImageSet).sort((a, b) => a - b);
}

function selectedCommentIndexes() {
  return Array.from(selectedCommentSet).sort((a, b) => a - b);
}

function renderCaptureOptions() {
  const isNote = pageTypeEl.value === "note";
  const clipKind = selectedClipKind();
  const allowsImages = isNote || clipKind === "material";
  const staged = Boolean(stagedCaptureMessage);
  const imageModule = document.getElementById("m-images");
  const commentModule = document.getElementById("m-comments");
  imageModule.disabled = staged || !allowsImages || !(parsed?.images?.length);
  commentModule.disabled = staged || !isNote || !(parsed?.comments?.length);
}

function selectedClipKind() {
  if (clipKindEl?.value === "account") return "account";
  if (clipKindEl?.value === "material") return "material";
  if (clipKindEl?.value === "note") return "note";
  return pageTypeEl.value === "profile" ? "account" : "note";
}

function typeLabel(t) {
  return t === "note" ? "小红书笔记" : t === "profile" ? "小红书作者主页" : "普通网页文章";
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
      titleBody: pageTypeEl.value !== "profile" && document.getElementById("m-titleBody").checked,
      authorSource: document.getElementById("m-authorSource").checked,
      images: document.getElementById("m-images").checked,
      comments: document.getElementById("m-comments").checked,
    },
    data: {
      metrics: document.getElementById("m-metrics").checked,
      publishedAt: document.getElementById("m-published").checked,
    },
  };
}

async function readActiveCreatorTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isCreatorPublishUrl(tab.url || "")) {
    throw new Error("请在小红书创作发布页打开插件后重试");
  }
  return tab;
}

async function sendCreatorPageMessage(tab, message) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["creator-fill.js"],
  });
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response || null);
    });
  });
}

function creatorDesiredBody(task) {
  const tags = Array.isArray(task.tags) ? task.tags.filter(Boolean).map((tag) => `#${tag}`).join(" ") : "";
  return `${task.body || ""}${tags ? `\n\n${tags}` : ""}`.trim();
}

function displayCreatorTask(task, current) {
  creatorTaskPreview.hidden = false;
  creatorFillResult.textContent = "";
  creatorTaskBody = creatorDesiredBody(task);
  creatorPreviewCurrent = current;
  document.getElementById("creator-task-title").textContent = `将填入标题（v${task.contentVersion}）：\n${task.title}`;
  document.getElementById("creator-task-body").textContent = `将填入正文 + 话题：\n${creatorTaskBody}`;
  document.getElementById("creator-current-title").textContent = current.fields.title.found
    ? (current.fields.title.value || "（空）")
    : "未找到有明确标题标识的输入框";
  document.getElementById("creator-current-body").textContent = current.fields.body.found
    ? (current.fields.body.value || "（空）")
    : "未找到有明确正文标识的编辑框";
  const images = Array.isArray(creatorClaim.images) ? creatorClaim.images : [];
  const previousImages = new Map((task.fillResult?.images?.items || []).map((image) => [image.itemId, image]));
  creatorImageList.replaceChildren();
  for (const image of images) {
    const row = document.createElement("div");
    const prior = previousImages.get(image.itemId)?.status;
    const status = prior === "filled" ? "已填入" : prior === "failed" ? "上次失败，可重试" : "待填入";
    row.textContent = `${Number(image.index) + 1}. ${image.filename} · ${Math.ceil(image.totalBytes / 1024)} KiB · ${status}`;
    creatorImageList.append(row);
  }
  const video = creatorClaim.video || null;
  const videoStatus = task.fillResult?.video?.status;
  if (video) {
    const row = document.createElement("div");
    row.textContent = `视频：${video.filename} · ${Math.ceil(video.totalBytes / 1024 / 1024)} MiB · ${videoStatus === "filled" ? "已填入" : videoStatus === "failed" ? "上次失败，可重试" : "待填入"}`;
    creatorImageList.append(row);
  }
  const mediaNote = video
    ? `；视频 ${video.filename} 将传入创作页`
    : images.length ? `；${images.length} 张关联图片将按发布快照顺序填入` : "；此任务不含图片";
  creatorFillMeta.textContent = `任务 ${task.attemptId} · 本地账号 ${task.accountPoolId} · 有效至 ${creatorClaim.claimExpiresAt}${mediaNote}`;
  const priorTitle = task.fillResult?.title?.status;
  const priorBody = task.fillResult?.body?.status;
  const failedFields = [
    ...(priorTitle === "failed" ? ["title"] : []),
    ...(priorBody === "failed" ? ["body"] : []),
  ];
  const failedImageIds = images
    .filter((image) => previousImages.get(image.itemId)?.status === "failed")
    .map((image) => image.itemId);
  const failedVideo = Boolean(video && videoStatus === "failed");
  creatorRetryBtn.hidden = failedFields.length === 0 && failedImageIds.length === 0 && !failedVideo;
  creatorRetryBtn.dataset.fields = JSON.stringify(failedFields);
  creatorRetryBtn.dataset.imageIds = JSON.stringify(failedImageIds);
  creatorRetryBtn.dataset.video = failedVideo ? "true" : "false";
  creatorRetryBtn.disabled = false;
  creatorConfirmFill.checked = false;
  creatorFillBtn.disabled = true;
  creatorFillBtn.textContent = video ? "确认填入文字与视频，不发布" : "确认填入文字与图片，不发布";
  creatorClaimBtn.disabled = true;
  creatorCancelBtn.disabled = false;
  targetAccountEl.disabled = true;
}

async function claimCreatorTask() {
  if (creatorBusy) return;
  creatorBusy = true;
  creatorClaimBtn.disabled = true;
  setStatus("正在领取一条填充任务…");
  try {
    const tab = await readActiveCreatorTab();
    creatorTabId = tab.id;
    creatorPageUrl = tab.url || "";
    if (!targetAccountEl.value) throw new Error("请选择要使用的本地账号");
    const { response, runtimeError } = await sendNativeRequest({
      action: "claim_publish_fill_task",
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: manifest?.version || "",
      requestId: crypto.randomUUID(),
      targetAccountId: Number(targetAccountEl.value),
      sourceUrl: creatorPageUrl,
    });
    const identityMatches = updateConnectionStatus(response, runtimeError);
    if (!identityMatches || runtimeError || response?.ok !== true) {
      throw new Error(response?.error || runtimeError || connectionDetailEl.textContent || "领取任务失败");
    }
    if (!response.claim) {
      setStatus("当前账号没有等待领取的文字填充任务");
      creatorClaimBtn.disabled = !desktopConnected || !targetAccountEl.value;
      return;
    }
    creatorClaim = response.claim;
    const current = await sendCreatorPageMessage(tab, { action: "aichihongshu:creator-inspect" });
    if (!current?.ok) throw new Error(current?.error || "无法读取当前创作页字段");
    displayCreatorTask(creatorClaim.task, current);
    setStatus("请检查标题、正文、媒体和当前页面内容，再勾选确认");
  } catch (error) {
    if (creatorClaim) {
      try {
        await finishCreatorTask({ cancelled: true, titleStatus: "skipped", titleError: "", bodyStatus: "skipped", bodyError: "" });
      } catch { /* The short claim lease expires automatically. */ }
    }
    creatorClaim = null;
    creatorTaskPreview.hidden = true;
    setStatus(error?.message || String(error), true);
    creatorClaimBtn.disabled = !desktopConnected || !targetAccountEl.value;
  } finally {
    creatorBusy = false;
  }
}

async function finishCreatorTask({ cancelled, titleStatus, titleError, bodyStatus, bodyError, imageResults = [], videoStatus = "skipped", videoError = "" }) {
  if (!creatorClaim) throw new Error("请先领取填充任务");
  const tab = await readActiveCreatorTab();
  if (tab.id !== creatorTabId) throw new Error("活动标签页已改变，请回到原创作页后重试");
  const { response, runtimeError } = await sendNativeRequest({
    action: "finish_publish_fill_task",
    protocolVersion: PROTOCOL_VERSION,
    extensionVersion: manifest?.version || "",
    requestId: crypto.randomUUID(),
    targetAccountId: creatorClaim.task.accountPoolId,
    attemptId: creatorClaim.task.attemptId,
    claimToken: creatorClaim.claimToken,
    sourceUrl: tab.url || "",
    cancelled: Boolean(cancelled),
    titleStatus,
    titleError: titleError || "",
    bodyStatus,
    bodyError: bodyError || "",
    imageResults,
    videoStatus,
    videoError: videoError || "",
  });
  const identityMatches = updateConnectionStatus(response, runtimeError);
  if (!identityMatches || runtimeError || response?.ok !== true) {
    throw new Error(response?.error || runtimeError || connectionDetailEl.textContent || "桌面端未确认填充结果");
  }
  return response;
}

function base64ByteLength(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

async function transferCreatorImage(port, image, capabilityKey) {
  let offset = 0;
  while (offset < image.totalBytes) {
    if (creatorCancelRequested) throw new Error("USER_CANCELLED");
    const response = await port.request({
      action: "read_publish_fill_image_chunk",
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: manifest?.version || "",
      requestId: crypto.randomUUID(),
      targetAccountId: creatorClaim.task.accountPoolId,
      attemptId: creatorClaim.task.attemptId,
      claimToken: creatorClaim.claimToken,
      itemId: image.itemId,
      offset,
      chunkBytes: 32 * 1024,
      sourceUrl: creatorPageUrl,
    });
    if (response?.ok !== true || !response.chunk) throw new Error(response?.error || "桌面端未返回图片分块");
    const chunk = response.chunk;
    const expectedLength = Math.min(32 * 1024, image.totalBytes - offset);
    if (chunk.itemId !== image.itemId || chunk.offset !== offset
      || chunk.totalBytes !== image.totalBytes || chunk.sha256 !== image.sha256
      || chunk.filename !== image.filename || chunk.mimeType !== image.mimeType
      || base64ByteLength(chunk.dataBase64 || "") !== expectedLength) {
      throw new Error("图片分块身份、校验值或长度与预览不一致");
    }
    const accepted = await sendCreatorPageMessage({ id: creatorTabId }, {
      action: "aichihongshu:creator-image-chunk",
      confirmReplace: true,
      capabilityKey,
      itemId: image.itemId,
      offset,
      dataBase64: chunk.dataBase64,
      done: chunk.done === true,
    });
    if (accepted?.ok !== true) throw new Error(accepted?.error || "创作页未接受图片分块");
    offset += expectedLength;
  }
}

async function transferCreatorVideo(port, video, capabilityKey) {
  let offset = 0;
  while (offset < video.totalBytes) {
    if (creatorCancelRequested) throw new Error("USER_CANCELLED");
    const response = await port.request({
      action: "read_publish_fill_video_chunk",
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: manifest?.version || "",
      requestId: crypto.randomUUID(),
      targetAccountId: creatorClaim.task.accountPoolId,
      attemptId: creatorClaim.task.attemptId,
      claimToken: creatorClaim.claimToken,
      offset,
      chunkBytes: 96 * 1024,
      sourceUrl: creatorPageUrl,
    });
    if (response?.ok !== true || !response.chunk) throw new Error(response?.error || "桌面端未返回视频分块");
    const chunk = response.chunk;
    const expectedLength = Math.min(96 * 1024, video.totalBytes - offset);
    if (chunk.offset !== offset || chunk.totalBytes !== video.totalBytes || chunk.sha256 !== video.sha256
      || chunk.filename !== video.filename || chunk.mimeType !== video.mimeType
      || base64ByteLength(chunk.dataBase64 || "") !== expectedLength) {
      throw new Error("视频分块身份、校验值或长度与预览不一致");
    }
    const accepted = await sendCreatorPageMessage({ id: creatorTabId }, {
      action: "aichihongshu:creator-video-chunk",
      confirmReplace: true,
      capabilityKey,
      offset,
      dataBase64: chunk.dataBase64,
      done: chunk.done === true,
    });
    if (accepted?.ok !== true) throw new Error(accepted?.error || "创作页未接受视频分块");
    offset += expectedLength;
  }
}

async function runCreatorFill(onlyFields = null, onlyImageIds = null, onlyVideo = false) {
  if (!creatorClaim || creatorBusy) return;
  if (!creatorConfirmFill.checked) {
    setStatus("请先确认预览内容和替换范围", true);
    return;
  }
  creatorBusy = true;
  creatorCancelRequested = false;
  creatorFillBtn.disabled = true;
  creatorRetryBtn.disabled = true;
  creatorCancelBtn.disabled = false;
  const allImages = Array.isArray(creatorClaim.images) ? creatorClaim.images : [];
  const video = creatorClaim.video || null;
  const priorVideoStatus = creatorClaim.task.fillResult?.video?.status;
  const includeVideo = Boolean(video && (onlyVideo || priorVideoStatus !== "filled"));
  const priorImages = new Map((creatorClaim.task.fillResult?.images?.items || []).map((image) => [image.itemId, image]));
  const selectedImages = onlyImageIds
    ? allImages.filter((image) => onlyImageIds.includes(image.itemId))
    : allImages.filter((image) => priorImages.get(image.itemId)?.status !== "filled");
  const transferStatuses = new Map();
  let nativePort = null;
  try {
    const tab = await readActiveCreatorTab();
    if (tab.id !== creatorTabId) throw new Error("活动标签页已改变，未作页面修改");
    const begin = await sendCreatorPageMessage(tab, {
      action: "aichihongshu:creator-images-begin",
      confirmReplace: true,
      attemptId: creatorClaim.task.attemptId,
      accountPoolId: creatorClaim.task.accountPoolId,
      claimToken: creatorClaim.claimToken,
      images: allImages,
      itemIds: selectedImages.map((image) => image.itemId),
    });
    if (begin?.ok !== true) throw new Error(begin?.error || "图片传输授权失败");
    let capabilityKey = begin.capabilityKey;
    if (includeVideo) {
      const videoBegin = await sendCreatorPageMessage(tab, {
        action: "aichihongshu:creator-video-begin",
        confirmReplace: true,
        attemptId: creatorClaim.task.attemptId,
        accountPoolId: creatorClaim.task.accountPoolId,
        claimToken: creatorClaim.claimToken,
        video,
      });
      if (videoBegin?.ok !== true) throw new Error(videoBegin?.error || "视频传输授权失败");
      capabilityKey = videoBegin.capabilityKey;
    }
    nativePort = selectedImages.length || includeVideo ? openNativePort() : null;
    for (let index = 0; index < selectedImages.length; index += 1) {
      const image = selectedImages[index];
      if (creatorCancelRequested) throw new Error("USER_CANCELLED");
      setStatus("正在传输图片 " + (index + 1) + "/" + selectedImages.length + "…");
      try {
        await transferCreatorImage(nativePort, image, capabilityKey);
        transferStatuses.set(image.itemId, { status: "filled", error: null });
      } catch (error) {
        if (error?.message === "USER_CANCELLED") throw error;
        transferStatuses.set(image.itemId, { status: "failed", error: error?.message || "图片传输失败" });
      }
    }
    let videoTransferStatus = null;
    if (includeVideo) {
      setStatus("正在传输视频（不超过 500 MiB）…");
      try {
        await transferCreatorVideo(nativePort, video, capabilityKey);
        videoTransferStatus = { status: "filled", error: null };
      } catch (error) {
        if (error?.message === "USER_CANCELLED") throw error;
        videoTransferStatus = { status: "failed", error: error?.message || "视频传输失败" };
      }
    }
    nativePort?.close();
    nativePort = null;
    if (creatorCancelRequested) throw new Error("USER_CANCELLED");
    const outcome = await sendCreatorPageMessage(tab, {
      action: "aichihongshu:creator-fill",
      confirmReplace: true,
      capabilityKey,
      title: creatorClaim.task.title,
      body: creatorTaskBody,
      onlyFields,
      allImageIds: allImages.map((image) => image.itemId),
      imageItemIds: selectedImages.map((image) => image.itemId),
      preserveImageItemIds: allImages
        .filter((image) => priorImages.get(image.itemId)?.status === "filled")
        .map((image) => image.itemId),
      includeVideo,
    });
    if (!outcome?.ok) throw new Error(outcome?.error || "创作页未接受填充请求");
    const imageResults = (outcome.images || []).map((result) => {
      const transfer = transferStatuses.get(result.itemId);
      return transfer?.status === "failed" ? { ...result, ...transfer } : result;
    });
    const videoOutcome = videoTransferStatus?.status === "failed" ? videoTransferStatus : outcome.video || { status: "skipped", error: null };
    const saved = await finishCreatorTask({
      cancelled: false,
      titleStatus: outcome.title?.status || "failed",
      titleError: outcome.title?.error || "",
      bodyStatus: outcome.body?.status || "failed",
      bodyError: outcome.body?.error || "",
      imageResults,
      videoStatus: videoOutcome.status || "skipped",
      videoError: videoOutcome.error || "",
    });
    creatorClaim.task.fillResult = saved.fillResult || creatorClaim.task.fillResult;
    const result = saved.fillResult || {};
    const titleLine = "标题：" + (result.title?.status === "filled" ? "已填入" : result.title?.status === "failed" ? ("失败（" + (result.title?.error || "可重试") + "）") : "未更改");
    const bodyLine = "正文 + 话题：" + (result.body?.status === "filled" ? "已填入" : result.body?.status === "failed" ? ("失败（" + (result.body?.error || "可重试") + "）") : "未更改");
    const imageLine = (result.images?.items || []).map((image) => {
      const meta = allImages.find((entry) => entry.itemId === image.itemId);
      const index = meta ? Number(meta.index) + 1 : image.itemId;
      return "图片 #" + index + "：" + (image.status === "filled" ? "已填入" : image.status === "failed" ? ("失败（" + (image.error || "可重试") + "）") : "待处理");
    }).join("；");
    const videoLine = result.video ? "；视频：" + (result.video.status === "filled" ? "已填入" : result.video.status === "failed" ? ("失败（" + (result.video.error || "可重试") + "）") : "未更改") : "";
    creatorFillResult.textContent = titleLine + "；" + bodyLine + (imageLine ? "；" + imageLine : "") + videoLine
      + "。状态：" + (saved.fillStatus === "filled" ? "已填充待人工检查和提交" : "部分失败，可重试失败项") + "。";
    setStatus("");
    const failedFields = [
      ...(result.title?.status === "failed" ? ["title"] : []),
      ...(result.body?.status === "failed" ? ["body"] : []),
    ];
    const failedImageIds = (result.images?.items || []).filter((image) => image.status === "failed").map((image) => image.itemId);
    const failedVideo = Boolean(video && result.video?.status === "failed");
    creatorRetryBtn.hidden = failedFields.length === 0 && failedImageIds.length === 0 && !failedVideo;
    creatorRetryBtn.dataset.fields = JSON.stringify(failedFields);
    creatorRetryBtn.dataset.imageIds = JSON.stringify(failedImageIds);
    creatorRetryBtn.dataset.video = failedVideo ? "true" : "false";
    creatorFillBtn.disabled = saved.fillStatus === "filled";
    creatorFillBtn.textContent = saved.fillStatus === "filled" ? "内容已填入，不会自动发布" : video ? "确认再次填入文字与视频，不发布" : "确认再次填入文字与图片，不发布";
    creatorCancelBtn.disabled = saved.fillStatus === "filled";
    if (saved.fillStatus === "filled") {
      await sendCreatorPageMessage(tab, {
        action: "aichihongshu:creator-images-clear",
        capabilityKey,
      }).catch(() => {});
    }
  } catch (error) {
    if (error?.message === "USER_CANCELLED") {
      const capabilityKey = creatorClaim.task.attemptId + ":" + creatorClaim.task.accountPoolId + ":" + creatorClaim.claimToken;
      await sendCreatorPageMessage({ id: creatorTabId }, {
        action: "aichihongshu:creator-images-clear",
        capabilityKey,
      }).catch(() => {});
      try {
        await finishCreatorTask({ cancelled: true, titleStatus: "skipped", titleError: "", bodyStatus: "skipped", bodyError: "" });
        creatorClaim = null;
        creatorTaskPreview.hidden = true;
        creatorClaimBtn.disabled = false;
        creatorConfirmFill.checked = false;
        targetAccountEl.disabled = false;
        creatorFillResult.textContent = "已取消媒体传输和填充；页面未作修改。";
      } catch (cancelError) {
        creatorFillResult.textContent = "取消未确认：" + (cancelError?.message || cancelError);
      }
      return;
    }
    creatorFillResult.textContent = "填充结果未确认：" + (error?.message || error) + "。请先检查页面当前内容。";
    setStatus(error?.message || String(error), true);
    creatorFillBtn.disabled = false;
    creatorCancelBtn.disabled = false;
  } finally {
    nativePort?.close();
    creatorBusy = false;
    creatorRetryBtn.disabled = false;
    creatorCancelBtn.disabled = !creatorClaim;
  }
}
async function cancelCreatorTask() {
  if (!creatorClaim) return;
  if (creatorBusy) {
    creatorCancelRequested = true;
    creatorCancelBtn.disabled = true;
    setStatus("正在停止媒体传输并取消任务…");
    return;
  }
  creatorBusy = true;
  creatorCancelBtn.disabled = true;
  try {
    const capabilityKey = creatorClaim.task.attemptId + ":" + creatorClaim.task.accountPoolId + ":" + creatorClaim.claimToken;
    await sendCreatorPageMessage({ id: creatorTabId }, {
      action: "aichihongshu:creator-images-clear",
      capabilityKey,
    }).catch(() => {});
    await finishCreatorTask({
      cancelled: true,
      titleStatus: "skipped",
      titleError: "",
      bodyStatus: "skipped",
      bodyError: "",
    });
    creatorClaim = null;
    creatorTaskPreview.hidden = true;
    creatorClaimBtn.disabled = false;
    creatorConfirmFill.checked = false;
    targetAccountEl.disabled = false;
    creatorFillResult.textContent = "已取消后续填充任务；已经填入页面的内容保留。";
  } catch (error) {
    creatorFillResult.textContent = `取消未确认：${error?.message || error}`;
    creatorCancelBtn.disabled = false;
  } finally {
    creatorBusy = false;
  }
}

async function loadPreview() {
  const epoch = ++pageEpoch;
  configurationEdited = false;
  lookupEpoch += 1;
  await readConnectionPreference();
  await restoreStagedCapture();
  captureBtn.disabled = true;
  desktopConnected = false;
  setConnectionStatus("checking", "正在检测");
  connectionDetailEl.textContent = "正在检测 " + (expectedChannel === "dev" ? "DEV" : "正式版") + " 桌面连接…";
  connectionRemedyEl.textContent = "只读检查；打开插件不会自动启动桌面 APP。";
  retryConnectionBtn.hidden = true;
  launchDesktopBtn.hidden = true;
  accountStatusEl.textContent = "等待解析当前页面…";
  setStatus(stagedCaptureMessage
    ? `已暂存到浏览器会话；尚未保存到桌面端。目标账号 ${stagedCaptureMessage.targetAccountId}。`
    : "");
  try {
    await restorePendingCapture();
    await restoreSessionAccounts();
    const connectionPromise = discoverAndConnect().catch((error) => {
      reportConnectionFailure({ runtimeError: error?.message || String(error), step: "desktop_instance" });
      return false;
    });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (epoch !== pageEpoch) return;
    if (!tab?.id) throw new Error("没有活动标签页");
    sourceTabId = tab.id;
    sourceTabUrl = String(tab.url || "");
    parseBatchId = "";
    selectedImageSet = new Set();
    selectedCommentSet = new Set();
    commentsOpen = false;
    profileNotesOpen = false;
    activeImageIndex = 0;
    creatorTabId = null;
    creatorPageUrl = "";
    creatorClaim = null;
      creatorTaskPreview.hidden = true;
      creatorFillResult.textContent = "";
    setCreatorWorkflowVisible(isCreatorPublishUrl(tab.url || ""));
    if (isCreatorPublishUrl(tab.url || "")) {
      creatorTabId = tab.id;
      creatorPageUrl = tab.url || "";
      restricted = false;
      parsed = null;
      previewMeta.textContent = "小红书创作页 · 填入前会显示标题、正文和现有内容差异";
      previewFields.replaceChildren();
      accountStatusEl.textContent = "正在读取用于任务领取的账号…";
      void connectionPromise.then(async (connected) => {
        if (epoch !== pageEpoch) return;
        if (connected) await loadCaptureAccounts(epoch);
        else await restoreSessionAccounts();
        if (epoch === pageEpoch) creatorClaimBtn.disabled = !targetAccountEl.value || !desktopConnected;
      });
      setStatus("请先在桌面端发布准备中创建一条文字填充任务");
      return;
    }
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["extract.js"],
    });
    if (epoch !== pageEpoch) return;
    parsed = result?.result ?? null;
    if (!parsed || !parsed.title) {
      restricted = true;
      previewMeta.textContent = "当前页不可抓取（chrome:// 等受限页面）";
      captureBtn.disabled = true;
      accountStatusEl.textContent = "受限页面无法提供账号关联预览";
      return;
    }
    if (sourceTabUrl && parsed.sourceUrl !== sourceTabUrl) {
      throw new Error("解析期间来源页面已导航；请重新打开插件后再采集");
    }
    parseBatchId = crypto.randomUUID();
    restricted = false;
    pageContext = null;
    contextLookupAvailable = false;
    pageTypeEl.value = parsed.pageType || "web";
    if (pageTypeEl.value !== "profile") {
      selectedImageSet = new Set((parsed.images || []).slice(0, 12).map((_, index) => index));
    }
    await restoreUiSelectionForPage();
    renderCaptureOptions();
    applyDefaultMode();
    previewMeta.textContent = "已解析当前页为「" + typeLabel(pageTypeEl.value) + "」；本地账号与历史数据正在独立读取";
    renderPreview();
    accountStatusEl.textContent = "正在读取本地账号与页面归属…";
    void connectionPromise.then(async (connected) => {
      if (epoch !== pageEpoch) return;
      if (connected) await loadAccountsAndContext(epoch);
      else {
        await restoreSessionAccounts();
        pageContext = null;
        contextLookupAvailable = false;
        applyDefaultMode();
        renderPreview();
      }
    }).catch((error) => {
      if (epoch !== pageEpoch) return;
      contextLookupAvailable = false;
      pageContext = null;
      accountStatusEl.textContent = "账号或归属查询失败：" + (error?.message || error) + "；页面预览仍可查看";
      applyDefaultMode();
      renderPreview();
    });
  } catch (error) {
    if (epoch !== pageEpoch) return;
    restricted = true;
    previewMeta.textContent = "当前页不可抓取";
    captureBtn.disabled = true;
    accountStatusEl.textContent = "页面解析失败，无法提供预览";
    setStatus(String(error?.message || error), true);
  }
}

async function openExpandedPreview() {
  if (!parsed || restricted || sourceTabId == null || !parseBatchId) return;
  if (!chrome.storage?.session) throw new Error("浏览器未提供 session 临时存储；请更新 Chrome/Edge 后重试");
  if (parsed.sourceUrl !== sourceTabUrl) throw new Error("来源链接与解析批次不一致；请重新解析后展开预览");
  const sourceTab = await chrome.tabs.get(sourceTabId);
  if (!sourceTab?.url || sourceTab.url !== sourceTabUrl) throw new Error("原来源标签页已关闭或导航；请重新解析后展开预览");
  const previewTab = await chrome.tabs.create({ url: "about:blank", active: false });
  if (!previewTab?.id) throw new Error("无法创建展开预览标签页");
  const key = globalThis.AichiPreviewSession.storageKey(previewTab.id);
  try {
    const record = {
      previewTabId: previewTab.id,
      sourceTabId,
      sourceUrl: sourceTabUrl,
      parseBatchId,
      createdAt: Date.now(),
      parsed,
      pageType: pageTypeEl.value,
      clipKind: selectedClipKind(),
      modules: selectedModules(),
      selectedImageIndexes: selectedImageIndexes(),
      activeImageIndex,
      selectedCommentIndexes: selectedCommentIndexes(),
      pageContext: pageContext ? {
        pageType: pageContext.pageType,
        snapshotKind: pageContext.snapshotKind,
        lastSnapshotAt: pageContext.lastSnapshotAt,
        lastSnapshotMetrics: pageContext.lastSnapshotMetrics || null,
      } : null,
    };
    await chrome.storage.session.set({ [key]: record });
    // Do not put source text, comments, URLs, session keys, or tokens in the URL.
    await chrome.tabs.update(previewTab.id, { url: chrome.runtime.getURL("preview.html"), active: true });
  } catch (error) {
    if (key) await chrome.storage.session.remove(key).catch(() => {});
    await chrome.tabs.remove(previewTab.id).catch(() => {});
    throw error;
  }
}

async function assertCaptureSource() {
  const source = sourceTabId == null ? null : await chrome.tabs.get(sourceTabId);
  if (!source?.url || source.url !== sourceTabUrl || parsed?.sourceUrl !== sourceTabUrl) {
    restricted = true;
    renderPreview();
    throw new Error("来源页面已关闭或导航，请重新打开插件解析后再保存");
  }
  return source;
}

function requestedCaptureOutcomes(message) {
  return globalThis.AichiCaptureRecovery.requestedOutcomes(message);
}

function missingCaptureOutcomes(message, status) {
  return globalThis.AichiCaptureRecovery.missingOutcomes(message, status);
}

function captureOutcomeText(outcomes, message) {
  const requested = requestedCaptureOutcomes(message);
  const results = [];
  if (requested.collectRequested) {
    results.push(outcomes.collectionSaved ? "收藏已入库 ✓" : `收藏失败：${outcomes.collectionError || "未确认持久化"}`);
  }
  if (requested.snapshotRequested) {
    results.push(outcomes.snapshotSaved ? "数据快照已保存 ✓" : `数据快照失败：${outcomes.snapshotError || "未确认持久化"}`);
  }
  if (requested.detailsRequested) {
    results.push(outcomes.captureDetailsSaved
      ? `图片清单/评论摘录已保存 ✓（${message.images?.length || 0} 张图片，${message.comments?.length || 0} 条评论）`
      : `图片/评论摘录未确认：${outcomes.captureDetailsError || "待核实"}`);
  }
  if (requested.imageBytesRequested) {
    const ready = Number(outcomes.imagesReady);
    const expected = message.images.length;
    results.push(ready === expected
      ? `${expected} 张所选原图已校验并保存到本地 ✓`
      : `原图本地保存待核实（${Number.isFinite(ready) ? ready : 0}/${expected}）`);
  }
  if (requested.profileNotesRequested) {
    if (outcomes.profileNotesSaved) {
      const noteResult = outcomes.profileNotesSkipped
        ? "当前主页尚未登记为本人/榜样账号，未导入笔记"
        : `主页笔记已同步 ${Number(outcomes.profileNotesImported || 0)} 篇（更新 ${Number(outcomes.profileNotesUpdated || 0)} 篇）${outcomes.profileNotesState === "partial" ? "，本次为部分加载，互动汇总未覆盖" : ""}`;
      results.push(noteResult + " ✓");
    } else {
      results.push(`主页笔记同步未确认：${outcomes.profileNotesError || "待核实"}`);
    }
  }
  return results.join("；");
}

function completeCaptureStatus(message, status) {
  return missingCaptureOutcomes(message, status).length === 0;
}

async function verifyPendingCapture() {
  if (!pendingCaptureMessage || verifyingCapture) return;
  verifyingCapture = true;
  const message = pendingCaptureMessage;
  verifyCaptureBtn.disabled = true;
  retryCaptureBtn.hidden = true;
  setStatus("正在按 requestId 核实本地保存结果…");
  try {
    if (!desktopConnected) await checkDesktopConnection();
    if (!desktopConnected) throw new Error("原工作区连接尚未恢复，请先重试连接");
    const lookupRequest = globalThis.AichiCaptureRecovery.buildLookupRequest(
      message,
      PROTOCOL_VERSION,
      manifest?.version || "",
    );
    if (!lookupRequest) throw new Error("原采集请求缺少有效 requestId 或账号；请重新解析页面");
    const { response, runtimeError, timedOut } = await sendNativeRequest(lookupRequest);
    updateConnectionStatus(response, runtimeError);
    if (timedOut || runtimeError || response?.ok !== true || !response.captureStatus) {
      setStatus("保存结果仍待核实：" + (runtimeError || response?.error || "查询暂不可用") + "。请稍后再次核实；不会自动重发。", true);
      verifyCaptureBtn.hidden = false;
      return;
    }
    if (!responseMatchesExpectedIdentity(response)) {
      setStatus("保存结果仍待核实：响应来自不同通道或工作区；请恢复原连接后再次核实。", true);
      verifyCaptureBtn.hidden = false;
      return;
    }
    const captureStatus = response.captureStatus;
    if (!globalThis.AichiCaptureRecovery.matchesRequest(captureStatus, message)) {
      setStatus("保存结果仍待核实：回执 requestId 或目标账号不匹配；为避免重复写入，不提供安全重试。", true);
      verifyCaptureBtn.hidden = false;
      return;
    }
    const missing = missingCaptureOutcomes(message, captureStatus);
    if (completeCaptureStatus(message, captureStatus)) {
      const results = captureOutcomeText({
        collectionSaved: captureStatus.collectionSaved,
        snapshotSaved: captureStatus.snapshotSaved,
        captureDetailsSaved: captureStatus.captureDetailsSaved,
        profileNotesSaved: captureStatus.profileNotesSaved,
        profileNotesImported: captureStatus.profileNotesImported,
        profileNotesUpdated: captureStatus.profileNotesUpdated,
        profileNotesSkipped: captureStatus.profileNotesSkipped,
        profileNotesState: captureStatus.profileNotesState,
        profileNotesError: captureStatus.profileNotesError,
        imagesTotal: captureStatus.imagesTotal,
        imagesReady: captureStatus.imagesReady,
        imagesFailed: captureStatus.imagesFailed,
      }, message);
      await clearPendingCapture();
      await clearStagedCapture();
      verifyCaptureBtn.hidden = true;
      retryCaptureBtn.hidden = true;
      setStatus("核实完成：" + results);
      renderPreview();
      return;
    }
    retryCaptureBtn.textContent = requestedCaptureOutcomes(message).imageBytesRequested
      ? "重试未完成原图" : "使用相同请求重试";
    const imageProgress = requestedCaptureOutcomes(message).imageBytesRequested
      ? `原图 ${Number(captureStatus.imagesReady || 0)}/${message.images.length} 已落地，失败 ${Number(captureStatus.imagesFailed || 0)} 张。`
      : "";
    setStatus(`requestId ${message.requestId} 已核实。${imageProgress}以下模块尚未完成：${missing.join("、")}。可使用同一请求安全重试。`, true);
    verifyCaptureBtn.hidden = false;
    retryCaptureBtn.hidden = false;
  } catch (error) {
    setStatus("保存结果仍待核实：" + (error?.message || String(error)) + "。请稍后再次核实；不会自动重发。", true);
    verifyCaptureBtn.hidden = false;
  } finally {
    verifyingCapture = false;
    verifyCaptureBtn.disabled = false;
  }
}

async function submitCaptureMessage(message) {
  if (savingCapture) return;
  savingCapture = true;
  updateConnectionControls();
  captureBtn.disabled = true;
  verifyCaptureBtn.hidden = true;
  retryCaptureBtn.hidden = true;
  setStatus("正在回传并保存…");
  try {
    await retainPendingCapture(message);
    const { response, runtimeError, timedOut } = await sendNativeRequest(message);
    const connectionValid = updateConnectionStatus(response, runtimeError, timedOut);
    const identityMatches = globalThis.AichiCaptureRecovery.matchesIdentity(response, expectedChannel, connectedWorkspaceId);
    const responseError = typeof response?.error === "string" ? response.error : "";
    if (connectionValid && identityMatches && response?.ok === true
      && response.collectionSaved === true && response.captureDetailsSaved === true
      && message.imageTransferProtocol && Array.isArray(message.images) && message.images.length > 0) {
      try {
        await transferSelectedCaptureImages(message, String(response.collectionId || `bc:${message.targetAccountId}:${message.requestId}`));
        pendingCaptureMessage = message;
        await verifyPendingCapture();
      } catch (error) {
        pendingCaptureMessage = message;
        verifyCaptureBtn.hidden = false;
        await verifyPendingCapture();
        if (pendingCaptureMessage?.requestId === message.requestId) {
          setStatus(`正文已保存，原图传输未完成：${error?.message || error}。可按原 requestId 核实并重试。`, true);
        }
      }
      return;
    }
    let disposition = globalThis.AichiCaptureRecovery.classifySaveResponse(
      message,
      { response, runtimeError, timedOut },
      identityMatches,
    );
    if (identityMatches && !connectionValid && response?.ok === true) disposition = "lookup";
    if (disposition === "identity_mismatch") {
      pendingCaptureMessage = message;
      verifyCaptureBtn.hidden = false;
      setStatus("写入结果来自不同通道或工作区，暂不能确认；恢复原连接后再核实，不会自动重发。", true);
      return;
    }
    if (disposition === "lookup") {
      pendingCaptureMessage = message;
      verifyCaptureBtn.hidden = false;
      setStatus("写入回执未确认；正在按原 requestId 查询结果，避免重复收藏…");
      await verifyPendingCapture();
      return;
    }
    if (disposition === "rejected") {
      await clearPendingCapture();
      setStatus("回传失败：" + (responseError || "桌面端未接受请求"), true);
      return;
    }
    const outcomes = response.outcomes || response;
    const missing = missingCaptureOutcomes(message, {
      collectionSaved: outcomes.collectionSaved === true,
      captureDetailsSaved: outcomes.captureDetailsSaved === true,
      snapshotSaved: outcomes.snapshotSaved === true,
      profileNotesSaved: outcomes.profileNotesSaved === true,
    });
    if (missing.length) {
      pendingCaptureMessage = message;
      setStatus("桌面端回执显示尚未保存：" + missing.join("、") + "；正在核实 requestId…", true);
      verifyCaptureBtn.hidden = false;
      await verifyPendingCapture();
      return;
    }
    await clearPendingCapture();
    await clearStagedCapture();
    setStatus(captureOutcomeText(outcomes, message));
  } catch (error) {
    // A bridge or UI exception may occur after the host has persisted the request.
    // Keep the exact requestId and verify before offering a retry.
    pendingCaptureMessage = message;
    verifyCaptureBtn.hidden = false;
    setStatus("写入结果未确认：" + (error?.message || String(error)) + "；正在按原 requestId 查询结果…", true);
    await verifyPendingCapture();
  } finally {
    savingCapture = false;
    renderPreview();
  }
}

["m-titleBody", "m-authorSource", "m-metrics", "m-published", "m-images", "m-comments"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => {
    configurationEdited = true;
    if (id === "m-images" || id === "m-comments") renderCaptureOptions();
    renderPreview();
    void persistUiSelection();
  });
});
collectTab.addEventListener("click", () => setMode("collect"));
dataTab.addEventListener("click", () => setMode("data"));
updateContentBtn.addEventListener("click", () => setMode("collect"));
refreshDataBtn.addEventListener("click", () => setMode("data"));
document.querySelector(".mode-tabs").addEventListener("keydown", (event) => {
  const tabs = [collectTab, dataTab].filter((tab) => !tab.disabled);
  const current = tabs.indexOf(document.activeElement);
  const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const tab = event.key === "Home" ? tabs[0] : tabs[tabs.length - 1];
    tab?.focus();
    setMode(tab === collectTab ? "collect" : "data");
  } else if (direction && current >= 0) {
    event.preventDefault();
    const tab = tabs[(current + direction + tabs.length) % tabs.length];
    tab.focus();
    setMode(tab === collectTab ? "collect" : "data");
  }
});
pageTypeEl.addEventListener("change", () => {
  configurationEdited = true;
  if (pageTypeEl.value === "web") activeMode = "collect";
  renderCaptureOptions();
  void refreshLookupForSelectedAccount().catch((error) => setStatus(String(error?.message || error), true));
  void persistUiSelection();
});
targetAccountEl.addEventListener("change", () => {
  if (creatorTabId !== null) {
    creatorClaimBtn.disabled = !targetAccountEl.value || !desktopConnected || Boolean(creatorClaim);
    return;
  }
  void persistUiSelection();
  accountStatusEl.textContent = "正在查询所选账号中的页面归属…";
  void refreshLookupForSelectedAccount().catch((error) => {
    accountStatusEl.textContent = "读取所选账号失败：" + (error?.message || error) + "；页面预览仍可查看";
  });
});

retryConnectionBtn.addEventListener("click", () => {
  const epoch = pageEpoch;
  retryConnectionBtn.disabled = true;
  setConnectionStatus("checking", "正在检测");
  void (async () => {
    const connected = await discoverAndConnect();
    if (connected && parsed && !restricted) await loadAccountsAndContext(epoch);
    else if (!connected) await restoreSessionAccounts();
    if (pendingCaptureMessage) await verifyPendingCapture();
  })().catch((error) => {
    connectionDetailEl.textContent = error?.message || String(error);
  }).finally(() => {
    retryConnectionBtn.disabled = false;
    retryConnectionBtn.hidden = desktopConnected;
  });
});

launchDesktopBtn.addEventListener("click", () => void launchSelectedDesktop());

connectInstanceBtn.addEventListener("click", () => {
  if (stagedCaptureMessage || pendingCaptureMessage || preparingCapture || savingCapture) {
    setStatus("当前有绑定原实例的暂存或待核实请求；请先完成该请求后再切换实例。", true);
    return;
  }
  const workspaceId = instancePicker.value;
  if (!workspaceId) return;
  connectedWorkspaceId = workspaceId;
  selectedWorkspaceByChannel[expectedChannel] = workspaceId;
  void saveConnectionPreference().then(async () => {
    const connected = await connectToInstance(workspaceId);
    if (connected && parsed && !restricted) await loadAccountsAndContext(pageEpoch);
    else if (!connected) await restoreSessionAccounts();
  }).catch((error) => reportConnectionFailure({ runtimeError: error?.message || String(error), step: "desktop_instance" }));
});

devModeToggle.addEventListener("change", () => {
  if (stagedCaptureMessage || pendingCaptureMessage || preparingCapture || savingCapture) {
    devModeToggle.checked = devModeEnabled;
    setStatus("当前请求正在准备或绑定原通道/工作区；先完成后再切换开发模式。", true);
    return;
  }
  devModeEnabled = Boolean(devModeToggle.checked);
  expectedChannel = devModeEnabled ? "dev" : "prod";
  connectedWorkspaceId = selectedWorkspaceByChannel[expectedChannel] || "";
  desktopConnected = false;
  availableInstances = [];
  void saveConnectionPreference().then(async () => {
    await restoreStagedCapture();
    await restorePendingCapture();
    await restoreSessionAccounts();
    const connected = await discoverAndConnect();
    if (connected && parsed && !restricted) await loadAccountsAndContext(pageEpoch);
    else if (!connected) renderPreview();
  }).catch((error) => reportConnectionFailure({ runtimeError: error?.message || String(error), step: "desktop_instance" }));
});

creatorClaimBtn.addEventListener("click", () => void claimCreatorTask());
creatorConfirmFill.addEventListener("change", () => {
  creatorFillBtn.disabled = !creatorConfirmFill.checked || !creatorClaim || creatorBusy;
});
creatorFillBtn.addEventListener("click", () => void runCreatorFill());
creatorRetryBtn.addEventListener("click", () => {
  let fields = [];
  let imageIds = [];
  const video = creatorRetryBtn.dataset.video === "true";
  try { fields = JSON.parse(creatorRetryBtn.dataset.fields || "[]"); } catch { /* keep empty */ }
  try { imageIds = JSON.parse(creatorRetryBtn.dataset.imageIds || "[]"); } catch { /* keep empty */ }
  if (fields.length || imageIds.length || video) void runCreatorFill(fields, imageIds, video);
});
creatorCancelBtn.addEventListener("click", () => void cancelCreatorTask());

async function buildCaptureMessageFromPreview(epoch) {
  if (!parsed || restricted || !targetAccountEl.value) throw new Error("页面预览或目标账号尚未就绪");
  const source = await assertCaptureSource();
  const accountId = targetAccountEl.value;
  const type = pageTypeEl.value;
  const uiModules = selectedModules();
  const isDataRefresh = activeMode === "data";
  const modules = isDataRefresh ? {
    collect: { titleBody: false, authorSource: false, images: false, comments: false },
    data: uiModules.data,
  } : uiModules;
  const images = selectedImageIndexes();
  const comments = selectedCommentIndexes();
  const channel = expectedChannel;
  const workspaceId = connectedWorkspaceId || selectedWorkspaceByChannel[expectedChannel] || "";
  const message = globalThis.AichiCapturePreview.buildCaptureMessage(parsed, {
    pageType: type,
    modules,
    clipKind: selectedClipKind(),
    kind: isDataRefresh ? (pageContext?.snapshotKind || (type === "profile" ? "ref_snapshot" : "note_snapshot")) : "clip",
    selectedImageIndexes: images,
    selectedCommentIndexes: comments,
    pageContext,
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    targetAccountId: Number(accountId),
    extensionVersion: manifest?.version || "",
  });
  message.imageTransferProtocol = !isDataRefresh && Array.isArray(message.images) && message.images.length > 0;
  message.profileNotesRequested = false;
  const current = await assertCaptureSource();
  if (epoch !== pageEpoch || current.id !== sourceTabId || accountId !== targetAccountEl.value
    || type !== pageTypeEl.value || channel !== expectedChannel
    || workspaceId !== (connectedWorkspaceId || selectedWorkspaceByChannel[expectedChannel] || "")
    || JSON.stringify(uiModules) !== JSON.stringify(selectedModules())
    || JSON.stringify(images) !== JSON.stringify(selectedImageIndexes())
    || JSON.stringify(comments) !== JSON.stringify(selectedCommentIndexes())) {
    throw new Error("采集配置或来源页面已改变；本次没有保存，请检查预览后重试");
  }
  return message;
}

captureBtn.addEventListener("click", async () => {
  if (!parsed || restricted || !desktopConnected || pendingCaptureMessage || stagedCaptureMessage || savingCapture || preparingCapture) return;
  preparingCapture = true;
  updateConnectionControls();
  try {
    const permissionPromise = requestSelectedImagePermissionsFromPreview();
    const message = await buildCaptureMessageFromPreview(pageEpoch);
    await permissionPromise;
    await submitCaptureMessage(message);
  } catch (error) {
    setStatus(String(error?.message || error), true);
  } finally {
    preparingCapture = false;
    renderPreview();
  }
});

stageCaptureBtn.addEventListener("click", async () => {
  if (!parsed || restricted || desktopConnected || !targetAccountEl.value || savingCapture || preparingCapture) return;
  preparingCapture = true;
  stageCaptureBtn.disabled = true;
  updateConnectionControls();
  try {
    const channel = expectedChannel;
    const workspaceId = connectedWorkspaceId || selectedWorkspaceByChannel[expectedChannel] || "";
    const accountId = Number(targetAccountEl.value);
    const message = await buildCaptureMessageFromPreview(pageEpoch);
    if (!workspaceId) {
      throw new Error("还没有已绑定的桌面实例；请先连接一次并读取目标账号后再暂存");
    }
    if (desktopConnected || channel !== expectedChannel
      || workspaceId !== (connectedWorkspaceId || selectedWorkspaceByChannel[expectedChannel] || "")
      || accountId !== Number(targetAccountEl.value)) {
      throw new Error("连接、工作区或账号在暂存准备期间发生变化；本次没有暂存，请检查后重试");
    }
    await retainStagedCapture(message);
    setStatus(`已暂存到浏览器会话；尚未保存到桌面端。目标账号 ${message.targetAccountId}。桌面恢复后请核对账号再保存。`);
  } catch (error) {
    setStatus(String(error?.message || error), true);
  } finally {
    preparingCapture = false;
    renderPreview();
    renderInstancePicker();
  }
});

saveStagedCaptureBtn.addEventListener("click", async () => {
  const message = stagedCaptureMessage;
  if (!message || savingCapture || preparingCapture) return;
  try {
    const permissionPromise = requestSelectedImagePermissions(message);
    await permissionPromise;
    if (!desktopConnected) throw new Error("请先连接原桌面实例");
    if (stagedCaptureChannel !== expectedChannel || stagedCaptureWorkspaceId !== connectedWorkspaceId) {
      throw new Error("暂存请求绑定的是另一桌面实例；不会转投当前数据库，请切回原通道和工作区");
    }
    if (verifiedAccountsWorkspaceId !== connectedWorkspaceId) {
      if (!(await loadCaptureAccounts(pageEpoch))) throw new Error("未能重新读取原桌面实例账号；内容仍只暂存在浏览器");
    }
    const accountId = Number(message.targetAccountId);
    if (Number(targetAccountEl.value) !== accountId
      || !sessionAccounts.some((account) => account.id === accountId)) {
      throw new Error(`请在目标账号列表中核对原账号 ${accountId}；当前选择不同，未写入桌面`);
    }
    if (parsed?.sourceUrl !== message.sourceUrl) throw new Error("请回到原来源页面再保存暂存内容");
    await assertCaptureSource();
    await submitCaptureMessage(message);
  } catch (error) {
    setStatus(String(error?.message || error), true);
  }
});

cancelStagedCaptureBtn.addEventListener("click", async () => {
  if (!stagedCaptureMessage || pendingCaptureMessage || savingCapture || preparingCapture) return;
  try {
    await clearStagedCapture();
    setStatus("已放弃浏览器暂存；没有写入桌面端。");
    renderCaptureOptions();
    renderPreview();
  } catch (error) {
    setStatus(`取消暂存失败：${error?.message || error}`, true);
  }
});

expandPreviewBtn.addEventListener("click", () => {
  expandPreviewBtn.disabled = true;
  void openExpandedPreview().catch((error) => setStatus(error?.message || String(error), true))
    .finally(() => { expandPreviewBtn.disabled = !parsed || restricted || sourceTabId == null; });
});

verifyCaptureBtn.addEventListener("click", () => void verifyPendingCapture());
retryCaptureBtn.addEventListener("click", () => {
  if (pendingCaptureMessage) {
    const permissionPromise = requestSelectedImagePermissions(pendingCaptureMessage);
    void permissionPromise.then(() => submitCaptureMessage(pendingCaptureMessage)).catch((error) => setStatus(String(error?.message || error), true));
  }
});

clipKindEl.addEventListener("change", () => {
  configurationEdited = true;
  if (selectedClipKind() === "material") {
    if (selectedImageIndexes().length === 0 && parsed?.images?.length) {
      selectedImageSet = new Set((parsed.images || []).slice(0, 12).map((_, index) => index));
    }
    document.getElementById("m-images").checked = selectedImageIndexes().length > 0;
    if (activeMode === "data") setMode("collect", false);
  } else if (pageTypeEl.value === "web") {
    document.getElementById("m-images").checked = false;
  }
  renderCaptureOptions();
  renderPreview();
  void persistUiSelection();
});

void loadPreview();
