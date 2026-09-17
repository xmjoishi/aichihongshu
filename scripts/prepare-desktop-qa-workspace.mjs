import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const qaRoot = join(repoRoot, ".qa", "desktop-workspace");
const dataDir = join(qaRoot, "data");
const databasePath = join(dataDir, "app.db");
const markerPath = join(qaRoot, ".aichihongshu-qa-workspace");
const fixturePath = join(repoRoot, "scripts", "desktop-qa-fixtures.json");
const fixtureImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function json(value) {
  return sql(JSON.stringify(value));
}

function schemaSql() {
  return `
PRAGMA foreign_keys=ON;
BEGIN;
CREATE TABLE account_pool (
  id INTEGER PRIMARY KEY,
  alias TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'operation',
  user_data_dir TEXT UNIQUE NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  image_path TEXT NOT NULL,
  style TEXT,
  material TEXT,
  scene TEXT,
  color TEXT,
  tags TEXT DEFAULT '[]',
  analysis_raw TEXT,
  note_count INTEGER DEFAULT 0,
  account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  deleted_at TEXT,
  image_version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT,
  metadata_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  item_id INTEGER REFERENCES items(id),
  item_ids TEXT DEFAULT '[]',
  title TEXT,
  body TEXT,
  tags TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  note_type TEXT DEFAULT 'text',
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  collects INTEGER DEFAULT 0,
  published_at TEXT,
  note_url TEXT,
  account_ref TEXT,
  cover_desc TEXT,
  prompt_used TEXT,
  content_version INTEGER NOT NULL DEFAULT 1,
  account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE my_profile (
  id INTEGER PRIMARY KEY,
  account_pool_id INTEGER UNIQUE REFERENCES account_pool(id) ON DELETE CASCADE,
  account_id TEXT,
  display_name TEXT,
  niche TEXT,
  target_audience TEXT,
  content_pillars TEXT DEFAULT '[]',
  persona_name TEXT,
  persona_bio TEXT,
  persona_tone TEXT,
  persona_taboos TEXT DEFAULT '[]',
  followers INTEGER DEFAULT 0,
  total_notes INTEGER DEFAULT 0,
  total_likes INTEGER DEFAULT 0,
  total_collects INTEGER DEFAULT 0,
  avg_likes REAL DEFAULT 0,
  avg_comments REAL DEFAULT 0,
  avg_collects REAL DEFAULT 0,
  preferred_styles TEXT DEFAULT '[]',
  preferred_scenes TEXT DEFAULT '[]',
  hashtag_pool TEXT DEFAULT '[]',
  posting_rhythm TEXT,
  avatar_url TEXT,
  xhs_bio TEXT,
  xhs_follows INTEGER DEFAULT 0,
  ip_location TEXT,
  xhs_tags TEXT DEFAULT '[]',
  crawled_at TEXT,
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE reference_accounts (
  id INTEGER PRIMARY KEY,
  account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  name TEXT,
  followers INTEGER DEFAULT 0,
  total_likes INTEGER DEFAULT 0,
  note_count INTEGER DEFAULT 0,
  avg_likes REAL DEFAULT 0,
  avg_comments REAL DEFAULT 0,
  avg_collects REAL DEFAULT 0,
  content_style TEXT,
  top_notes TEXT DEFAULT '[]',
  raw_data TEXT,
  crawled_at TEXT,
  analyzed_at TEXT,
  insights TEXT,
  insights_at TEXT,
  UNIQUE(account_pool_id, account_id)
);
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
INSERT INTO schema_migrations(version, name) VALUES (1, 'rust_local_core');
${fixtures.accounts
  .map(
    (account) =>
      `INSERT INTO account_pool(id, alias, role, user_data_dir, display_name, status) VALUES (${account.id}, ${sql(account.alias)}, ${sql(account.role)}, ${sql(`browser_profiles/${account.alias}`)}, ${sql(account.displayName)}, ${sql(account.status)});`,
  )
  .join("\n")}
INSERT INTO app_settings(key, value) VALUES ('active_account_id', ${sql(fixtures.expected.activeAccountId)});
${fixtures.items
  .map(
    (item) =>
      `INSERT INTO items(id, title, image_path, tags, note_count, account_pool_id) VALUES (${item.id}, ${sql(item.title)}, ${sql(item.imagePath)}, ${json(item.tags)}, 1, ${item.accountPoolId});`,
  )
  .join("\n")}
${fixtures.notes
  .map(
    (note) =>
      `INSERT INTO notes(id, item_id, item_ids, title, body, tags, status, note_type, account_pool_id) VALUES (${note.id}, ${note.itemId}, ${json([note.itemId])}, ${sql(note.title)}, ${sql(note.body)}, ${json(note.tags)}, 'draft', 'text', ${note.accountPoolId});`,
  )
  .join("\n")}
${fixtures.accounts
  .map(
    (account, index) =>
      `INSERT INTO my_profile(id, account_pool_id, account_id, display_name, niche, target_audience, content_pillars, persona_name, persona_bio, persona_tone, persona_taboos, hashtag_pool) VALUES (${index + 1}, ${account.id}, ${sql(account.accountId)}, ${sql(account.displayName)}, ${sql(account.niche)}, 'QA 测试受众', ${json([account.niche])}, ${sql(`${account.alias} 人设`)}, '固定隔离测试人设', '清晰、克制', ${json(["不可跨账号写入"])}, ${json(["#QA隔离"])});`,
  )
  .join("\n")}
COMMIT;
`;
}

