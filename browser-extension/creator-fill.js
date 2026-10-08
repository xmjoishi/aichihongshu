// Injected only after an explicit popup action on the XHS creator publish page.
// It never clicks platform buttons or submits a post.
(() => {
  if (globalThis.__AICHIHONGSHU_CREATOR_FILL_INSTALLED__) return;
  globalThis.__AICHIHONGSHU_CREATOR_FILL_INSTALLED__ = true;

  const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
  const MAX_IMAGE_CHUNK_BYTES = 32 * 1024;
  const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
  const MAX_VIDEO_CHUNK_BYTES = 96 * 1024;
  const imageFiles = new Map();
  const imageTransfers = new Map();
  const imageCatalog = new Map();
  let videoFile = null;
  let videoTransfer = null;
  let videoMetadata = null;
  let capabilityKey = "";

  const isCreatorPublishPage = () => {
    const current = new URL(window.location.href);
    return current.protocol === "https:"
      && current.hostname === "creator.xiaohongshu.com"
      && (current.pathname === "/publish" || current.pathname.startsWith("/publish/"));
  };

  const firstMatch = (selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && !element.disabled && !element.readOnly) return element;
    }
    return null;
  };

  const titleField = () => firstMatch([
    'input[placeholder*="标题"]',
    'textarea[placeholder*="标题"]',
    'input[aria-label*="标题"]',
    'textarea[aria-label*="标题"]',
  ]);

  const bodyField = () => firstMatch([
    '[contenteditable="true"][data-placeholder*="正文"]',
    '[contenteditable="true"][data-placeholder*="描述"]',
    '[contenteditable="true"][aria-label*="正文"]',
    '[contenteditable="true"][aria-label*="描述"]',
    'textarea[placeholder*="正文"]',
    'textarea[placeholder*="描述"]',
    '.ql-editor[contenteditable="true"]',
  ]);

  const readValue = (element) => {
    if (!element) return "";
    return "value" in element ? String(element.value || "") : String(element.innerText || element.textContent || "");
  };

  const inspect = () => {
    if (!isCreatorPublishPage()) return { ok: false, error: "当前页面不是小红书创作发布页" };
    const title = titleField();
    const body = bodyField();
    return {
      ok: true,
      fields: {
        title: { found: Boolean(title), value: readValue(title) },
        body: { found: Boolean(body), value: readValue(body) },
      },
    };
  };

  const writeValue = (element, value) => {
    if (!element) return { status: "failed", error: "没有找到有明确标题/正文标识的编辑框" };
    try {
      element.focus();
      if ("value" in element) {
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(element, value);
        else element.value = value;
      } else {
        element.replaceChildren(document.createTextNode(value));
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      const actual = readValue(element);
      if (actual !== value) return { status: "failed", error: "页面没有接受完整文字，请检查后手动补齐" };
      return { status: "filled", error: null };
    } catch (_error) {
      return { status: "failed", error: "编辑框拒绝填入，请检查页面并手动补齐" };
    }
  };

  const imageTypeMatches = (mimeType, bytes) => {
    if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (mimeType === "image/png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
    if (mimeType === "image/gif") return bytes.length >= 6 && (new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a" || new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a");
    if (mimeType === "image/webp") return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
    if (mimeType === "image/avif") return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp" && ["avif", "avis", "mif1", "msf1", "heic", "heix"].includes(new TextDecoder().decode(bytes.slice(8, 12)));
    return false;
  };

  const decodeBase64 = (value) => {
    const raw = atob(value);
    const output = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
    return output;
  };

  const beginImages = (message) => {
    if (message.confirmReplace !== true || !message.attemptId || !message.claimToken) {
      return { ok: false, error: "开始图片传输需要当前任务的明确确认" };
    }
    const images = Array.isArray(message.images) ? message.images : [];
    if (images.length > 9) return { ok: false, error: "图片数量超过单条任务上限" };
    const nextCapabilityKey = `${message.attemptId}:${message.accountPoolId}:${message.claimToken}`;
    if (capabilityKey && capabilityKey !== nextCapabilityKey) {
      imageFiles.clear();
      imageTransfers.clear();
      imageCatalog.clear();
      videoFile = null;
      videoTransfer = null;
      videoMetadata = null;
    }
    capabilityKey = nextCapabilityKey;
    const replaceItemIds = new Set(Array.isArray(message.itemIds) ? message.itemIds : []);
    for (const meta of images) {
      if (!Number.isSafeInteger(meta.itemId) || !Number.isSafeInteger(meta.totalBytes)
        || meta.totalBytes < 1 || meta.totalBytes > MAX_IMAGE_BYTES
        || !/^image\/(jpeg|png|gif|webp|avif)$/.test(meta.mimeType || "")
        || !/^[0-9a-f]{64}$/.test(meta.sha256 || "")
        || typeof meta.filename !== "string" || /[/\\]/.test(meta.filename)) {
        imageTransfers.delete(meta.itemId);
        return { ok: false, error: "图片校验元数据无效", itemId: meta.itemId };
      }
      imageCatalog.set(meta.itemId, meta);
      if (!replaceItemIds.has(meta.itemId)) continue;
      imageFiles.delete(meta.itemId);
      imageTransfers.set(meta.itemId, { meta, chunks: [], received: 0 });
    }
    return { ok: true, capabilityKey };
  };

  const videoExtensionForMime = (mimeType) => ({
    "video/mp4": ["mp4", "m4v"],
    "video/x-m4v": ["m4v"],
    "video/quicktime": ["mov"],
    "video/webm": ["webm"],
  })[mimeType] || [];

  const beginVideo = (message) => {
    if (message.confirmReplace !== true || !message.attemptId || !message.claimToken) {
      return { ok: false, error: "开始视频传输需要当前任务的明确确认" };
    }
    const meta = message.video;
    const extension = typeof meta?.filename === "string" ? meta.filename.split(".").pop().toLowerCase() : "";
    if (!meta || !Number.isSafeInteger(meta.totalBytes) || meta.totalBytes < 1 || meta.totalBytes > MAX_VIDEO_BYTES
      || !videoExtensionForMime(meta.mimeType).includes(extension)
      || !/^[0-9a-f]{64}$/.test(meta.sha256 || "")
      || typeof meta.filename !== "string" || /[/\\]/.test(meta.filename)) {
      return { ok: false, error: "视频校验元数据无效" };
    }
    const nextCapabilityKey = `${message.attemptId}:${message.accountPoolId}:${message.claimToken}`;
    if (capabilityKey && capabilityKey !== nextCapabilityKey) {
      imageFiles.clear();
      imageTransfers.clear();
      imageCatalog.clear();
      videoFile = null;
    }
    capabilityKey = nextCapabilityKey;
    videoMetadata = meta;
    videoFile = null;
    videoTransfer = { meta, bytes: new Uint8Array(meta.totalBytes), received: 0 };
    return { ok: true, capabilityKey };
  };

  const videoTypeMatches = (mimeType, bytes) => {
    if (mimeType === "video/webm") return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp";
  };

  const acceptVideoChunk = (message) => {
    if (message.confirmReplace !== true || message.capabilityKey !== capabilityKey) {
      return { ok: false, error: "视频传输授权与当前任务不匹配" };
    }
    if (!videoTransfer) return { ok: false, error: "视频传输未初始化" };
    const transfer = videoTransfer;
    try {
      const data = decodeBase64(message.dataBase64 || "");
      if (data.length === 0 || data.length > MAX_VIDEO_CHUNK_BYTES
        || message.offset !== transfer.received
        || transfer.received + data.length > transfer.meta.totalBytes) {
        throw new Error("视频分块大小、顺序或偏移无效");
      }
      transfer.bytes.set(data, transfer.received);
      transfer.received += data.length;
      if (message.done === true) {
        if (transfer.received !== transfer.meta.totalBytes) throw new Error("视频分块总大小不完整");
        const bytes = transfer.bytes;
        if (!videoTypeMatches(transfer.meta.mimeType, bytes)) throw new Error("视频魔数与 MIME 类型不匹配");
        return crypto.subtle.digest("SHA-256", bytes).then((digest) => {
          const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
          if (hash !== transfer.meta.sha256) throw new Error("视频 SHA-256 校验失败");
          videoFile = new File([bytes], transfer.meta.filename, { type: transfer.meta.mimeType });
          videoTransfer = null;
          return { ok: true, complete: true, bytes: transfer.received };
        }).catch((error) => {
          videoTransfer = null;
          return { ok: false, error: error?.message || "视频校验失败" };
        });
      }
      return { ok: true, complete: false, received: transfer.received };
    } catch (error) {
      videoTransfer = null;
      return { ok: false, error: error?.message || "视频分块无效" };
    }
  };

  const acceptImageChunk = (message) => {
    if (message.confirmReplace !== true || message.capabilityKey !== capabilityKey) {
      return { ok: false, error: "图片传输授权与当前任务不匹配", itemId: message.itemId };
    }
    const transfer = imageTransfers.get(message.itemId);
    if (!transfer) return { ok: false, error: "图片传输未初始化", itemId: message.itemId };
    try {
      const data = decodeBase64(message.dataBase64 || "");
      if (data.length === 0 || data.length > MAX_IMAGE_CHUNK_BYTES
        || message.offset !== transfer.received
        || transfer.received + data.length > transfer.meta.totalBytes) {
        throw new Error("图片分块大小、顺序或偏移无效");
      }
      transfer.chunks.push(data);
      transfer.received += data.length;
      if (message.done === true) {
        if (transfer.received !== transfer.meta.totalBytes) throw new Error("图片分块总大小不完整");
        const bytes = new Uint8Array(transfer.received);
        let offset = 0;
        for (const chunk of transfer.chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        if (!imageTypeMatches(transfer.meta.mimeType, bytes)) throw new Error("图片魔数与 MIME 类型不匹配");
        return crypto.subtle.digest("SHA-256", bytes).then((digest) => {
          const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
          if (hash !== transfer.meta.sha256) throw new Error("图片 SHA-256 校验失败");
          const file = new File([bytes], transfer.meta.filename, { type: transfer.meta.mimeType });
          imageFiles.set(message.itemId, { meta: transfer.meta, file });
          imageTransfers.delete(message.itemId);
          return { ok: true, itemId: message.itemId, complete: true, bytes: transfer.received };
        }).catch((error) => {
          imageTransfers.delete(message.itemId);
          return { ok: false, error: error?.message || "图片校验失败", itemId: message.itemId };
        });
      }
      return { ok: true, itemId: message.itemId, complete: false, received: transfer.received };
    } catch (error) {
      imageTransfers.delete(message.itemId);
      return { ok: false, error: error?.message || "图片分块无效", itemId: message.itemId };
    }
  };

  const imageInput = () => {
    const candidates = Array.from(document.querySelectorAll('input[type="file"]'))
      .filter((input) => !input.disabled && input.multiple === true && /image|\.jpe?g|\.png|\.gif|\.webp|\.avif/i.test(input.accept || ""));
    return candidates.length === 1 ? candidates[0] : null;
  };

  const assignImageFiles = (message) => {
    const itemIds = Array.isArray(message.imageItemIds) ? message.imageItemIds : [];
    const orderedIds = Array.isArray(message.allImageIds) ? message.allImageIds : itemIds;
    if (!itemIds.length) return { results: [], error: null };
    const input = imageInput();
    if (!input) {
      return { results: itemIds.map((itemId) => ({ itemId, status: "failed", error: "未找到唯一且支持多选的图片文件框" })), error: "未找到唯一且支持多选的图片文件框" };
    }
    try {
      const currentByName = new Map(Array.from(input.files || []).map((file) => [file.name, file]));
      const fileFor = (itemId) => imageFiles.get(itemId)?.file
        || currentByName.get(imageCatalog.get(itemId)?.filename);
      const missingPreserved = (Array.isArray(message.preserveImageItemIds) ? message.preserveImageItemIds : [])
        .filter((itemId) => !fileFor(itemId));
      if (missingPreserved.length) {
        return {
          results: itemIds.map((itemId) => ({ itemId, status: "failed", error: "之前成功的图片已不在当前页面缓存中；为避免覆盖图片顺序，本次没有更改文件列表" })),
          error: "之前成功的图片缓存已丢失，未更改创作页图片",
        };
      }
      const readyIds = orderedIds.filter((itemId) => fileFor(itemId));
      if (!readyIds.length) {
        return {
          results: itemIds.map((itemId) => ({ itemId, status: "failed", error: "图片没有完整传输或校验失败" })),
          error: "图片未就绪，未更改创作页图片",
        };
      }
      const transfer = new DataTransfer();
      const files = readyIds.map(fileFor);
      for (const file of files) transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const assigned = Array.from(input.files || []);
      const acceptedNames = new Set(assigned.map((file) => file.name));
      return {
        results: itemIds.map((itemId) => {
          const file = fileFor(itemId);
          const accepted = Boolean(file && acceptedNames.has(file.name));
          const error = accepted ? null : file ? "创作页没有接受该图片" : "图片没有完整传输或校验失败";
          return { itemId, status: accepted ? "filled" : "failed", error };
        }),
        error: null,
      };
    } catch (_error) {
      return { results: itemIds.map((itemId) => ({ itemId, status: "failed", error: "浏览器拒绝设置图片文件列表" })), error: "浏览器拒绝设置图片文件列表" };
    }
  };

  const videoInput = () => {
    const candidates = Array.from(document.querySelectorAll('input[type="file"]'))
      .filter((input) => !input.disabled
        && /video|\.mp4|\.mov|\.m4v|\.webm/i.test(input.accept || ""));
    return candidates.length === 1 ? candidates[0] : null;
  };

  const assignVideoFile = (includeVideo) => {
    if (!includeVideo) return { status: "skipped", error: null };
    const input = videoInput();
    if (!input) return { status: "failed", error: "未找到唯一的视频文件框" };
    if (!videoFile) {
      const existing = Array.from(input.files || []).find((file) => file.name === videoMetadata?.filename
        && file.size === videoMetadata?.totalBytes);
      if (existing) return { status: "filled", error: null };
      return { status: "failed", error: "视频没有完整传输或校验失败" };
    }
    try {
      const transfer = new DataTransfer();
      transfer.items.add(videoFile);
      input.files = transfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const accepted = Array.from(input.files || []).some((file) => file.name === videoFile.name
        && file.size === videoFile.size && file.type === videoFile.type);
      return accepted
        ? { status: "filled", error: null }
        : { status: "failed", error: "创作页没有接受该视频" };
    } catch (_error) {
      return { status: "failed", error: "浏览器拒绝设置视频文件列表" };
    }
  };

  const fill = (message) => {
    if (!isCreatorPublishPage()) return { ok: false, error: "页面已离开小红书创作发布页，未作修改" };
    if (message.confirmReplace !== true || message.capabilityKey !== capabilityKey) {
      return { ok: false, error: "尚未确认在当前页面填写内容", title: { status: "skipped" }, body: { status: "skipped" } };
    }
    const onlyFields = Array.isArray(message.onlyFields) ? new Set(message.onlyFields) : null;
    const titleResult = !onlyFields || onlyFields.has("title")
      ? writeValue(titleField(), String(message.title || ""))
      : { status: "skipped", error: null };
    const bodyResult = !onlyFields || onlyFields.has("body")
      ? writeValue(bodyField(), String(message.body || ""))
      : { status: "skipped", error: null };
    const imageOutcome = assignImageFiles(message);
    const video = assignVideoFile(message.includeVideo === true);
    return { ok: true, title: titleResult, body: bodyResult, images: imageOutcome.results, imageError: imageOutcome.error, video };
  };

  const handleMessage = (message) => {
    if (!message || ![
      "aichihongshu:creator-inspect",
      "aichihongshu:creator-images-begin",
      "aichihongshu:creator-image-chunk",
      "aichihongshu:creator-video-begin",
      "aichihongshu:creator-video-chunk",
      "aichihongshu:creator-images-clear",
      "aichihongshu:creator-fill",
    ].includes(message.action)) return null;
    if (!isCreatorPublishPage()) return { ok: false, error: "当前页面不是小红书创作发布页" };
    if (message.action === "aichihongshu:creator-inspect") return inspect();
    if (message.action === "aichihongshu:creator-images-begin") return beginImages(message);
    if (message.action === "aichihongshu:creator-image-chunk") return acceptImageChunk(message);
    if (message.action === "aichihongshu:creator-video-begin") return beginVideo(message);
    if (message.action === "aichihongshu:creator-video-chunk") return acceptVideoChunk(message);
    if (message.action === "aichihongshu:creator-images-clear") {
      if (message.capabilityKey === capabilityKey) {
        imageTransfers.clear();
        imageFiles.clear();
        capabilityKey = "";
        imageCatalog.clear();
        videoFile = null;
        videoTransfer = null;
        videoMetadata = null;
      }
      return { ok: true };
    }
    return fill(message);
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const result = handleMessage(message);
    if (result === null) return false;
    if (result && typeof result.then === "function") {
      result.then(sendResponse, (error) => sendResponse({ ok: false, error: error?.message || "媒体校验失败" }));
      return true;
    }
    sendResponse(result);
    return false;
  });
})();
