// Exercises the real phone synchronization service without native SQLite/network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
let supportsSnapshot = true;
let failSnapshot = false;
let calls = [];
let writes = [];
let rows = Array.from({ length: 7 }, (_, index) => ({
  id: index + 1, remote_id: null, remote_server: '', title: `经验${index + 1}`,
  content: '手机内容', enabled: 1, apply_scope: 'account', apply_target: 'all', sort_order: index,
}));
const tombstone = { id: 81, server_url: 'http://192.168.1.2:18765', entity_type: 'prompt', remote_id: 81 };
const client = {
  health: async () => ({ accountId: 1, capabilities: supportsSnapshot ? ['mobilePromptSnapshot'] : [] }),
  replaceMobilePromptSnapshot: async body => {
    calls.push(['snapshot', body]);
    if (failSnapshot) throw new Error('snapshot rejected');
    return { mappings: body.prompts.map(p => ({ localId: p.localId, remoteId: 100 + p.localId })), deletedPrompts: 10 };
  },
  reconcileMobileMemoryCache: async body => {
    calls.push(['reconcile', body]);
    return { deletedEntries: 0, deletedPrompts: 0 };
  },
};
function load(name) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../services', name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(js, { exports, require(id) {
    if (id === './writingRules') return load('writingRules');
    if (id === './pcHarness') return {
      getPcHarnessConfig: async () => ({ baseUrl: tombstone.server_url, accountId: 1 }),
      createPcHarnessClientFromConfig: () => client,
    };
    if (id === './db') return {
      initDb: async () => {},
      sqlAll: sql => sql.includes('FROM experience_prompts') ? rows
        : sql.includes('FROM memory_sync_deletions') ? [tombstone] : [],
      sqlRun: (sql, params) => writes.push([sql, [...params]]),
    };
    throw new Error(id);
  } });
  return exports;
}
(async () => {
  const memory = load('memory');
  supportsSnapshot = false;
  await assert.rejects(memory.syncMemoryWithPc(), /更新并重启/);
  assert.equal(calls.length, 0);
  assert.equal(writes.length, 0);
  supportsSnapshot = true;
  failSnapshot = true;
  await assert.rejects(memory.syncMemoryWithPc(), /snapshot rejected/);
  assert.equal(writes.length, 0, 'failed snapshot must not delete prompt tombstone or write mappings');
  assert.equal(calls.length, 1);
  failSnapshot = false;
  calls = [];
  const result = await memory.syncMemoryWithPc();
  assert.equal(result.pushedPrompts, 7);
  assert.equal(result.deletedPrompts, 10);
  assert.equal(calls[0][0], 'snapshot');
  assert.equal(calls[0][1].accountId, 1);
  assert.equal(calls[0][1].prompts.length, 7);
  assert.equal(calls[1][0], 'reconcile');
  assert.equal(calls[1][1].promptIds.join(','), '101,102,103,104,105,106,107');
  assert.equal(writes.filter(([sql]) => sql.startsWith('UPDATE experience_prompts')).length, 7);
  assert.equal(writes.filter(([sql]) => sql.startsWith('DELETE FROM memory_sync_deletions')).length, 1);
  calls = [];
  rows = [];
  await memory.syncMemoryWithPc();
  assert.equal(calls[0][1].prompts.length, 0, 'empty phone snapshot must be sent');
  console.log('PASS: old-PC capability gate, failure preserves mappings/tombstones, retry queue, one full snapshot, empty snapshot');
})().catch(error => { console.error(error); process.exitCode = 1; });
