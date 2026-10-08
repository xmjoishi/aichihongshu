import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();
const source = fs.readFileSync(path.join(root, "browser-extension/creator-fill.js"), "utf8");

class HTMLInputElement {
  constructor(value = "") {
    this.value = value;
    this.disabled = false;
    this.readOnly = false;
    this.events = [];
    this.files = [];
    this.multiple = false;
    this.accept = "";
  }
  focus() { this.focused = true; }
  dispatchEvent(event) { this.events.push(event.type); }
}
class HTMLTextAreaElement extends HTMLInputElement {}
class TestFile {
  constructor(parts, name, options = {}) {
    this.name = name;
    this.type = options.type || "";
    this.bytes = Uint8Array.from(parts.flatMap((part) => Array.from(part)));
    this.size = this.bytes.length;
  }
}
class TestDataTransfer {
  constructor() {
    this._files = [];
    this.items = { add: (file) => this._files.push(file) };
  }
  get files() { return this._files; }
}

function createBridge({ url, title, body, omitTitle = false, omitBody = false, withFileInput = false, withVideoInput = false }) {
  const input = new HTMLInputElement(title);
  const editor = {
    innerText: body,
    textContent: body,
    disabled: false,
    readOnly: false,
    focus() { this.focused = true; },
    replaceChildren(text) { this.innerText = text.textContent; this.textContent = text.textContent; },
    dispatchEvent(event) { this.lastEvent = event.type; },
  };
  const fileInput = new HTMLInputElement();
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = "image/*";
  const videoInput = new HTMLInputElement();
  videoInput.type = "file";
  videoInput.multiple = false;
  videoInput.accept = "video/*,.mp4,.mov,.m4v,.webm";
  const publishButton = { clicked: false };
  const selectors = {
    'input[placeholder*="标题"]': omitTitle ? null : input,
    'textarea[placeholder*="标题"]': null,
    'input[aria-label*="标题"]': null,
    'textarea[aria-label*="标题"]': null,
    '[contenteditable="true"][data-placeholder*="正文"]': omitBody ? null : editor,
    '[contenteditable="true"][data-placeholder*="描述"]': null,
    '[contenteditable="true"][aria-label*="正文"]': null,
    '[contenteditable="true"][aria-label*="描述"]': null,
    'textarea[placeholder*="正文"]': null,
    'textarea[placeholder*="描述"]': null,
    '.ql-editor[contenteditable="true"]': null,
  };
  let listener;
  const context = vm.createContext({
    URL,
    window: { location: { href: url } },
    document: {
      querySelector(selector) { return selectors[selector] ?? null; },
      querySelectorAll(selector) {
        if (selector !== 'input[type="file"]') return [];
        return [...(withFileInput ? [fileInput] : []), ...(withVideoInput ? [videoInput] : [])];
      },
      createTextNode(textContent) { return { textContent }; },
    },
    chrome: { runtime: { onMessage: { addListener(callback) { listener = callback; } } } },
    HTMLInputElement,
    HTMLTextAreaElement,
    InputEvent: class InputEvent { constructor(type, properties) { this.type = type; Object.assign(this, properties); } },
    Event: class Event { constructor(type, properties = {}) { this.type = type; Object.assign(this, properties); } },
    File: TestFile,
    DataTransfer: TestDataTransfer,
    crypto: webcrypto,
    atob,
    TextDecoder,
    Uint8Array,
  });
  vm.runInContext(source, context);
  function send(message) {
    return new Promise((resolve) => {
      let settled = false;
      const returned = listener(message, {}, (value) => {
        settled = true;
        resolve(value);
      });
      if (returned !== true && !settled) resolve(null);
    });
  }
  return { input, editor, fileInput, videoInput, publishButton, send };
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}
async function sha256(bytes) {
  const digest = await webcrypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const bridge = createBridge({
  url: "https://creator.xiaohongshu.com/publish/publish",
  title: "旧标题",
  body: "旧正文",
  withFileInput: true,
});
const inspected = await bridge.send({ action: "aichihongshu:creator-inspect" });
assert.equal(inspected.ok, true);
assert.equal(inspected.fields.title.value, "旧标题");
assert.equal(inspected.fields.body.value, "旧正文");
assert.equal(bridge.input.value, "旧标题", "inspection must not modify form state");

const unconfirmed = await bridge.send({
  action: "aichihongshu:creator-fill",
  confirmReplace: false,
  title: "新标题",
  body: "新正文",
});
assert.equal(unconfirmed.ok, false);
assert.equal(bridge.input.value, "旧标题", "fill requires a separate explicit confirmation");

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const pngSecond = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03, 0x04]);
const image = {
  index: 0,
  itemId: 71,
  filename: "image-01.png",
  mimeType: "image/png",
  totalBytes: png.length,
  sha256: await sha256(png),
};
const imageSecond = {
  index: 1,
  itemId: 72,
  filename: "image-02.png",
  mimeType: "image/png",
  totalBytes: pngSecond.length,
  sha256: await sha256(pngSecond),
};
const capability = {
  attemptId: "fixture-attempt",
  accountPoolId: 2,
  claimToken: "a".repeat(64),
};
const begin = await bridge.send({
  action: "aichihongshu:creator-images-begin",
  confirmReplace: true,
  ...capability,
  images: [image],
  itemIds: [image.itemId],
});
assert.equal(begin.ok, true);
const unauthorizedChunk = await bridge.send({
  action: "aichihongshu:creator-image-chunk",
  confirmReplace: false,
  capabilityKey: begin.capabilityKey,
  itemId: image.itemId,
  offset: 0,
  dataBase64: toBase64(png),
  done: true,
});
assert.equal(unauthorizedChunk.ok, false);

