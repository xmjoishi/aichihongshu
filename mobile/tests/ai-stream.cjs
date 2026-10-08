// Isolated transport contract: no native runtime, credentials, or provider network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
let provider = 'minimax';
let response;
let request;
let requests = 0;
function load(name) {
  const filename = path.join(__dirname, '../services', name + '.ts');
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, { exports, TextDecoder, require(id) {
    if (id === 'expo-secure-store') return { getItemAsync: async key => key === 'ai_config' ? JSON.stringify({providerId: provider, modelId: 'test'}) : 'fixture-key' };
    if (id === 'expo/fetch') return { fetch: async (_url, init) => { requests++; request = JSON.parse(init.body); return response; } };
    if (id === './media') return { sniffImageMimeFromBase64: () => 'image/jpeg' };
    if (id === './writingRules') return load('writingRules');
    throw new Error(id);
  }});
  return exports;
}
function stream(text) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    // Split every UTF-8 codepoint and SSE frame across chunks.
    for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
    controller.close();
  }}), { headers: { 'content-type': 'text/event-stream' } });
}
(async () => {
  const ai = load('ai');
  const rules = load('writingRules');
  const prompt = ai.buildSystemPrompt({ taboos: '不夸大' }, []);
  assert.ok(prompt.includes(rules.DEFAULT_WRITING_EXPERIENCE));
  assert.ok(prompt.includes('用户经验优先于默认写作风格'));
  assert.equal(rules.countPromptCharacters('😀'.repeat(5000)), 5000);
  for (provider of ['minimax', 'openai']) {
    response = stream(provider === 'minimax'
      ? 'data: {"delta":{"text":"你"}}\r\n\r\ndata: {"delta":{"text":"好😀"}}\n\ndata: {"type":"message_stop"}'
      : 'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好😀"}}]}\n\ndata: [DONE]');
    const deltas = [];
    assert.equal(await ai.chatStream([{role:'user',content:'写笔记'}], prompt, d => deltas.push(d)), '你好😀');
    assert.deepEqual(deltas, ['你','好😀']);
    assert.equal(provider === 'minimax' ? request.system : request.messages[0].content, prompt);
  }
  response = stream('data: {"error":{"message":"provider failed"}}\n');
  await assert.rejects(ai.chatStream([], prompt, () => {}), /provider failed/);
  response = new Response(JSON.stringify({choices:[{message:{content:'完整内容'}}]}), {headers:{'content-type':'application/json'}});
  const before = requests;
  assert.equal(await ai.chatStream([], prompt, () => {}), '完整内容');
  assert.equal(requests - before, 1);
  response = stream('data: {"choices":[{"delta":{"content":"半篇"}}]}\n');
  await assert.rejects(ai.chatStream([], prompt, () => {}), /连接中断/);
  response = stream('data: {"choices":[{"delta":{"content":"半篇"},"finish_reason":"length"}]}\n\ndata: [DONE]');
  await assert.rejects(ai.chatStream([], prompt, () => {}), /未完整结束/);
  response = stream('data: [DONE]');
  await assert.rejects(ai.chatStream([], prompt, () => {}), /未返回正文/);
  provider = 'minimax';
  response = stream('data: {"delta":{"text":"半篇"}}\ndata: {"delta":{"stop_reason":"max_tokens"}}');
  await assert.rejects(ai.chatStream([], prompt, () => {}), /未完整结束/);
  response = new Response(JSON.stringify({content:[{type:'text',text:'半篇'}],stop_reason:'max_tokens'}), {headers:{'content-type':'application/json'}});
  await assert.rejects(ai.chatStream([], prompt, () => {}), /未完整结束/);
  const controller = new AbortController();
  controller.abort();
  const beforeAbort = requests;
  await assert.rejects(ai.chatStream([], prompt, () => {}, {signal:controller.signal}), /取消/);
  assert.equal(requests,beforeAbort);
  let activeStream;
  response = new Response(new ReadableStream({ start(streamController) {
    activeStream = streamController;
    streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"片段"}}]}\n'));
  }}), { headers: { 'content-type': 'text/event-stream' } });
  const activeController = new AbortController();
  const activeRequest = ai.chatStream([], prompt, () => {}, {signal:activeController.signal});
  await new Promise(resolve => setImmediate(resolve));
  activeController.abort();
  activeStream.error(new Error('request aborted'));
  await assert.rejects(activeRequest, /request aborted/);
  console.log('PASS: incomplete EOF, token limit, empty stream, JSON truncation, pre-abort and in-flight cancellation; rule injection, Unicode counting, both provider streams, UTF-8 chunks, final line, error event, JSON single request');
})().catch(error => { console.error(error); process.exitCode = 1; });
