const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const secureStoreReads = [];
let aiConfig = {
  providerId: 'custom',
  modelId: 'custom-model',
  customBaseUrl: 'https://user:password@private.example/private/path?api_key=fixture-secret#fragment',
};
const modules = new Map();

function load(relativePath) {
  if (modules.has(relativePath)) return modules.get(relativePath);
  const filename = path.join(__dirname, '../services', `${relativePath}.ts`);
  const exports = {};
  modules.set(relativePath, exports);
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(js, {
    exports,
    URL,
    require(id) {
      if (id === 'expo-secure-store') {
        return {
          getItemAsync: async (key) => {
            secureStoreReads.push(key);
            return key === 'ai_config' ? JSON.stringify(aiConfig) : null;
          },
        };
      }
      if (id === 'expo/fetch') return { fetch: async () => { throw new Error('network should not be used'); } };
      if (id === './media') return { sniffImageMimeFromBase64: () => 'image/jpeg' };
      if (id === './ai') return load('ai');
      if (id === './memory') return { buildMobileMemoryPrompt: async () => '【启用经验】保留真实细节' };
      if (id === './writingRules') return load('writingRules');
      throw new Error(`Unexpected import ${id}`);
    },
  });
  return exports;
}

(async () => {
  const ai = load('ai');
  const compose = load('composePrompt');
  const profile = { personaName: '虾薯', niche: '家居', personaTone: '自然', taboos: '["不夸大"]' };
  const analyses = ['图片里能看见木色鞋柜'];
  const snapshot = await compose.buildComposePromptSnapshot({
    profile,
    analyses,
    theme: '出租屋玄关收纳',
    taskPrompt: '写一篇笔记',
    hasImages: false,
  });
  const expectedSystem = `${ai.buildSystemPrompt(profile, analyses)}\n\n【启用经验】保留真实细节`;
  assert.equal(snapshot.clientLabel, '手机端');
  assert.equal(snapshot.providerLabel, '自定义（OpenAI 兼容）');
  assert.equal(snapshot.endpointLabel, 'https://private.example');
  assert.equal(snapshot.personaPrompt, ai.buildSystemPrompt(profile, analyses).split('\n\n【默认写作经验】')[0]);
  assert.equal(snapshot.experiencePrompt, '【启用经验】保留真实细节');
  assert.equal(snapshot.systemPrompt, expectedSystem);
  assert.equal(snapshot.userPrompt, '本篇主题与用户要求（所有重新生成都须保持）：\n出租屋玄关收纳\n\n写一篇笔记');
  assert.equal(snapshot.combinedPrompt, `【系统提示词】\n${expectedSystem}\n\n【用户提示词】\n${snapshot.userPrompt}`);
  assert.doesNotMatch(JSON.stringify(snapshot), /password|private\/path|fixture-secret|fragment/);
  assert.deepEqual(secureStoreReads, ['ai_config']);

  aiConfig = { providerId: 'openai', modelId: 'gpt-4o-mini' };
  const imageSnapshot = await compose.buildComposePromptSnapshot({
    profile,
    taskPrompt: '写标题',
    hasImages: true,
  });
  assert.equal(imageSnapshot.modelId, 'gpt-4o-mini');
  assert.deepEqual(secureStoreReads, ['ai_config', 'ai_config']);
  console.log('PASS: shared prompt assembly, current theme/experience/persona, vision model route, endpoint sanitization, no API-key lookup');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
