import type { Item, Note, ReferenceAccount } from "./types";
import type { Inspiration } from "./inspirationCapture";

export type WorkspaceSearchKind = "note" | "item" | "inspiration" | "reference";

export interface WorkspaceSearchResult {
  id: string;
  kind: WorkspaceSearchKind;
  title: string;
  summary: string;
  href: string;
  badge?: string;
  updatedAt?: string;
}

export interface WorkspaceSearchInput {
  query: string;
  notes?: Note[];
  items?: Item[];
  inspirations?: Inspiration[];
  references?: ReferenceAccount[];
}

function normalize(value: unknown): string {
  return String(value ?? "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function excerpt(value: unknown, max = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function matches(haystack: string, tokens: string[]): boolean {
  return tokens.every((token) => haystack.includes(token));
}

/**
 * Search only the already scoped workspace snapshot. This deliberately stays
 * client-side in the first slice: no vector index, no cross-account fallback,
 * and no network request per result.
 */
export function searchWorkspace(input: WorkspaceSearchInput): WorkspaceSearchResult[] {
  const tokens = normalize(input.query).split(" ").filter(Boolean);
  if (!tokens.length) return [];
  const results: WorkspaceSearchResult[] = [];

  for (const note of input.notes ?? []) {
    const title = note.title?.trim() || "未命名笔记";
    const haystack = normalize([title, note.body, note.tags.join(" "), note.status, note.note_type].join(" "));
    if (!matches(haystack, tokens)) continue;
    results.push({
      id: `note:${note.id}`,
      kind: "note",
      title,
      summary: excerpt(note.body || note.tags.map((tag) => `#${tag}`).join(" ") || "暂无正文"),
      href: `/notes/${note.id}`,
      badge: note.status,
      updatedAt: note.updated_at || note.created_at,
    });
  }

  for (const item of input.items ?? []) {
    const title = item.title?.trim() || `素材 ${item.id}`;
    const haystack = normalize([title, item.tags.join(" "), item.style, item.material, item.scene, item.color, item.analysis_raw].join(" "));
    if (!matches(haystack, tokens)) continue;
    results.push({
      id: `item:${item.id}`,
      kind: "item",
      title,
      summary: excerpt(item.tags.length ? item.tags.map((tag) => `#${tag}`).join(" ") : item.analysis_raw || "暂无识别信息"),
      href: `/library?item=${item.id}`,
      badge: item.note_count ? `${item.note_count} 篇笔记` : "未使用",
      updatedAt: item.created_at,
    });
  }

  for (const inspiration of input.inspirations ?? []) {
    const haystack = normalize([inspiration.title, inspiration.sourceUrl, inspiration.body, inspiration.reason, inspiration.status].join(" "));
    if (!matches(haystack, tokens)) continue;
    results.push({
      id: `inspiration:${inspiration.id}`,
      kind: "inspiration",
      title: inspiration.title,
      summary: excerpt(inspiration.body || inspiration.reason || inspiration.sourceUrl || "暂无观察"),
      href: "/inspire",
      badge: inspiration.status === "converted" ? "已转草稿" : "书签",
      updatedAt: inspiration.observedAt,
    });
  }

  for (const reference of input.references ?? []) {
    const title = reference.name?.trim() || reference.account_id;
    const haystack = normalize([title, reference.account_id, reference.content_style, reference.insights, ...reference.top_notes.map((note) => note.title)].join(" "));
    if (!matches(haystack, tokens)) continue;
    results.push({
      id: `reference:${reference.id}`,
      kind: "reference",
      title,
      summary: excerpt(reference.insights || reference.content_style || `${reference.note_count} 篇参考笔记`),
      href: `/accounts?account=${reference.id}`,
      badge: "榜样",
      updatedAt: reference.analyzed_at || reference.crawled_at,
    });
  }

  return results
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, 50);
}
