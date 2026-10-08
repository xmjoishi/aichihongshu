use super::*;

fn stage_legacy_inspirations(conn: &Connection) -> SqlResult<()> {
    let mut statement = conn.prepare("PRAGMA table_info(\"inspirations\")")?;
    let mut rows = statement.query([])?;
    let mut id_type = None;
    let mut has_account_scope = false;
    let mut has_body = false;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        let column_type: String = row.get(2)?;
        match name.as_str() {
            "id" => id_type = Some(column_type),
            "account_pool_id" => has_account_scope = true,
            "body" => has_body = true,
            _ => {}
        }
    }
    drop(rows);
    drop(statement);

    let is_current_schema = id_type
        .as_deref()
        .is_some_and(|column_type| column_type.eq_ignore_ascii_case("TEXT"))
        && has_account_scope
        && has_body;
    if id_type.is_none() || is_current_schema {
        return Ok(());
    }

    let legacy_exists: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'inspirations_legacy_v1'
         )",
        [],
        |row| row.get(0),
    )?;
    if legacy_exists {
        return Err(rusqlite::Error::InvalidParameterName(
            "检测到未完成的 inspirations 迁移：inspirations_legacy_v1 已存在".to_string(),
        ));
    }

    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_inspirations_pool;
         DROP INDEX IF EXISTS idx_inspirations_dedupe;
         ALTER TABLE inspirations RENAME TO inspirations_legacy_v1;",
    )
}

pub(super) fn import_legacy_inspirations(
    conn: &mut Connection,
    account_pool_id: i64,
) -> SqlResult<()> {
    let legacy_exists: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'inspirations_legacy_v1'
         )",
        [],
        |row| row.get(0),
    )?;
    if !legacy_exists {
        return Ok(());
    }

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO inspirations (
             id, account_pool_id, title, source_url, body, observed_at, reason,
             status, note_id, dedupe_key, created_at, updated_at,
             keyword, source, likes_ref, note_ref, saved, legacy_id
         )
         SELECT
             'legacy-' || CAST(id AS TEXT),
             ?1,
             COALESCE(title, ''),
             CASE
                 WHEN source LIKE 'http://%' OR source LIKE 'https://%' THEN source
                 ELSE ''
             END,
             COALESCE(keyword, ''),
             COALESCE(created_at, datetime('now', 'localtime')),
             COALESCE(source, ''),
             'saved',
             NULL,
             NULL,
             COALESCE(created_at, datetime('now', 'localtime')),
             COALESCE(created_at, datetime('now', 'localtime')),
             keyword,
             COALESCE(source, 'ai'),
             COALESCE(likes_ref, 0),
             note_ref,
             COALESCE(saved, 1),
             id
         FROM inspirations_legacy_v1",
        params![account_pool_id],
    )?;
    tx.execute_batch("DROP TABLE inspirations_legacy_v1;")?;
    tx.commit()
}

