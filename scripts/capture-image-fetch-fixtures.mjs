import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = fs.readFileSync("browser-extension/capture-image-fetch.js", "utf8");
const imageUrl = "https://sns-img-bd.xhscdn.com/fixture.jpg";
const sourceUrl = "https://www.xiaohongshu.com/explore/fixture-note";
const imageBytes = new Uint8Array(70 * 1024 + 7);
imageBytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
for (let index = 8; index < imageBytes.length; index += 1) imageBytes[index] = index % 251;

let responseUrl = imageUrl;
let responseLength = imageBytes.byteLength;
const fetchCalls = [];
const permissionCalls = [];
const context = vm.createContext({
  URL,
  URLSearchParams,
  AbortController,
  Uint8Array,
  ArrayBuffer,
  Map,
  Set,
  String,
  Number,
  RegExp,
  Math,
  Promise,
  Error,
  crypto: webcrypto,
  btoa: globalThis.btoa,
  setTimeout,
  clearTimeout,
  chrome: {
    runtime: { id: "fixture-extension" },
    tabs: { async get(id) { return { id, url: sourceUrl }; } },
    permissions: {
      async contains(value) { permissionCalls.push(value); return true; },
    },
  },
  async fetch(url, options) {
    fetchCalls.push({ url, options });
    const chunks = [imageBytes.slice(0, 31_111), imageBytes.slice(31_111)];
    let index = 0;
    return {
      ok: true,
      status: 200,
      url: responseUrl,
      headers: { get(name) {
        return name.toLowerCase() === "content-type" ? "image/jpeg; charset=binary"
          : name.toLowerCase() === "content-length" ? String(responseLength) : null;
      } },
      body: { getReader() { return { async read() {
        if (index >= chunks.length) return { done: true };
        return { done: false, value: chunks[index++] };
      }, async cancel() {} }; } },
    };
  },
});
vm.runInContext(source, context, { filename: "capture-image-fetch.js" });
const worker = context.AichiCaptureImageFetchWorker;

function createPort(url = "chrome-extension://fixture-extension/popup.html") {
  const messageListeners = [];
  const disconnectListeners = [];
  const waiters = new Map();
  const port = {
    sender: { id: "fixture-extension", url },
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    postMessage(reply) {
      const waiter = waiters.get(reply.messageId);
      if (waiter) { waiters.delete(reply.messageId); waiter(reply); }
    },
    send(message) {
      const reply = new Promise((resolve) => {
        waiters.set(message.messageId, resolve);
        for (const listener of messageListeners) listener(message);
      });
      return reply.then(async (value) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return value;
      });
    },
    disconnect() { for (const listener of disconnectListeners) listener(); },
  };
  worker.handlePort(port);
  return port;
}

const identity = {
  captureRequestId: "fixture-request-1",
  targetAccountId: 12,
  expectedChannel: "prod",
  expectedWorkspaceId: "fixture-workspace",
  sourceTabId: 42,
  sourceUrl,
  position: 0,
};
let sequence = 0;
const request = (port, action, fields = {}) => port.send({
  messageId: `message-${++sequence}`,
  action,
  ...identity,
  ...fields,
});
const value = async (promise) => {
  const result = await promise;
  assert.equal(result.ok, true, result.error || "worker request failed");
  return result;
};

const port = createPort();
const metadata = await value(request(port, "fetch_selected_image", { imageUrl }));
assert.equal(metadata.totalBytes, imageBytes.byteLength);
assert.equal(metadata.mimeType, "image/jpeg");
assert.match(metadata.sha256, /^[0-9a-f]{64}$/);
assert.equal(permissionCalls.at(-1).origins[0], "https://sns-img-bd.xhscdn.com/*");
assert.equal(fetchCalls.at(-1).options.credentials, "omit");
assert.equal(fetchCalls.at(-1).options.referrerPolicy, "no-referrer");
assert.equal(fetchCalls.at(-1).options.cache, "no-store");

const first = await value(request(port, "read_image_chunk", {
  transferId: metadata.transferId,
  offset: 0,
}));
assert.equal(first.byteLength, 64 * 1024);
assert.equal(first.dataBase64.length, Math.ceil(first.byteLength / 3) * 4);
assert.deepEqual(Buffer.from(first.dataBase64, "base64"), Buffer.from(imageBytes.slice(0, 64 * 1024)));
const second = await value(request(port, "read_image_chunk", {
  transferId: metadata.transferId,
  offset: first.byteLength,
}));
assert.equal(second.byteLength, imageBytes.byteLength - first.byteLength);
assert.deepEqual(Buffer.from(second.dataBase64, "base64"), Buffer.from(imageBytes.slice(first.byteLength)));
const mismatch = await request(port, "read_image_chunk", {
  transferId: metadata.transferId,
  offset: 0,
  position: 1,
});
assert.equal(mismatch.ok, false, "a transfer cannot be read under another image position");
await value(request(port, "finish_image_transfer", { transferId: metadata.transferId }));

const forbiddenPopup = createPort("chrome-extension://fixture-extension/preview.html");
const forbidden = await request(forbiddenPopup, "fetch_selected_image", { imageUrl });
assert.equal(forbidden.ok, false, "only the popup may start image reads");
assert.equal(fetchCalls.length, 1);

const privateHost = await request(port, "fetch_selected_image", { imageUrl: "https://127.0.0.1/private.jpg" });
assert.equal(privateHost.ok, false, "private hosts are rejected before fetch");
assert.equal(fetchCalls.length, 1);

responseUrl = "https://another-image-host.example/image.jpg";
const redirect = await request(port, "fetch_selected_image", { imageUrl });
assert.equal(redirect.ok, false, "cross-origin redirects are rejected");
assert.equal(fetchCalls.length, 2);
responseUrl = imageUrl;

responseLength = 25 * 1024 * 1024 + 1;
const oversized = await request(port, "fetch_selected_image", { imageUrl });
assert.equal(oversized.ok, false, "declared payloads above the per-image cap are rejected");
assert.match(oversized.error, /25MB/);
assert.equal(fetchCalls.length, 3);

responseLength = imageBytes.byteLength;
const resumable = await value(request(port, "fetch_selected_image", { imageUrl }));
port.disconnect();
await new Promise((resolve) => setTimeout(resolve, 0));
const disconnected = await request(port, "read_image_chunk", {
  transferId: resumable.transferId,
  offset: 0,
});
assert.equal(disconnected.ok, false, "popup disconnect clears worker-held image bytes");

console.log(JSON.stringify({ ok: true, cases: [
  "selected-image-only-uncredentialed-fetch",
  "sha256-and-64k-ordered-chunks",
  "popup-and-capture-identity-binding",
  "private-host-and-cross-origin-redirect-rejection",
  "image-size-cap-and-disconnect-cleanup",
] }));
