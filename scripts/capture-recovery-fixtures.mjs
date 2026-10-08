import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = fs.readFileSync(path.join(process.cwd(), "browser-extension/capture-recovery.js"), "utf8");
const context = { globalThis: {}, Boolean, Number, Object, String };
vm.runInNewContext(source, context, { filename: "capture-recovery.js" });
const recovery = context.globalThis.AichiCaptureRecovery;
const request = {
  requestId: "same-request-1",
  targetAccountId: 42,
  modules: {
    collect: { titleBody: true, authorSource: true, images: false, comments: false },
    data: { metrics: true, publishedAt: false },
  },
};

const lookup = recovery.buildLookupRequest(request, 12, "0.9.0");
assert.deepEqual(JSON.parse(JSON.stringify(lookup)), {
  action: "lookup_capture_request",
  protocolVersion: 12,
  requestId: "same-request-1",
  targetAccountId: 42,
  extensionVersion: "0.9.0",
});
assert.deepEqual(Array.from(recovery.missingOutcomes(request, {})), ["素材收藏", "数据快照"]);
assert.deepEqual(Array.from(recovery.missingOutcomes(request, {
  collectionSaved: true,
  snapshotSaved: true,
})), []);
assert.deepEqual(Array.from(recovery.missingOutcomes(request, {
  collectionSaved: true,
  snapshotSaved: true,
})), []);
const profileRequest = {
  requestId: "profile-save-1",
  targetAccountId: 42,
  pageType: "profile",
  modules: { collect: { titleBody: true, authorSource: true }, data: { metrics: true } },
  profileNotesRequested: false,
};
assert.deepEqual(Array.from(recovery.missingOutcomes(profileRequest, {
  collectionSaved: true,
  snapshotSaved: true,
})), [], "saving profile metrics must not imply a home-note sync");
assert.equal(recovery.requestedOutcomes({ ...profileRequest, profileNotesRequested: "true" }).profileNotesRequested, false,
  "the home-note sync request is a strict explicit boolean");
const profileNotesRequest = { ...profileRequest, profileNotesRequested: true };
assert.deepEqual(Array.from(recovery.missingOutcomes(profileNotesRequest, {
  collectionSaved: true,
  snapshotSaved: true,
})), ["主页笔记同步"]);
assert.deepEqual(Array.from(recovery.missingOutcomes(profileRequest, {
  collectionSaved: true,
  snapshotSaved: true,
  profileNotesSaved: true,
})), [], "an unrequested profile-note outcome is ignored");
assert.deepEqual(Array.from(recovery.missingOutcomes(profileNotesRequest, {
  collectionSaved: true,
  snapshotSaved: true,
  profileNotesSaved: true,
})), []);
assert.equal(recovery.matchesRequest({ requestId: request.requestId, targetAccountId: request.targetAccountId }, request), true);
assert.equal(recovery.matchesRequest({ requestId: "other-request", targetAccountId: request.targetAccountId }, request), false);
assert.equal(recovery.matchesRequest({ requestId: request.requestId, targetAccountId: 9 }, request), false);
assert.equal(recovery.matchesIdentity({ channel: "dev", workspaceId: "repo-a-1234" }, "dev"), true);
assert.equal(recovery.matchesIdentity({ channel: "prod", workspaceId: "repo-a-1234" }, "dev"), false);
assert.equal(recovery.matchesIdentity({ channel: "dev", workspaceId: "repo-b-5678" }, "dev", "repo-a-1234"), false);
const completeReply = {
  response: { ok: true, outcomes: { collectionSaved: true, captureDetailsSaved: true, snapshotSaved: true } },
  runtimeError: "",
  timedOut: false,
};
assert.equal(recovery.classifySaveResponse(request, completeReply, true), "complete");
assert.equal(recovery.classifySaveResponse(request, completeReply, false), "identity_mismatch");
assert.equal(recovery.classifySaveResponse(request, { response: null, runtimeError: "timeout", timedOut: true }, false), "lookup");
const detailsRequest = { ...request, modules: { ...request.modules, collect: { ...request.modules.collect, images: true } } };
assert.equal(recovery.classifySaveResponse(detailsRequest, {
  response: { ok: true, outcomes: { collectionSaved: true, captureDetailsSaved: false, snapshotSaved: true } },
}, true), "lookup");
assert.equal(recovery.classifySaveResponse(request, { response: { ok: false, error: "账号不可用" } }, true), "rejected");
assert.equal(recovery.buildLookupRequest({ ...request, targetAccountId: 0 }, 12, "0.9.0"), null);
assert.equal(recovery.buildLookupRequest({ ...request, requestId: "" }, 12, "0.9.0"), null);
assert.equal(recovery.buildLookupRequest({ ...request, requestId: " padded " }, 12, "0.9.0"), null);

console.log(JSON.stringify({
  ok: true,
  scenarios: ["protocol 12 lookup preserves original request and account", "missing outcomes", "profile metrics do not imply home-note sync", "explicit home-note sync outcome", "request/account match", "channel/workspace identity", "successful receipt completes", "wrong identity blocks write", "timeout queries before retry", "business rejection is definite", "invalid retry identity rejected"],
}));
