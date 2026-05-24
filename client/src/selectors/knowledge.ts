/**
 * knowledge selector — 从本地 notes 数据计算互动规律
 *
 * 替代 GET /api/knowledge/rules 中的"计算"部分（服务端 _compute_rules）。
 * 启用状态仍然存在后端 prompt_configs 表中，此处仅计算 desc / value。
 * 使用方式：把 selector 结果与后端返回的 enabled 状态合并展示。
 */

import type { Note, KnowledgeRule } from "../lib/types";

function publishedNotes(notes: Note[]): Note[] {
  return notes.filter((n) => n.status === "published");
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

// ── 规律计算函数 ──────────────────────────────────────────────────────────────

/** 规律1：最佳标题字数区间 */
function ruleTitleLength(pub: Note[]): { value: string; desc: string } | null {
  const withTitle = pub.filter((n) => n.title);
  if (withTitle.length < 3) return null;

  const BUCKETS = [
    { label: "1-5字", min: 1, max: 5 },
    { label: "6-10字", min: 6, max: 10 },
    { label: "11-15字", min: 11, max: 15 },
    { label: "16-20字", min: 16, max: 20 },
    { label: "21+字", min: 21, max: Infinity },
  ];

  let best = { label: "", avg_likes: -1, count: 0 };
  for (const b of BUCKETS) {
    const bucket = withTitle.filter((n) => {
      const len = (n.title ?? "").length;
      return len >= b.min && len <= b.max;
    });
    if (!bucket.length) continue;
    const al = avg(bucket.map((n) => n.likes));
    if (al > best.avg_likes) best = { label: b.label, avg_likes: al, count: bucket.length };
  }
  if (!best.label) return null;

  return {
    value: best.label,
    desc: `标题字数在 ${best.label} 时平均点赞最高（${best.avg_likes}赞，共 ${best.count} 篇）`,
  };
}

/** 规律2：最佳发布时段 */
function ruleBestHour(pub: Note[]): { value: string; desc: string } | null {
  const withTs = pub.filter((n) => n.published_at);
  if (withTs.length < 3) return null;

  const hourMap = new Map<number, number[]>();
  for (const n of withTs) {
    const d = new Date(n.published_at!);
    if (isNaN(d.getTime())) continue;
    const h = d.getHours();
    const cur = hourMap.get(h) ?? [];
    cur.push(n.likes);
    hourMap.set(h, cur);
  }

  let best = { hour: -1, avg_likes: -1, count: 0 };
  for (const [h, likes] of hourMap.entries()) {
    if (likes.length < 2) continue;
    const al = avg(likes);
    if (al > best.avg_likes) best = { hour: h, avg_likes: al, count: likes.length };
  }
  if (best.hour < 0) return null;

  const h = String(best.hour).padStart(2, "0");
  return {
    value: `${h}:00`,
    desc: `${h}:00 发布的笔记平均点赞最高（${best.avg_likes}赞，共 ${best.count} 篇）`,
  };
}

/** 规律3：高点赞笔记最常用标签 */
function ruleTopTag(pub: Note[]): { value: string; desc: string } | null {
  if (pub.length < 3) return null;

  const topLikesThreshold = avg(pub.map((n) => n.likes));
  const topNotes = pub.filter((n) => n.likes >= topLikesThreshold);

  const freq = new Map<string, number>();
  for (const n of topNotes) {
    for (const tag of n.tags ?? []) {
      const t = tag.trim().replace(/^#/, "");
      if (t) freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }

  if (!freq.size) return null;
  const [topTag, count] = [...freq.entries()].sort(([, a], [, b]) => b - a)[0];

  return {
    value: `#${topTag}`,
    desc: `高赞笔记最常用标签是 #${topTag}（出现 ${count} 次），优先使用此标签`,
  };
}

/** 规律4：收藏/点赞比高的笔记特征 */
function ruleCollectRatio(pub: Note[]): { value: string; desc: string } | null {
  const withLikes = pub.filter((n) => n.likes > 0);
  if (withLikes.length < 3) return null;

  const ratios = withLikes.map((n) => n.collects / n.likes);
  const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;

  // 高收藏比的笔记
  const highCollect = withLikes.filter((n) => n.collects / n.likes > avgRatio);
  if (!highCollect.length) return null;

  const pct = Math.round((highCollect.length / withLikes.length) * 100);
  const avgCollects = avg(highCollect.map((n) => n.collects));

  return {
    value: `${Math.round(avgRatio * 100)}%`,
    desc: `${pct}% 的已发布笔记收藏率高于均值，这类笔记平均收藏 ${avgCollects}，值得总结选题规律`,
  };
}

// ── 导出函数 ──────────────────────────────────────────────────────────────────

/**
 * 从本地 notes 重新计算规律的 value + desc。
 * 返回格式与后端 KnowledgeRule[] 兼容，key/label/enabled 与后端数据合并使用。
 */
export function computeRulesFromNotes(
  notes: Note[]
): Pick<KnowledgeRule, "key" | "value" | "desc">[] {
  const pub = publishedNotes(notes);
  const results: Pick<KnowledgeRule, "key" | "value" | "desc">[] = [];

  const titleRule = ruleTitleLength(pub);
  if (titleRule) {
    results.push({ key: "title_length", ...titleRule });
  }

  const hourRule = ruleBestHour(pub);
  if (hourRule) {
    results.push({ key: "best_hour", ...hourRule });
  }

  const tagRule = ruleTopTag(pub);
  if (tagRule) {
    results.push({ key: "top_tag", ...tagRule });
  }

  const collectRule = ruleCollectRatio(pub);
  if (collectRule) {
    results.push({ key: "collect_ratio", ...collectRule });
  }

  return results;
}

/**
 * 将本地计算的规律与后端返回的 enabled 状态合并。
 * 后端 rules 作为基准（含 label / enabled），本地结果覆盖 value / desc。
 */
export function mergeRules(
  backendRules: KnowledgeRule[],
  localRules: Pick<KnowledgeRule, "key" | "value" | "desc">[]
): KnowledgeRule[] {
  const localMap = new Map(localRules.map((r) => [r.key, r]));
  return backendRules.map((r) => {
    const local = localMap.get(r.key);
    if (!local) return r;
    return { ...r, value: local.value, desc: local.desc };
  });
}
