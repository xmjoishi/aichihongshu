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
      tags TEXT NOT NULL DEFAULT '[]',
      analysis TEXT,
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

    INSERT OR IGNORE INTO profile (id) VALUES (1);
  `);
}
