import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = fs.readFileSync(path.join(process.cwd(), "browser-extension/native-bridge.js"), "utf8");
function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(value) { for (const listener of listeners) listener(value); },
  };
}

let messageCallback;
let mockPort;
const context = {
  chrome: {
    runtime: {
      lastError: null,
      sendNativeMessage(_host, _message, callback) { messageCallback = callback; },
      connectNative() {
        mockPort = {
          onMessage: event(),
          onDisconnect: event(),
          disconnected: false,
          posted: [],
          postMessage(message) { this.posted.push(message); },
          disconnect() { this.disconnected = true; },
        };
        return mockPort;
      },
    },
  },
  setTimeout,
  clearTimeout,
  Promise,
  Error,
  Math,
};
vm.runInNewContext(source, context, { filename: "native-bridge.js" });
const bridge = context.AichiNativeBridge;

const responsePromise = bridge.sendRequest("com.example.host", { action: "ping" }, 100);
messageCallback({ ok: true, status: "ready" });
const response = await responsePromise;
assert.equal(response.response.status, "ready");
assert.equal(response.timedOut, false);

const timeoutPromise = bridge.sendRequest("com.example.host", { action: "ping" }, 10);
const timeout = await timeoutPromise;
assert.equal(timeout.timedOut, true);
assert.match(timeout.runtimeError, /超时/);
messageCallback({ ok: true, status: "late" });
assert.equal(timeout.response, null, "a late callback cannot change the settled result");

const port = bridge.openPort("com.example.host", 10);
const pendingOne = port.request({ requestId: "one" }).then(
  () => ({ status: "resolved" }),
  (error) => ({ status: "rejected", message: error.message }),
);
const pendingTwo = port.request({ requestId: "two" }).then(
  () => ({ status: "resolved" }),
  (error) => ({ status: "rejected", message: error.message }),
);
const pending = await Promise.all([pendingOne, pendingTwo]);
assert.equal(mockPort.disconnected, true, "a timed-out port is closed");
assert.deepEqual(pending.map((item) => item.status), ["rejected", "rejected"]);
assert.ok(pending.every((item) => /超时/.test(item.message)));
mockPort.onMessage.emit({ requestId: "late-one", ok: true });
await assert.rejects(port.request({ requestId: "three" }), /超时/);

console.log(JSON.stringify({
  ok: true,
  scenarios: ["request resolves", "request deadline ignores late callback", "port timeout closes connection and rejects queued requests"],
}));
