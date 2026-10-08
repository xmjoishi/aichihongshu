// Native Messaging helpers with bounded callback/port lifetimes.
(() => {
  function sendRequest(hostName, message, timeoutMs = 5_000) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({
        response: null,
        runtimeError: `Native Messaging 请求超时（${Math.ceil(timeoutMs / 1000)} 秒）`,
        timedOut: true,
      }), timeoutMs);
      try {
        chrome.runtime.sendNativeMessage(hostName, message, (response) => {
          finish({
            response: response ?? null,
            runtimeError: chrome.runtime.lastError?.message || "",
            timedOut: false,
          });
        });
      } catch (error) {
        finish({
          response: null,
          runtimeError: error?.message || String(error),
          timedOut: false,
        });
      }
    });
  }

  function openPort(hostName, timeoutMs = 5_000) {
    const port = chrome.runtime.connectNative(hostName);
    const pending = [];
    let closedError = "";

    function rejectPending(error) {
      while (pending.length) {
        const request = pending.shift();
        clearTimeout(request.timer);
        request.reject(error);
      }
    }

    function failPort(error) {
      if (closedError) return;
      closedError = error?.message || String(error);
      rejectPending(new Error(closedError));
      try { port.disconnect(); } catch { /* the browser may have closed it already */ }
    }

    port.onMessage.addListener((response) => {
      if (closedError) return;
      const current = pending.shift();
      if (!current) return;
      clearTimeout(current.timer);
      current.resolve(response || null);
    });
    port.onDisconnect.addListener(() => {
      if (closedError) return;
      const error = chrome.runtime.lastError?.message || "Native Messaging 连接已断开";
      closedError = error;
      rejectPending(new Error(error));
    });

    return {
      request(message, requestTimeoutMs = timeoutMs) {
        if (closedError) return Promise.reject(new Error(closedError));
        return new Promise((resolve, reject) => {
          const request = {
            resolve,
            reject,
            timer: setTimeout(() => failPort(
              new Error(`Native Messaging Port 请求超时（${Math.ceil(requestTimeoutMs / 1000)} 秒）`),
            ), requestTimeoutMs),
          };
          pending.push(request);
          try {
            port.postMessage(message);
          } catch (error) {
            failPort(error);
          }
        });
      },
      close() { failPort(new Error("Native Messaging 连接已关闭")); },
    };
  }

  globalThis.AichiNativeBridge = { sendRequest, openPort };
})();