function assertSafeQaPath(path) {
  const expectedRoot = join(repoRoot, ".qa", "desktop-workspace");
  if (resolve(path) !== resolve(expectedRoot)) {
    throw new Error(`拒绝操作非固定 QA 目录: ${path}`);
  }
}

function runSqlite(sqlText) {
  const result = spawnSync("sqlite3", [databasePath], {
    input: sqlText,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`无法执行 sqlite3；请安装 sqlite3 后重试: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`QA 数据库初始化失败（sqlite3 ${result.status}）: ${result.stderr || result.stdout}`);
  }
}

function prepare() {
  assertSafeQaPath(qaRoot);
  if (existsSync(databasePath) && !existsSync(markerPath)) {
    throw new Error(`QA 目录已有未标记数据库，拒绝覆盖: ${databasePath}`);
  }
  const alreadyPrepared =
    existsSync(databasePath) &&
    existsSync(markerPath) &&
    fixtures.items.every((item) => existsSync(join(qaRoot, item.imagePath)));
  if (alreadyPrepared) {
    return result();
  }

  mkdirSync(join(qaRoot, "fixtures"), { recursive: true });
  mkdirSync(join(qaRoot, "browser_profiles", "QA-A"), { recursive: true });
  mkdirSync(join(qaRoot, "browser_profiles", "QA-B"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(qaRoot, "fixtures", "qa-a-desk.png"), fixtureImage);
  writeFileSync(join(qaRoot, "fixtures", "qa-b-balcony.png"), fixtureImage);
  runSqlite(schemaSql());
  writeFileSync(markerPath, `${fixtures.workspaceId}\n仅供隔离桌面 QA；不放入凭据、Cookie 或正式素材。\n`);
  return result();
}

function result() {
  return {
    workspaceId: fixtures.workspaceId,
    workspacePath: qaRoot,
    databasePath,
    activeAccountId: fixtures.expected.activeAccountId,
    accounts: fixtures.accounts.map(({ id, alias, displayName }) => ({ id, alias, displayName })),
    expected: fixtures.expected,
  };
}

function printResult(result) {
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`QA workspace: ${result.workspacePath}`);
  console.log(`QA database: ${result.databasePath}`);
  console.log(`QA active account: ${result.activeAccountId} (QA-A)`);
  console.log("QA accounts: 101/QA-A, 202/QA-B");
  console.log("启动变量: AICHIHONGSHU_QA_WORKSPACE=" + result.workspacePath);
}

if (process.argv.includes("--reset")) {
  assertSafeQaPath(qaRoot);
  if (existsSync(qaRoot)) {
    rmSync(qaRoot, { recursive: true, force: true });
  }
}

printResult(prepare());
