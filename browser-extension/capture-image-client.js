// Popup-side bounded request/response client for the capture image service worker.
(() => {
  function open(identity, defaultTimeoutMs = 65_000) {
    const port = chrome.runtime.connect({ name: "aichi.capture-image-transfer" });
    const pending = new Map();
    let closedError = "";

    function rejectPending(error) {
      for (const [id, request] of pending) {
        clearTimeout(request.timer);
        request.reject(error);
        pending.delete(id);
      }
    }

    function closeWithError(error) {
      if (closedError) return;
      closedError = error?.message || String(error);
      rejectPending(new Error(closedError));
      try { port.disconnect(); } catch { /* the popup may already be closing */ }
    }

    port.onMessage.addListener((response) => {
      const request = pending.get(response?.messageId);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(response.messageId);
      if (response?.ok === true) request.resolve(response);
      else request.reject(new Error(response?.error || "图片 service worker 未接受请求"));
    });
    port.onDisconnect.addListener(() => {
      if (closedError) return;
      const error = chrome.runtime.lastError?.message || "图片读取连接已断开；桌面已确认的分块位置会保留";
      closedError = error;
      rejectPending(new Error(error));
    });

    return {
      request(action, fields = {}, timeoutMs = defaultTimeoutMs) {
        if (closedError) return Promise.reject(new Error(closedError));
        const messageId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => closeWithError(
            new Error(`图片 service worker 请求超时（${Math.ceil(timeoutMs / 1000)} 秒）；可按原 requestId 核实后重试`),
          ), timeoutMs);
          pending.set(messageId, { resolve, reject, timer });
          try {
            port.postMessage({
              messageId,
              action,
              captureRequestId: identity.captureRequestId,
              targetAccountId: identity.targetAccountId,
              expectedChannel: identity.expectedChannel,
              expectedWorkspaceId: identity.expectedWorkspaceId,
              sourceTabId: identity.sourceTabId,
              sourceUrl: identity.sourceUrl,
              position: identity.position,
              ...fields,
            });
          } catch (error) {
            closeWithError(error);
          }
        });
      },
      close() { closeWithError(new Error("图片读取连接已关闭")); },
    };
  }

  globalThis.AichiCaptureImageFetchClient = Object.freeze({ open });
})();
