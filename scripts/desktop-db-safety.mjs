import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
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
  ensureHealthy(report, "备份");
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
    for (const item of report.assets) {
      const relativePath = item.storedPath;
      const target = join(staging, "assets", relativePath);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(item.path, target);
      assets.push({ itemId: item.itemId, accountPoolId: item.accountPoolId, storedPath: relativePath, backupPath: `assets/${relativePath}`, size: item.size, sha256: item.sha256 });
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

function print(value, asJson) {
  if (asJson) console.log(JSON.stringify(value, null, 2));
  else console.log(value.message || JSON.stringify(value, null, 2));
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  const opts = options(argv);
  if (!command || command === "help") throw new SafetyError("INVALID_ARGUMENT", "用法: preflight|backup|restore-check|migration-plan --source/--assets-root/--output ... [--json]");
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
  throw new SafetyError("INVALID_ARGUMENT", `未知操作: ${command}`);
}

try {
  main();
} catch (error) {
  const failure = { ok: false, status: error.code || "FAILED", message: error.message, ...error.details };
  print(failure, process.argv.includes("--json"));
  process.exitCode = error.code === "INVALID_ARGUMENT" ? 64 : 2;
}