const badHashMeta = { ...image, sha256: "0".repeat(64) };
const badHashBegin = await bridge.send({
  action: "aichihongshu:creator-images-begin",
  confirmReplace: true,
  ...capability,
  images: [badHashMeta],
  itemIds: [image.itemId],
});
const badHash = await bridge.send({
  action: "aichihongshu:creator-image-chunk",
  confirmReplace: true,
  capabilityKey: badHashBegin.capabilityKey,
  itemId: image.itemId,
  offset: 0,
  dataBase64: toBase64(png),
  done: true,
});
assert.equal(badHash.ok, false, "corrupt digest must fail before FileList assignment");

const retryBegin = await bridge.send({
  action: "aichihongshu:creator-images-begin",
  confirmReplace: true,
  ...capability,
  images: [image, imageSecond],
  itemIds: [image.itemId, imageSecond.itemId],
});
const imageChunk = await bridge.send({
  action: "aichihongshu:creator-image-chunk",
  confirmReplace: true,
  capabilityKey: retryBegin.capabilityKey,
  itemId: image.itemId,
  offset: 0,
  dataBase64: toBase64(png),
  done: true,
});
assert.equal(imageChunk.ok, true);
assert.equal(imageChunk.complete, true);
const corruptedSecond = Uint8Array.from([...pngSecond.slice(0, 8), 0x09, 0x09]);
const badSecondChunk = await bridge.send({
  action: "aichihongshu:creator-image-chunk",
  confirmReplace: true,
  capabilityKey: retryBegin.capabilityKey,
  itemId: imageSecond.itemId,
  offset: 0,
  dataBase64: toBase64(corruptedSecond),
  done: true,
});
assert.equal(badSecondChunk.ok, false, "one corrupt image fails independently");

const filled = await bridge.send({
  action: "aichihongshu:creator-fill",
  confirmReplace: true,
  capabilityKey: retryBegin.capabilityKey,
  title: "新标题",
  body: "新正文\n\n#测试话题",
  allImageIds: [image.itemId, imageSecond.itemId],
  imageItemIds: [image.itemId, imageSecond.itemId],
});
assert.equal(filled.title.status, "filled");
assert.equal(filled.body.status, "filled");
assert.deepEqual(JSON.parse(JSON.stringify(filled.images)), [
  { itemId: image.itemId, status: "filled", error: null },
  { itemId: imageSecond.itemId, status: "failed", error: "图片没有完整传输或校验失败" },
]);
assert.equal(bridge.input.value, "新标题");
assert.equal(bridge.editor.innerText, "新正文\n\n#测试话题");
assert.equal(bridge.fileInput.files.length, 1, "the available image can be filled independently");
assert.equal(bridge.fileInput.files[0].name, "image-01.png");
assert.deepEqual(bridge.fileInput.events, ["input", "change"]);
assert.equal(bridge.publishButton.clicked, false, "creator submit controls are never clicked");

const failedImageRetryBegin = await bridge.send({
  action: "aichihongshu:creator-images-begin",
  confirmReplace: true,
  ...capability,
  images: [image, imageSecond],
  itemIds: [imageSecond.itemId],
});
const retriedImage = await bridge.send({
  action: "aichihongshu:creator-image-chunk",
  confirmReplace: true,
  capabilityKey: failedImageRetryBegin.capabilityKey,
  itemId: imageSecond.itemId,
  offset: 0,
  dataBase64: toBase64(pngSecond),
  done: true,
});
assert.equal(retriedImage.ok, true);
const retriedFill = await bridge.send({
  action: "aichihongshu:creator-fill",
  confirmReplace: true,
  capabilityKey: failedImageRetryBegin.capabilityKey,
  title: "新标题",
  body: "新正文\n\n#测试话题",
  onlyFields: [],
  allImageIds: [image.itemId, imageSecond.itemId],
  imageItemIds: [imageSecond.itemId],
  preserveImageItemIds: [image.itemId],
});
assert.deepEqual(JSON.parse(JSON.stringify(retriedFill.images)), [{ itemId: imageSecond.itemId, status: "filled", error: null }]);
assert.equal(bridge.fileInput.files.length, 2, "retrying only the failed image retains the prior image");
assert.deepEqual(bridge.fileInput.files.map((file) => file.name), ["image-01.png", "image-02.png"], "FileList follows snapshot order");

