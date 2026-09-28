import { create } from 'zustand';
import { db } from '../services/db';
import { items, notes, profile } from '../drizzle/schema';
import { eq, desc } from 'drizzle-orm';
import type { Item, Note, Profile } from '../drizzle/schema';
import { Platform } from 'react-native';

export type ItemUsageSource = 'ai_creation' | 'image_analysis' | 'note_attachment' | 'pc_harness';
export type UsedAssetInput = { imagePath: string; sourceAssetId?: string | null; title?: string };

/** 瀑布流每页条数：双列一屏约 4–6 张卡，12 够两屏滚动，后续按需再取 */
const NOTES_PAGE_SIZE = 12;

interface AppState {
  // 图库
  items: Item[];
  loadItems: () => Promise<void>;
  recordAssetUse: (assets: UsedAssetInput[], source: ItemUsageSource) => Promise<Item[]>;
  markItemsUsed: (ids: number[], source: ItemUsageSource) => Promise<void>;
  updateItemAnalysis: (id: number, analysis: string) => Promise<void>;
  updateItemTags: (id: number, tags: string[]) => Promise<void>;
  deleteItem: (id: number) => Promise<void>;
  clearItems: () => Promise<void>;

  // 草稿（分页）
  notes: Note[];
  notesHasMore: boolean;
  notesLoading: boolean;
  loadNotes: (reset?: boolean) => Promise<void>;
  loadMoreNotes: () => Promise<void>;
  addNote: (data?: { title?: string; body?: string; itemIds?: number[] }) => Promise<Note>;
  updateNote: (id: number, data: Partial<Note>) => Promise<void>;
  deleteNote: (id: number) => Promise<void>;

  // 人设
  profile: Profile | null;
  loadProfile: () => Promise<void>;
  updateProfile: (data: Partial<Profile>) => Promise<void>;
}

