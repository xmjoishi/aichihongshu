import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = fs.readFileSync(path.join(process.cwd(), "browser-extension/capture-preview.js"), "utf8");

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this.classList = { toggle: () => {} };
    this.scrollTop = 0;
    this.hidden = false;
    this.checked = false;
    this.open = false;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  dispatch(name) { this.listeners[name]?.({ target: this }); }
  set textContent(value) { this.text = String(value); }
  get textContent() { return this.text || this.children.map((child) => child.textContent).join(""); }
}

const context = vm.createContext({
  URL,
  Intl,
  document: { createElement: (tag) => new Element(tag) },
});
vm.runInContext(source, context, { filename: "capture-preview.js" });
const preview = context.AichiCapturePreview;
const parsed = {
  pageType: "note",
  title: "长正文笔记",
  body: "正文内容。".repeat(500),
  bodyExcerpt: "正文摘要",
  author: "作者甲",
  sourceUrl: "https://www.xiaohongshu.com/explore/fixture",
  observedAt: "2026-09-29T00:00:00Z",
  metrics: { like: 100, collect: null, comment: 9, share: null },
  images: [
    { url: "https://sns-img-bd.xhscdn.com/1.jpg", width: 900, height: 1200 },
    { url: "https://sns-img-bd.xhscdn.com/2.jpg", width: 800, height: 900 },
    { url: "https://sns-img-bd.xhscdn.com/3.jpg", width: 640, height: 640 },
  ],
  comments: [
    { author: "读者甲", text: "评论很长。".repeat(100), truncated: true },
    { author: "读者乙", text: "第二条评论", truncated: false },
  ],
  publishedAt: "09-15",
  publishedLocation: "四川",
  imageStatus: { state: "ready", reason: "当前笔记图片已加载" },
};
const modules = {
  collect: { titleBody: false, authorSource: true, images: true, comments: true },
  data: { metrics: true, publishedAt: false },
};
const model = preview.buildModel(parsed, {
  pageType: "note",
  modules,
  selectedImageIndexes: [1],
  selectedCommentIndexes: [0],
  pageContext: { lastSnapshotAt: "2026-09-28T10:00:00Z", lastSnapshotMetrics: { like: 80, collect: null, comment: 7 } },
  batchId: "batch-1",
});
assert.equal(model.body.length, parsed.body.length, "long bodies remain available to the expanded preview");
assert.equal(model.bodyIncluded, false);
assert.equal(model.images.length, 3);
assert.deepEqual(JSON.parse(JSON.stringify(model.images.map((image) => image.included))), [false, true, false]);
assert.equal(model.comments.length, 2);
assert.deepEqual(JSON.parse(JSON.stringify(model.comments.map((comment) => comment.included))), [true, false]);
assert.equal(model.metrics.find((metric) => metric.key === "like").previous, 80);
assert.equal(model.metrics.find((metric) => metric.key === "collect").value, null, "unknown values stay unknown");
assert.equal(model.metrics.find((metric) => metric.key === "comment").label, "评论总数");
assert.equal(model.publishedAt, "09-15", "the preview keeps dates without an observed year");
assert.equal(model.publishedLocation, "四川");

const payload = preview.buildCaptureMessage(parsed, {
  pageType: "note",
  modules: { ...modules, data: { ...modules.data, publishedAt: true } },
  selectedImageIndexes: [1, 99],
  selectedCommentIndexes: [0],
  pageContext: { pageType: "note", snapshotKind: "note_snapshot" },
  protocolVersion: 12,
  requestId: "request-1",
  targetAccountId: 12,
  extensionVersion: "0.8.1",
});
assert.equal(payload.body, "", "disabled body module does not leak text into the save payload");
assert.equal(payload.bodyExcerpt, "", "preview and payload share the same module decision");
assert.deepEqual(JSON.parse(JSON.stringify(payload.images.map((image) => image.url))), [parsed.images[1].url]);
assert.deepEqual(JSON.parse(JSON.stringify(payload.comments.map((comment) => comment.author))), ["读者甲"]);
assert.equal(payload.modules.collect.images, true);
assert.equal(payload.requestId, "request-1");
assert.equal(payload.targetAccountId, 12);
assert.equal(payload.publishedAt, "09-15");
assert.equal(payload.publishedLocation, "四川");

