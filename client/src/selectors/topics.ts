/**
 * topics selector — 替代 GET /api/analytics/topics
 *
 * 从已发布笔记的标签 + 标题分词提取热词候选。
 * 与后端口径保持一致：中文 2 字以上词，去停用词，按频次降序。
 */

import type { Note } from "../lib/types";

// 简单中文停用词（与后端 analytics.py 保持一致）
const STOP_WORDS = new Set([
  "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "那", "来", "他", "她", "它",
]);

export interface TopicItem {
  word: string;
  count: number;
}

/**
 * 替代 GET /api/analytics/topics
 * 从 tags 取词 + 从标题做简单分词取词，合并计频。
 */
export function buildTopicsVM(notes: Note[], limit = 30): { topics: TopicItem[] } {
  const published = notes.filter((n) => n.status === "published");
  const freq = new Map<string, number>();

  function addWord(w: string) {
    const t = w.trim().replace(/^#/, "");
    if (t.length < 2) return;
    if (STOP_WORDS.has(t)) return;
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  for (const n of published) {
    // tags 直接加
    for (const tag of n.tags ?? []) {
      addWord(tag);
    }

    // 标题做简单分词：按常见标点/空格切分，取 2 字以上中文片段
    if (n.title) {
      const parts = n.title.split(/[\s，。！？、：；「」【】「」\(\)\[\]《》~\-_/|\\]+/);
      for (const p of parts) {
        // 尝试滑窗提取 2-4 字中文词
        const chinese = p.match(/[\u4e00-\u9fa5]{2,4}/g) ?? [];
        for (const w of chinese) addWord(w);
      }
    }
  }

  const topics: TopicItem[] = [...freq.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));

  return { topics };
}