export const useStore = create<AppState>((set, get) => ({
  items: [],
  notes: [],
  notesHasMore: true,
  notesLoading: false,
  profile: null,

  loadItems: async () => {
    const rows = await db.select().from(items).orderBy(desc(items.createdAt));
    set({ items: rows });
  },

  /** 建立/复用系统照片的应用元数据记录；不复制图片文件。 */
  recordAssetUse: async (assets, source) => {
    if (assets.length === 0) return [];
    const now = new Date().toISOString();
    const normalized = assets.map((asset) => ({
      ...asset,
      sourceAssetId: asset.sourceAssetId
        ? asset.sourceAssetId.startsWith(`${Platform.OS}:`)
          ? asset.sourceAssetId
          : `${Platform.OS}:${asset.sourceAssetId}`
        : null,
      title: asset.title ?? '新图片',
    }));
    // The app catalog contains only used photos, so reading its rows stays small
    // and also protects against duplicates when Zustand has not finished loading.
    const current = await db.select().from(items);
    const findItem = (asset: typeof normalized[number]) => current.find((item) =>
      (asset.sourceAssetId && item.sourceAssetId === asset.sourceAssetId)
      || item.imagePath === asset.imagePath
    );
    const existingByIndex = normalized.map(findItem);
    const missingByKey = new Map<string, typeof normalized[number]>();
    normalized.forEach((asset, index) => {
      if (existingByIndex[index]) return;
      const key = asset.sourceAssetId ? `asset:${asset.sourceAssetId}` : `uri:${asset.imagePath}`;
      if (!missingByKey.has(key)) missingByKey.set(key, asset);
    });
    const missing = [...missingByKey.values()];
    const inserted = missing.length > 0
      ? await db.insert(items).values(missing.map((asset) => ({
          title: asset.title,
          imagePath: asset.imagePath,
          sourceAssetId: asset.sourceAssetId,
          usedAt: now,
          usageSources: JSON.stringify([source]),
        }))).returning()
      : [];
    const insertedByKey = new Map<string, Item>();
    inserted.forEach((item) => {
      const key = item.sourceAssetId ? `asset:${item.sourceAssetId}` : `uri:${item.imagePath}`;
      insertedByKey.set(key, item);
    });

    const allRows = [...current];
    for (const item of inserted) {
      if (!allRows.some((row) => row.id === item.id)) allRows.unshift(item);
    }
    const result = normalized.map((asset, index) => {
      const found = existingByIndex[index];
      if (found) return found;
      const key = asset.sourceAssetId ? `asset:${asset.sourceAssetId}` : `uri:${asset.imagePath}`;
      return insertedByKey.get(key)!;
    });

    const uniqueExisting = [...new Map(existingByIndex.filter(Boolean).map((item) => [item!.id, item!])).values()];
    const updatedExisting = new Map<number, Item>();
    for (const item of uniqueExisting) {
      const matching = normalized.find((asset) =>
        (asset.sourceAssetId && item.sourceAssetId === asset.sourceAssetId)
        || item.imagePath === asset.imagePath
      );
      let sources: string[] = [];
      try { sources = JSON.parse(item.usageSources || '[]'); } catch {}
      const nextSources = sources.includes(source) ? sources : [...sources, source];
      const next = {
        ...item,
        imagePath: matching?.imagePath ?? item.imagePath,
        sourceAssetId: matching?.sourceAssetId ?? item.sourceAssetId,
        usedAt: item.usedAt ?? now,
        usageSources: JSON.stringify(nextSources),
      };
      if (
        next.imagePath !== item.imagePath
        || next.sourceAssetId !== item.sourceAssetId
        || next.usedAt !== item.usedAt
        || next.usageSources !== item.usageSources
      ) {
        await db.update(items).set({
          imagePath: next.imagePath,
          sourceAssetId: next.sourceAssetId,
          usedAt: next.usedAt,
          usageSources: next.usageSources,
        }).where(eq(items.id, item.id));
      }
      updatedExisting.set(item.id, next);
    }
    for (let index = 0; index < result.length; index += 1) {
      const updated = updatedExisting.get(result[index].id);
      if (updated) result[index] = updated;
    }
    set({ items: allRows.map((item) => updatedExisting.get(item.id) ?? item) });
    return result;
  },

  markItemsUsed: async (ids, source) => {
    const now = new Date().toISOString();
    const updated = new Map<number, Item>();
    for (const id of [...new Set(ids)]) {
      const item = get().items.find((candidate) => candidate.id === id);
      if (!item) continue;
      let sources: string[] = [];
      try { sources = JSON.parse(item.usageSources || '[]'); } catch {}
      const nextSources = sources.includes(source) ? sources : [...sources, source];
      const next = { ...item, usedAt: item.usedAt ?? now, usageSources: JSON.stringify(nextSources) };
      if (next.usedAt !== item.usedAt || next.usageSources !== item.usageSources) {
        await db.update(items).set({ usedAt: next.usedAt, usageSources: next.usageSources }).where(eq(items.id, id));
      }
      updated.set(id, next);
    }
    if (updated.size > 0) {
      set((state) => ({ items: state.items.map((item) => updated.get(item.id) ?? item) }));
    }
  },

  updateItemAnalysis: async (id, analysis) => {
    await db.update(items).set({ analysis }).where(eq(items.id, id));
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? { ...i, analysis } : i)),
    }));
  },

  updateItemTags: async (id, tags) => {
    const tagsJson = JSON.stringify(tags);
    await db.update(items).set({ tags: tagsJson }).where(eq(items.id, id));
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? { ...i, tags: tagsJson } : i)),
    }));
  },

  deleteItem: async (id) => {
    await db.delete(items).where(eq(items.id, id));
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },

  clearItems: async () => {
    await db.delete(items);
    set({ items: [] });
  },

  loadNotes: async (reset = true) => {
    const { notesLoading } = get();
    if (notesLoading) return;
    set({ notesLoading: true });
    try {
      const rows = await db
        .select()
        .from(notes)
        .orderBy(desc(notes.updatedAt))
        .limit(NOTES_PAGE_SIZE);
      set({
        notes: rows,
        notesHasMore: rows.length >= NOTES_PAGE_SIZE,
      });
    } finally {
      set({ notesLoading: false });
    }
  },

  loadMoreNotes: async () => {
    const state = get();
    if (!state.notesHasMore || state.notesLoading || state.notes.length === 0) return;
    set({ notesLoading: true });
    try {
      const offset = state.notes.length;
      const rows = await db
        .select()
        .from(notes)
        .orderBy(desc(notes.updatedAt))
        .limit(NOTES_PAGE_SIZE)
        .offset(offset);
      set({
        notes: [...state.notes, ...rows],
        notesHasMore: rows.length >= NOTES_PAGE_SIZE,
      });
    } finally {
      set({ notesLoading: false });
    }
  },

  addNote: async (data = {}) => {
    const rows = await db
      .insert(notes)
      .values({
        title: data.title ?? '',
        body: data.body ?? '',
        itemIds: JSON.stringify(data.itemIds ?? []),
      })
      .returning();
    const note = rows[0];
    set((s) => ({ notes: [note, ...s.notes] }));
    return note;
  },

  updateNote: async (id, data) => {
    const now = new Date().toISOString();
    await db
      .update(notes)
      .set({ ...data, updatedAt: now })
      .where(eq(notes.id, id));
    set((s) => ({
      notes: s.notes.map((n) => (n.id === id ? { ...n, ...data, updatedAt: now } : n)),
    }));
  },

  deleteNote: async (id) => {
    await db.delete(notes).where(eq(notes.id, id));
    set((s) => ({ notes: s.notes.filter((n) => n.id !== id) }));
  },

  loadProfile: async () => {
    const rows = await db.select().from(profile).where(eq(profile.id, 1));
    set({ profile: rows[0] ?? null });
  },

  updateProfile: async (data) => {
    const now = new Date().toISOString();
    await db.update(profile).set({ ...data, updatedAt: now }).where(eq(profile.id, 1));
    set((s) => ({
      profile: s.profile ? { ...s.profile, ...data, updatedAt: now } : null,
    }));
  },
}));
