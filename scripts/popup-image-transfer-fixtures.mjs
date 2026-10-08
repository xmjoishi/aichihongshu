import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

function makeHarness(plan = {}) {
  const elements = new Map();
  const listeners = () => ({ addListener() {}, removeListener() {} });
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id,
      value: id === "target-account" ? "12" : "",
      checked: false,
      disabled: false,
      hidden: false,
      style: {},
      dataset: {},
      options: [],
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {},
      addEventListener() {},
      replaceChildren() {},
      append() {},
      focus() {},
      textContent: "",
    });
    return elements.get(id);
  }

  const actions = [];
  const clientRequests = [];
  const nativeRequests = [];
  const nativeTimeouts = [];
  let nativeClosed = 0;
  let imageClosed = 0;
  const imageClient = {
    open() {
      return {
        async request(action, fields = {}) {
          clientRequests.push({ action, ...fields });
          if (action === "fetch_selected_image") {
            if (plan.fetchFailPosition === fields.position) throw new Error("fixture image fetch denied");
            const totalBytes = 64 * 1024 + 3;
            return {
              transferId: `transfer-${fields.position}`,
              totalBytes,
              sha256: "a".repeat(64),
              mimeType: "image/jpeg",
            };
          }
          if (action === "read_image_chunk") {
            const totalBytes = 64 * 1024 + 3;
            const byteLength = Math.min(64 * 1024, totalBytes - fields.offset);
            return {
              offset: fields.offset,
              byteLength,
              dataBase64: Buffer.alloc(byteLength).toString("base64"),
            };
          }
          return { released: true };
        },
        close() { imageClosed += 1; },
      };
    },
  };
  const context = vm.createContext({
    URL,
    Intl,
    Date,
    Math,
    Number,
    String,
    JSON,
    Array,
    Object,
    Set,
    Map,
    Promise,
    Error,
    RegExp,
    Uint8Array,
    crypto: webcrypto,
    document: {
      getElementById: element,
      querySelector: element,
      createElement: (tag) => ({ tagName: tag, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, append() {} }),
      body: { classList: { toggle() {} } },
      activeElement: null,
    },
    chrome: {
      runtime: {
        getManifest: () => ({ name: "fixture", version: "0.9.0" }),
        getURL: (value) => `chrome-extension://fixture/${value}`,
        lastError: null,
      },
      storage: { session: { async set() {}, async get() { return {}; }, async remove() {} } },
      tabs: { async get(id) { return { id, url: "https://www.xiaohongshu.com/explore/fixture" }; } },
      scripting: { async executeScript() { return [{ result: null }]; } },
    },
    setTimeout,
    clearTimeout,
  });
  context.AichiCaptureImageFetchClient = imageClient;
  const source = fs.readFileSync("browser-extension/popup.js", "utf8").replace(/void loadPreview\(\);\s*$/, "");
  vm.runInContext(source, context, { filename: "popup.js" });
  context.openNativePort = () => ({
    async request(message, timeoutMs) {
      nativeRequests.push(message);
      nativeTimeouts.push({ action: message.action, timeoutMs });
      actions.push(message.action);
      if (plan.protocolMismatchAction === message.action) {
        return { ok: true, channel: "prod", workspaceId: "fixture-workspace", protocolVersion: 11 };
      }
      if (message.action === "begin_capture_image_upload") {
        const totalBytes = 64 * 1024 + 3;
        if (plan.readyPositions?.includes(message.position)) {
          return { ok: true, upload: { nextOffset: totalBytes, totalBytes, alreadyReady: true }, channel: "prod", workspaceId: "fixture-workspace", protocolVersion: 12 };
        }
        const nextOffset = Number(plan.resumeOffsets?.[message.position] || 0);
        return { ok: true, upload: { nextOffset, totalBytes, alreadyReady: false }, channel: "prod", workspaceId: "fixture-workspace", protocolVersion: 12 };
      }
      if (message.action === "write_capture_image_chunk") {
        if (plan.nativeWriteTimeoutPosition === message.position) throw new Error("Native Messaging Port 请求超时");
        const encoded = String(message.dataBase64 || "");
        const byteLength = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
        return { ok: true, upload: { nextOffset: message.offset + byteLength }, channel: "prod", workspaceId: "fixture-workspace", protocolVersion: 12 };
      }
      if (message.action === "finish_capture_image_upload") {
        return { ok: true, status: "ready", channel: "prod", workspaceId: "fixture-workspace", protocolVersion: 12 };
      }
      return { ok: true, status: "failed", channel: "prod", workspaceId: "fixture-workspace", protocolVersion: 12 };
    },
    close() { nativeClosed += 1; },
  });
  context.assertCaptureSource = async () => ({ id: 42, url: "https://www.xiaohongshu.com/explore/fixture" });
  context.responseMatchesExpectedIdentity = () => true;
  context.setStatus = () => {};
  vm.runInContext(`
    desktopConnected = true;
    connectedWorkspaceId = "fixture-workspace";
    expectedChannel = "prod";
    sourceTabId = 42;
    sourceTabUrl = "https://www.xiaohongshu.com/explore/fixture";
    targetAccountEl.value = "12";
  `, context);
  return { context, actions, clientRequests, nativeRequests, nativeTimeouts, get nativeClosed() { return nativeClosed; }, get imageClosed() { return imageClosed; } };
}

