import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const elements = new Map();
function el(id) {
  if (!elements.has(id)) elements.set(id, { value: '', checked: false, options: [{}, {}], style: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, replaceChildren() {}, append() {} });
  return elements.get(id);
}
const context = vm.createContext({
  document: { getElementById: el, querySelector: el },
  chrome: { runtime: { getManifest: () => ({ name: 'fixture', version: '0.8.1' }) } },
});
const source = fs.readFileSync('browser-extension/popup.js', 'utf8').replace(/void loadPreview\(\);\s*$/, '');
vm.runInContext(source, context);
vm.runInContext(`
  renderPreview = () => {};
  updateConnectionStatus = () => true;
  parsed = {sourceUrl:'https://example.com/note', pageType:'note'};
  pageTypeEl.value = 'note'; targetAccountEl.value = '1';
  globalThis.resolvers = [];
  lookupPageContext = () => new Promise(resolve => resolvers.push(resolve));
`, context);
const run = (code) => vm.runInContext(code, context);
function reply(id) { return {context: {id, matchType:'known_snapshot', defaultAction:'update_data', pageType:'note'}, available: true}; }
const first = run('refreshLookupForSelectedAccount()');
run("targetAccountEl.value = '2'");
const second = run('refreshLookupForSelectedAccount()');
context.resolvers[1](reply('account-2')); await second;
context.resolvers[0](reply('account-1')); await first;
assert.equal(run('pageContext.id'), 'account-2');
const third = run('refreshLookupForSelectedAccount()');
assert.equal(run('pageContext'), null, 'old comparison clears immediately');
run("setMode('collect'); document.getElementById('m-titleBody').checked = true;");
context.resolvers[2](reply('manual-mode')); await third;
assert.equal(run('activeMode'), 'collect');
assert.equal(el('m-titleBody').checked, true, 'late lookup preserves manually edited modules');
const fourth = run('refreshLookupForSelectedAccount()');
run("pageTypeEl.value = 'profile'");
context.resolvers[3](reply('old-page-type')); await fourth;
assert.equal(run('pageContext'), null, 'old page type response cannot install stale context');
console.log(JSON.stringify({ok:true, cases:['account-out-of-order','clear-old-comparison','manual-mode-preserved','page-type-race']}));
vm.runInContext(fs.readFileSync('browser-extension/capture-recovery.js', 'utf8'), context);
const memory = {};
context.chrome.storage = {session:{
  async set(values) { Object.assign(memory, JSON.parse(JSON.stringify(values))); },
  async get(key) { return {[key]: memory[key]}; },
  async remove(key) { delete memory[key]; },
}};
run("connectedWorkspaceId='original-workspace'");
await run("retainPendingCapture({requestId:'recover-original',targetAccountId:2,modules:{collect:{titleBody:true}},body:'test-only'})");
run("pendingCaptureMessage=null; connectedWorkspaceId=''");
await run('restorePendingCapture()');
assert.equal(run('pendingCaptureMessage.requestId'), 'recover-original');
assert.equal(run('connectedWorkspaceId'), 'original-workspace');
await run('clearPendingCapture()');
assert.equal(Object.keys(memory).length, 0);
run("connectedWorkspaceId='original-workspace'; expectedChannel='prod'");
const stagedMessage = {requestId:'stage-original',targetAccountId:2,sourceUrl:'https://example.com/note',body:'explicit-stage-only'};
await run(`retainStagedCapture(${JSON.stringify(stagedMessage)})`);
assert.equal(memory['aichi-capture-staged'].stage, 'user_requested_offline');
assert.equal(memory['aichi-capture-staged'].workspaceId, 'original-workspace');
run('stagedCaptureMessage=null; stagedCaptureWorkspaceId=""');
await run('restoreStagedCapture()');
assert.equal(run('stagedCaptureMessage.requestId'), 'stage-original');
assert.equal(run('stagedCaptureWorkspaceId'), 'original-workspace');
assert.equal(run('expectedChannel'), 'prod');
await run('clearStagedCapture()');
assert.equal(Object.keys(memory).length, 0);
console.log(JSON.stringify({ok:true,cases:['reopen-recovers-original-request-and-workspace','confirmed-outcome-clears-session','explicit-stage-restores-original-workspace-and-clears']}));
