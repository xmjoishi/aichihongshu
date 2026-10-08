const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, mocks = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => id in mocks ? mocks[id] : id.startsWith('.') ? load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(filename), id + '.ts')), mocks) : require(id);
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  return module.exports;
}
const { buildPublishText, withShareTitle } = load('utils/publishText.ts');
const text = buildPublishText('🏠 **我的出租房**', '🏠 我的出租房\n\n普通厨房\n#租房', ['租房', '#厨房', '厨房', '']);
assert.equal(text.title, '🏠 我的出租房');
assert.equal(text.fullText, '🏠 我的出租房\n\n普通厨房\n#租房\n\n#厨房');
assert.equal(withShareTitle(text.title, text.fullText), text.fullText);
assert.equal(buildPublishText('', '正文', []).fullText, '正文');
assert.equal(buildPublishText('标题', '', []).fullText, '标题');
assert.equal(buildPublishText('标题', '标题以外的开头', []).fullText, '标题\n\n标题以外的开头');
(async () => {
  for (const native of [true, false]) {
    let payload;
    let dismissed = false;
    const share = load('services/share.ts', {
      'react-native': { TurboModuleRegistry: { get: () => native }, NativeModules: {}, Share: { dismissedAction: 'dismissedAction', share: async (value) => { payload = value; return { action: dismissed ? 'dismissedAction' : 'sharedAction' }; } } },
      'react-native-share': { open: async (value) => { payload = value; return { success: !dismissed }; } },
      './media': { resolveLocalUri: async (uri) => uri, exportToAlbum: async () => {} },
    });
    assert.equal(await share.shareImagesWithText(['file:///test.png'], { title: text.title, message: text.fullText }), 'shared');
    assert.equal(payload.message, text.fullText);
    assert.equal(payload.title, text.title);
    dismissed = true;
    assert.equal(await share.shareImagesWithText(['file:///test.png'], { title: '标题', message: '正文' }), 'dismissed');
    assert.equal(payload.message, '标题\n\n正文');
  }

  // Multi-image failure must never silently send only the cover; failed album
  // export must not open the fallback share UI or claim the images were saved.
  for (const native of [true, false]) {
    let fallbackCalls = 0;
    const share = load('services/share.ts', {
      'react-native': {
        TurboModuleRegistry: { get: () => native }, NativeModules: {},
        Share: { share: async () => { fallbackCalls++; return { action: 'sharedAction' }; } },
      },
      'react-native-share': { open: async () => { throw new Error('native share unavailable'); } },
      './media': {
        resolveLocalUri: async (uri) => uri,
        exportToAlbum: async () => { throw new Error('album export denied'); },
      },
    });
    await assert.rejects(
      share.shareImagesWithText(['file:///cover.png', 'file:///second.png'], { message: '完整文案', albumName: '测试相册' }),
      native ? /native share unavailable/ : /album export denied/,
    );
    assert.equal(fallbackCalls, 0);
  }

  const stored = new Map();
  const progressService = load('services/publishProgress.ts', {
    'expo-secure-store': {
      getItemAsync: async (key) => stored.get(key) ?? null,
      setItemAsync: async (key, value) => { stored.set(key, value); },
      deleteItemAsync: async (key) => { stored.delete(key); },
    },
  });
  const shareReturned = await progressService.setPublishProgress(42, {
    copiedFull: true,
    shareAttemptAt: '2026-10-04T00:00:00.000Z',
    lastShareResult: 'shared',
  });
  assert.equal(progressService.getPublishProgressStage(shareReturned), 'copied');
  assert.equal((await progressService.getPublishProgress(42)).lastShareResult, 'shared');
  const cancelled = await progressService.setPublishProgress(43, { lastShareResult: 'dismissed' });
  assert.equal(progressService.getPublishProgressStage(cancelled), 'none');
  const preparing = await progressService.setPublishProgress(44, { lastShareResult: 'preparing' });
  assert.equal(progressService.getPublishProgressStage(preparing), 'none');

  const publishSource = fs.readFileSync(path.resolve(__dirname, '..', 'app/(tabs)/create/publish.tsx'), 'utf8');
  const orderBlock = publishSource.match(/const itemById = new Map\(items\.map\(\(item\) => \[item\.id, item\]\)\);[\s\S]+?const linkedItems = linkedItemIds\.flatMap\([\s\S]+?\n  \}\);/);
  assert.ok(orderBlock, 'publish preview resolves image references in note.itemIds order');
  const orderedItemsJs = ts.transpileModule(orderBlock[0], { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const resolveOrderedItems = new Function('items', 'linkedItemIds', `${orderedItemsJs}; return linkedItems;`);
  const orderedItems = resolveOrderedItems([{ id: 1 }, { id: 2 }, { id: 3 }], [3, 1, 99]);
  assert.deepEqual(orderedItems.map((item) => item.id), [3, 1]);
  assert.match(publishSource, /linkedItems\.map\(\(i\) => i\.imagePath\)/);
  const shareFlow = publishSource.slice(publishSource.indexOf('async function handleShare()'), publishSource.indexOf('async function handleMarkDone()'));
  assert.match(shareFlow, /lastShareResult:\s*outcome/);
  assert.doesNotMatch(shareFlow, /status:\s*['"]published['"]/);
  assert.match(publishSource, /我已在小红书完成发布/);
  const doneFlow = publishSource.slice(publishSource.indexOf('async function handleMarkDone()'), publishSource.indexOf('\n  return (', publishSource.indexOf('async function handleMarkDone()')));
  assert.match(doneFlow, /updateNote\(noteId, \{ status: 'published' \}\)/);
  assert.doesNotMatch(doneFlow, /Alert\.alert\(\s*['"]确认/);

  console.log('PASS publish text, ordered image references, share outcomes, and publication confirmation boundary');
})().catch((error) => { console.error(error); process.exitCode = 1; });