const wrongPage = createBridge({
  url: "https://example.com/publish/publish",
  title: "unchanged",
  body: "unchanged",
});
assert.equal((await wrongPage.send({ action: "aichihongshu:creator-inspect" })).ok, false);
assert.equal((await wrongPage.send({ action: "aichihongshu:creator-fill", confirmReplace: true, title: "x", body: "y" })).ok, false);

const partial = createBridge({
  url: "https://creator.xiaohongshu.com/publish/publish",
  title: "",
  body: "",
  omitTitle: true,
});
const partialBegin = await partial.send({
  action: "aichihongshu:creator-images-begin",
  confirmReplace: true,
  ...capability,
  images: [],
  itemIds: [],
});
const partialResult = await partial.send({
  action: "aichihongshu:creator-fill",
  confirmReplace: true,
  capabilityKey: partialBegin.capabilityKey,
  title: "标题",
  body: "正文",
  allImageIds: [],
  imageItemIds: [],
});
assert.equal(partialResult.title.status, "failed");
assert.equal(partialResult.body.status, "filled", "the available field can succeed independently");

const videoBridge = createBridge({
  url: "https://creator.xiaohongshu.com/publish/publish",
  title: "旧标题",
  body: "旧正文",
  withVideoInput: true,
});
const videoBytes = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 1]);
const video = {
  filename: "clip.mp4",
  mimeType: "video/mp4",
  totalBytes: videoBytes.length,
  sha256: await sha256(videoBytes),
};
const videoBegin = await videoBridge.send({
  action: "aichihongshu:creator-video-begin",
  confirmReplace: true,
  ...capability,
  video,
});
assert.equal(videoBegin.ok, true);
const badOffset = await videoBridge.send({
  action: "aichihongshu:creator-video-chunk",
  confirmReplace: true,
  capabilityKey: videoBegin.capabilityKey,
  offset: 1,
  dataBase64: toBase64(videoBytes),
  done: true,
});
assert.equal(badOffset.ok, false, "video chunks must be contiguous and ordered");
const videoRetryBegin = await videoBridge.send({
  action: "aichihongshu:creator-video-begin",
  confirmReplace: true,
  ...capability,
  video,
});
const firstVideoChunk = await videoBridge.send({
  action: "aichihongshu:creator-video-chunk",
  confirmReplace: true,
  capabilityKey: videoRetryBegin.capabilityKey,
  offset: 0,
  dataBase64: toBase64(videoBytes.slice(0, 8)),
  done: false,
});
assert.equal(firstVideoChunk.ok, true);
const finalVideoChunk = await videoBridge.send({
  action: "aichihongshu:creator-video-chunk",
  confirmReplace: true,
  capabilityKey: videoRetryBegin.capabilityKey,
  offset: 8,
  dataBase64: toBase64(videoBytes.slice(8)),
  done: true,
});
assert.equal(finalVideoChunk.ok, true);
assert.equal(finalVideoChunk.complete, true);
const videoFilled = await videoBridge.send({
  action: "aichihongshu:creator-fill",
  confirmReplace: true,
  capabilityKey: videoRetryBegin.capabilityKey,
  title: "视频标题",
  body: "视频正文",
  allImageIds: [],
  imageItemIds: [],
  includeVideo: true,
});
assert.equal(videoFilled.video.status, "filled");
assert.equal(videoBridge.videoInput.files.length, 1);
assert.equal(videoBridge.videoInput.files[0].name, "clip.mp4");
assert.deepEqual(videoBridge.videoInput.events, ["input", "change"]);
assert.equal(videoBridge.publishButton.clicked, false, "video filling never submits the post");
const badVideo = await videoBridge.send({
  action: "aichihongshu:creator-video-begin",
  confirmReplace: true,
  ...capability,
  video: { ...video, sha256: "0".repeat(64) },
});
const corruptedVideo = await videoBridge.send({
  action: "aichihongshu:creator-video-chunk",
  confirmReplace: true,
  capabilityKey: badVideo.capabilityKey,
  offset: 0,
  dataBase64: toBase64(videoBytes),
  done: true,
});
assert.equal(corruptedVideo.ok, false, "incorrect video digest must be rejected");

console.log(JSON.stringify({
  ok: true,
  fixtures: [
    "creator-page-inspect",
    "explicit-fill-confirmation",
    "bounded-image-transfer-and-filelist-order",
    "image-digest-failure-and-retry",
    "wrong-page-rejected",
    "partial-field-failure",
    "bounded-video-transfer-and-filelist-assignment",
    "video-digest-failure-and-retry",
    "input-change-events",
    "never-click-submit",
  ],
}));