const message = {
  imageTransferProtocol: true,
  requestId: "same-request-id",
  targetAccountId: 12,
  images: [{ url: "https://cdn.example/first.jpg" }, { url: "https://cdn.example/second.jpg" }],
};

const resumeHarness = makeHarness({ resumeOffsets: { 0: 64 * 1024 }, readyPositions: [1] });
await vm.runInContext(`transferSelectedCaptureImages(${JSON.stringify(message)}, "bc:12:same-request-id")`, resumeHarness.context);
const resumedWrites = resumeHarness.nativeRequests.filter((request) => request.action === "write_capture_image_chunk");
assert.equal(resumedWrites.length, 1, "resume sends only bytes at the confirmed offset");
assert.equal(resumedWrites[0].position, 0);
assert.equal(resumedWrites[0].offset, 64 * 1024);
assert.deepEqual(resumeHarness.nativeRequests.filter((request) => request.action === "begin_capture_image_upload").map((request) => request.position), [0, 1]);
assert.equal(resumeHarness.nativeRequests.some((request) => request.action === "finish_capture_image_upload" && request.position === 0), true);
assert.equal(resumeHarness.actions.includes("fail_capture_image_upload"), false);
assert.deepEqual(resumeHarness.nativeTimeouts.map(({ action, timeoutMs }) => [action, timeoutMs]), [
  ["begin_capture_image_upload", 15_000],
  ["write_capture_image_chunk", 15_000],
  ["finish_capture_image_upload", 35_000],
  ["begin_capture_image_upload", 15_000],
]);
for (const request of resumedWrites) {
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 256 * 1024, "64 KiB raw chunks stay within the Native Messaging frame limit");
  assert.ok(request.dataBase64.length <= 88 * 1024, "base64 chunk stays within the Rust field limit");
}
assert.equal(resumeHarness.nativeClosed, 1);
assert.equal(resumeHarness.imageClosed, 1);

const fetchFailureHarness = makeHarness({ fetchFailPosition: 0, readyPositions: [1] });
await assert.rejects(
  vm.runInContext(`transferSelectedCaptureImages(${JSON.stringify(message)}, "bc:12:same-request-id")`, fetchFailureHarness.context),
  /原图完成 1\/2 张.*第 1 张：fixture image fetch denied/,
);
assert.deepEqual(fetchFailureHarness.nativeRequests.filter((request) => request.action === "fail_capture_image_upload").map((request) => request.position), [0]);
assert.equal(fetchFailureHarness.nativeRequests.some((request) => request.action === "begin_capture_image_upload" && request.position === 1), true);
assert.deepEqual(fetchFailureHarness.nativeTimeouts.filter(({ action }) => action === "fail_capture_image_upload"), [
  { action: "fail_capture_image_upload", timeoutMs: 15_000 },
]);

const protocolMismatchHarness = makeHarness({ protocolMismatchAction: "begin_capture_image_upload" });
await assert.rejects(
  vm.runInContext(`transferSelectedCaptureImages(${JSON.stringify(message)}, "bc:12:same-request-id")`, protocolMismatchHarness.context),
  /剪藏协议版本不兼容.*v12.*v11/,
);
assert.equal(protocolMismatchHarness.actions.includes("fail_capture_image_upload"), false,
  "an incompatible desktop protocol is explicit and does not send fallback writes");

const timeoutHarness = makeHarness({ nativeWriteTimeoutPosition: 0 });
await assert.rejects(
  vm.runInContext(`transferSelectedCaptureImages(${JSON.stringify(message)}, "bc:12:same-request-id")`, timeoutHarness.context),
  /完成 1\/2/,
);
assert.equal(timeoutHarness.nativeRequests.some((request) => request.action === "fail_capture_image_upload"), false,
  "a lost Native acknowledgement leaves the upload for same-request offset verification");
assert.equal(timeoutHarness.nativeClosed, 1);
assert.equal(timeoutHarness.imageClosed, 1);

console.log(JSON.stringify({ ok: true, cases: [
  "same-request-resume-from-native-confirmed-offset",
  "already-ready-image-is-not-written-again",
  "one-image-failure-is-explicit-and-does-not-block-later-selection",
  "backend-deadline-margins-and-native-frame-bounds",
  "protocol-mismatch-is-explicit-and-stops-transfer",
  "native-timeout-preserves-progress-without-blind-failure-write",
] }));
