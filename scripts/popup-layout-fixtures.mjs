import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const base = path.join(process.cwd(), "browser-extension");
const html = fs.readFileSync(path.join(base, "popup.html"), "utf8");
const css = fs.readFileSync(path.join(base, "popup.css"), "utf8");
const js = fs.readFileSync(path.join(base, "popup.js"), "utf8");
const preview = fs.readFileSync(path.join(base, "capture-preview.js"), "utf8");
const extract = fs.readFileSync(path.join(base, "extract.js"), "utf8");

for (const marker of [
  'class="popup-header"',
  'class="connection-bar"',
  'id="target-account"',
  'id="advanced-connection"',
  'id="clip-type-label"',
  'id="type-adjustments"',
  'id="existing-actions"',
  'id="update-content"',
  'id="refresh-data"',
  'class="preview-pane"',
  'id="preview-fields"',
  'class="fixed-actions"',
  'id="capture"',
  'id="creator-fill-panel"',
  'class="legacy-controls" hidden',
]) assert.ok(html.includes(marker), `popup structure needs ${marker}`);

assert.match(css, /html\s*\{[^}]*width:\s*780px;[^}]*height:\s*580px/s);
assert.match(css, /\.layout\s*\{[^}]*flex-direction:\s*column/s);
assert.match(css, /\.clip-columns\s*\{[^}]*grid-template-columns:\s*minmax\(260px,\s*42%\)\s+minmax\(0,\s*58%\)/s);
assert.match(css, /\.image-thumbnails\s*\{[^}]*overflow-x:\s*auto/s);
assert.match(css, /\.material-image-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s);
assert.match(css, /\.preview-content\s*\{[^}]*overflow:\s*auto/s);
assert.match(css, /\.fixed-actions\s*\{[^}]*flex:\s*0 0 auto/s);
assert.match(css, /\.advanced-connection\s*\{[^}]*flex:\s*0 0 auto/s);
assert.match(css, /\.existing-actions \.inline-action\[aria-pressed="true"\]/);
assert.match(css, /@media\s*\(max-width:\s*620px\)/);
assert.match(css, /\.creator-mode/);
assert.doesNotMatch(css, /(?:98vw|88vh)/);

assert.match(js, /PROTOCOL_VERSION\s*=\s*12/);
assert.match(js, /new Set\(\(parsed\.images\s*\|\|\s*\[\]\)\.slice\(0,\s*12\)/);
assert.match(js, /onSelectAllImages/);
assert.match(js, /onClearImages/);
assert.match(js, /updateContentBtn\.addEventListener/);
assert.match(js, /refreshDataBtn\.addEventListener/);
assert.match(js, /profileNotesRequested\s*=\s*false/);
assert.doesNotMatch(js, /executeScript\(\{[^}]*files:\s*\["profile-notes\.js"\]/s,
  "saving or refreshing a profile must not auto-import its visible notes");
assert.match(js, /targetAccountEl\.disabled\s*=\s*Boolean\(locked\)/);
assert.match(js, /requestId:\s*message\.requestId/);
assert.match(preview, /appendNoteImages/);
assert.match(preview, /appendMaterialGrid/);
assert.match(preview, /onProfileNoteOpen/);
assert.match(preview, /默认不保存/);
assert.match(preview, /主页当前可见笔记 · 逐篇单独剪藏/);
assert.match(extract, /function imageRootForCurrentPage/);
assert.match(extract, /当前文章内容区没有识别到图片容器/);
assert.match(extract, /share:\s*pageType === "note" \? findMetric/);

console.log(JSON.stringify({ ok: true, cases: [
  "content-first-popup-with-folded-diagnostics",
  "note-carousel-and-separate-material-grid",
  "explicit-update-and-refresh-actions",
  "default-selected-images-and-collapsed-comments",
  "profile-note-actions-stay-independent",
  "bounded-popup-layout-and-sticky-primary-action",
] }));
