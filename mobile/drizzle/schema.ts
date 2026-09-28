import { integer, sqliteTable, text, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const items = sqliteTable('items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  imagePath: text('image_path').notNull(),
  /** 系统相册资源 ID（按设备平台命名空间）；图片本体仍由系统图库持有。 */
  sourceAssetId: text('source_asset_id'),
  tags: text('tags').notNull().default('[]'),
  analysis: text('analysis'),
  usedAt: text('used_at'),
  usageSources: text('usage_sources').notNull().default('[]'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title'),
  body: text('body'),
  tags: text('tags').notNull().default('[]'),
  itemIds: text('item_ids').notNull().default('[]'),
  status: text('status').notNull().default('draft'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const profile = sqliteTable('profile', {
  id: integer('id').primaryKey().default(1),
  displayName: text('display_name'),
  niche: text('niche').default('家居软装/出租屋改造'),
  personaName: text('persona_name'),
  personaBio: text('persona_bio'),
  personaTone: text('persona_tone'),
  taboos: text('taboos').notNull().default('[]'),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
export type Profile = typeof profile.$inferSelect;
