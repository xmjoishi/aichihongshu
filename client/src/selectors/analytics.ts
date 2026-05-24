/**
 * analytics selector — 从基础实体本地计算，替代后端 analytics/* 聚合接口
 *
 * 替代目标：
 *   GET /api/analytics/summary      → buildSummaryVM
 *   GET /api/analytics/notes-trend  → buildTrendVM
 *   GET /api/analytics/insights     → buildInsightsVM
 *   GET /api/analytics/notes        → buildRankingVM（含 engagement_rate）
 */

import type {
  Note, Item, Profile, ReferenceAccount,
  Analytics, AnalyticsNote, Insights,
  TitleLengthBucket, HourDist, TagFreq,
} from "../lib/types";

// ── 工具 ──────────────────────────────────────────────────────────────────────

/** 从 published_at 字符串取 YYYY-MM-DD */
function toDateStr(ts: string | undefined): string {
  if (!ts) return "";
  // 支持 ISO 字符串和时间戳两种格式
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function publishedNotes(notes: Note[]): Note[] {
  return notes.filter((n) => n.status === "published");
}

// ── buildSummaryVM ────────────────────────────────────────────────────────────

export interface SummaryInput {
  notes: Note[];
  items: Item[];
  profile?: Profile | null;
  accounts: ReferenceAccount[];
}

/**
 * 替代 GET /api/analytics/summary
 * 输出格式与旧接口 Analytics 保持兼容，减少页面改动。
 */
export function buildSummaryVM(input: SummaryInput): Analytics {
  const { notes, items, profile, accounts } = input;

  const pub = publishedNotes(notes);
  const byStatus: Record<string, number> = {};
  for (const n of notes) {
    byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
  }

  const publishedAvg = {
    likes: avg(pub.map((n) => n.likes)),
    comments: avg(pub.map((n) => n.comments)),
    collects: avg(pub.map((n) => n.collects)),
  };

  // top_notes：按点赞降序取前 10
  const topNotes = [...pub]
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 10)
    .map((n) => {
      // item_title：优先用 item_ids[0] 对应的 item.title
      const item = items.find((i) => i.id === (n.item_ids?.[0] ?? n.item_id));
      return {
        id: n.id,
        title: n.title ?? "无标题",
        likes: n.likes,
        item_title: item?.title ?? "",
        note_url: n.note_url,
      };
    });

  // 今天 vs 最近一篇 published_at 相差天数
  const pubDates = pub
    .map((n) => toDateStr(n.published_at))
    .filter(Boolean)
    .sort()
    .reverse();
  let daysSincePublish: number | null = null;
  if (pubDates.length) {
    const last = new Date(pubDates[0]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    daysSincePublish = Math.floor(
      (today.getTime() - last.getTime()) / (1000 * 60 * 60 * 24)
    );
  }

  // items_without_notes：有效 item 但没有关联笔记
  const notedItemIds = new Set(notes.flatMap((n) => n.item_ids ?? (n.item_id ? [n.item_id] : [])));
  const activeItems = items.filter((i) => !i.deleted_at);
  const itemsWithoutNotes = activeItems.filter((i) => !notedItemIds.has(i.id)).length;

  const draftCount = byStatus["draft"] ?? 0;

  return {
    library: { total_items: activeItems.length },
    notes: {
      total: notes.length,
      by_status: byStatus,
      published_avg: publishedAvg,
    },
    accounts: { total: accounts.length },
    my_profile: profile ?? {},
    top_notes: topNotes,
    suggestions: {
      items_without_notes: itemsWithoutNotes,
      days_since_publish: daysSincePublish,
      draft_count: draftCount,
    },
  };
}

// ── buildTrendVM ──────────────────────────────────────────────────────────────

export interface TrendItem {
  day: string;
  count: number;
  total_likes: number;
}

export interface TrendVM {
  granularity: "day" | "week";
  items: TrendItem[];
}

/**
 * 替代 GET /api/analytics/notes-trend
 * 取近 90 天已发布笔记，按天或周聚合。
 * 数据点 > 14 时自动按周聚合（与后端保持一致）。
 */
export function buildTrendVM(
  notes: Note[],
  opts: { granularity?: "auto" | "day" | "week"; lookbackDays?: number } = {}
): TrendVM {
  const { granularity = "auto", lookbackDays = 90 } = opts;

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  const pub = publishedNotes(notes).filter((n) => {
    const d = toDateStr(n.published_at);
    return d && d >= cutoff.toISOString().slice(0, 10);
  });

  // 按天聚合
  const dayMap = new Map<string, { count: number; total_likes: number }>();
  for (const n of pub) {
    const d = toDateStr(n.published_at);
    if (!d) continue;
    const cur = dayMap.get(d) ?? { count: 0, total_likes: 0 };
    dayMap.set(d, { count: cur.count + 1, total_likes: cur.total_likes + n.likes });
  }

  const dayItems: TrendItem[] = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day, ...v }));

  const useWeek =
    granularity === "week" ||
    (granularity === "auto" && dayItems.length > 14);

  if (!useWeek) return { granularity: "day", items: dayItems };

  // 按 ISO 周聚合 (YYYY-WXX)
  function toISOWeek(dateStr: string): string {
    const d = new Date(dateStr);
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const startOfWeek1 = new Date(jan4);
    startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
    const diff = d.getTime() - startOfWeek1.getTime();
    const weekNum = Math.floor(diff / (7 * 86400000)) + 1;
    const year = d.getFullYear();
    return `${year}-W${String(weekNum).padStart(2, "0")}`;
  }

  const weekMap = new Map<string, { count: number; total_likes: number; day: string }>();
  for (const item of dayItems) {
    const wk = toISOWeek(item.day);
    const cur = weekMap.get(wk) ?? { count: 0, total_likes: 0, day: item.day };
    weekMap.set(wk, {
      count: cur.count + item.count,
      total_likes: cur.total_likes + item.total_likes,
      day: cur.day <= item.day ? cur.day : item.day, // 取该周最早日期做 x 轴 label
    });
  }

  const weekItems: TrendItem[] = [...weekMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => ({ day: v.day, count: v.count, total_likes: v.total_likes }));

  return { granularity: "week", items: weekItems };
}

