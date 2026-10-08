const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(relative, overrides = {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(js, {
    exports,
    Date,
    require(id) {
      if (id in overrides) return overrides[id];
      return require(id);
    },
  });
  return exports;
}

const review = load('../src/pages/memory/experiencePromptReview.ts');
const fixtures = [
  { id: 1, title: '用 Emoji', content: '请适当使用 emoji。', enabled: true, applyScope: 'account', applyTarget: 'all', accountPoolId: 7 },
  { id: 2, title: '不使用 Emoji', content: '不要使用 emoji。', enabled: true, applyScope: 'account', applyTarget: 'compose', accountPoolId: 7 },
  { id: 3, title: '自然口吻', content: '语气自然，像朋友聊天。', enabled: true, applyScope: 'account', applyTarget: 'all', accountPoolId: 7 },
  { id: 4, title: '正式口吻', content: '语气正式严谨。', enabled: true, applyScope: 'account', applyTarget: 'all', accountPoolId: 7 },
  { id: 5, title: '分段偏好', content: '段落之间空一行，分段清晰。', enabled: true, applyScope: 'account', applyTarget: 'all', accountPoolId: 7 },
  { id: 6, title: '一段到底', content: '不要分段，一段到底。', enabled: true, applyScope: 'account', applyTarget: 'all', accountPoolId: 7 },
  { id: 7, title: '重复甲', content: '正文使用短句\n每段留空行', enabled: false, applyScope: 'account', applyTarget: 'all', accountPoolId: 7 },
  { id: 8, title: '重复乙', content: ' 正文使用短句   每段留空行 ', enabled: true, applyScope: 'global', applyTarget: 'all', accountPoolId: 7 },
  { id: 9, title: '小标题', content: '每节加上小标题', enabled: true, applyScope: 'account', applyTarget: 'compose', accountPoolId: 7 },
  { id: 10, title: '不要小标题', content: '不要添加小标题', enabled: true, applyScope: 'account', applyTarget: 'compose', accountPoolId: 7 },
  { id: 11, title: '分点列表', content: '用项目符号分点列出', enabled: true, applyScope: 'account', applyTarget: 'compose', accountPoolId: 7 },
  { id: 12, title: '不用列表', content: '不要使用列表，只写自然段', enabled: true, applyScope: 'account', applyTarget: 'compose', accountPoolId: 7 },
];

const findings = review.reviewExperiencePrompts(fixtures);
assert.equal(findings.filter((finding) => finding.kind === 'duplicate').length, 1);
assert(findings.some((finding) => finding.kind === 'conflict' && finding.label === 'Emoji 使用偏好'));
assert(findings.some((finding) => finding.kind === 'conflict' && finding.label === '分段偏好'));
assert(findings.some((finding) => finding.kind === 'conflict' && finding.label === '小标题偏好'));
assert(findings.some((finding) => finding.kind === 'conflict' && finding.label === '列表偏好'));
assert(!findings.some((finding) => finding.kind === 'conflict' && finding.evidence.some(({ promptId }) => promptId === 3 || promptId === 4)));
assert.equal(findings.find((finding) => finding.kind === 'conflict' && finding.label === 'Emoji 使用偏好').evidence[0].excerpt, '适当使用 emoji');

const noConflictForDisabledOrDifferentScene = review.reviewExperiencePrompts([
  { id: 11, title: '启用要求', content: '使用项目符号分点列出', enabled: true, applyTarget: 'compose' },
  { id: 12, title: '停用要求', content: '不要使用列表', enabled: false, applyTarget: 'compose' },
  { id: 13, title: '对话要求', content: '不要使用列表', enabled: true, applyTarget: 'chat' },
]);
assert(!noConflictForDisabledOrDifferentScene.some((finding) => finding.kind === 'conflict'));

const apply = load('../src/pages/memory/MemorySections.tsx', {
  '../../lib/workspaceActivity': { useWorkspaceQuery: () => ({ data: fixtures, isPending: false, isError: false }) },
  '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries() {} }) },
  'react-router-dom': { Link: 'a' },
  'lucide-react': Object.fromEntries(['Trash2', 'Sparkles', 'RotateCcw', 'Pencil', 'ToggleLeft', 'ToggleRight', 'BookOpen'].map((name) => [name, () => null])),
  '../../components/ui': {
    Dialog: () => null,
    Empty: ({ message }) => React.createElement('p', null, message),
    Spinner: () => React.createElement('p', null, 'loading'),
    primaryButtonClass: 'primary',
    secondaryButtonClass: 'secondary',
  },
  '../../lib/local': { IS_TAURI_RUNTIME: true },
  '../../lib/memoryAi': {},
  '../../lib/accountContext': { useAccountContext: () => ({ accountId: 7 }) },
  '../../components/Toast': { useToast: () => ({ toast() {} }) },
  './experiencePromptReview': review,
});
const render = (origin) => renderToStaticMarkup(React.createElement(apply.ExperiencePromptsSection, {
  origin,
  canWrite: false,
  onSeed() {},
  seeding: false,
  onEdit() {},
}));
const pcHtml = render('pc');
assert.match(pcHtml, /重复与冲突检查/);
assert.match(pcHtml, /明确偏好冲突/);
assert.match(pcHtml, /不会修改任何内容/);
assert.doesNotMatch(render('mobile'), /重复与冲突检查/);

console.log('PASS: exact normalized duplicates, explicit preference conflicts, conservative scope handling, read-only PC-only review UI');
