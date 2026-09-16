use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Rust 本地数据层使用传入的 SQLite 数据库路径。
///
/// 开发态可以复用项目已有的 `data/app.db`，让桌面端直接看到历史数据；
/// 发布态由宿主传入应用数据目录中的数据库。该层不会复制浏览器目录、Cookie 或登录态。
pub struct LocalDb {
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAccount {
    pub id: i64,
    pub alias: String,
    pub role: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolAccount {
    pub id: i64,
    pub alias: String,
    pub role: String,
    pub display_name: Option<String>,
    pub is_active: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub id: i64,
    pub account_pool_id: i64,
    pub account_id: Option<String>,
    pub display_name: Option<String>,
    pub niche: Option<String>,
    pub target_audience: Option<String>,
    pub content_pillars: Vec<String>,
    pub persona_name: Option<String>,
    pub persona_bio: Option<String>,
    pub persona_tone: Option<String>,
    pub persona_taboos: Vec<String>,
    pub followers: i64,
    pub total_notes: i64,
    pub total_likes: i64,
    pub total_collects: i64,
    pub avg_likes: f64,
    pub avg_comments: f64,
    pub avg_collects: f64,
    pub preferred_styles: Vec<String>,
    pub preferred_scenes: Vec<String>,
    pub hashtag_pool: Vec<String>,
    pub posting_rhythm: Option<String>,
    pub avatar_url: Option<String>,
    pub xhs_bio: Option<String>,
    pub xhs_follows: i64,
    pub ip_location: Option<String>,
    pub xhs_tags: Vec<String>,
    pub crawled_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    pub id: i64,
    pub title: String,
    pub image_path: String,
    pub tags: Vec<String>,
    pub style: Option<String>,
    pub material: Option<String>,
    pub scene: Option<String>,
    pub color: Option<String>,
    pub analysis_raw: Option<String>,
    pub note_count: i64,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: i64,
    pub item_id: Option<i64>,
    pub item_ids: Vec<i64>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub tags: Vec<String>,
    pub status: String,
    pub note_type: String,
    pub likes: i64,
    pub comments: i64,
    pub collects: i64,
    pub published_at: Option<String>,
    pub note_url: Option<String>,
    pub account_ref: Option<String>,
    pub cover_desc: Option<String>,
    pub prompt_used: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceAccountSummary {
    pub id: i64,
    pub account_id: String,
    pub name: Option<String>,
    pub followers: i64,
    pub total_likes: i64,
    pub note_count: i64,
    pub avg_likes: f64,
    pub avg_comments: f64,
    pub avg_collects: f64,
    pub content_style: Option<String>,
    pub top_notes: Vec<ReferenceNote>,
    pub raw_data: Option<String>,
    pub crawled_at: Option<String>,
    pub analyzed_at: Option<String>,
    pub insights: Option<String>,
    pub insights_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct ReferenceNote {
    pub title: String,
    pub likes: i64,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub database_path: String,
    pub active_account: ActiveAccount,
    pub profile: Option<ProfileSummary>,
    pub item_count: i64,
    pub items: Vec<ItemSummary>,
    pub note_count: i64,
    pub note_status_counts: BTreeMap<String, i64>,
    pub notes: Vec<NoteSummary>,
    pub reference_accounts: Vec<ReferenceAccountSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountPoolSnapshot {
    pub items: Vec<PoolAccount>,
}

impl LocalDb {
    pub fn open(path: PathBuf) -> SqlResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| rusqlite::Error::InvalidPath(parent.to_path_buf()))?;
        }

        let db = Self { path };
        let mut conn = db.connect()?;
        migrate(&mut conn)?;
        ensure_active_account(&mut conn, &db.path)?;
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读取当前运营账号可见物品的本地图片，返回 data URL 供桌面 WebView 展示。
    /// 图片路径来自受账号隔离约束的 items 记录，不接受前端任意文件路径。
    pub fn image_data_url(&self, item_id: i64) -> Result<Option<String>, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        let stored_path: Option<String> = conn
            .query_row(
                "SELECT image_path FROM items
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![item_id, active.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取图片记录失败: {error}"))?;

        let Some(stored_path) = stored_path else {
            return Ok(None);
        };
        let image_path = self.resolve_image_path(&stored_path);
        let bytes = fs::read(&image_path)
            .map_err(|error| format!("读取图片失败（{}）: {error}", image_path.display()))?;
        let extension = image_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime = match extension.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "svg" => "image/svg+xml",
            _ => "application/octet-stream",
        };
        Ok(Some(format!(
            "data:{mime};base64,{}",
            STANDARD.encode(bytes)
        )))
    }

    fn resolve_image_path(&self, stored_path: &str) -> PathBuf {
        let path = PathBuf::from(stored_path);
        if path.is_absolute() {
            return path;
        }

        let db_dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        let project_root = db_dir.parent().unwrap_or(db_dir);
        let candidates = [
            db_dir.join(&path),
            project_root.join(&path),
            project_root.join("assets").join(&path),
            db_dir.join("assets").join(&path),
        ];
        candidates
            .iter()
            .find(|candidate| candidate.is_file())
            .cloned()
            .unwrap_or_else(|| project_root.join("assets").join(path))
    }

    fn connect(&self) -> SqlResult<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             PRAGMA busy_timeout=5000;
             PRAGMA synchronous=NORMAL;
             PRAGMA journal_mode=WAL;",
        )?;
        Ok(conn)
    }

    pub fn snapshot(&self) -> SqlResult<WorkspaceSnapshot> {
        let mut conn = self.connect()?;
        let active = ensure_active_account(&mut conn, &self.path)?;

        let profile = conn
            .query_row(
                "SELECT id, account_pool_id, account_id, display_name, niche, target_audience,
                        content_pillars, persona_name, persona_bio, persona_tone, persona_taboos,
                        followers, total_notes, total_likes, total_collects,
                        avg_likes, avg_comments, avg_collects,
                        preferred_styles, preferred_scenes, hashtag_pool, posting_rhythm,
                        avatar_url, xhs_bio, xhs_follows, ip_location, xhs_tags, crawled_at, updated_at
                 FROM my_profile
                 WHERE account_pool_id = ?1
                 ORDER BY id
                 LIMIT 1",
                params![active.id],
                |row| {
                    Ok(ProfileSummary {
                        id: row.get(0)?,
                        account_pool_id: row.get(1)?,
                        account_id: row.get(2)?,
                        display_name: row.get(3)?,
                        niche: row.get(4)?,
                        target_audience: row.get(5)?,
                        content_pillars: parse_json_vec(row.get(6)?),
                        persona_name: row.get(7)?,
                        persona_bio: row.get(8)?,
                        persona_tone: row.get(9)?,
                        persona_taboos: parse_json_vec(row.get(10)?),
                        followers: row.get(11)?,
                        total_notes: row.get(12)?,
                        total_likes: row.get(13)?,
                        total_collects: row.get(14)?,
                        avg_likes: row.get(15)?,
                        avg_comments: row.get(16)?,
                        avg_collects: row.get(17)?,
                        preferred_styles: parse_json_vec(row.get(18)?),
                        preferred_scenes: parse_json_vec(row.get(19)?),
                        hashtag_pool: parse_json_vec(row.get(20)?),
                        posting_rhythm: row.get(21)?,
                        avatar_url: row.get(22)?,
                        xhs_bio: row.get(23)?,
                        xhs_follows: row.get(24)?,
                        ip_location: row.get(25)?,
                        xhs_tags: parse_json_vec(row.get(26)?),
                        crawled_at: row.get(27)?,
                        updated_at: row.get(28)?,
                    })
                },
            )
            .optional()?;

        let item_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM items
             WHERE account_pool_id = ?1 AND deleted_at IS NULL",
            params![active.id],
            |row| row.get(0),
        )?;
        let note_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE account_pool_id = ?1",
            params![active.id],
            |row| row.get(0),
        )?;
        let note_status_counts = {
            let mut status_stmt = conn.prepare(
                "SELECT status, COUNT(*) FROM notes
                 WHERE account_pool_id = ?1
                 GROUP BY status
                 ORDER BY status",
            )?;
            let status_rows = status_stmt.query_map(params![active.id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            let mut counts = BTreeMap::new();
            for row in status_rows {
                let (status, count) = row?;
                counts.insert(status, count);
            }
            counts
        };

        let mut item_stmt = conn.prepare(
            "SELECT id, title, image_path, tags, style, material, scene, color,
                    analysis_raw, note_count, created_at
             FROM items
             WHERE account_pool_id = ?1 AND deleted_at IS NULL
             ORDER BY id DESC
             LIMIT 5000",
        )?;
        let items = item_stmt
            .query_map(params![active.id], |row| {
                Ok(ItemSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    image_path: row.get(2)?,
                    tags: parse_json_vec(row.get(3)?),
                    style: row.get(4)?,
                    material: row.get(5)?,
                    scene: row.get(6)?,
                    color: row.get(7)?,
                    analysis_raw: row.get(8)?,
                    note_count: row.get(9)?,
                    created_at: row.get(10)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        let mut note_stmt = conn.prepare(
            "SELECT id, item_id, item_ids, title, body, tags, status, note_type,
                    likes, comments, collects, published_at, note_url, account_ref,
                    cover_desc, prompt_used, created_at, updated_at
             FROM notes
             WHERE account_pool_id = ?1
             ORDER BY id DESC
             LIMIT 5000",
        )?;
        let notes = note_stmt
            .query_map(params![active.id], |row| {
                Ok(NoteSummary {
                    id: row.get(0)?,
                    item_id: row.get(1)?,
                    item_ids: parse_json_vec(row.get(2)?),
                    title: row.get(3)?,
                    body: row.get(4)?,
                    tags: parse_json_vec(row.get(5)?),
                    status: row.get(6)?,
                    note_type: row.get(7)?,
                    likes: row.get(8)?,
                    comments: row.get(9)?,
                    collects: row.get(10)?,
                    published_at: row.get(11)?,
                    note_url: row.get(12)?,
                    account_ref: row.get(13)?,
                    cover_desc: row.get(14)?,
                    prompt_used: row.get(15)?,
                    created_at: row.get(16)?,
                    updated_at: row.get(17)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        let mut ref_stmt = conn.prepare(
            "SELECT id, account_id, name, followers, total_likes, note_count,
                    avg_likes, avg_comments, avg_collects, content_style, top_notes,
                    raw_data, crawled_at, analyzed_at, insights, insights_at
             FROM reference_accounts
             WHERE account_pool_id = ?1
             ORDER BY id DESC",
        )?;
        let reference_accounts = ref_stmt
            .query_map(params![active.id], |row| {
                Ok(ReferenceAccountSummary {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    name: row.get(2)?,
                    followers: row.get(3)?,
                    total_likes: row.get(4)?,
                    note_count: row.get(5)?,
                    avg_likes: row.get(6)?,
                    avg_comments: row.get(7)?,
                    avg_collects: row.get(8)?,
                    content_style: row.get(9)?,
                    top_notes: parse_json_vec(row.get(10)?),
                    raw_data: row.get(11)?,
                    crawled_at: row.get(12)?,
                    analyzed_at: row.get(13)?,
                    insights: row.get(14)?,
                    insights_at: row.get(15)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(WorkspaceSnapshot {
            database_path: self.path.display().to_string(),
            active_account: active,
            profile,
            item_count,
            items,
            note_count,
            note_status_counts,
            notes,
            reference_accounts,
        })
    }

    pub fn create_local_draft(&self, title: &str) -> SqlResult<NoteSummary> {
        let title = title.trim();
        if title.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "title must not be empty".to_string(),
            ));
        }
        if title.chars().count() > 200 {
            return Err(rusqlite::Error::InvalidParameterName(
                "title is longer than 200 characters".to_string(),
            ));
        }

        let mut conn = self.connect()?;
        let active = ensure_active_account(&mut conn, &self.path)?;
        conn.execute(
            "INSERT INTO notes (item_id, item_ids, title, tags, status, account_pool_id)
             VALUES (NULL, '[]', ?1, '[]', 'draft', ?2)",
            params![title, active.id],
        )?;
        let note_id = conn.last_insert_rowid();
        conn.query_row(
            "SELECT id, item_id, item_ids, title, body, tags, status, note_type,
                    likes, comments, collects, published_at, note_url, account_ref,
                    cover_desc, prompt_used, created_at, updated_at
             FROM notes WHERE id = ?1 AND account_pool_id = ?2",
            params![note_id, active.id],
            |row| {
                Ok(NoteSummary {
                    id: row.get(0)?,
                    item_id: row.get(1)?,
                    item_ids: parse_json_vec(row.get(2)?),
                    title: row.get(3)?,
                    body: row.get(4)?,
                    tags: parse_json_vec(row.get(5)?),
                    status: row.get(6)?,
                    note_type: row.get(7)?,
                    likes: row.get(8)?,
                    comments: row.get(9)?,
                    collects: row.get(10)?,
                    published_at: row.get(11)?,
                    note_url: row.get(12)?,
                    account_ref: row.get(13)?,
                    cover_desc: row.get(14)?,
                    prompt_used: row.get(15)?,
                    created_at: row.get(16)?,
                    updated_at: row.get(17)?,
                })
            },
        )
    }

    pub fn account_pool(&self) -> SqlResult<AccountPoolSnapshot> {
        let mut conn = self.connect()?;
        let active = ensure_active_account(&mut conn, &self.path)?;
        let mut stmt = conn.prepare(
            "SELECT id, alias, role, display_name, status
             FROM account_pool
             ORDER BY id",
        )?;
        let items = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                Ok(PoolAccount {
                    id,
                    alias: row.get(1)?,
                    role: row.get(2)?,
                    display_name: row.get(3)?,
                    is_active: id == active.id,
                    status: row.get(4)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(AccountPoolSnapshot { items })
    }

    pub fn activate_account(&self, account_id: i64) -> SqlResult<ActiveAccount> {
        let conn = self.connect()?;
        let account = conn
            .query_row(
                "SELECT id, alias, role, status
                 FROM account_pool
                 WHERE id = ?1",
                params![account_id],
                |row| {
                    Ok(ActiveAccount {
                        id: row.get(0)?,
                        alias: row.get(1)?,
                        role: row.get(2)?,
                        status: row.get(3)?,
                    })
                },
            )
            .optional()?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if account.status != "active" || !is_operation_role(&account.role) {
            return Err(rusqlite::Error::InvalidParameterName(
                "active account must be an active operation account".to_string(),
            ));
        }
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at)
             VALUES ('active_account_id', ?1, datetime('now', 'localtime'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value,
             updated_at = excluded.updated_at",
            params![account.id.to_string()],
        )?;
        Ok(account)
    }
}

fn parse_json_vec<T: DeserializeOwned>(raw: Option<String>) -> Vec<T> {
    raw.and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn migrate(conn: &mut Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );",
    )?;

    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS account_pool (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             alias TEXT UNIQUE NOT NULL,
             role TEXT NOT NULL DEFAULT 'operation'
                 CHECK(role IN ('operation', 'assistant')),
             user_data_dir TEXT UNIQUE NOT NULL,
             display_name TEXT,
             status TEXT NOT NULL DEFAULT 'active'
                 CHECK(status IN ('active', 'banned', 'suspended', 'retired')),
             created_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS app_settings (
             key TEXT PRIMARY KEY,
             value TEXT,
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS items (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
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
             deleted_at TEXT
         );
         CREATE TABLE IF NOT EXISTS notes (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
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
             account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE SET NULL,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS my_profile (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             account_pool_id INTEGER UNIQUE REFERENCES account_pool(id) ON DELETE CASCADE,
             account_id TEXT,
             display_name TEXT,
             niche TEXT,
             followers INTEGER DEFAULT 0,
             total_notes INTEGER DEFAULT 0,
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS reference_accounts (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
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
         );",
    )?;

    // 旧数据库可能由 Python 先创建过部分表。只增加缺失列，不重建表、不覆盖字段。
    for (table, column, definition) in [
        ("account_pool", "role", "TEXT NOT NULL DEFAULT 'operation'"),
        ("account_pool", "user_data_dir", "TEXT NOT NULL DEFAULT ''"),
        ("account_pool", "display_name", "TEXT"),
        ("account_pool", "status", "TEXT NOT NULL DEFAULT 'active'"),
        ("items", "title", "TEXT NOT NULL DEFAULT ''"),
        ("items", "image_path", "TEXT NOT NULL DEFAULT ''"),
        ("items", "style", "TEXT"),
        ("items", "material", "TEXT"),
        ("items", "scene", "TEXT"),
        ("items", "color", "TEXT"),
        ("items", "tags", "TEXT DEFAULT '[]'"),
        ("items", "analysis_raw", "TEXT"),
        ("items", "note_count", "INTEGER DEFAULT 0"),
        ("items", "account_pool_id", "INTEGER"),
        ("items", "created_at", "TEXT"),
        ("items", "deleted_at", "TEXT"),
        ("notes", "item_id", "INTEGER"),
        ("notes", "item_ids", "TEXT DEFAULT '[]'"),
        ("notes", "title", "TEXT"),
        ("notes", "body", "TEXT"),
        ("notes", "status", "TEXT NOT NULL DEFAULT 'draft'"),
        ("notes", "note_type", "TEXT DEFAULT 'text'"),
        ("notes", "likes", "INTEGER DEFAULT 0"),
        ("notes", "comments", "INTEGER DEFAULT 0"),
        ("notes", "collects", "INTEGER DEFAULT 0"),
        ("notes", "published_at", "TEXT"),
        ("notes", "note_url", "TEXT"),
        ("notes", "account_ref", "TEXT"),
        ("notes", "cover_desc", "TEXT"),
        ("notes", "prompt_used", "TEXT"),
        ("notes", "account_pool_id", "INTEGER"),
        ("notes", "created_at", "TEXT"),
        ("notes", "updated_at", "TEXT"),
        ("my_profile", "account_pool_id", "INTEGER"),
        ("my_profile", "account_id", "TEXT"),
        ("my_profile", "display_name", "TEXT"),
        ("my_profile", "niche", "TEXT"),
        ("my_profile", "followers", "INTEGER DEFAULT 0"),
        ("my_profile", "total_notes", "INTEGER DEFAULT 0"),
        ("my_profile", "target_audience", "TEXT"),
        ("my_profile", "content_pillars", "TEXT DEFAULT '[]'"),
        ("my_profile", "persona_name", "TEXT"),
        ("my_profile", "persona_bio", "TEXT"),
        ("my_profile", "persona_tone", "TEXT"),
        ("my_profile", "persona_taboos", "TEXT DEFAULT '[]'"),
        ("my_profile", "total_likes", "INTEGER DEFAULT 0"),
        ("my_profile", "total_collects", "INTEGER DEFAULT 0"),
        ("my_profile", "avg_likes", "REAL DEFAULT 0"),
        ("my_profile", "avg_comments", "REAL DEFAULT 0"),
        ("my_profile", "avg_collects", "REAL DEFAULT 0"),
        ("my_profile", "preferred_styles", "TEXT DEFAULT '[]'"),
        ("my_profile", "preferred_scenes", "TEXT DEFAULT '[]'"),
        ("my_profile", "hashtag_pool", "TEXT DEFAULT '[]'"),
        ("my_profile", "posting_rhythm", "TEXT"),
        ("my_profile", "avatar_url", "TEXT"),
        ("my_profile", "xhs_bio", "TEXT"),
        ("my_profile", "xhs_follows", "INTEGER DEFAULT 0"),
        ("my_profile", "ip_location", "TEXT"),
        ("my_profile", "xhs_tags", "TEXT DEFAULT '[]'"),
        ("my_profile", "crawled_at", "TEXT"),
        ("my_profile", "updated_at", "TEXT"),
        ("reference_accounts", "account_pool_id", "INTEGER"),
        (
            "reference_accounts",
            "account_id",
            "TEXT NOT NULL DEFAULT ''",
        ),
        ("reference_accounts", "name", "TEXT"),
        ("reference_accounts", "followers", "INTEGER DEFAULT 0"),
        ("reference_accounts", "total_likes", "INTEGER DEFAULT 0"),
        ("reference_accounts", "note_count", "INTEGER DEFAULT 0"),
        ("reference_accounts", "avg_likes", "REAL DEFAULT 0"),
        ("reference_accounts", "avg_comments", "REAL DEFAULT 0"),
        ("reference_accounts", "avg_collects", "REAL DEFAULT 0"),
        ("reference_accounts", "content_style", "TEXT"),
        ("reference_accounts", "top_notes", "TEXT DEFAULT '[]'"),
        ("reference_accounts", "raw_data", "TEXT"),
        ("reference_accounts", "crawled_at", "TEXT"),
        ("reference_accounts", "analyzed_at", "TEXT"),
        ("reference_accounts", "insights", "TEXT"),
        ("reference_accounts", "insights_at", "TEXT"),
    ] {
        ensure_column(&tx, table, column, definition)?;
    }

    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_items_pool_active
             ON items(account_pool_id, deleted_at, id);
         CREATE INDEX IF NOT EXISTS idx_notes_pool_id
             ON notes(account_pool_id, id);
         CREATE INDEX IF NOT EXISTS idx_profile_pool_id
             ON my_profile(account_pool_id);
         CREATE INDEX IF NOT EXISTS idx_reference_accounts_pool
             ON reference_accounts(account_pool_id, id);",
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, name)
         VALUES (1, 'rust_local_core')",
        [],
    )?;
    tx.commit()
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> SqlResult<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let mut rows = stmt.query([])?;
    let mut found = false;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            found = true;
            break;
        }
    }
    drop(rows);
    drop(stmt);
    if !found {
        conn.execute(
            &format!("ALTER TABLE \"{table}\" ADD COLUMN \"{column}\" {definition}"),
            [],
        )?;
    }
    Ok(())
}

fn ensure_active_account(conn: &mut Connection, db_path: &Path) -> SqlResult<ActiveAccount> {
    let configured_id = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'active_account_id'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .and_then(|value| value.parse::<i64>().ok());

    if let Some(id) = configured_id {
        let configured = conn
            .query_row(
                "SELECT id, alias, role, status FROM account_pool WHERE id = ?1",
                params![id],
                |row| {
                    Ok(ActiveAccount {
                        id: row.get(0)?,
                        alias: row.get(1)?,
                        role: row.get(2)?,
                        status: row.get(3)?,
                    })
                },
            )
            .optional()?;
        let account = configured.ok_or_else(|| {
            rusqlite::Error::InvalidParameterName(
                "active_account_id points to missing account".into(),
            )
        })?;
        if account.status != "active" || !is_operation_role(&account.role) {
            return Err(rusqlite::Error::InvalidParameterName(
                "active account must be an active operation account".into(),
            ));
        }
        return Ok(account);
    }

    let existing = conn
        .query_row(
            "SELECT id, alias, role, status
             FROM account_pool
             WHERE status = 'active' AND role IN ('operation', 'main', 'sub_publish')
             ORDER BY id
             LIMIT 1",
            [],
            |row| {
                Ok(ActiveAccount {
                    id: row.get(0)?,
                    alias: row.get(1)?,
                    role: row.get(2)?,
                    status: row.get(3)?,
                })
            },
        )
        .optional()?;

    let account = match existing {
        Some(account) => account,
        None => {
            let browser_dir = db_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("browser_profiles")
                .join("main");
            fs::create_dir_all(&browser_dir)
                .map_err(|_| rusqlite::Error::InvalidPath(browser_dir.clone()))?;
            conn.execute(
                "INSERT INTO account_pool (alias, role, user_data_dir, status)
                 VALUES ('主号', 'operation', ?1, 'active')",
                params![browser_dir.display().to_string()],
            )?;
            ActiveAccount {
                id: conn.last_insert_rowid(),
                alias: "主号".to_string(),
                role: "operation".to_string(),
                status: "active".to_string(),
            }
        }
    };

    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES ('active_account_id', ?1, datetime('now', 'localtime'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at",
        params![account.id.to_string()],
    )?;
    Ok(account)
}

fn is_operation_role(role: &str) -> bool {
    matches!(role, "operation" | "main" | "sub_publish")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db() -> (LocalDb, PathBuf) {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aichihongshu-local-db-{suffix}"));
        let db = LocalDb::open(dir.join("app.db")).expect("open local db");
        (db, dir)
    }

    #[test]
    fn creates_schema_and_keeps_drafts_in_active_pool() {
        let (db, dir) = temp_db();
        let db_path = db.path.clone();
        let before = db.snapshot().expect("initial snapshot");
        assert!(before.items.is_empty());
        assert!(before.notes.is_empty());
        assert_eq!(before.item_count, 0);
        assert_eq!(before.note_count, 0);

        let note = db
            .create_local_draft("本地 Rust 草稿")
            .expect("create draft");
        assert_eq!(note.status, "draft");

        let after = db.snapshot().expect("snapshot after write");
        assert_eq!(after.notes.len(), 1);
        assert_eq!(after.note_count, 1);
        assert_eq!(after.note_status_counts.get("draft"), Some(&1));
        assert_eq!(after.notes[0].title.as_deref(), Some("本地 Rust 草稿"));
        assert_eq!(after.notes[0].item_ids, Vec::<i64>::new());

        drop(db);
        let reopened = LocalDb::open(db_path).expect("reopen local db");
        let restored = reopened.snapshot().expect("snapshot after reopen");
        assert_eq!(restored.note_count, 1);
        assert_eq!(restored.notes[0].title.as_deref(), Some("本地 Rust 草稿"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reads_active_item_image_as_data_url() {
        let (db, dir) = temp_db();
        let assets = dir.join("assets");
        fs::create_dir_all(&assets).expect("create assets dir");
        fs::write(assets.join("sample.png"), b"png-bytes").expect("write image");

        let conn = db.connect().expect("connect test db");
        conn.execute(
            "INSERT INTO items (title, image_path, account_pool_id) VALUES (?1, ?2, 1)",
            params!["测试图片", "sample.png"],
        )
        .expect("insert image item");
        let item_id = conn.last_insert_rowid();
        drop(conn);

        let data_url = db
            .image_data_url(item_id)
            .expect("read image data")
            .expect("image should exist");
        assert!(data_url.starts_with("data:image/png;base64,"));
        assert!(data_url.ends_with("cG5nLWJ5dGVz"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reads_existing_workspace_history_without_recreating_it() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aichihongshu-legacy-db-{suffix}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("app.db");
        let legacy = Connection::open(&path).expect("open legacy db");
        legacy
            .execute_batch(
                "CREATE TABLE account_pool (
                     id INTEGER PRIMARY KEY, alias TEXT NOT NULL, role TEXT NOT NULL,
                     user_data_dir TEXT NOT NULL, display_name TEXT, status TEXT NOT NULL
                 );
                 CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
                 CREATE TABLE items (
                     id INTEGER PRIMARY KEY, title TEXT NOT NULL, image_path TEXT NOT NULL,
                     tags TEXT, note_count INTEGER, account_pool_id INTEGER, deleted_at TEXT
                 );
                 CREATE TABLE notes (
                     id INTEGER PRIMARY KEY, item_id INTEGER, item_ids TEXT, title TEXT,
                     tags TEXT, status TEXT, account_pool_id INTEGER
                 );
                 CREATE TABLE my_profile (
                     id INTEGER PRIMARY KEY, account_pool_id INTEGER, account_id TEXT,
                     display_name TEXT, niche TEXT, followers INTEGER, total_notes INTEGER
                 );
                 CREATE TABLE reference_accounts (
                     id INTEGER PRIMARY KEY, account_pool_id INTEGER, account_id TEXT,
                     name TEXT, followers INTEGER, total_likes INTEGER, note_count INTEGER,
                     avg_likes REAL, avg_comments REAL, avg_collects REAL, content_style TEXT,
                     top_notes TEXT, raw_data TEXT, crawled_at TEXT, analyzed_at TEXT,
                     insights TEXT, insights_at TEXT
                 );
                 INSERT INTO account_pool VALUES (1, '主号', 'operation', '/tmp/profile', '历史主号', 'active');
                 INSERT INTO app_settings VALUES ('active_account_id', '1', NULL);
                 INSERT INTO items VALUES (7, '历史图库', 'history.jpg', '[\"家居\"]', 2, 1, NULL);
                 INSERT INTO notes VALUES (9, 7, '[7]', '历史笔记', '[\"装修\"]', 'published', 1);
                 INSERT INTO my_profile VALUES (1, 1, 'history-user', '历史账号', '家居', 88, 9);
                 INSERT INTO reference_accounts VALUES (3, 1, 'reference-user', '历史榜样', 100, 200, 4,
                   50, 5, 10, NULL, '[{\"title\":\"参考笔记\",\"likes\":12}]', NULL, NULL, NULL, NULL, NULL);",
            )
            .expect("seed legacy history");
        drop(legacy);

        let db = LocalDb::open(path).expect("migrate legacy db");
        let snapshot = db.snapshot().expect("read legacy snapshot");
        assert_eq!(snapshot.active_account.id, 1);
        assert_eq!(snapshot.item_count, 1);
        assert_eq!(snapshot.items[0].title, "历史图库");
        assert_eq!(snapshot.notes[0].title.as_deref(), Some("历史笔记"));
        assert_eq!(
            snapshot.reference_accounts[0].name.as_deref(),
            Some("历史榜样")
        );
        assert_eq!(
            snapshot.reference_accounts[0].top_notes[0].title,
            "参考笔记"
        );
        assert_eq!(
            snapshot.profile.unwrap().display_name.as_deref(),
            Some("历史账号")
        );
        fs::remove_dir_all(dir).ok();
    }
}
