export type InspirationStatus = "saved" | "converted";

export interface Inspiration {
  id: string;
  accountId: number;
  title: string;
  sourceUrl: string;
  body: string;
  observedAt: string;
  reason: string;
  status: InspirationStatus;
  noteId?: number;
  /** 由浏览器剪藏宿主生成，防止同一账号重复写入同一来源。 */
  dedupeKey?: string;
}

function storageKey(databaseIdentity: string, accountId: number): string {
  return `inspirations-v1-${encodeURIComponent(databaseIdentity)}-account-${accountId}`;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

export function listInspirations(databaseIdentity: string, accountId: number): Inspiration[] {
  try {
    const raw = storage()?.getItem(storageKey(databaseIdentity, accountId));
    const value = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((item): item is Inspiration => item?.accountId === accountId && typeof item?.title === "string") : [];
  } catch { return []; }
}

export function addInspiration(input: Omit<Inspiration, "id" | "observedAt" | "status">): Inspiration {
  const title = input.title.trim();
  if (!title) throw new Error("灵感标题不能为空");
  const sourceUrl = input.sourceUrl.trim();
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) throw new Error("来源链接必须以 http:// 或 https:// 开头");
  const item: Inspiration = {
    ...input,
    title,
    sourceUrl,
    id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `inspiration-${Date.now()}`,
    observedAt: new Date().toISOString(),
    status: "saved",
  };
  return { ...item, body: input.body.trim(), reason: input.reason.trim() };
}

export function saveInspiration(databaseIdentity: string, item: Inspiration): void {
  const current = listInspirations(databaseIdentity, item.accountId).filter((entry) => entry.id !== item.id && (!item.dedupeKey || entry.dedupeKey !== item.dedupeKey));
  storage()?.setItem(storageKey(databaseIdentity, item.accountId), JSON.stringify([item, ...current].slice(0, 100)));
}

export function markInspirationConverted(databaseIdentity: string, accountId: number, id: string, noteId: number): Inspiration | null {
  const current = listInspirations(databaseIdentity, accountId);
  const found = current.find((entry) => entry.id === id);
  if (!found) return null;
  const updated = { ...found, status: "converted" as const, noteId };
  saveInspiration(databaseIdentity, updated);
  return updated;
}
