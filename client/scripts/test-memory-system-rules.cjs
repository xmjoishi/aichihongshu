// No native runtime, network, or user database. Exercise actual component routing and bridge validation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const path = require('node:path');
let queryData;
let queryError;
let bridgeResult;
const queries = [];
function load(relative, overrides = {}) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  vm.runInNewContext(js, {exports, Date, require(id) {
    if (id in overrides) return overrides[id];
    return require(id);
  }});
  return exports;
}
const bridge = load('../src/lib/local/companion.ts', {
  '@tauri-apps/api/core': {invoke: async (_name, args) => { assert.equal(args.operation, 'readSystemRules'); return bridgeResult; }},
  './runtime': {requireTauri() {}},
});
const snapshot = { origin: 'mobile', accountId: 7, editable: false, source:'phone-runtime', version:'fixture-v1', readAt:new Date().toISOString(), defaultExperience:'PHONE-ONLY-EXPERIENCE', outputRules:'PHONE-ONLY-OUTPUT' };
const section = load('../src/pages/memory/MemorySections.tsx', {
  '../../lib/workspaceActivity': {useWorkspaceQuery: options => { queries.push(options); return {data:queryData, error:queryError, isError:!!queryError, isPending:false, refetch(){}}; }},
  '@tanstack/react-query': {useQueryClient: () => ({invalidateQueries(){}})},
  'react-router-dom': {Link: 'a'},
  '../../components/ui': {Empty: ({message}) => React.createElement('p', null, message), Spinner: () => React.createElement('p', null, 'loading')},
  '../../lib/local': {IS_TAURI_RUNTIME:true, readMemorySystemRules: () => {}, readMobileSystemRules:bridge.readMobileSystemRules},
  '../../lib/memoryAi': {},
  '../../lib/accountContext': {useAccountContext: () => ({accountId:7})},
  '../../components/Toast': {useToast: () => ({})},
});
const render = (origin, connected) => renderToStaticMarkup(React.createElement(section.SystemRulesSection, {origin, mobileConnected:connected}));
(async () => {
  queryData = {l0:'PC-ONLY-SKELETON', l1Active:'PC-ONLY-RULES', l1IsOverride:false};
  assert.match(render('pc', false), /编辑副本/);
  assert.equal(queries.at(-1).queryKey[1], 'pc');
  queryData = snapshot;
  let html = render('mobile', true);
  assert.match(html, /PHONE-ONLY-EXPERIENCE/);
  assert.doesNotMatch(html, /编辑副本|保存覆盖|恢复默认|PC-ONLY/);
  assert.equal(queries.at(-1).queryKey[1], 'mobile');
  assert.equal(queries.at(-1).queryKey[2], 7);
  html = render('mobile', false);
  assert.match(html, /手机未连接/);
  assert.doesNotMatch(html, /PHONE-ONLY|PC-ONLY|编辑副本/);
  queryError = new Error('手机版本不支持');
  html = render('mobile', true);
  assert.match(html, /手机版本不支持/);
  assert.doesNotMatch(html, /PHONE-ONLY|PC-ONLY|编辑副本/);
  bridgeResult = {systemRules:snapshot};
  assert.equal((await bridge.readMobileSystemRules(7)).version, 'fixture-v1');
  await assert.rejects(bridge.readMobileSystemRules(8), /当前账号/);
  bridgeResult = {};
  await assert.rejects(bridge.readMobileSystemRules(7), /手机未返回/);
  console.log('PASS: PC/mobile routing, no mobile PC editor/fallback, offline/error, account scope, missing payload');
})().catch(error => {console.error(error);process.exitCode=1;});
