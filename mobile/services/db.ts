import * as SQLite from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import * as schema from '../drizzle/schema';

let _sqlite: SQLite.SQLiteDatabase | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

function getSqlite() {
  if (!_sqlite) {
    _sqlite = SQLite.openDatabaseSync('aichihongshu.db');
  }
  return _sqlite;
}

/** 原生 SQL 读写（记忆池等未进 drizzle schema 的表）。 */
export function sqlAll<T = any>(query: string, params: any[] = []): T[] {
  return getSqlite().getAllSync(query, params) as T[];
}

export function sqlRun(query: string, params: any[] = []): { changes: number } {
  const result = getSqlite().runSync(query, params);
  return { changes: result.changes ?? 0 };
}

// db 通过 Proxy 懒初始化，避免模块加载时崩溃
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop) {
    if (!_db) {
      _db = drizzle(getSqlite(), { schema });
    }
    return (_db as any)[prop];
  },
});

export async function initDb() {
  // 确保 _db 已初始化
  const sqlite = getSqlite();
  if (!_db) {
    _db = drizzle(sqlite, { schema });
  }

  sqlite.execSync(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      image_path TEXT NOT NULL,
      source_asset_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      analysis TEXT,
      used_at TEXT,
      usage_sources TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      body TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      item_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY DEFAULT 1,
      display_name TEXT,
      niche TEXT DEFAULT '家居软装/出租屋改造',
      persona_name TEXT,
      persona_bio TEXT,
      persona_tone TEXT,
      taboos TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_id INTEGER,
      remote_server TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'user',
      occurred_at TEXT,
      confirm_status TEXT NOT NULL DEFAULT 'candidate',
      valid_status TEXT NOT NULL DEFAULT 'valid',
      enabled INTEGER NOT NULL DEFAULT 1,
      replaced_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS experience_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_id INTEGER,
      remote_server TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      apply_scope TEXT NOT NULL DEFAULT 'account',
      apply_target TEXT NOT NULL DEFAULT 'all',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memory_sync_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_url TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('entry', 'prompt')),
      remote_id INTEGER NOT NULL,
      UNIQUE(server_url, entity_type, remote_id)
    );

    INSERT OR IGNORE INTO profile (id) VALUES (1);
  `);

  // 为已有手机数据库补充字段；重复初始化/并发初始化时允许另一调用先完成迁移。
  for (const [table, column, definition] of [
    ['items', 'source_asset_id', 'TEXT'],
    ['items', 'used_at', 'TEXT'],
    ['items', 'usage_sources', "TEXT NOT NULL DEFAULT '[]'"],
    ['memory_entries', 'enabled', 'INTEGER NOT NULL DEFAULT 1'],
    ['memory_entries', 'remote_server', "TEXT NOT NULL DEFAULT ''"],
    ['experience_prompts', 'remote_server', "TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    if (!sqlAll<{ name: string }>(`PRAGMA table_info(${table})`).some((item) => item.name === column)) {
      try {
        sqlite.execSync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      } catch (error) {
        if (!sqlAll<{ name: string }>(`PRAGMA table_info(${table})`).some((item) => item.name === column)) throw error;
      }
    }
  }
}
