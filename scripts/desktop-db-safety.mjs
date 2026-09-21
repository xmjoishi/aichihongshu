import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const REQUIRED_SCHEMA = {
  account_pool: ["id", "alias", "role", "user_data_dir", "status"],
  app_settings: ["key", "value"],
  items: ["id", "title", "image_path", "tags", "account_pool_id", "deleted_at"],
  notes: ["id", "item_id", "item_ids", "title", "body", "tags", "status", "note_type", "account_pool_id"],
  my_profile: ["id", "account_pool_id"],
};

class SafetyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") result.json = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new SafetyError("INVALID_ARGUMENT", `缺少参数值: --${key}`);
      result[key] = value;
      i += 1;
    } else throw new SafetyError("INVALID_ARGUMENT", `未知参数: ${arg}`);
  }
  return result;
}

function requireOption(opts, name) {
  if (!opts[name]) throw new SafetyError("INVALID_ARGUMENT", `必须提供 --${name}`);
  return resolve(opts[name]);
}

function regularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new SafetyError("SOURCE_MISSING", `${label}不存在: ${path}`);
  }
  if (stat.isSymbolicLink()) throw new SafetyError("UNSAFE_PATH", `${label}不能是符号链接: ${path}`);
  if (!stat.isFile()) throw new SafetyError("UNSAFE_PATH", `${label}不是普通文件: ${path}`);
  return realpathSync(path);
}

function directory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new SafetyError("ASSETS_MISSING", `${label}不存在: ${path}`);
  }
  if (stat.isSymbolicLink()) throw new SafetyError("UNSAFE_PATH", `${label}不能是符号链接: ${path}`);
  if (!stat.isDirectory()) throw new SafetyError("UNSAFE_PATH", `${label}不是目录: ${path}`);
  return realpathSync(path);
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sqliteJson(db, query) {
  const result = spawnSync("sqlite3", ["-json", db, query], { encoding: "utf8" });
  if (result.error) throw new SafetyError("SQLITE_UNAVAILABLE", `无法执行 sqlite3: ${result.error.message}`);
  if (result.status !== 0) throw new SafetyError("SQLITE_ERROR", `SQLite 查询失败: ${result.stderr || result.stdout}`);
  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : [];
  } catch (error) {
    throw new SafetyError("SQLITE_ERROR", `SQLite 返回了无法解析的结果: ${error.message}`);
  }
}

function count(db, table, where = "1=1") {
  return Number(sqliteJson(db, `SELECT COUNT(*) AS count FROM ${table} WHERE ${where};`)[0]?.count || 0);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assetCheck(storedPath, assetsRoot) {
  if (!storedPath || typeof storedPath !== "string") return { status: "missing", storedPath: storedPath || "" };
  if (isAbsolute(storedPath) || storedPath.includes("\0")) return { status: "unsafe", storedPath };
  const candidate = resolve(assetsRoot, storedPath);
  if (!inside(assetsRoot, candidate)) return { status: "unsafe", storedPath };
  try {
    const real = realpathSync(candidate);
    if (!inside(assetsRoot, real)) return { status: "unsafe", storedPath };
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: "unsafe", storedPath };
    return { status: "ok", storedPath, path: real, size: stat.size, sha256: sha256(real) };
  } catch {
    return { status: "missing", storedPath };
  }
}

function inspect(source, assetsPath) {
  const db = regularFile(source, "源数据库");
  const assets = directory(assetsPath, "素材根目录");
  const quickCheck = sqliteJson(db, "PRAGMA quick_check;")[0]?.quick_check;
  const tables = sqliteJson(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;").map((row) => row.name);
  const missingTables = Object.keys(REQUIRED_SCHEMA).filter((name) => !tables.includes(name));
  const missingColumns = {};
  for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
    if (!tables.includes(table)) continue;
    const actual = new Set(sqliteJson(db, `PRAGMA table_info('${table}');`).map((row) => row.name));
    const missing = columns.filter((column) => !actual.has(column));
    if (missing.length) missingColumns[table] = missing;
  }
  const compatible = quickCheck === "ok" && missingTables.length === 0 && Object.keys(missingColumns).length === 0;
  if (!compatible) {
    return {
      status: "incompatible_schema",
      compatible: false,
      databasePath: db,
      assetsRoot: assets,
      quickCheck,
      tables,
      missingTables,
      missingColumns,
    };
  }

  const items = sqliteJson(db, "SELECT id, account_pool_id, image_path FROM items WHERE deleted_at IS NULL ORDER BY id;");
  const accountRows = sqliteJson(db, `SELECT a.id, a.alias, a.display_name AS displayName,
      (SELECT COUNT(*) FROM items i WHERE i.account_pool_id = a.id AND i.deleted_at IS NULL) AS itemCount,
      (SELECT COUNT(*) FROM notes n WHERE n.account_pool_id = a.id) AS noteCount
      FROM account_pool a ORDER BY a.id;`);
  const orphanItems = count(db, "items", "account_pool_id IS NOT NULL AND account_pool_id NOT IN (SELECT id FROM account_pool)");
  const orphanNotes = count(db, "notes", "account_pool_id IS NOT NULL AND account_pool_id NOT IN (SELECT id FROM account_pool)");
  const assetsReport = items.map((item) => ({ itemId: item.id, accountPoolId: item.account_pool_id, ...assetCheck(item.image_path, assets) }));
  const missingAssets = assetsReport.filter((item) => item.status === "missing");
  const unsafeAssets = assetsReport.filter((item) => item.status === "unsafe");
  const status = unsafeAssets.length ? "unsafe_assets" : missingAssets.length ? "missing_assets" : "ok";
  return {
    status,
    compatible: true,
    databasePath: db,
    assetsRoot: assets,
    quickCheck,
    schema: { tables, missingTables, missingColumns },
    counts: {
      accounts: count(db, "account_pool"),
      items: count(db, "items"),
      activeItems: items.length,
      notes: count(db, "notes"),
      profiles: count(db, "my_profile"),
    },
    accounts: accountRows,
    orphanItems,
    orphanNotes,
    assets: assetsReport,
    missingAssets,
    unsafeAssets,
  };
}

