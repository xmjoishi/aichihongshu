import { create } from 'zustand';
import { db } from '../services/db';
import { items, notes, profile } from '../drizzle/schema';
import { eq, desc } from 'drizzle-orm';
import type { Item, Note, Profile } from '../drizzle/schema';

interface AppState {
  // 图库
  items: Item[];
  loadItems: () => Promise<void>;
  addItem: (data: { title: string; imagePath: string }) => Promise<Item>;
  updateItemAnalysis: (id: number, analysis: string) => Promise<void>;
  updateItemTags: (id: number, tags: string[]) => Promise<void>;
  deleteItem: (id: number) => Promise<void>;
  clearItems: () => Promise<void>;

  // 草稿
  notes: Note[];
  loadNotes: () => Promise<void>;
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
  profile: null,

  loadItems: async () => {
    const rows = await db.select().from(items).orderBy(desc(items.createdAt));
    set({ items: rows });
  },

  addItem: async (data) => {
    const rows = await db
      .insert(items)
      .values({ title: data.title, imagePath: data.imagePath })
      .returning();
    const item = rows[0];
    set((s) => ({ items: [item, ...s.items] }));
    return item;
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

  loadNotes: async () => {
    const rows = await db.select().from(notes).orderBy(desc(notes.updatedAt));
    set({ notes: rows });
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
