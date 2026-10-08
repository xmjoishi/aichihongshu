import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourcePath = new URL("../src/lib/browserCapture.ts", import.meta.url);
const source = await readFile(sourcePath, "utf8");
const javascript = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
const { serializeBrowserCapturePayload, validateBrowserCapture } = await import(moduleUrl);

const materialResult = validateBrowserCapture({
  title: "页面图集",
  sourceUrl: "https://example.com/article",
  targetAccountId: 12,
  transport: "extension",
  clipKind: "material",
  materialType: "image_material",
  pageType: "web",
  imageTransferProtocol: true,
  body: "",
  author: "作者甲",
  images: [{ url: "https://cdn.example.com/photo.jpg", width: 1200, height: 800, source: "selected-image" }],
  metrics: { like: null, share: null },
  profile: { bio: "简介", follows: null, tags: ["设计"] },
  modules: { collect: { images: true } },
}, 12);

assert.equal(materialResult.ok, true);
if (!materialResult.ok) throw new Error(materialResult.message);
assert.equal(materialResult.value.clipKind, "material");
assert.equal(materialResult.value.materialType, "image_material");
assert.equal(materialResult.value.pageType, "web");
assert.equal(materialResult.value.imageTransferProtocol, true);
assert.equal(materialResult.value.modules.collect.images, true);
assert.equal(materialResult.value.images.length, 1);
assert.equal(materialResult.value.captureDetails.images[0].source, "selected-image");
assert.equal(materialResult.value.metrics.like, null);
assert.equal(materialResult.value.metrics.share, null);

const payload = JSON.parse(serializeBrowserCapturePayload(materialResult.value));
assert.equal(payload.images[0].url, "https://cdn.example.com/photo.jpg");
assert.equal(payload.metrics.like, null);
assert.equal(payload.profile.bio, "简介");
assert.deepEqual(payload.tags, ["设计"]);

const ordinaryWeb = validateBrowserCapture({
  title: "普通文章",
  sourceUrl: "https://example.com/post",
  targetAccountId: 12,
  transport: "extension",
  materialType: "web_material",
  pageType: "web",
  images: [{ url: "https://cdn.example.com/not-selected.jpg" }],
  modules: { collect: { images: true } },
}, 12);
assert.equal(ordinaryWeb.ok, true);
if (!ordinaryWeb.ok) throw new Error(ordinaryWeb.message);
assert.equal(ordinaryWeb.value.clipKind, "note");
assert.equal(ordinaryWeb.value.modules.collect.images, false);
assert.equal(ordinaryWeb.value.images.length, 0);

console.log("browser-capture validator: material uploads and legacy web behavior passed");