function outputMustBeAbsent(path, label) {
  if (existsSync(path)) throw new SafetyError("TARGET_NON_EMPTY", `${label}已存在，拒绝覆盖: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
}

function targetCheck(target) {
  if (!existsSync(target)) return { status: "empty", path: target };
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new SafetyError("TARGET_NON_EMPTY", `目标数据库不是可安全检查的空文件: ${target}`);
  if (stat.size > 0) throw new SafetyError("TARGET_NON_EMPTY", `目标数据库已有内容，拒绝覆盖: ${target}`, { target });
  return { status: "empty_file", path: target };
}

function tableExists(db, table) {
  return sqliteJson(db, `SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=${sqlLiteral(table)} LIMIT 1;`).length > 0;
}

function tableColumns(db, table) {
  return sqliteJson(db, `PRAGMA table_info('${String(table).replaceAll("'", "''")}');`).map((row) => row.name);
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function targetDirectoryState(target) {
  if (!existsSync(target)) return { state: "absent", path: target };
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new SafetyError("UNSAFE_PATH", `目标素材目录不能是符号链接: ${target}`);
  if (!stat.isDirectory()) throw new SafetyError("TARGET_NON_EMPTY", `目标素材路径不是目录: ${target}`);
  const entries = readdirSync(target);
  return { state: entries.length === 0 ? "empty_directory" : "non_empty", path: target, entries: entries.length };
}

function migrationTargetState(target) {
  if (!existsSync(target)) return { status: "absent", path: target };
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new SafetyError("UNSAFE_PATH", `迁移目标不能是符号链接: ${target}`);
  if (stat.isDirectory()) return { status: "directory", path: target };
  if (!stat.isFile()) return { status: "unsupported", path: target };
  if (stat.size === 0) return { status: "empty_file", path: target };
  const quickCheck = sqliteJson(target, "PRAGMA quick_check;")[0]?.quick_check;
  const tables = sqliteJson(target, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;").map((row) => row.name);
  return { status: "non_empty", path: target, quickCheck, tables, counts: { accounts: tables.includes("account_pool") ? count(target, "account_pool") : null, items: tables.includes("items") ? count(target, "items") : null, notes: tables.includes("notes") ? count(target, "notes") : null } };
}

function migrationAssets(source, assetsRoot) {
  const rows = sqliteJson(source, "SELECT id, account_pool_id, image_path, deleted_at FROM items WHERE image_path IS NOT NULL ORDER BY id;");
  return rows.map((item) => ({ itemId: item.id, accountPoolId: item.account_pool_id, deletedAt: item.deleted_at, ...assetCheck(item.image_path, assetsRoot) }));
}

function ensureMigrationHealthy(report, assets) {
  ensureHealthy(report, "导入");
  const unsafe = assets.filter((asset) => asset.status === "unsafe");
  const missing = assets.filter((asset) => asset.status === "missing");
  if (unsafe.length) throw new SafetyError("UNSAFE_ASSET", "导入拒绝：存在越界或符号链接素材", { assets: unsafe });
  if (missing.length) throw new SafetyError("MISSING_ASSETS", "导入拒绝：存在不可达素材", { assets: missing });
}

function copyTree(source, target) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new SafetyError("UNSAFE_PATH", `不能复制符号链接: ${source}`);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) copyTree(join(source, entry), join(target, entry));
    return;
  }
  if (!stat.isFile()) throw new SafetyError("UNSAFE_PATH", `不能复制特殊文件: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function copyReferencedAssets(assets, targetRoot, allowExisting = false) {
  for (const asset of assets) {
    const target = resolve(targetRoot, asset.storedPath);
    if (!inside(resolve(targetRoot), target)) throw new SafetyError("UNSAFE_PATH", `素材目标越界: ${asset.storedPath}`);
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new SafetyError("UNSAFE_PATH", `素材目标不是普通文件: ${target}`);
      if (sha256(target) !== asset.sha256) throw new SafetyError("ASSET_CONFLICT", `目标已有不同内容的素材: ${asset.storedPath}`, { storedPath: asset.storedPath });
      if (allowExisting) continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(asset.path, target);
  }
}

function sqliteBackup(source, output) {
  mkdirSync(dirname(output), { recursive: true });
  const result = spawnSync("sqlite3", [source, `.backup '${output.replaceAll("'", "''")}'`], { encoding: "utf8" });
  if (result.error) throw new SafetyError("SQLITE_UNAVAILABLE", `无法执行 sqlite3 备份: ${result.error.message}`);
  if (result.status !== 0) throw new SafetyError("BACKUP_FAILED", `SQLite 备份失败: ${result.stderr || result.stdout}`);
}

function readJsonFile(path, label) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("必须是 JSON 对象");
    return parsed;
  } catch (error) {
    throw new SafetyError("INVALID_ACCOUNT_MAP", `${label}无法读取: ${error.message}`);
  }
}

