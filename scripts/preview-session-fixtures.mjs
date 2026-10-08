import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = fs.readFileSync(path.join(process.cwd(), "browser-extension/preview-session.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context, { filename: "preview-session.js" });
const sessions = context.AichiPreviewSession;
const sourceUrl = "https://www.xiaohongshu.com/explore/fixture?xsec_token=private";
const record = {
  previewTabId: 51,
  sourceTabId: 17,
  sourceUrl,
  parseBatchId: "batch-abc",
  createdAt: 100_000,
  parsed: { sourceUrl, body: "temporary" },
  modules: { collect: {}, data: {} },
};
assert.equal(sessions.storageKey(51), "aichi-capture-preview:51");
assert.equal(sessions.storageKey(-1), "");
assert.equal(sessions.validate(record, { previewTabId: 51, sourceTabId: 17, sourceUrl, now: 101_000 }).ok, true);
assert.equal(sessions.validate(record, { previewTabId: 52, now: 101_000 }).ok, false);
assert.equal(sessions.validate(record, { previewTabId: 51, sourceTabId: 18, now: 101_000 }).reason.includes("来源标签页"), true);
assert.equal(sessions.validate(record, { previewTabId: 51, sourceUrl: "https://www.xiaohongshu.com/explore/other", now: 101_000 }).ok, false);
assert.equal(sessions.validate({ ...record, createdAt: 0 }, { previewTabId: 51, now: 400_000 }).ok, false);
assert.equal(sessions.validate({ ...record, parsed: { sourceUrl: "https://wrong.test" } }, { previewTabId: 51, now: 101_000 }).ok, false);

const previewHtml = fs.readFileSync(path.join(process.cwd(), "browser-extension/preview.html"), "utf8");
const popupSource = fs.readFileSync(path.join(process.cwd(), "browser-extension/popup.js"), "utf8");
assert.match(popupSource, /chrome\.runtime\.getURL\("preview\.html"\)/);
assert.doesNotMatch(previewHtml, /\?(?:[^"']*(?:token|body|comment|sourceUrl|session))/i);
assert.doesNotMatch(popupSource, /localStorage|sessionStorage/);
assert.match(popupSource, /chrome\.storage\.session\.set/);
assert.match(popupSource, /sourceTabId[\s\S]*sourceUrl[\s\S]*parseBatchId/);

console.log(JSON.stringify({ ok: true, cases: [
  "one-time-key-bound-to-preview-tab", "source-tab-url-and-batch-identity", "expiry-and-navigation-fail-closed",
  "no-preview-payload-in-url-or-localStorage",
] }));
