// Pure helpers for one-time expanded-preview state kept only in chrome.storage.session.
(() => {
  const PREFIX = "aichi-capture-preview:";
  const MAX_AGE_MS = 5 * 60 * 1000;

  function storageKey(previewTabId) {
    const id = Number(previewTabId);
    return Number.isInteger(id) && id > 0 ? `${PREFIX}${id}` : "";
  }

  function validate(record, expected = {}) {
    if (!record || typeof record !== "object") return { ok: false, reason: "展开预览临时会话不存在，返回插件重新解析。" };
    if (Number(record.previewTabId) !== Number(expected.previewTabId)) return { ok: false, reason: "展开页身份与临时会话不匹配。" };
    if (!Number.isInteger(Number(record.sourceTabId)) || typeof record.parseBatchId !== "string" || !record.parseBatchId) return { ok: false, reason: "采集来源或解析批次身份无效。" };
    if (typeof record.sourceUrl !== "string" || !record.sourceUrl || record.parsed?.sourceUrl !== record.sourceUrl) return { ok: false, reason: "采集来源链接与解析批次不匹配。" };
    if (expected.sourceTabId != null && Number(record.sourceTabId) !== Number(expected.sourceTabId)) return { ok: false, reason: "来源标签页已变化；请回到原页面重新解析。" };
    if (expected.sourceUrl != null && record.sourceUrl !== expected.sourceUrl) return { ok: false, reason: "来源页面已导航；请重新解析后展开预览。" };
    const age = Number(expected.now ?? Date.now()) - Number(record.createdAt || 0);
    if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return { ok: false, reason: "展开预览临时会话已过期；请重新打开预览。" };
    if (!record.parsed || typeof record.parsed !== "object" || !record.modules || typeof record.modules !== "object") return { ok: false, reason: "展开预览数据不完整；请重新解析页面。" };
    return { ok: true, record };
  }

  globalThis.AichiPreviewSession = Object.freeze({ storageKey, validate, maxAgeMs: MAX_AGE_MS });
})();