function resolveAccountMap(sourceReport, targetDb, mapPath) {
  const targetRows = sqliteJson(targetDb, "SELECT id, alias, role FROM account_pool ORDER BY id;");
  const byId = new Map(targetRows.map((row) => [String(row.id), row]));
  const byAlias = new Map(targetRows.map((row) => [row.alias, row]));
  const supplied = mapPath ? readJsonFile(mapPath, "账号映射文件") : {};
  const mapping = {};
  const used = new Set();
  for (const sourceAccount of sourceReport.accounts) {
    const configured = supplied[String(sourceAccount.id)] ?? supplied[sourceAccount.alias];
    const targetAccount = configured === undefined ? byAlias.get(sourceAccount.alias) : byId.get(String(configured));
    if (!targetAccount) {
      throw new SafetyError("ACCOUNT_MAPPING_REQUIRED", `源账号无法映射到目标账号: ${sourceAccount.alias} (${sourceAccount.id})`, { sourceAccount, targetAccounts: targetRows });
    }
    if (used.has(targetAccount.id)) throw new SafetyError("ACCOUNT_MAPPING_CONFLICT", `多个源账号映射到同一个目标账号: ${targetAccount.id}`, { mapping });
    used.add(targetAccount.id);
    mapping[String(sourceAccount.id)] = targetAccount.id;
  }
  return { mapping, targetAccounts: targetRows };
}

function parseJsonIds(value, label) {
  if (value === null || value === undefined || value === "") return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed) || parsed.some((id) => !Number.isInteger(Number(id)))) throw new Error("必须是整数数组");
    return parsed.map(Number);
  } catch (error) {
    throw new SafetyError("REFERENCE_MISMATCH", `${label}不是有效的素材 ID 数组: ${error.message}`);
  }
}