// ── buildInsightsVM ───────────────────────────────────────────────────────────

const TITLE_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "1-5", min: 1, max: 5 },
  { label: "6-10", min: 6, max: 10 },
  { label: "11-15", min: 11, max: 15 },
  { label: "16-20", min: 16, max: 20 },
  { label: "21+", min: 21, max: Infinity },
];

/**
 * 替代 GET /api/analytics/insights
 * 标题字数分布、发布时段、标签词频、与榜样账号对比。
 */
export function buildInsightsVM(input: {
  notes: Note[];
  accounts: ReferenceAccount[];
}): Insights {
  const { notes, accounts } = input;
  const pub = publishedNotes(notes).filter((n) => n.title);

  // ── 标题字数分桶 ──
  const titleLengthDist: TitleLengthBucket[] = TITLE_BUCKETS.map(({ label, min, max }) => {
    const bucket = pub.filter((n) => {
      const len = (n.title ?? "").length;
      return len >= min && len <= max;
    });
    return {
      range: label,
      count: bucket.length,
      avg_likes: avg(bucket.map((n) => n.likes)),
    };
  });

  // ── 发布时段 ──
  const hourMap = new Map<number, number[]>();
  for (const n of publishedNotes(notes)) {
    if (!n.published_at) continue;
    const d = new Date(n.published_at);
    if (isNaN(d.getTime())) continue;
    const h = d.getHours();
    const cur = hourMap.get(h) ?? [];
    cur.push(n.likes);
    hourMap.set(h, cur);
  }
  const hourDist: HourDist[] = [...hourMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, likes]) => ({ hour, count: likes.length, avg_likes: avg(likes) }));

  // ── 标签词频 top20 ──
  const tagMap = new Map<string, { count: number; likes: number[] }>();
  for (const n of publishedNotes(notes)) {
    for (const tag of n.tags ?? []) {
      const t = tag.trim().replace(/^#/, "");
      if (!t) continue;
      const cur = tagMap.get(t) ?? { count: 0, likes: [] };
      tagMap.set(t, { count: cur.count + 1, likes: [...cur.likes, n.likes] });
    }
  }
  const tagFreq: TagFreq[] = [...tagMap.entries()]
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 20)
    .map(([tag, { count, likes }]) => ({ tag, count, avg_likes: avg(likes) }));

  // ── 与榜样账号均值对比 ──
  const pubAvg = {
    avg_likes: avg(publishedNotes(notes).map((n) => n.likes)),
    avg_comments: avg(publishedNotes(notes).map((n) => n.comments)),
    avg_collects: avg(publishedNotes(notes).map((n) => n.collects)),
  };

  const refAvg = accounts.length
    ? {
        avg_likes: avg(accounts.map((a) => a.avg_likes)),
        avg_comments: avg(accounts.map((a) => a.avg_comments)),
        avg_collects: avg(accounts.map((a) => a.avg_collects)),
      }
    : { avg_likes: 0, avg_comments: 0, avg_collects: 0 };

  return {
    title_length_dist: titleLengthDist,
    hour_dist: hourDist,
    tag_freq: tagFreq,
    comparison: { mine: pubAvg, reference: refAvg },
  };
}

// ── buildRankingVM ────────────────────────────────────────────────────────────

/**
 * 替代 GET /api/analytics/notes?sort=...
 * 返回已发布笔记列表，含 engagement_rate，按指定字段降序。
 */
export function buildRankingVM(
  notes: Note[],
  sort: "likes" | "collects" | "comments" = "likes"
): AnalyticsNote[] {
  return [...publishedNotes(notes)]
    .sort((a, b) => b[sort] - a[sort])
    .map((n) => {
      const rate =
        n.likes > 0
          ? Math.round(((n.collects + n.comments) / n.likes) * 10) / 10
          : 0;
      return {
        id: n.id,
        title: n.title,
        likes: n.likes,
        comments: n.comments,
        collects: n.collects,
        published_at: n.published_at,
        note_url: n.note_url,
        cover_desc: n.cover_desc,
        cover_image: undefined, // 原接口也是可选字段
        engagement_rate: rate,
      };
    });
}