pub(super) fn migrate(conn: &mut Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );",
    )?;

    let tx = conn.transaction()?;
    // Python 旧版已经创建过一个同名的 inspirations 表，但其主键是
    // INTEGER 且字段语义不同。先把它移到待导入表名，让下面的完整表
    // 定义真正落地；数据会在 active account 建立后再导入。
    stage_legacy_inspirations(&tx)?;
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
         CREATE TABLE IF NOT EXISTS crawl_logs (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             keywords TEXT NOT NULL,
             count INTEGER DEFAULT 0,
             source_file TEXT,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             account_pool_id INTEGER
         );
         CREATE TABLE IF NOT EXISTS items (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             title TEXT NOT NULL,
             image_path TEXT NOT NULL,
             thumbnail_path TEXT,
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
         CREATE TABLE IF NOT EXISTS notes (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             item_id INTEGER REFERENCES items(id),
             item_ids TEXT DEFAULT '[]',
             title TEXT,
             body TEXT,
             tags TEXT DEFAULT '[]',
             status TEXT NOT NULL DEFAULT 'draft',
             note_type TEXT DEFAULT 'text',
             video_path TEXT,
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
             deleted_at TEXT,
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
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
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
         );
         CREATE TABLE IF NOT EXISTS inspirations (
             id TEXT PRIMARY KEY,
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             title TEXT NOT NULL,
             source_url TEXT NOT NULL DEFAULT '',
             body TEXT NOT NULL DEFAULT '',
             observed_at TEXT NOT NULL,
             reason TEXT NOT NULL DEFAULT '',
             status TEXT NOT NULL DEFAULT 'saved'
                 CHECK(status IN ('saved', 'converted')),
             note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
             dedupe_key TEXT,
             material_type TEXT NOT NULL DEFAULT 'web_material',
             author TEXT NOT NULL DEFAULT '',
             capture_modules TEXT NOT NULL DEFAULT '[]',
             capture_payload TEXT NOT NULL DEFAULT '{}',
             collection_tags TEXT NOT NULL DEFAULT '[]',
             keyword TEXT,
             source TEXT NOT NULL DEFAULT 'manual',
             likes_ref INTEGER NOT NULL DEFAULT 0,
             note_ref TEXT,
             saved INTEGER NOT NULL DEFAULT 1,
             legacy_id INTEGER,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS inspiration_images (
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             inspiration_id TEXT NOT NULL,
             position INTEGER NOT NULL CHECK(position >= 0 AND position < 12),
             source_url TEXT NOT NULL,
             source_kind TEXT NOT NULL DEFAULT 'legacy_url'
                 CHECK(source_kind IN ('legacy_url', 'extension_bytes')),
             status TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending', 'downloading', 'ready', 'failed')),
             image_path TEXT,
             thumbnail_path TEXT,
             sha256 TEXT,
             mime_type TEXT,
             byte_size INTEGER,
             width INTEGER,
             height INTEGER,
             error TEXT,
             request_id TEXT,
             updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
             PRIMARY KEY(account_pool_id, inspiration_id, position),
             FOREIGN KEY(inspiration_id) REFERENCES inspirations(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_inspiration_images_request
             ON inspiration_images(account_pool_id, request_id, status);
         CREATE TABLE IF NOT EXISTS browser_capture_requests (
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             request_id TEXT NOT NULL,
             inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
             capture_details_saved INTEGER NOT NULL DEFAULT 0,
             created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
             PRIMARY KEY(account_pool_id, request_id)
         );
         CREATE TABLE IF NOT EXISTS inspiration_image_uploads (
             account_pool_id INTEGER NOT NULL,
             inspiration_id TEXT NOT NULL,
             position INTEGER NOT NULL,
             request_id TEXT NOT NULL,
             total_bytes INTEGER NOT NULL,
             sha256 TEXT NOT NULL,
             mime_type TEXT NOT NULL,
             next_offset INTEGER NOT NULL DEFAULT 0,
             temp_name TEXT NOT NULL,
             updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
             PRIMARY KEY(account_pool_id, inspiration_id, position),
             FOREIGN KEY(account_pool_id, inspiration_id, position)
                 REFERENCES inspiration_images(account_pool_id, inspiration_id, position) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS inspiration_links (
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
             target_kind TEXT NOT NULL CHECK(target_kind IN
                 ('topic', 'reference_account', 'inspiration', 'note', 'item')),
             target_id TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
             PRIMARY KEY(account_pool_id, inspiration_id, target_kind, target_id)
         );
         CREATE INDEX IF NOT EXISTS idx_inspiration_links_target
             ON inspiration_links(account_pool_id, target_kind, target_id);
         CREATE TABLE IF NOT EXISTS ai_runs (
             run_id TEXT PRIMARY KEY,
             account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE CASCADE,
             note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
             item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
             provider TEXT NOT NULL,
             started_at TEXT NOT NULL,
             status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
             finished_at TEXT,
             error TEXT,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS ai_run_artifacts (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             run_id TEXT NOT NULL REFERENCES ai_runs(run_id) ON DELETE CASCADE,
             account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE CASCADE,
             note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
             item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
             kind TEXT NOT NULL,
             content TEXT NOT NULL,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             UNIQUE(run_id, kind)
         );
         CREATE TABLE IF NOT EXISTS publish_outbox (
             attempt_id TEXT PRIMARY KEY,
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
             snapshot_key TEXT NOT NULL,
             content_version INTEGER NOT NULL,
             snapshot_json TEXT NOT NULL,
             status TEXT NOT NULL CHECK(status IN ('prepared', 'submitted', 'confirmed', 'failed', 'unknown')),
             platform_url TEXT,
             error TEXT,
             fill_status TEXT NOT NULL DEFAULT 'not_requested',
             fill_expires_at TEXT,
             fill_claim_token TEXT,
             fill_claim_expires_at TEXT,
             fill_result_json TEXT NOT NULL DEFAULT '{}',
             created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
             updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS memory_entries (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             origin TEXT NOT NULL DEFAULT 'pc' CHECK(origin IN ('pc', 'mobile')),
             kind TEXT NOT NULL DEFAULT 'fact'
                 CHECK(kind IN ('positioning', 'expression', 'fact', 'event', 'content_history')),
             content TEXT NOT NULL,
             subject TEXT NOT NULL DEFAULT '',
             scope TEXT NOT NULL DEFAULT 'account',
             source TEXT NOT NULL DEFAULT '',
             source_type TEXT NOT NULL DEFAULT 'user'
                 CHECK(source_type IN ('user', 'ai_draft', 'import', 'sync')),
             occurred_at TEXT,
             confirm_status TEXT NOT NULL DEFAULT 'candidate'
                 CHECK(confirm_status IN ('candidate', 'confirmed', 'rejected', 'outdated')),
             valid_status TEXT NOT NULL DEFAULT 'valid'
                 CHECK(valid_status IN ('valid', 'invalid')),
             replaced_by INTEGER REFERENCES memory_entries(id) ON DELETE SET NULL,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_memory_entries_pool_origin
             ON memory_entries(account_pool_id, origin, confirm_status, valid_status);
         CREATE TABLE IF NOT EXISTS experience_prompts (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             origin TEXT NOT NULL DEFAULT 'pc' CHECK(origin IN ('pc', 'mobile')),
             title TEXT NOT NULL,
             content TEXT NOT NULL,
             enabled INTEGER NOT NULL DEFAULT 1,
             apply_scope TEXT NOT NULL DEFAULT 'account'
                 CHECK(apply_scope IN ('global', 'account')),
             apply_target TEXT NOT NULL DEFAULT 'all'
                 CHECK(apply_target IN ('all', 'compose', 'chat')),
             source TEXT NOT NULL DEFAULT 'user'
                 CHECK(source IN ('user', 'from_memory')),
             sort_order INTEGER NOT NULL DEFAULT 0,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_experience_prompts_pool_origin
             ON experience_prompts(account_pool_id, origin, enabled);
         CREATE TABLE IF NOT EXISTS page_snapshots (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             kind TEXT NOT NULL CHECK(kind IN ('note_snapshot', 'ref_snapshot', 'clip')),
             source_url TEXT NOT NULL DEFAULT '',
             title TEXT NOT NULL DEFAULT '',
             author TEXT NOT NULL DEFAULT '',
             body_excerpt TEXT NOT NULL DEFAULT '',
             like_count INTEGER,
             collect_count INTEGER,
             comment_count INTEGER,
             metrics_json TEXT NOT NULL DEFAULT '{}',
             note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
             reference_account_id INTEGER REFERENCES reference_accounts(id) ON DELETE SET NULL,
             request_id TEXT,
             observed_at TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_page_snapshots_pool_kind
             ON page_snapshots(account_pool_id, kind, observed_at);
         CREATE INDEX IF NOT EXISTS idx_page_snapshots_url
             ON page_snapshots(account_pool_id, source_url);",
    )?;

    // 旧数据库可能由 Python 先创建过部分表。只增加缺失列，不重建表、不覆盖字段。
    for (table, column, definition) in [
        ("account_pool", "role", "TEXT NOT NULL DEFAULT 'operation'"),
        ("account_pool", "user_data_dir", "TEXT NOT NULL DEFAULT ''"),
        ("account_pool", "xhs_user_id", "TEXT"),
        ("account_pool", "display_name", "TEXT"),
        ("account_pool", "followers", "INTEGER NOT NULL DEFAULT 0"),
        ("account_pool", "status", "TEXT NOT NULL DEFAULT 'active'"),
        ("account_pool", "ban_count", "INTEGER NOT NULL DEFAULT 0"),
        ("account_pool", "last_used_at", "TEXT"),
        ("account_pool", "notes", "TEXT"),
        ("items", "title", "TEXT NOT NULL DEFAULT ''"),
        ("items", "image_path", "TEXT NOT NULL DEFAULT ''"),
        ("items", "thumbnail_path", "TEXT"),
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
        ("items", "image_version", "INTEGER NOT NULL DEFAULT 1"),
        ("items", "content_hash", "TEXT"),
        ("items", "metadata_version", "INTEGER NOT NULL DEFAULT 1"),
        ("notes", "item_id", "INTEGER"),
        ("notes", "item_ids", "TEXT DEFAULT '[]'"),
        ("notes", "title", "TEXT"),
        ("notes", "body", "TEXT"),
        ("notes", "status", "TEXT NOT NULL DEFAULT 'draft'"),
        ("notes", "note_type", "TEXT DEFAULT 'text'"),
        ("notes", "video_path", "TEXT"),
        ("notes", "likes", "INTEGER DEFAULT 0"),
        ("notes", "comments", "INTEGER DEFAULT 0"),
        ("notes", "collects", "INTEGER DEFAULT 0"),
        ("notes", "published_at", "TEXT"),
        ("notes", "note_url", "TEXT"),
        ("notes", "account_ref", "TEXT"),
        ("notes", "cover_desc", "TEXT"),
        ("notes", "prompt_used", "TEXT"),
        ("notes", "use_as_reference", "INTEGER DEFAULT 0"),
        ("notes", "content_version", "INTEGER NOT NULL DEFAULT 1"),
        ("notes", "account_pool_id", "INTEGER"),
        ("notes", "deleted_at", "TEXT"),
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
        ("my_profile", "risk_warning_ack", "INTEGER DEFAULT 0"),
        ("my_profile", "risk_warning_ack_at", "TEXT"),
        ("my_profile", "crawled_at", "TEXT"),
        ("my_profile", "created_at", "TEXT"),
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
        ("inspirations", "account_pool_id", "INTEGER"),
        ("inspirations", "source_url", "TEXT NOT NULL DEFAULT ''"),
        ("inspirations", "body", "TEXT NOT NULL DEFAULT ''"),
        ("inspirations", "observed_at", "TEXT NOT NULL DEFAULT ''"),
        ("inspirations", "reason", "TEXT NOT NULL DEFAULT ''"),
        ("inspirations", "status", "TEXT NOT NULL DEFAULT 'saved'"),
        ("inspirations", "note_id", "INTEGER"),
        ("inspirations", "dedupe_key", "TEXT"),
        ("inspirations", "created_at", "TEXT"),
        ("inspirations", "updated_at", "TEXT"),
        (
            "inspirations",
            "material_type",
            "TEXT NOT NULL DEFAULT 'web_material'",
        ),
        (
            "inspirations",
            "capture_modules",
            "TEXT NOT NULL DEFAULT '[]'",
        ),
        ("inspirations", "author", "TEXT NOT NULL DEFAULT ''"),
        (
            "inspirations",
            "capture_payload",
            "TEXT NOT NULL DEFAULT '{}'",
        ),
        (
            "inspirations",
            "collection_tags",
            "TEXT NOT NULL DEFAULT '[]'",
        ),
        ("inspirations", "keyword", "TEXT"),
        ("inspirations", "source", "TEXT NOT NULL DEFAULT 'manual'"),
        ("inspirations", "likes_ref", "INTEGER NOT NULL DEFAULT 0"),
        ("inspirations", "note_ref", "TEXT"),
        ("inspirations", "saved", "INTEGER NOT NULL DEFAULT 1"),
        ("inspirations", "legacy_id", "INTEGER"),
        (
            "inspiration_images",
            "source_kind",
            "TEXT NOT NULL DEFAULT 'legacy_url'",
        ),
        ("ai_runs", "run_id", "TEXT"),
        ("ai_runs", "account_pool_id", "INTEGER"),
        ("ai_runs", "note_id", "INTEGER"),
        ("ai_runs", "item_id", "INTEGER"),
        ("ai_runs", "provider", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("ai_runs", "started_at", "TEXT NOT NULL DEFAULT ''"),
        ("ai_runs", "status", "TEXT NOT NULL DEFAULT 'interrupted'"),
        ("ai_runs", "finished_at", "TEXT"),
        ("ai_runs", "error", "TEXT"),
        ("ai_runs", "created_at", "TEXT"),
        ("ai_runs", "updated_at", "TEXT"),
        ("ai_run_artifacts", "run_id", "TEXT"),
        ("ai_run_artifacts", "account_pool_id", "INTEGER"),
        ("ai_run_artifacts", "note_id", "INTEGER"),
        ("ai_run_artifacts", "item_id", "INTEGER"),
        (
            "ai_run_artifacts",
            "kind",
            "TEXT NOT NULL DEFAULT 'unknown'",
        ),
        ("ai_run_artifacts", "content", "TEXT NOT NULL DEFAULT ''"),
        ("ai_run_artifacts", "created_at", "TEXT"),
        ("publish_outbox", "attempt_id", "TEXT"),
        ("publish_outbox", "account_pool_id", "INTEGER"),
        ("publish_outbox", "note_id", "INTEGER"),
        ("publish_outbox", "snapshot_key", "TEXT"),
        (
            "publish_outbox",
            "content_version",
            "INTEGER NOT NULL DEFAULT 1",
        ),
        (
            "publish_outbox",
            "snapshot_json",
            "TEXT NOT NULL DEFAULT '{}'",
        ),
        (
            "publish_outbox",
            "status",
            "TEXT NOT NULL DEFAULT 'prepared'",
        ),
        ("publish_outbox", "platform_url", "TEXT"),
        ("publish_outbox", "error", "TEXT"),
        (
            "publish_outbox",
            "fill_status",
            "TEXT NOT NULL DEFAULT 'not_requested'",
        ),
        ("publish_outbox", "fill_expires_at", "TEXT"),
        ("publish_outbox", "fill_claim_token", "TEXT"),
        ("publish_outbox", "fill_claim_expires_at", "TEXT"),
        (
            "publish_outbox",
            "fill_result_json",
            "TEXT NOT NULL DEFAULT '{}'",
        ),
        ("publish_outbox", "created_at", "TEXT"),
        ("publish_outbox", "updated_at", "TEXT"),
        ("memory_entries", "enabled", "INTEGER NOT NULL DEFAULT 1"),
        ("crawl_logs", "account_pool_id", "INTEGER"),
    ] {
        ensure_column(&tx, table, column, definition)?;
    }

    tx.execute(
        "UPDATE my_profile
         SET created_at = COALESCE(NULLIF(created_at, ''), updated_at, datetime('now', 'localtime'))
         WHERE created_at IS NULL OR created_at = ''",
        [],
    )?;

    // 记忆启用位一次性回填：原「已确认且有效」为启用，候选/否定/过时为停用。
    let memory_enabled_migrated: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = 2",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if memory_enabled_migrated == 0 {
        tx.execute_batch(
            "UPDATE memory_entries SET enabled = 1
             WHERE confirm_status = 'confirmed' AND valid_status = 'valid';
             UPDATE memory_entries SET enabled = 0
             WHERE NOT (confirm_status = 'confirmed' AND valid_status = 'valid');",
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, name)
             VALUES (2, 'memory_entries_enabled')",
            [],
        )?;
    }

    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_items_pool_active
             ON items(account_pool_id, deleted_at, id);
         CREATE INDEX IF NOT EXISTS idx_notes_pool_id
             ON notes(account_pool_id, id);
         CREATE INDEX IF NOT EXISTS idx_profile_pool_id
             ON my_profile(account_pool_id);
         CREATE INDEX IF NOT EXISTS idx_reference_accounts_pool
             ON reference_accounts(account_pool_id, id);
         CREATE INDEX IF NOT EXISTS idx_inspirations_pool
             ON inspirations(account_pool_id, observed_at DESC, id);
         CREATE INDEX IF NOT EXISTS idx_inspirations_dedupe
             ON inspirations(account_pool_id, dedupe_key);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_inspirations_legacy_id
             ON inspirations(legacy_id) WHERE legacy_id IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_ai_runs_scope
             ON ai_runs(account_pool_id, note_id, item_id, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_ai_run_artifacts_scope
             ON ai_run_artifacts(account_pool_id, note_id, item_id, id DESC);
         CREATE INDEX IF NOT EXISTS idx_publish_outbox_scope
             ON publish_outbox(account_pool_id, note_id, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_publish_outbox_snapshot
             ON publish_outbox(account_pool_id, snapshot_key, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_crawl_logs_pool_created
             ON crawl_logs(account_pool_id, created_at DESC);",
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, name)
         VALUES (1, 'rust_local_core')",
        [],
    )?;
    tx.commit()?;
    migrate_companion_tasks(conn)
}

fn migrate_companion_tasks(conn: &mut Connection) -> SqlResult<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS companion_tasks (
             task_id TEXT PRIMARY KEY,
             client_task_id TEXT,
             account_pool_id INTEGER NOT NULL,
             status TEXT NOT NULL,
             topic TEXT,
             item_ids TEXT NOT NULL DEFAULT '[]',
             note_id INTEGER,
             title TEXT,
             body TEXT,
             tags TEXT NOT NULL DEFAULT '[]',
             content_version INTEGER,
             publish_status TEXT,
             publish_note_url TEXT,
             publish_message TEXT,
             error TEXT,
             created_at TEXT,
             updated_at TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_companion_tasks_client
             ON companion_tasks(account_pool_id, client_task_id);
         CREATE INDEX IF NOT EXISTS idx_companion_tasks_account
             ON companion_tasks(account_pool_id, updated_at DESC);",
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, name)
         VALUES (2, 'companion_tasks_v1')",
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