function insertRowSql(table, columns, row, overrides = {}) {
  const values = columns.map((column) => Object.hasOwn(overrides, column) ? overrides[column] : row[column]);
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.map(sqlLiteral).join(", ")});`;
}

function mergeRows(sourceDb, targetDb, accountMapping) {
  const sourceItems = sqliteJson(sourceDb, "SELECT * FROM items ORDER BY id;");
  const sourceNotes = sqliteJson(sourceDb, "SELECT * FROM notes ORDER BY id;");
  const targetItemIds = new Set(sqliteJson(targetDb, "SELECT id FROM items;").map((row) => Number(row.id)));
  const targetNoteIds = new Set(sqliteJson(targetDb, "SELECT id FROM notes;").map((row) => Number(row.id)));
  const sourceItemIds = new Set(sourceItems.map((row) => Number(row.id)));
  const sourceNoteIds = new Set(sourceNotes.map((row) => Number(row.id)));
  if (sourceItems.length === 0 && sourceNotes.length === 0) return { sql: "BEGIN; COMMIT;", itemMap: {}, noteMap: {}, inserted: { items: 0, notes: 0, profiles: 0, references: 0, settings: 0 } };

  const targetItemColumns = tableColumns(targetDb, "items");
  const targetNoteColumns = tableColumns(targetDb, "notes");
  const itemColumns = targetItemColumns.filter((column) => column !== "id" && sourceItems.some((row) => Object.hasOwn(row, column)));
  const noteColumns = targetNoteColumns.filter((column) => column !== "id" && sourceNotes.some((row) => Object.hasOwn(row, column)));
  const itemMap = {};
  let nextItemId = Math.max(0, ...[...targetItemIds]) + 1;
  for (const row of sourceItems) itemMap[String(row.id)] = nextItemId++;
  const noteMap = {};
  let nextNoteId = Math.max(0, ...[...targetNoteIds]) + 1;
  for (const row of sourceNotes) noteMap[String(row.id)] = nextNoteId++;

  const statements = ["PRAGMA foreign_keys=ON;", "BEGIN IMMEDIATE;"];
  for (const row of sourceItems) {
    if (row.account_pool_id === null || row.account_pool_id === undefined || !accountMapping[String(row.account_pool_id)]) throw new SafetyError("ACCOUNT_MAPPING_REQUIRED", `素材 ${row.id} 缺少有效账号映射`);
    statements.push(insertRowSql("items", ["id", ...itemColumns], row, { id: itemMap[String(row.id)], account_pool_id: accountMapping[String(row.account_pool_id)] }));
  }
  for (const row of sourceNotes) {
    if (row.account_pool_id === null || row.account_pool_id === undefined || !accountMapping[String(row.account_pool_id)]) throw new SafetyError("ACCOUNT_MAPPING_REQUIRED", `笔记 ${row.id} 缺少有效账号映射`);
    const itemId = row.item_id === null || row.item_id === undefined ? null : itemMap[String(row.item_id)];
    if (row.item_id !== null && row.item_id !== undefined && !itemId) throw new SafetyError("REFERENCE_MISMATCH", `笔记 ${row.id} 的主素材不在源库`);
    const itemIds = parseJsonIds(row.item_ids, `笔记 ${row.id}`);
    if (itemIds.some((id) => !sourceItemIds.has(id))) throw new SafetyError("REFERENCE_MISMATCH", `笔记 ${row.id} 引用了不在源库的素材`, { itemIds });
    statements.push(insertRowSql("notes", ["id", ...noteColumns], row, { id: noteMap[String(row.id)], item_id: itemId, item_ids: JSON.stringify(itemIds.map((id) => itemMap[String(id)])), account_pool_id: accountMapping[String(row.account_pool_id)] }));
  }

  let profileCount = 0;
  if (tableExists(sourceDb, "my_profile")) {
    const targetProfiles = new Set(sqliteJson(targetDb, "SELECT account_pool_id FROM my_profile WHERE account_pool_id IS NOT NULL;").map((row) => Number(row.account_pool_id)));
    const targetProfileColumns = tableColumns(targetDb, "my_profile");
    const profileColumns = targetProfileColumns.filter((column) => column !== "id");
    let nextProfileId = Math.max(0, ...sqliteJson(targetDb, "SELECT id FROM my_profile;").map((row) => Number(row.id))) + 1;
    for (const row of sqliteJson(sourceDb, "SELECT * FROM my_profile ORDER BY id;")) {
      const mapped = accountMapping[String(row.account_pool_id)];
      if (!mapped) throw new SafetyError("ACCOUNT_MAPPING_REQUIRED", `人设 ${row.id} 缺少有效账号映射`);
      if (targetProfiles.has(Number(mapped))) throw new SafetyError("TARGET_CONFLICT", `目标已存在账号 ${mapped} 的人设，合并会覆盖现有数据`);
      statements.push(insertRowSql("my_profile", ["id", ...profileColumns.filter((column) => Object.hasOwn(row, column))], row, { id: nextProfileId++, account_pool_id: mapped }));
      profileCount += 1;
    }
  }

  let referenceCount = 0;
  if (tableExists(sourceDb, "reference_accounts")) {
    const sourceRefs = sqliteJson(sourceDb, "SELECT * FROM reference_accounts ORDER BY id;");
    if (sourceRefs.length && !tableExists(targetDb, "reference_accounts")) throw new SafetyError("INCOMPATIBLE_SCHEMA", "目标库缺少 reference_accounts，无法安全合并");
    const targetReferenceKeys = new Set(sqliteJson(targetDb, "SELECT account_pool_id, account_id FROM reference_accounts;").map((row) => `${row.account_pool_id}:${row.account_id}`));
    const referenceColumns = tableExists(targetDb, "reference_accounts") ? tableColumns(targetDb, "reference_accounts") : [];
    let nextReferenceId = Math.max(0, ...sqliteJson(targetDb, "SELECT id FROM reference_accounts;").map((row) => Number(row.id))) + 1;
    for (const row of sourceRefs) {
      const mapped = accountMapping[String(row.account_pool_id)];
      if (!mapped) throw new SafetyError("ACCOUNT_MAPPING_REQUIRED", `榜样账号 ${row.id} 缺少有效账号映射`);
      const key = `${mapped}:${row.account_id}`;
      if (targetReferenceKeys.has(key)) throw new SafetyError("TARGET_CONFLICT", `目标已存在榜样账号 ${row.account_id}，合并会覆盖现有数据`);
      statements.push(insertRowSql("reference_accounts", ["id", ...referenceColumns.filter((column) => column !== "id" && Object.hasOwn(row, column))], row, { id: nextReferenceId++, account_pool_id: mapped }));
      targetReferenceKeys.add(key);
      referenceCount += 1;
    }
  }

  let settingCount = 0;
  const targetSettings = new Set(sqliteJson(targetDb, "SELECT key FROM app_settings;").map((row) => row.key));
  for (const row of sqliteJson(sourceDb, "SELECT key, value, updated_at FROM app_settings ORDER BY key;")) {
    if (row.key === "active_account_id") continue;
    const scoped = String(row.key).match(/^(knowledge_preferences|ai_provider_preference):([0-9]+)$/);
    const key = scoped ? `${scoped[1]}:${accountMapping[scoped[2]] || (() => { throw new SafetyError("ACCOUNT_MAPPING_REQUIRED", `设置 ${row.key} 缺少账号映射`); })()}` : row.key;
    if (targetSettings.has(key)) throw new SafetyError("TARGET_CONFLICT", `目标已存在设置键，拒绝覆盖: ${key}`);
    statements.push(`INSERT INTO app_settings (key, value, updated_at) VALUES (${sqlLiteral(key)}, ${sqlLiteral(row.value)}, ${sqlLiteral(row.updated_at)});`);
    targetSettings.add(key);
    settingCount += 1;
  }
  statements.push("COMMIT;");
  return { sql: `${statements.join("\n")}\n`, itemMap, noteMap, inserted: { items: sourceItems.length, notes: sourceNotes.length, profiles: profileCount, references: referenceCount, settings: settingCount } };
}

function executeSql(db, sql) {
  const result = spawnSync("sqlite3", [db], { input: sql, encoding: "utf8" });
  if (result.error) throw new SafetyError("SQLITE_UNAVAILABLE", `无法执行 sqlite3: ${result.error.message}`);
  if (result.status !== 0) throw new SafetyError("IMPORT_FAILED", `迁移写入失败: ${result.stderr || result.stdout}`);
}

function swapMigrationArtifacts(stagedDb, targetDb, stagedAssets, targetAssets) {
  const oldDb = `${targetDb}.migration-old-${process.pid}`;
  const oldAssets = `${targetAssets}.migration-old-${process.pid}`;
  let dbMoved = false;
  let assetsMoved = false;
  try {
    if (existsSync(targetDb)) { renameSync(targetDb, oldDb); dbMoved = true; }
    renameSync(stagedDb, targetDb);
    if (existsSync(targetAssets)) { renameSync(targetAssets, oldAssets); assetsMoved = true; }
    renameSync(stagedAssets, targetAssets);
    if (dbMoved) rmSync(oldDb, { force: true });
    if (assetsMoved) rmSync(oldAssets, { recursive: true, force: true });
  } catch (error) {
    try { if (existsSync(targetDb)) rmSync(targetDb, { force: true }); } catch {}
    try { if (dbMoved && existsSync(oldDb)) renameSync(oldDb, targetDb); } catch {}
    try { if (existsSync(targetAssets)) rmSync(targetAssets, { recursive: true, force: true }); } catch {}
    try { if (assetsMoved && existsSync(oldAssets)) renameSync(oldAssets, targetAssets); } catch {}
    throw new SafetyError("IMPORT_COMMIT_FAILED", `迁移提交失败，已尝试恢复目标：${error.message}`, { targetDb, targetAssets, stagedDb, stagedAssets });
  }
}

function ensureHealthy(report, operation) {
  if (!report.compatible) throw new SafetyError("INCOMPATIBLE_SCHEMA", `${operation}拒绝：schema 不兼容`, { report });
  if (report.unsafeAssets.length) throw new SafetyError("UNSAFE_ASSET", `${operation}拒绝：存在越界或符号链接素材`, { report });
  if (report.missingAssets.length) throw new SafetyError("MISSING_ASSETS", `${operation}拒绝：存在不可达素材`, { report });
}

function backup(source, assetsRoot, output) {
  const sourceReal = regularFile(source, "源数据库");
  if (resolve(output) === sourceReal) throw new SafetyError("INVALID_ARGUMENT", "备份目录不能是源数据库路径");
  const sourceSha256 = sha256(sourceReal);
  const report = inspect(sourceReal, assetsRoot);
  const backupAssets = migrationAssets(sourceReal, report.assetsRoot);
  ensureMigrationHealthy(report, backupAssets);
  outputMustBeAbsent(output, "备份目录");
  const staging = `${output}.staging-${process.pid}`;
  if (existsSync(staging)) throw new SafetyError("STAGING_EXISTS", `发现未完成的暂存目录，拒绝覆盖: ${staging}`);
  mkdirSync(join(staging, "data"), { recursive: true });
  mkdirSync(join(staging, "assets"), { recursive: true });
  try {
    const sqlite = spawnSync("sqlite3", [sourceReal, `.backup '${join(staging, "data", "app.db").replaceAll("'", "''")}'`], { encoding: "utf8" });
    if (sqlite.error) throw new SafetyError("SQLITE_UNAVAILABLE", `无法执行 sqlite3 备份: ${sqlite.error.message}`);
    if (sqlite.status !== 0) throw new SafetyError("BACKUP_FAILED", `SQLite 备份失败: ${sqlite.stderr || sqlite.stdout}`);
    const assets = [];
    for (const item of backupAssets) {
      const relativePath = item.storedPath;
      const target = join(staging, "assets", relativePath);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(item.path, target);
      assets.push({ itemId: item.itemId, accountPoolId: item.accountPoolId, deletedAt: item.deletedAt, storedPath: relativePath, backupPath: `assets/${relativePath}`, size: item.size, sha256: item.sha256 });
    }
    const manifest = {
      manifestVersion: 1,
      kind: "aichihongshu-local-backup",
      sourceSha256,
      database: "data/app.db",
      assetsRoot: "assets",
      counts: report.counts,
      accounts: report.accounts,
      assets,
      excludes: ["Cookie", "browser profile", "credentials", ".env", "unreferenced files"],
      sourceUnchanged: true,
    };
    if (sha256(sourceReal) !== sourceSha256) throw new SafetyError("SOURCE_CHANGED", "备份期间源数据库发生变化");
    writeFileSync(join(staging, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(staging, output);
    return { status: "ok", operation: "backup", backupPath: output, manifestPath: join(output, "backup-manifest.json"), report: inspect(join(output, "data", "app.db"), join(output, "assets")), manifest };
  } catch (error) {
    throw error instanceof SafetyError ? new SafetyError(error.code, `${error.message}；暂存目录已保留`, { ...error.details, stagingPath: staging }) : new SafetyError("BACKUP_FAILED", `${error.message}；暂存目录已保留`, { stagingPath: staging });
  }
}

