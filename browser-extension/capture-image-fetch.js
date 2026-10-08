// Fetches only user-selected public image URLs for the currently open popup.
// Image bytes stay in the service worker and are exposed in bounded chunks.
(() => {
  const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
  const MAX_CHUNK_BYTES = 64 * 1024;
  const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  const transfers = new Map();

  function fail(message) { throw new Error(message); }

  function publicHost(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
    if (host.includes(":")) return false;
    if (host.length > 253 || !host.includes(".") || !/^[a-z0-9.-]+$/.test(host)
      || host.split(".").some((part) => !part || part.length > 63 || part.startsWith("-") || part.endsWith("-"))) return false;
    const parts = host.split(".");
    const numericHost = parts.every((part) => /^\d+$/.test(part));
    if (!numericHost) return !["test", "example", "invalid", "localhost"].includes(parts.at(-1));
    if (parts.length !== 4) return false;
    if (parts.some((part) => Number(part) < 0 || Number(part) > 255)) return false;
    const octets = parts.map(Number);
    const [a, b, c] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }

  function validPopupSender(sender) {
    if (!sender || typeof chrome.runtime?.id !== "string" || sender.id !== chrome.runtime.id) return false;
    try {
      const url = new URL(String(sender.url || ""));
      return url.protocol === "chrome-extension:" && url.hostname === chrome.runtime.id
        && url.pathname === "/popup.html";
    } catch { return false; }
  }

  function validIdentity(message) {
    return typeof message.captureRequestId === "string" && message.captureRequestId.length > 0
      && message.captureRequestId.length <= 128
      && Number.isSafeInteger(message.targetAccountId) && message.targetAccountId > 0
      && ["prod", "dev"].includes(message.expectedChannel)
      && typeof message.expectedWorkspaceId === "string" && message.expectedWorkspaceId.length > 0
      && message.expectedWorkspaceId.length <= 200
      && Number.isSafeInteger(message.sourceTabId) && message.sourceTabId > 0
      && typeof message.sourceUrl === "string" && message.sourceUrl.length <= 2_000
      && Number.isInteger(message.position) && message.position >= 0 && message.position < 12;
  }

  function assertIdentityMatch(transfer, message, port) {
    if (transfer.owner !== port || transfer.captureRequestId !== message.captureRequestId
      || transfer.targetAccountId !== message.targetAccountId
      || transfer.expectedChannel !== message.expectedChannel
      || transfer.expectedWorkspaceId !== message.expectedWorkspaceId
      || transfer.sourceTabId !== message.sourceTabId || transfer.sourceUrl !== message.sourceUrl
      || transfer.position !== message.position) {
      fail("图片传输身份不匹配；请按原 requestId 核实后重试");
    }
  }

  function detectMime(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
    if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)).startsWith("GIF8")) return "image/gif";
    if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
    return "";
  }

  function encodeBase64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8_192) {
      binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 8_192, bytes.length)));
    }
    return btoa(binary);
  }

  async function readImageBytes(response) {
    const declaredMime = String(response.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase();
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) fail("图片超过 25MB，本次未保存");
    const reader = response.body?.getReader?.();
    if (!reader) fail("浏览器没有提供原图字节流");
    const parts = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        fail("图片超过 25MB，本次未保存");
      }
      parts.push(value);
    }
    if (!total || (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength !== total)) {
      fail("图片响应长度无效或传输不完整");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const detected = detectMime(bytes);
    const mimeType = declaredMime.startsWith("image/") ? declaredMime : detected;
    if (!detected || !ALLOWED_MIME_TYPES.has(mimeType) || mimeType !== detected) {
      fail("图片内容与受支持格式不匹配，本次未保存");
    }
    return { bytes, mimeType };
  }

  async function fetchSelectedImage(message, port) {
    if (transfers.size !== 0) fail("另一个所选图片仍在读取；请稍后重试");
    if (!validIdentity(message)) fail("图片传输缺少有效的来源或目标身份");
    const sourcePage = await chrome.tabs.get(message.sourceTabId).catch(() => null);
    if (!sourcePage?.url || sourcePage.url !== message.sourceUrl) fail("原来源页面已关闭或导航；请返回原页面重新解析");
    let source;
    try { source = new URL(String(message.imageUrl || "")); } catch { fail("所选图片链接无效"); }
    if (source.protocol !== "https:" || source.username || source.password
      || !publicHost(source.hostname) || (source.port && source.port !== "443")) {
      fail("仅支持公开 HTTPS 图片来源；本次没有发起请求");
    }
    const granted = await chrome.permissions.contains({ origins: [`${source.origin}/*`] });
    if (!granted) fail("尚未取得这张图片来源的权限；请在保存操作中允许后重试");
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 60_000);
    const transfer = {
      owner: port,
      controller,
      captureRequestId: message.captureRequestId,
      targetAccountId: message.targetAccountId,
      expectedChannel: message.expectedChannel,
      expectedWorkspaceId: message.expectedWorkspaceId,
      sourceTabId: message.sourceTabId,
      sourceUrl: message.sourceUrl,
      position: message.position,
      bytes: null,
      sha256: "",
      mimeType: "",
    };
    const transferId = crypto.randomUUID();
    transfers.set(transferId, transfer);
    try {
      const response = await fetch(source.href, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok) fail(`图片来源返回 HTTP ${response.status}`);
      const finalUrl = new URL(response.url || source.href);
      if (finalUrl.protocol !== "https:" || finalUrl.origin !== source.origin) {
        fail("图片跳转到另一个图源；为避免扩大权限，请回到原页面重新选择该图");
      }
      const image = await readImageBytes(response);
      const digest = await crypto.subtle.digest("SHA-256", image.bytes);
      transfer.bytes = image.bytes;
      transfer.mimeType = image.mimeType;
      transfer.sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      return {
        transferId,
        totalBytes: image.bytes.byteLength,
        sha256: transfer.sha256,
        mimeType: image.mimeType,
      };
    } catch (error) {
      transfers.delete(transferId);
      controller.abort();
      throw new Error(error?.name === "AbortError" ? "读取图片超过 60 秒；可按原 requestId 重试" : (error?.message || String(error)));
    } finally {
      clearTimeout(abortTimer);
    }
  }

  async function handleMessage(port, message) {
    if (!message || typeof message !== "object" || typeof message.messageId !== "string") {
      fail("图片传输消息格式无效");
    }
    if (!validPopupSender(port.sender)) fail("图片读取只允许当前扩展弹窗发起");
    if (message.action === "fetch_selected_image") {
      const metadata = await fetchSelectedImage(message, port);
      return { ...metadata };
    }
    const transfer = transfers.get(String(message.transferId || ""));
    if (!transfer) fail("图片读取状态已失效；按原 requestId 重试会从桌面确认的位置继续");
    assertIdentityMatch(transfer, message, port);
    if (message.action === "read_image_chunk") {
      if (!(transfer.bytes instanceof Uint8Array)) fail("图片读取尚未完成");
      const offset = Number(message.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= transfer.bytes.byteLength) fail("图片分块偏移无效");
      const end = Math.min(transfer.bytes.byteLength, offset + MAX_CHUNK_BYTES);
      const bytes = transfer.bytes.subarray(offset, end);
      return { offset, byteLength: bytes.byteLength, dataBase64: encodeBase64(bytes) };
    }
    if (message.action === "finish_image_transfer" || message.action === "cancel_image_transfer") {
      transfer.controller?.abort();
      transfers.delete(String(message.transferId));
      return { released: true };
    }
    fail("未知图片传输操作");
  }

  function handlePort(port) {
    let busy = false;
    const clearOwnedTransfers = () => {
      for (const [id, transfer] of transfers) {
        if (transfer.owner === port) {
          transfer.controller?.abort();
          transfers.delete(id);
        }
      }
    };
    port.onMessage.addListener((message) => {
      if (busy) {
        try { port.postMessage({ messageId: message?.messageId || "", ok: false, error: "请按顺序读取图片分块" }); } catch { /* disconnected */ }
        return;
      }
      busy = true;
      void handleMessage(port, message).then((result) => {
        port.postMessage({ messageId: message.messageId, ok: true, ...result });
      }).catch((error) => {
        try { port.postMessage({ messageId: message?.messageId || "", ok: false, error: error?.message || String(error) }); } catch { /* disconnected */ }
      }).finally(() => { busy = false; });
    });
    port.onDisconnect.addListener(clearOwnedTransfers);
  }

  globalThis.AichiCaptureImageFetchWorker = Object.freeze({
    handlePort,
    limits: Object.freeze({ maxImageBytes: MAX_IMAGE_BYTES, maxChunkBytes: MAX_CHUNK_BYTES }),
  });
})();