const root = new Element("main");
const callbacks = { images: [], comments: [], commentDisclosure: null };
preview.render(root, model, {
  interactive: true,
  onImageToggle: (index, checked) => callbacks.images.push([index, checked]),
  onCommentToggle: (index, checked) => callbacks.comments.push([index, checked]),
  onCommentsToggle: (open) => { callbacks.commentDisclosure = open; },
});
const flatten = (element) => [element, ...element.children.flatMap(flatten)];
const rendered = flatten(root);
assert.ok(rendered.some((element) => element.textContent.includes("较上次 +20")));
assert.ok(rendered.some((element) => element.textContent.includes("变化未知")));
assert.ok(rendered.some((element) => element.textContent.includes("未开启标题与正文摘要；预览内容不会保存")));
assert.ok(rendered.some((element) => element.textContent.includes("评论总数")));
assert.ok(rendered.some((element) => element.textContent.includes("2 条已加载")), "loaded excerpts remain separate from the total counter");
const details = rendered.find((element) => element.tagName === "details");
assert.ok(details);
assert.equal(details.open, false, "comments are folded by default");
details.open = true;
details.dispatch("toggle");
assert.equal(callbacks.commentDisclosure, true);
const imageCheckbox = rendered.find((element) => element.tagName === "input" && element.attributes["aria-label"] === "选择第 1 张图片");
const commentCheckbox = rendered.find((element) => element.tagName === "input" && element.attributes["aria-label"] === "选择评论 1");
assert.equal(imageCheckbox.checked, false);
assert.equal(commentCheckbox.checked, true);
imageCheckbox.checked = true;
imageCheckbox.dispatch("change");
assert.deepEqual(callbacks.images, [[0, true]]);
commentCheckbox.checked = false;
commentCheckbox.dispatch("change");
assert.deepEqual(callbacks.comments, [[0, false]]);

const emptyModel = preview.buildModel({ ...parsed, images: [], comments: [] }, { pageType: "note", modules });
assert.equal(emptyModel.images.length, 0);
assert.equal(emptyModel.comments.length, 0);
const oneModel = preview.buildModel({ ...parsed, images: parsed.images.slice(0, 1), comments: [] }, { pageType: "note", modules, selectedImageIndexes: [0] });
assert.equal(oneModel.images.length, 1);

const webParsed = { ...parsed, pageType: "web", sourceUrl: "https://example.com/article" };
const materialPayload = preview.buildCaptureMessage(webParsed, {
  pageType: "web",
  clipKind: "material",
  modules: { collect: { titleBody: false, authorSource: true, images: true, comments: false }, data: {} },
  selectedImageIndexes: [0, 2],
  requestId: "material-request",
  targetAccountId: 12,
  protocolVersion: 12,
});
assert.equal(materialPayload.pageType, "web");
assert.equal(materialPayload.clipKind, "material");
assert.equal(materialPayload.materialType, "image_material");
assert.equal(materialPayload.imageTransferProtocol, true);
assert.equal(materialPayload.title, "长正文笔记");
assert.equal(materialPayload.body, "");
assert.deepEqual(JSON.parse(JSON.stringify(materialPayload.images.map((image) => image.url))), [parsed.images[0].url, parsed.images[2].url]);
const materialRoot = new Element("main");
preview.render(materialRoot, preview.buildModel(webParsed, {
  pageType: "web", clipKind: "material", modules: { collect: { images: true }, data: {} }, selectedImageIndexes: [0, 2],
}), { interactive: true });
const materialRendered = flatten(materialRoot);
assert.ok(materialRendered.some((element) => element.className === "material-image-grid"));
assert.equal(materialRendered.filter((element) => element.className === "image-thumb").length, 3);

const webArticleRoot = new Element("main");
preview.render(webArticleRoot, preview.buildModel(webParsed, {
  pageType: "web", clipKind: "note", modules: { collect: { titleBody: true }, data: {} }, selectedImageIndexes: [0, 2],
}));
assert.ok(flatten(webArticleRoot).some((element) => element.textContent.includes("调整为“素材剪藏”")));
assert.equal(flatten(webArticleRoot).some((element) => element.className === "image-stage"), false,
  "article images are not presented as note carousel or saved unless the user selects material clipping");

const profileModel = preview.buildModel({
  pageType: "profile",
  title: "创作者主页",
  author: "创作者甲",
  body: "简介与三十张主页笔记被错误拼接的正文。",
  profile: { bio: "分享居家灵感", ipLocation: "四川", tags: ["家居"] },
  profileNotes: [{ title: "一张独立主页笔记", likes: 10, comments: null, collects: 2 }],
  metrics: { followers: 100, noteCount: 30 },
  sourceUrl: "https://www.xiaohongshu.com/user/profile/creator-1",
}, {
  pageType: "profile",
  modules: { collect: { titleBody: true, authorSource: true }, data: { metrics: true } },
});
assert.equal(profileModel.body, "", "profile feed text never becomes the profile biography");
const profileRoot = new Element("main");
preview.render(profileRoot, profileModel);
const profileRendered = flatten(profileRoot);
assert.ok(profileRendered.some((element) => element.textContent.includes("创作者甲")));
assert.ok(profileRendered.some((element) => element.textContent.includes("一张独立主页笔记")));
assert.ok(profileRendered.some((element) => element.textContent.includes("主页当前可见笔记")));
assert.ok(profileRendered.some((element) => element.textContent.includes("IP 属地 四川")));
assert.ok(!profileRendered.some((element) => element.textContent.includes("三十张主页笔记被错误拼接")));

console.log(JSON.stringify({ ok: true, cases: [
  "shared-model-keeps-selection-and-payload-aligned", "long-body-and-comment", "unknown-metrics-stay-unknown",
  "comment-list-collapsed-by-default", "keyboard-accessible-selection-controls", "zero-one-and-many-images",
  "web-material-payload-keeps-only-selected-image-order", "ordinary-web-article-does-not-pretend-to-save-images",
] }));