function restoreCheck(backupPath, output) {
  const backupDir = directory(backupPath, "备份目录");
  const manifestPath = join(backupDir, "backup-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.manifestVersion !== 1 || manifest.kind !== "aichihongshu-local-backup") throw new SafetyError("INCOMPATIBLE_BACKUP", "备份清单版本不受支持");
  const sourceDb = join(backupDir, manifest.database);
  const sourceAssets = join(backupDir, manifest.assetsRoot);
  const sourceReport = inspect(sourceDb, sourceAssets);
  ensureHealthy(sourceReport, "恢复校验");
  outputMustBeAbsent(output, "恢复目录");
  const staging = `${output}.staging-${process.pid}`;
  if (existsSync(staging)) throw new SafetyError("STAGING_EXISTS", `发现未完成的恢复暂存目录，拒绝覆盖: ${staging}`);
  mkdirSync(join(staging, "data"), { recursive: true });
  mkdirSync(join(staging, "assets"), { recursive: true });
  try {
    copyFileSync(sourceDb, join(staging, "data", "app.db"));
    for (const asset of manifest.assets) {
      const from = join(backupDir, asset.backupPath);
      const to = join(staging, asset.backupPath);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
    const restoredReport = inspect(join(staging, "data", "app.db"), join(staging, "assets"));
    ensureHealthy(restoredReport, "恢复校验");
    if (JSON.stringify(restoredReport.counts) !== JSON.stringify(manifest.counts)) throw new SafetyError("RESTORE_MISMATCH", "恢复后的关键记录数量与清单不一致", { restored: restoredReport.counts, expected: manifest.counts });
    renameSync(staging, output);
    return { status: "ok", operation: "restore-check", restoredPath: output, databasePath: join(output, "data", "app.db"), report: inspect(join(output, "data", "app.db"), join(output, "assets")) };
  } catch (error) {
    throw error instanceof SafetyError ? new SafetyError(error.code, `${error.message}；恢复暂存目录已保留`, { ...error.details, stagingPath: staging }) : new SafetyError("RESTORE_FAILED", `${error.message}；恢复暂存目录已保留`, { stagingPath: staging });
  }
}

function migrationPlan(source, assetsRoot, target) {
  const sourceReal = regularFile(source, "源数据库");
  const targetPath = resolve(target);
  if (targetPath === sourceReal) throw new SafetyError("INVALID_ARGUMENT", "迁移目标不能与源数据库相同");
  const sourceReport = inspect(sourceReal, assetsRoot);
  let targetReport;
  if (!existsSync(targetPath)) {
    targetReport = { state: "absent", path: targetPath };
  } else {
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink()) throw new SafetyError("UNSAFE_PATH", `迁移目标不能是符号链接: ${targetPath}`);
    if (stat.isDirectory()) {
      targetReport = { state: "directory", path: targetPath };
    } else if (stat.isFile() && stat.size === 0) {
      targetReport = { state: "empty_file", path: targetPath };
    } else if (stat.isFile()) {
      const quickCheck = sqliteJson(targetPath, "PRAGMA quick_check;")[0]?.quick_check;
      const tables = sqliteJson(targetPath, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;").map((row) => row.name);
      targetReport = {
        state: "non_empty",
        path: targetPath,
        quickCheck,
        tables,
        counts: {
          accounts: tables.includes("account_pool") ? count(targetPath, "account_pool") : null,
          items: tables.includes("items") ? count(targetPath, "items") : null,
          notes: tables.includes("notes") ? count(targetPath, "notes") : null,
        },
      };
    } else {
      targetReport = { state: "unsupported", path: targetPath };
    }
  }
  return {
    operation: "migration-plan",
    status: "review_required",
    writes: false,
    source: sourceReport,
    target: targetReport,
    decisionRequired: ["replace", "merge", "cancel"],
    defaultDecision: "cancel",
    notes: [
      "该命令只生成检查报告，不复制数据库或素材。",
      "正式导入前必须明确选择合并或替换，并先完成备份。",
      "源库和素材检查不通过时不得继续导入。",
    ],
  };
}

function migrationExecute(source, assetsRoot, target, targetAssetsRoot, mode, backupRoot, accountMapPath) {
  if (!["cancel", "merge", "replace"].includes(mode)) throw new SafetyError("INVALID_ARGUMENT", `不支持的导入模式: ${mode}；必须是 replace、merge 或 cancel`);
  const sourceReal = regularFile(source, "源数据库");
  const targetPath = resolve(target);
  const targetAssets = resolve(targetAssetsRoot);
  if (targetPath === sourceReal) throw new SafetyError("INVALID_ARGUMENT", "迁移目标不能与源数据库相同");
  if (resolve(assetsRoot) === targetAssets) throw new SafetyError("INVALID_ARGUMENT", "源素材目录不能与目标素材目录相同");
  const sourceReport = inspect(sourceReal, assetsRoot);
  const sourceAssets = migrationAssets(sourceReal, sourceReport.assetsRoot);
  ensureMigrationHealthy(sourceReport, sourceAssets);
  if (mode === "cancel") {
    return {
      operation: "migration-execute",
      mode,
      status: "cancelled",
      writes: false,
      source: sourceReport,
      target: targetPath,
      targetAssetsRoot: targetAssets,
      decisionRequired: ["replace", "merge", "cancel"],
    };
  }

  if (!backupRoot) throw new SafetyError("INVALID_ARGUMENT", "正式导入必须提供 --backup-output，迁移前会先生成可恢复备份");
  const backupPath = resolve(backupRoot);
  if (existsSync(backupPath)) throw new SafetyError("BACKUP_EXISTS", `备份输出目录已存在，拒绝覆盖: ${backupPath}`);
  const targetState = migrationTargetState(targetPath);
  const targetAssetsState = targetDirectoryState(targetAssets);
  if (mode === "replace") {
    if (!["absent", "empty_file"].includes(targetState.status)) throw new SafetyError("TARGET_NON_EMPTY", "replace 拒绝写入已有内容的目标数据库", { target: targetState });
    if (!["absent", "empty_directory"].includes(targetAssetsState.state)) throw new SafetyError("TARGET_NON_EMPTY", "replace 拒绝写入已有内容的目标素材目录", { target: targetAssetsState });
  } else {
    if (targetState.status !== "non_empty") throw new SafetyError("TARGET_NON_EMPTY", "merge 要求目标数据库已有可检查内容；空目标请使用 replace", { target: targetState });
    if (targetAssetsState.state !== "non_empty") throw new SafetyError("TARGET_NON_EMPTY", "merge 要求目标素材目录已有内容且可检查", { target: targetAssetsState });
    const targetReport = inspect(targetPath, targetAssets);
    ensureHealthy(targetReport, "目标库检查");
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  mkdirSync(dirname(targetAssets), { recursive: true });
  const stagingDb = `${targetPath}.migration-staging-${process.pid}`;
  const stagingAssets = `${targetAssets}.migration-staging-${process.pid}`;
  if (existsSync(stagingDb) || existsSync(stagingAssets)) throw new SafetyError("STAGING_EXISTS", "发现未完成的迁移暂存路径，拒绝覆盖", { stagingDb, stagingAssets });
  mkdirSync(backupPath, { recursive: true });
  // 备份必须在任何目标暂存写入前完成；源库永远保留，merge 还额外保留原目标。
  backup(sourceReal, assetsRoot, join(backupPath, "source"));
  if (mode === "merge") backup(targetPath, targetAssets, join(backupPath, "target"));
  mkdirSync(stagingAssets, { recursive: true });
  let accountMapping = {};
  let mergeSummary = { items: sourceReport.counts.items, notes: sourceReport.counts.notes, profiles: sourceReport.counts.profiles, references: 0, settings: 0 };
  try {
    if (mode === "replace") {
      mkdirSync(dirname(stagingDb), { recursive: true });
      sqliteBackup(sourceReal, stagingDb);
      copyReferencedAssets(sourceAssets, stagingAssets);
    } else {
      sqliteBackup(targetPath, stagingDb);
      copyTree(targetAssets, stagingAssets);
      const mapping = resolveAccountMap(sourceReport, targetPath, accountMapPath);
      accountMapping = mapping.mapping;
      const merge = mergeRows(sourceReal, stagingDb, accountMapping);
      executeSql(stagingDb, merge.sql);
      mergeSummary = merge.inserted;
      copyReferencedAssets(sourceAssets, stagingAssets, true);
    }
    const stagedReport = inspect(stagingDb, stagingAssets);
    ensureHealthy(stagedReport, "导入结果校验");
    if (mode === "replace" && JSON.stringify(stagedReport.counts) !== JSON.stringify(sourceReport.counts)) throw new SafetyError("IMPORT_MISMATCH", "replace 后关键记录数量与源库不一致", { source: sourceReport.counts, staged: stagedReport.counts });
    swapMigrationArtifacts(stagingDb, targetPath, stagingAssets, targetAssets);
    const finalReport = inspect(targetPath, targetAssets);
    ensureHealthy(finalReport, "导入完成校验");
    return {
      operation: "migration-execute",
      mode,
      status: "ok",
      writes: true,
      source: sourceReport,
      target: finalReport,
      targetDatabase: targetPath,
      targetAssetsRoot: targetAssets,
      backupPath,
      accountMapping,
      inserted: mergeSummary,
    };
  } catch (error) {
    throw error instanceof SafetyError ? new SafetyError(error.code, `${error.message}；暂存路径已保留`, { ...error.details, stagingDb, stagingAssets }) : new SafetyError("IMPORT_FAILED", `${error.message}；暂存路径已保留`, { stagingDb, stagingAssets });
  }
}

function print(value, asJson) {
  if (asJson) console.log(JSON.stringify(value, null, 2));
  else console.log(value.message || JSON.stringify(value, null, 2));
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  const opts = options(argv);
  if (!command || command === "help") throw new SafetyError("INVALID_ARGUMENT", "用法: preflight|backup|restore-check|migration-plan|migration-execute --source/--assets-root/--target ... [--json]");
  if (command === "preflight") {
    const source = requireOption(opts, "source");
    const assetsRoot = requireOption(opts, "assets-root");
    if (opts.target) targetCheck(resolve(opts.target));
    const report = inspect(source, assetsRoot);
    print({ operation: "preflight", ...report, target: opts.target ? resolve(opts.target) : undefined }, opts.json);
    if (report.status !== "ok") process.exitCode = 2;
    return;
  }
  if (command === "backup") {
    print(backup(requireOption(opts, "source"), requireOption(opts, "assets-root"), requireOption(opts, "output")), opts.json);
    return;
  }
  if (command === "restore-check") {
    print(restoreCheck(requireOption(opts, "backup"), requireOption(opts, "output")), opts.json);
    return;
  }
  if (command === "migration-plan") {
    print(migrationPlan(requireOption(opts, "source"), requireOption(opts, "assets-root"), requireOption(opts, "target")), opts.json);
    return;
  }
  if (command === "migration-execute") {
    print(migrationExecute(
      requireOption(opts, "source"),
      requireOption(opts, "assets-root"),
      requireOption(opts, "target"),
      requireOption(opts, "target-assets-root"),
      opts.mode || "cancel",
      opts["backup-output"],
      opts["account-map"],
    ), opts.json);
    return;
  }
  throw new SafetyError("INVALID_ARGUMENT", `未知操作: ${command}`);
}

try {
  main();
} catch (error) {
  const failure = { ok: false, status: error.code || "FAILED", message: error.message, ...error.details };
  print(failure, process.argv.includes("--json"));
  process.exitCode = error.code === "INVALID_ARGUMENT" ? 64 : 2;
}
