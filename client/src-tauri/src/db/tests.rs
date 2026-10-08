use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_db() -> (LocalDb, PathBuf) {
    static NEXT_TEMP_DB_ID: AtomicU64 = AtomicU64::new(0);
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let sequence = NEXT_TEMP_DB_ID.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "aichihongshu-local-db-{}-{suffix}-{sequence}",
        std::process::id()
    ));
    let db = LocalDb::open(dir.join("app.db")).expect("open local db");
    (db, dir)
}

#[test]
fn cli_library_query_preserves_legacy_like_limit_and_order() {
    let (db, dir) = temp_db();
    let conn = db.connect().expect("connect to seed CLI query rows");
    conn.execute(
        "INSERT INTO items(title, image_path, style, tags, account_pool_id, created_at)
         VALUES ('legacy marker', 'legacy-marker.png', '奶油风客厅', '[\"contract_marker\"]', 1, '2000-01-01 00:00:00')",
        [],
    )
    .expect("insert old matching item");
    for index in 1..=50 {
        conn.execute(
            "INSERT INTO items(title, image_path, style, tags, account_pool_id, created_at)
             VALUES (?1, ?2, '现代简约', '[]', 1, ?3)",
            params![
                format!("recent {index}"),
                format!("recent-{index}.png"),
                format!("2026-01-01 00:00:{index:02}")
            ],
        )
        .expect("insert recent item");
    }
    drop(conn);

    let recent = db
        .list_local_items_for_cli(None, None)
        .expect("list current page");
    assert_eq!(recent.len(), 50);
    assert_eq!(recent[0].title, "recent 50");
    assert!(recent.iter().all(|item| item.title != "legacy marker"));

    let wildcard_tag = db
        .list_local_items_for_cli(Some("CONTRACT_%"), None)
        .expect("apply legacy wildcard tag filter");
    assert_eq!(wildcard_tag.len(), 1);
    assert_eq!(wildcard_tag[0].title, "legacy marker");

    let substring_style = db
        .list_local_items_for_cli(None, Some("油风"))
        .expect("apply legacy substring style filter");
    assert_eq!(substring_style.len(), 1);
    assert_eq!(substring_style[0].title, "legacy marker");

    let empty_tag = db
        .list_local_items_for_cli(Some(""), None)
        .expect("empty optional filter is ignored");
    assert_eq!(empty_tag.len(), 50);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn cli_note_query_preserves_legacy_filters_and_created_order() {
    let (db, dir) = temp_db();
    assert_eq!(
        db.create_local_account(LocalAccountCreate {
            alias: "CLI 列表隔离测试账号".to_string(),
            role: "operation".to_string(),
            notes: None,
        })
        .expect("create isolated second account"),
        2
    );
    let conn = db.connect().expect("connect to seed CLI note query rows");
    conn.execute(
        "INSERT INTO items (id, title, image_path, account_pool_id) VALUES
             (101, 'CLI note item 101', 'cli-note-101.png', 1),
             (102, 'CLI note item 102', 'cli-note-102.png', 1)",
        [],
    )
    .expect("insert note item fixtures");
    conn.execute(
        "INSERT INTO notes (item_id, item_ids, title, status, account_pool_id, created_at)
         VALUES
             (101, '[101,102]', 'newest secondary association', 'ready', 1, '2026-01-03 00:00:00'),
             (102, '[102]', 'middle primary association', 'draft', 1, '2026-01-02 00:00:00'),
             (NULL, '[]', 'oldest unassociated', 'draft', 1, '2026-01-01 00:00:00'),
             (101, '[101]', 'other account', 'ready', 2, '2026-01-04 00:00:00')",
        [],
    )
    .expect("insert CLI note fixtures");
    drop(conn);

    let (item_account_id, item) = db
        .get_local_item_for_cli(101)
        .expect("look up one item for an active-account CLI command");
    assert_eq!(item_account_id, 1);
    assert_eq!(
        item.expect("current-account item exists").title,
        "CLI note item 101"
    );

    let (_, all) = db
        .list_local_notes_for_legacy(Some(""), Some(0))
        .expect("list notes with disabled legacy filters");
    assert_eq!(
        all.iter()
            .map(|note| note.title.as_deref())
            .collect::<Vec<_>>(),
        vec![
            Some("newest secondary association"),
            Some("middle primary association"),
            Some("oldest unassociated")
        ]
    );

    let (_, by_primary_item) = db
        .list_local_notes_for_legacy(None, Some(102))
        .expect("filter by the legacy primary item field");
    assert_eq!(by_primary_item.len(), 1);
    assert_eq!(
        by_primary_item[0].title.as_deref(),
        Some("middle primary association")
    );

    let (_, by_status) = db
        .list_local_notes_for_legacy(Some("draft"), None)
        .expect("filter by legacy note status");
    assert_eq!(by_status.len(), 2);
    assert!(by_status.iter().all(|note| note.status == "draft"));
    fs::remove_dir_all(dir).ok();
}

#[test]
fn legacy_note_query_is_not_limited_by_the_workspace_snapshot_cap() {
    let (db, dir) = temp_db();
    let mut conn = db.connect().expect("connect to seed large note list");
    let tx = conn.transaction().expect("begin note fixture transaction");
    {
        let mut statement = tx
            .prepare(
                "INSERT INTO notes (title, status, account_pool_id, created_at)
                 VALUES (?1, 'draft', 1, ?2)",
            )
            .expect("prepare note fixture insert");
        for index in 0..5_005 {
            statement
                .execute(params![
                    format!("legacy note {index}"),
                    format!("2026-01-01 00:{:02}:00", index / 60)
                ])
                .expect("insert note fixture");
        }
    }
    tx.commit().expect("commit note fixture transaction");

    let (_, notes) = db
        .list_local_notes_for_legacy(None, None)
        .expect("read complete legacy note list");
    assert_eq!(notes.len(), 5_005);
    let (account_id, first_note) = db
        .get_local_note_for_legacy(1)
        .expect("look up an older note by ID");
    assert_eq!(account_id, 1);
    assert_eq!(
        first_note
            .expect("first note remains directly addressable")
            .title
            .as_deref(),
        Some("legacy note 0")
    );
    fs::remove_dir_all(dir).ok();
}

#[test]
fn cli_trash_query_preserves_legacy_deletion_order_and_has_no_snapshot_cap() {
    let (db, dir) = temp_db();
    assert_eq!(
        db.create_local_account(LocalAccountCreate {
            alias: "CLI 回收站隔离测试账号".to_string(),
            role: "operation".to_string(),
            notes: None,
        })
        .expect("create isolated second account"),
        2
    );
    let mut conn = db.connect().expect("connect to seed trash fixtures");
    let tx = conn.transaction().expect("begin trash fixture transaction");
    {
        let mut statement = tx
            .prepare(
                "INSERT INTO items (title, image_path, account_pool_id, deleted_at)
                 VALUES (?1, ?2, 1, ?3)",
            )
            .expect("prepare trash fixture insert");
        for index in 0..5_005 {
            let seconds = index;
            let day = 1 + seconds / 86_400;
            let hour = (seconds / 3_600) % 24;
            let minute = (seconds / 60) % 60;
            let second = seconds % 60;
            statement
                .execute(params![
                    format!("trashed item {index}"),
                    format!("trash-{index}.png"),
                    format!("2026-01-{day:02} {hour:02}:{minute:02}:{second:02}")
                ])
                .expect("insert trash fixture");
        }
    }
    tx.execute(
        "INSERT INTO items (title, image_path, account_pool_id, deleted_at)
         VALUES ('other account trash', 'other-trash.png', 2, '2026-02-01 00:00:00')",
        [],
    )
    .expect("insert second account trash fixture");
    tx.commit().expect("commit trash fixture transaction");

    let trashed = db
        .list_local_trashed_items_for_cli()
        .expect("read complete legacy trash list");
    assert_eq!(trashed.len(), 5_005);
    assert_eq!(trashed[0].title, "trashed item 5004");
    assert_eq!(
        trashed.last().expect("oldest trash row").title,
        "trashed item 0"
    );
    fs::remove_dir_all(dir).ok();
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
    assert_eq!(note.content_version, 1);

    let updated = db
        .update_local_note(LocalNoteUpdate {
            note_id: note.id,
            account_pool_id: 1,
            expected_version: note.content_version,
            title: "可靠保存标题".to_string(),
            body: "纯文本正文\n第二行".to_string(),
            tags: vec!["家居".to_string(), "改造".to_string()],
            note_type: "text".to_string(),
            item_ids: Vec::new(),
            video_path: None,
        })
        .expect("update local note");
    assert_eq!(updated.title.as_deref(), Some("可靠保存标题"));
    assert_eq!(updated.body.as_deref(), Some("纯文本正文\n第二行"));
    assert_eq!(updated.tags, vec!["家居".to_string(), "改造".to_string()]);
    assert_eq!(updated.content_version, 2);

    let stale = db.update_local_note(LocalNoteUpdate {
        note_id: note.id,
        account_pool_id: 1,
        expected_version: 1,
        title: "旧回执不应覆盖".to_string(),
        body: "旧正文".to_string(),
        tags: vec!["旧标签".to_string()],
        note_type: "text".to_string(),
        item_ids: Vec::new(),
        video_path: None,
    });
    assert!(stale.is_err());

    let ready = db
        .update_local_note_status(LocalNoteStatusUpdate {
            note_id: note.id,
            account_pool_id: 1,
            expected_version: 2,
            status: "ready".to_string(),
            note_url: None,
        })
        .expect("update local note status");
    assert_eq!(ready.status, "ready");
    assert_eq!(ready.content_version, 3);

    let after = db.snapshot().expect("snapshot after write");
    assert_eq!(after.notes.len(), 1);
    assert_eq!(after.note_count, 1);
    assert_eq!(after.note_status_counts.get("ready"), Some(&1));
    assert_eq!(after.notes[0].title.as_deref(), Some("可靠保存标题"));
    assert_eq!(after.notes[0].body.as_deref(), Some("纯文本正文\n第二行"));
    assert_eq!(
        after.notes[0].tags,
        vec!["家居".to_string(), "改造".to_string()]
    );
    assert_eq!(after.notes[0].content_version, 3);
    assert_eq!(after.notes[0].item_ids, Vec::<i64>::new());

    drop(db);
    let reopened = LocalDb::open(db_path).expect("reopen local db");
    let restored = reopened.snapshot().expect("snapshot after reopen");
    assert_eq!(restored.note_count, 1);
    assert_eq!(restored.notes[0].title.as_deref(), Some("可靠保存标题"));
    assert_eq!(restored.notes[0].status, "ready");
    assert_eq!(restored.notes[0].content_version, 3);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn persists_video_path_through_note_updates_snapshots_and_type_changes() {
    let (db, dir) = temp_db();
    let note = db
        .create_local_draft_for_account("视频草稿", Some(1))
        .expect("create video draft");
    let updated = db
        .update_local_note(LocalNoteUpdate {
            note_id: note.id,
            account_pool_id: 1,
            expected_version: note.content_version,
            title: "视频草稿".to_string(),
            body: "视频正文".to_string(),
            tags: vec![],
            note_type: "video".to_string(),
            item_ids: vec![],
            video_path: Some("/local/media/clip.mp4".to_string()),
        })
        .expect("associate video path");
    assert_eq!(updated.video_path.as_deref(), Some("/local/media/clip.mp4"));

    let edited = db
        .update_local_note(LocalNoteUpdate {
            note_id: note.id,
            account_pool_id: 1,
            expected_version: updated.content_version,
            title: "视频草稿编辑后".to_string(),
            body: "视频正文编辑后".to_string(),
            tags: vec!["视频".to_string()],
            note_type: "video".to_string(),
            item_ids: vec![],
            video_path: None,
        })
        .expect("legacy content update leaves unspecified video path unchanged");
    assert_eq!(edited.video_path.as_deref(), Some("/local/media/clip.mp4"));

    let snapshot = db.snapshot().expect("snapshot video draft");
    assert_eq!(
        snapshot.notes[0].video_path.as_deref(),
        Some("/local/media/clip.mp4")
    );
    let listed = db
        .list_local_notes_for_legacy(None, None)
        .expect("list video draft")
        .1;
    assert_eq!(
        listed[0].video_path.as_deref(),
        Some("/local/media/clip.mp4")
    );

    let switched = db
        .update_local_note(LocalNoteUpdate {
            note_id: note.id,
            account_pool_id: 1,
            expected_version: edited.content_version,
            title: "视频草稿".to_string(),
            body: "视频正文".to_string(),
            tags: vec![],
            note_type: "text".to_string(),
            item_ids: vec![],
            video_path: None,
        })
        .expect("switch note type away from video");
    assert_eq!(switched.video_path, None);

    let created = db
        .create_local_note(LocalNoteCreate {
            account_pool_id: 1,
            item_ids: vec![],
            account_ref: None,
            title: Some("新建视频笔记".to_string()),
            body: Some("视频正文".to_string()),
            tags: vec![],
            cover_desc: None,
            prompt_used: None,
            note_type: "video".to_string(),
            video_path: Some("/local/media/new-clip.mp4".to_string()),
        })
        .expect("create video note with path");
    assert_eq!(
        created.video_path.as_deref(),
        Some("/local/media/new-clip.mp4")
    );
    fs::remove_dir_all(dir).ok();
}

#[test]
fn imports_local_video_in_account_scoped_chunks_and_attaches_only_after_hashing() {
    let (db, dir) = temp_db();
    let note = db
        .create_local_draft_for_account("分块视频草稿", Some(1))
        .expect("create upload target");
    let video = [
        0, 0, 0, 16, b'f', b't', b'y', b'p', b'm', b'p', b'4', b'2', 0, 0, 0, 1,
    ];
    let upload_id = "01234567-89ab-cdef-0123-456789abcdef";
    let first = db
        .import_local_video_chunk(LocalVideoImportChunk {
            note_id: note.id,
            account_pool_id: 1,
            expected_version: note.content_version,
            upload_id: upload_id.to_string(),
            filename: "测试视频.mp4".to_string(),
            mime_type: "video/mp4".to_string(),
            total_bytes: video.len() as u64,
            offset: 0,
            data_base64: STANDARD.encode(&video[..8]),
            done: false,
        })
        .expect("write first chunk");
    assert!(!first.completed);
    assert_eq!(first.received_bytes, 8);
    assert!(db
        .import_local_video_chunk(LocalVideoImportChunk {
            note_id: note.id,
            account_pool_id: 1,
            expected_version: note.content_version,
            upload_id: upload_id.to_string(),
            filename: "测试视频.mp4".to_string(),
            mime_type: "video/mp4".to_string(),
            total_bytes: video.len() as u64,
            offset: 7,
            data_base64: STANDARD.encode(&video[8..]),
            done: true,
        })
        .is_err());

    let finished = db
        .import_local_video_chunk(LocalVideoImportChunk {
            note_id: note.id,
            account_pool_id: 1,
            expected_version: note.content_version,
            upload_id: upload_id.to_string(),
            filename: "测试视频.mp4".to_string(),
            mime_type: "video/mp4".to_string(),
            total_bytes: video.len() as u64,
            offset: 8,
            data_base64: STANDARD.encode(&video[8..]),
            done: true,
        })
        .expect("finish video import");
    let saved = finished.note.expect("updated note");
    assert!(finished.completed);
    assert_eq!(finished.received_bytes, video.len() as u64);
    assert_eq!(saved.note_type, "video");
    assert_eq!(saved.content_version, 2);
    let path = saved.video_path.expect("managed video path");
    assert!(path.starts_with("videos/1/"));
    assert!(path.ends_with(".mp4"));
    assert_eq!(fs::read(dir.join(path)).expect("read managed video"), video);

    let cancelled_id = "fedcba98-7654-3210-fedc-ba9876543210";
    db.import_local_video_chunk(LocalVideoImportChunk {
        note_id: note.id,
        account_pool_id: 1,
        expected_version: saved.content_version,
        upload_id: cancelled_id.to_string(),
        filename: "取消.mp4".to_string(),
        mime_type: "video/mp4".to_string(),
        total_bytes: video.len() as u64,
        offset: 0,
        data_base64: STANDARD.encode(&video[..8]),
        done: false,
    })
    .expect("write cancellable chunk");
    db.abort_local_video_upload(cancelled_id, 1)
        .expect("abort video upload");
    assert!(!dir
        .join("videos/1/.upload-fedcba98-7654-3210-fedc-ba9876543210.part")
        .exists());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn records_crawl_history_with_an_active_account_boundary() {
    let (db, dir) = temp_db();
    let first_account = db.current_active_account().unwrap().id;
    let log_id = db
        .record_local_crawl_log(
            first_account,
            "家居,软装",
            12,
            Some("data/crawl/result.json"),
        )
        .expect("record crawl history");
    assert!(log_id > 0);

    let second_account = db
        .create_local_account(LocalAccountCreate {
            alias: "另一个运营账号".into(),
            role: "operation".into(),
            notes: None,
        })
        .expect("create account");
    db.activate_account(second_account)
        .expect("activate account");
    assert!(db
        .record_local_crawl_log(first_account, "不应串号", 1, None)
        .is_err());
    let second_log_id = db
        .record_local_crawl_log(second_account, "另一个账号", 1, None)
        .expect("record scoped crawl history");
    assert_ne!(log_id, second_log_id);
    let history = db
        .list_local_crawl_logs(second_account, 20)
        .expect("list current account crawl history");
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].id, second_log_id);
    assert_eq!(history[0].keywords, "另一个账号");
    assert_eq!(
        db.list_local_crawl_keywords_for_analytics(second_account)
            .expect("list second account analytics keywords"),
        vec!["另一个账号"]
    );
    assert!(db
        .list_local_crawl_keywords_for_analytics(first_account)
        .is_err());

    let connection = db.connect().unwrap();
    let first_scope: i64 = connection
        .query_row(
            "SELECT account_pool_id FROM crawl_logs WHERE id = ?1",
            params![log_id],
            |row| row.get(0),
        )
        .unwrap();
    let second_scope: i64 = connection
        .query_row(
            "SELECT account_pool_id FROM crawl_logs WHERE id = ?1",
            params![second_log_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(first_scope, first_account);
    assert_eq!(second_scope, second_account);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn analytics_crawl_keywords_keep_legacy_limit_and_exclude_other_accounts() {
    let (db, dir) = temp_db();
    let first_account = db.current_active_account().unwrap().id;
    for index in 0..51 {
        db.record_local_crawl_log(first_account, &format!("keyword-{index}"), 0, None)
            .expect("record analytics keyword batch");
    }
    let first_keywords = db
        .list_local_crawl_keywords_for_analytics(first_account)
        .expect("list first account analytics keywords");
    assert_eq!(first_keywords.len(), 50);
    assert_eq!(
        first_keywords.first().map(String::as_str),
        Some("keyword-0")
    );
    assert_eq!(
        first_keywords.last().map(String::as_str),
        Some("keyword-49")
    );

    let second_account = db
        .create_local_account(LocalAccountCreate {
            alias: "其他账号".into(),
            role: "operation".into(),
            notes: None,
        })
        .expect("create second operation account");
    db.activate_account(second_account)
        .expect("activate second account");
    db.record_local_crawl_log(second_account, "private-keyword", 0, None)
        .expect("record second account analytics keyword");
    assert_eq!(
        db.list_local_crawl_keywords_for_analytics(second_account)
            .expect("list second account analytics keywords"),
        vec!["private-keyword"]
    );
    assert!(db
        .list_local_crawl_keywords_for_analytics(first_account)
        .is_err());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn analytics_published_tags_keep_legacy_row_order_without_snapshot_cap() {
    let (db, dir) = temp_db();
    let mut conn = db.connect().expect("connect to seed published tags");
    let tx = conn.transaction().expect("begin published tags fixture");
    for index in 0..5_005 {
        let tags = match index {
            0 => "[\"first tag\"]",
            5_004 => "[\"last tag\"]",
            _ => "[]",
        };
        tx.execute(
            "INSERT INTO notes (account_pool_id, status, tags)
             VALUES (1, 'published', ?1)",
            params![tags],
        )
        .expect("insert published analytics note");
    }
    tx.execute(
        "INSERT INTO notes (account_pool_id, status, tags, deleted_at)
         VALUES (1, 'published', '[\"deleted tag\"]', '2026-01-01 00:00:00')",
        [],
    )
    .expect("insert a trashed note excluded from analytics");
    tx.commit().expect("commit published tags fixture");
    drop(conn);

    let tags = db
        .list_local_published_note_tags_for_analytics(1)
        .expect("read all published analytics tags");
    assert_eq!(tags.len(), 5_005);
    assert_eq!(tags.first(), Some(&vec!["first tag".to_string()]));
    assert_eq!(tags.last(), Some(&vec!["last tag".to_string()]));
    assert!(!tags.iter().flatten().any(|tag| tag == "deleted tag"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn adds_account_scope_to_legacy_crawl_history_without_discarding_rows() {
    let dir = std::env::temp_dir().join(format!(
        "aichihongshu-legacy-crawl-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("app.db");
    let legacy = Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            "CREATE TABLE crawl_logs (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 keywords TEXT NOT NULL,
                 count INTEGER DEFAULT 0,
                 source_file TEXT,
                 created_at TEXT DEFAULT (datetime('now','localtime'))
             );
             INSERT INTO crawl_logs (keywords, count, source_file)
             VALUES ('legacy keyword', 3, 'old.json');",
        )
        .unwrap();
    drop(legacy);

    let db = LocalDb::open(path).expect("migrate existing crawl history");
    let connection = db.connect().unwrap();
    let (keywords, count, account_pool_id): (String, i64, Option<i64>) = connection
        .query_row(
            "SELECT keywords, count, account_pool_id FROM crawl_logs WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(keywords, "legacy keyword");
    assert_eq!(count, 3);
    assert_eq!(account_pool_id, None);
    assert!(db
        .list_local_crawl_logs(1, 20)
        .expect("list history without exposing unscoped legacy rows")
        .is_empty());
    assert!(db
        .list_local_crawl_keywords_for_analytics(1)
        .expect("list analytics without exposing unscoped legacy rows")
        .is_empty());
    drop(connection);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn browser_profile_snapshot_updates_only_the_matching_active_profile() {
    let (db, dir) = temp_db();
    db.update_local_profile(LocalProfileUpdate {
        account_pool_id: 1,
        account_id: Some("profile-123".to_string()),
        display_name: Some("profile-123".to_string()),
        niche: None,
        target_audience: None,
        content_pillars: Vec::new(),
        followers: None,
        persona_name: None,
        persona_bio: None,
        persona_tone: None,
        persona_taboos: Vec::new(),
        preferred_styles: Vec::new(),
        preferred_scenes: Vec::new(),
        hashtag_pool: Vec::new(),
        posting_rhythm: None,
        avatar_url: None,
        xhs_bio: None,
        xhs_follows: None,
        ip_location: None,
        xhs_tags: None,
        risk_warning_ack: None,
    })
    .expect("create test profile");

    assert!(db
        .update_profile_from_browser_snapshot(BrowserProfileSnapshot {
            account_pool_id: 1,
            profile_account_id: "profile-123",
            display_name: Some("主页昵称"),
            followers: Some(4200),
            total_notes: Some(28),
            avatar_url: Some("https://sns-img-bd.xhscdn.com/avatar/1.jpg"),
            xhs_bio: Some("红薯生活记录"),
            xhs_follows: Some(128),
            ip_location: Some("上海"),
            xhs_tags: Some(&["生活方式".to_string(), "家居".to_string()]),
        })
        .expect("update matching profile"));
    assert!(!db
        .update_profile_from_browser_snapshot(BrowserProfileSnapshot {
            account_pool_id: 1,
            profile_account_id: "someone-else",
            display_name: Some("他人昵称"),
            followers: Some(999),
            total_notes: Some(99),
            avatar_url: Some("https://sns-img-bd.xhscdn.com/avatar/other.jpg"),
            xhs_bio: Some("他人简介"),
            xhs_follows: Some(9),
            ip_location: Some("北京"),
            xhs_tags: Some(&["不应写入".to_string()]),
        })
        .expect("ignore another profile"));
    assert!(db
        .update_profile_from_browser_snapshot(BrowserProfileSnapshot {
            account_pool_id: 1,
            profile_account_id: "profile-123",
            display_name: None,
            followers: None,
            total_notes: None,
            avatar_url: None,
            xhs_bio: None,
            xhs_follows: None,
            ip_location: None,
            xhs_tags: None,
        })
        .expect("empty capture should leave prior values intact"));
    let profile = db
        .snapshot()
        .expect("read updated profile")
        .profile
        .unwrap();
    assert_eq!(profile.display_name.as_deref(), Some("主页昵称"));
    assert_eq!(profile.followers, 4200);
    assert_eq!(profile.total_notes, 28);
    assert_eq!(
        profile.avatar_url.as_deref(),
        Some("https://sns-img-bd.xhscdn.com/avatar/1.jpg")
    );
    assert_eq!(profile.xhs_bio.as_deref(), Some("红薯生活记录"));
    assert_eq!(profile.xhs_follows, 128);
    assert_eq!(profile.ip_location.as_deref(), Some("上海"));
    assert_eq!(profile.xhs_tags, vec!["生活方式", "家居"]);
    assert!(profile.crawled_at.is_some());
    let pool = db.account_pool().expect("read account pool");
    assert_eq!(pool.items[0].followers, 4200);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn browser_profile_snapshot_updates_the_matching_scoped_reference_account() {
    let (db, dir) = temp_db();
    db.upsert_local_reference_account_api(LocalReferenceAccountApiUpsert {
        account_pool_id: 1,
        account_id: "creator-321".to_string(),
        name: Some("creator-321".to_string()),
        followers: 10,
        note_count: 2,
        avg_likes: 0.0,
        avg_comments: 0.0,
        avg_collects: 0.0,
        content_style: None,
        top_notes: Vec::new(),
    })
    .expect("create reference account");
    let reference = db
        .snapshot_for_account(Some(1))
        .expect("read references")
        .reference_accounts
        .remove(0);
    assert_eq!(
        db.local_reference_account_id_for_capture(1, "creator-321")
            .expect("look up captured reference"),
        Some(reference.id)
    );
    assert_eq!(
        db.local_reference_account_id_for_capture(1, "unknown-creator")
            .expect("ignore unknown reference"),
        None
    );

    assert!(db
        .update_reference_account_from_browser_snapshot(
            1,
            reference.id,
            "creator-321",
            Some("榜样昵称"),
            Some(5200),
            Some(41),
        )
        .expect("update matching reference"));
    assert!(!db
        .update_reference_account_from_browser_snapshot(
            1,
            reference.id,
            "different-creator",
            Some("错误昵称"),
            Some(1),
            Some(1),
        )
        .expect("ignore mismatched profile"));
    let updated = db
        .snapshot_for_account(Some(1))
        .expect("read updated reference")
        .reference_accounts
        .remove(0);
    assert_eq!(updated.name.as_deref(), Some("榜样昵称"));
    assert_eq!(updated.followers, 5200);
    assert_eq!(updated.note_count, 41);
    assert!(updated.crawled_at.is_some());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn reimporting_a_reference_account_keeps_known_fields_when_new_values_are_unknown() {
    let (db, dir) = temp_db();
    let input = LocalReferenceAccountCreate {
        account_pool_id: 1,
        account_id: "creator-preserved".to_string(),
        name: Some("手工名称".to_string()),
        followers: 321,
    };
    db.create_local_reference_account(input.clone())
        .expect("create reference account");
    db.create_local_reference_account(LocalReferenceAccountCreate {
        account_pool_id: input.account_pool_id,
        account_id: input.account_id,
        name: None,
        followers: 0,
    })
    .expect("reimport without known metadata");
    let saved = db
        .snapshot_for_account(Some(1))
        .expect("read reference account")
        .reference_accounts
        .into_iter()
        .find(|reference| reference.account_id == "creator-preserved")
        .expect("reference should remain");
    assert_eq!(saved.name.as_deref(), Some("手工名称"));
    assert_eq!(saved.followers, 321);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn syncs_bounded_profile_notes_idempotently_and_only_overwrites_complete_aggregates() {
    let (db, dir) = temp_db();
    db.update_local_profile(LocalProfileUpdate {
        account_pool_id: 1,
        account_id: Some("profile-notes-123".to_string()),
        display_name: Some("本人".to_string()),
        niche: None,
        target_audience: None,
        content_pillars: Vec::new(),
        followers: None,
        persona_name: None,
        persona_bio: None,
        persona_tone: None,
        persona_taboos: Vec::new(),
        preferred_styles: Vec::new(),
        preferred_scenes: Vec::new(),
        hashtag_pool: Vec::new(),
        posting_rhythm: None,
        avatar_url: None,
        xhs_bio: None,
        xhs_follows: None,
        ip_location: None,
        xhs_tags: None,
        risk_warning_ack: None,
    })
    .expect("create own profile");
    let notes = vec![
        BrowserProfileNote {
            note_url: "https://www.xiaohongshu.com/explore/profile-note-1".to_string(),
            title: "主页笔记一".to_string(),
            body: "第一篇正文".to_string(),
            likes: Some(20),
            comments: Some(4),
            collects: Some(8),
            tags: vec!["家居".to_string()],
            published_at: Some("2026-09-20".to_string()),
        },
        BrowserProfileNote {
            note_url: "https://www.xiaohongshu.com/discovery/item/profile-note-2".to_string(),
            title: "主页笔记二".to_string(),
            body: "第二篇正文".to_string(),
            likes: Some(10),
            comments: Some(2),
            collects: Some(6),
            tags: vec!["收纳".to_string()],
            published_at: None,
        },
    ];

    let first = db
        .sync_profile_notes_from_browser_snapshot(1, "profile-notes-123", None, true, &notes)
        .expect("import complete own-profile notes");
    assert!(first.matched_profile);
    assert_eq!(first.imported, 2);
    assert_eq!(first.updated, 0);

    let conn = db.connect().expect("connect test database");
    conn.execute(
        "UPDATE notes SET title = '手动标题', body = '手动正文'
         WHERE account_pool_id = 1 AND note_url = ?1",
        params![notes[0].note_url],
    )
    .expect("simulate operator edits");
    drop(conn);
    let changed_notes = notes
        .iter()
        .cloned()
        .map(|mut note| {
            note.title = "平台新标题".to_string();
            note.body = "平台新正文".to_string();
            note.likes = note.likes.map(|value| value + 10);
            note
        })
        .collect::<Vec<_>>();
    let second = db
        .sync_profile_notes_from_browser_snapshot(
            1,
            "profile-notes-123",
            None,
            false,
            &changed_notes,
        )
        .expect("update partially loaded notes");
    assert_eq!(second.imported, 0);
    assert_eq!(second.updated, 2);
    let snapshot = db.snapshot().expect("read synced notes");
    assert_eq!(snapshot.profile.as_ref().unwrap().total_likes, 30);
    assert_eq!(snapshot.profile.as_ref().unwrap().total_collects, 14);
    assert_eq!(snapshot.profile.as_ref().unwrap().avg_likes, 15.0);
    let saved = snapshot
        .notes
        .iter()
        .find(|note| note.note_url.as_deref() == Some(notes[0].note_url.as_str()))
        .expect("first note should be visible");
    assert_eq!(saved.title.as_deref(), Some("手动标题"));
    assert_eq!(saved.body.as_deref(), Some("手动正文"));
    assert_eq!(saved.likes, 30);

    let unmatched = db
        .sync_profile_notes_from_browser_snapshot(1, "not-registered", None, true, &notes)
        .expect("ignore an unregistered creator");
    assert!(!unmatched.matched_profile && !unmatched.matched_reference);
    assert!(db
        .sync_profile_notes_from_browser_snapshot(
            1,
            "profile-notes-123",
            None,
            true,
            &[BrowserProfileNote {
                note_url: "https://example.com/explore/unsafe".to_string(),
                ..notes[0].clone()
            }],
        )
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn syncs_reference_notes_into_reference_data_without_polluting_own_notes() {
    let (db, dir) = temp_db();
    db.upsert_local_reference_account_api(LocalReferenceAccountApiUpsert {
        account_pool_id: 1,
        account_id: "creator-notes-456".to_string(),
        name: Some("榜样".to_string()),
        followers: 500,
        note_count: 10,
        avg_likes: 0.0,
        avg_comments: 0.0,
        avg_collects: 0.0,
        content_style: None,
        top_notes: Vec::new(),
    })
    .expect("create reference profile");
    let reference = db
        .snapshot_for_account(Some(1))
        .expect("read reference")
        .reference_accounts
        .remove(0);
    let notes = vec![BrowserProfileNote {
        note_url: "https://www.xiaohongshu.com/explore/reference-note".to_string(),
        title: "榜样笔记".to_string(),
        body: "榜样正文".to_string(),
        likes: Some(80),
        comments: Some(12),
        collects: Some(32),
        tags: Vec::new(),
        published_at: None,
    }];
    let result = db
        .sync_profile_notes_from_browser_snapshot(
            1,
            "creator-notes-456",
            Some(reference.id),
            true,
            &notes,
        )
        .expect("sync reference notes");
    assert!(result.matched_reference);
    assert_eq!(result.imported, 0);
    let snapshot = db.snapshot().expect("own note list remains scoped");
    assert!(snapshot.notes.is_empty());
    let saved = snapshot.reference_accounts.first().unwrap();
    assert_eq!(saved.total_likes, 80);
    assert_eq!(saved.avg_likes, 80.0);
    assert_eq!(saved.top_notes[0].title, "榜样笔记");
    assert!(saved
        .raw_data
        .as_deref()
        .unwrap()
        .contains("reference-note"));

    let partial_notes = vec![
        BrowserProfileNote {
            note_url: "https://www.xiaohongshu.com/explore/reference-note-partial-1".to_string(),
            title: "已显示赞数的样本".to_string(),
            body: String::new(),
            likes: Some(20),
            comments: None,
            collects: None,
            tags: Vec::new(),
            published_at: Some("2026-09-20".to_string()),
        },
        BrowserProfileNote {
            note_url: "https://www.xiaohongshu.com/explore/reference-note-partial-2".to_string(),
            title: "互动数据缺失的样本".to_string(),
            body: String::new(),
            likes: None,
            comments: None,
            collects: None,
            tags: Vec::new(),
            published_at: None,
        },
    ];
    db.sync_profile_notes_from_browser_snapshot(
        1,
        "creator-notes-456",
        Some(reference.id),
        false,
        &partial_notes,
    )
    .expect("sync partial reference sample");
    let partial = db.snapshot().expect("read partial reference sample");
    let saved = partial.reference_accounts.first().unwrap();
    assert_eq!(saved.avg_likes, 20.0);
    assert_eq!(
        saved.avg_comments, 12.0,
        "missing comment counters must not be written as zero"
    );
    assert_eq!(
        saved.avg_collects, 32.0,
        "missing collect counters must not be written as zero"
    );
    let evidence: serde_json::Value =
        serde_json::from_str(saved.raw_data.as_deref().unwrap()).expect("read sample evidence");
    assert_eq!(evidence["scope"]["state"], "partial");
    assert_eq!(evidence["scope"]["loadedNotes"], 2);
    assert_eq!(evidence["metricSamples"]["likes"], 1);
    assert_eq!(evidence["metricSamples"]["comments"], 0);
    assert_eq!(evidence["metricSamples"]["collects"], 0);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn updates_note_item_order_and_rejects_cross_account_item() {
    let (db, dir) = temp_db();
    let note = db.create_local_draft("素材关联测试").expect("create draft");
    let conn = db.connect().expect("connect test db");
    conn.execute(
        "INSERT INTO items (id, title, image_path, account_pool_id) VALUES
             (1001, 'A-1', 'fixtures/a-1.png', 1),
             (1002, 'A-2', 'fixtures/a-2.png', 1)",
        [],
    )
    .expect("insert active account items");
    conn.execute(
        "INSERT INTO account_pool (id, alias, role, user_data_dir, status)
             VALUES (2, 'B', 'operation', 'browser_profiles/B', 'active')",
        [],
    )
    .expect("insert second account");
    conn.execute(
        "INSERT INTO items (id, title, image_path, account_pool_id)
             VALUES (2001, 'B-1', 'fixtures/b-1.png', 2)",
        [],
    )
    .expect("insert other account item");
    drop(conn);

    let ordered = db
        .update_local_note_items(LocalNoteItemsUpdate {
            note_id: note.id,
            account_pool_id: 1,
            expected_version: 1,
            item_ids: vec![1002, 1001],
        })
        .expect("save item order");
    assert_eq!(ordered.item_ids, vec![1002, 1001]);
    assert_eq!(ordered.item_id, Some(1002));
    assert_eq!(ordered.content_version, 2);

    let cross_account = db.update_local_note_items(LocalNoteItemsUpdate {
        note_id: note.id,
        account_pool_id: 1,
        expected_version: 2,
        item_ids: vec![1002, 2001],
    });
    assert!(cross_account.is_err());
    let snapshot = db.snapshot().expect("read unchanged association");
    assert_eq!(snapshot.notes[0].item_ids, vec![1002, 1001]);
    assert_eq!(snapshot.notes[0].content_version, 2);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn reads_active_item_image_as_data_url() {
    let (db, dir) = temp_db();
    let assets = dir.join("assets");
    fs::create_dir_all(&assets).expect("create assets dir");
    fs::write(assets.join("sample.png"), b"png-bytes").expect("write image");
    fs::create_dir_all(assets.join("thumbnails")).expect("create thumbnails dir");
    fs::write(assets.join("thumbnails/sample.jpg"), b"thumb-bytes").expect("write thumbnail");

    let conn = db.connect().expect("connect test db");
    conn.execute(
            "INSERT INTO items (title, image_path, thumbnail_path, account_pool_id) VALUES (?1, ?2, ?3, 1)",
            params!["测试图片", "sample.png", "thumbnails/sample.jpg"],
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
    let thumbnail_url = db
        .image_data_url_for_account(item_id, Some(1), "thumbnail")
        .expect("read thumbnail")
        .expect("thumbnail should exist");
    assert!(thumbnail_url.starts_with("data:image/jpeg;base64,"));
    assert!(thumbnail_url.ends_with("dGh1bWItYnl0ZXM="));
    fs::remove_file(assets.join("thumbnails/sample.jpg")).expect("remove thumbnail");
    let fallback_url = db
        .image_data_url_for_account(item_id, Some(1), "thumbnail")
        .expect("fallback to original")
        .expect("original should still exist");
    assert!(fallback_url.ends_with("cG5nLWJ5dGVz"));
    assert!(db
        .image_data_url_for_account(item_id, Some(999), "original")
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn creates_updates_and_retires_local_accounts_without_crossing_active_boundary() {
    let (db, dir) = temp_db();
    db.create_local_account(LocalAccountCreate {
        alias: "辅助采集号".to_string(),
        role: "assistant".to_string(),
        notes: None,
    })
    .expect("create local account");
    let pool = db.account_pool().expect("read account pool");
    let assistant = pool
        .items
        .iter()
        .find(|account| account.alias == "辅助采集号")
        .expect("created assistant");
    assert_eq!(assistant.role, "assistant");
    assert!(!assistant.is_active);

    db.update_local_account(LocalAccountUpdate {
        account_id: assistant.id,
        alias: "辅助采集号-改名".to_string(),
        role: "operation".to_string(),
        xhs_user_id: None,
        display_name: Some("采集辅助".to_string()),
        status: "active".to_string(),
        followers: None,
        notes: None,
    })
    .expect("update local account");
    db.retire_local_account(assistant.id)
        .expect("retire non-active account");
    assert!(db.retire_local_account(1).is_err());

    db.update_local_profile(LocalProfileUpdate {
        account_pool_id: 1,
        account_id: Some("local-main".to_string()),
        display_name: Some("本地主号".to_string()),
        niche: Some("家居".to_string()),
        target_audience: Some("租房人群".to_string()),
        content_pillars: vec!["改造".to_string()],
        followers: None,
        persona_name: Some("红薯主理人".to_string()),
        persona_bio: Some("本地人设".to_string()),
        persona_tone: Some("直接".to_string()),
        persona_taboos: vec!["高级感".to_string()],
        preferred_styles: vec!["实用".to_string()],
        preferred_scenes: vec!["客厅".to_string()],
        hashtag_pool: vec!["家居好物".to_string()],
        posting_rhythm: Some("每周三篇".to_string()),
        avatar_url: None,
        xhs_bio: None,
        xhs_follows: None,
        ip_location: None,
        xhs_tags: None,
        risk_warning_ack: None,
    })
    .expect("update local profile");
    let profile = db
        .snapshot()
        .expect("read profile")
        .profile
        .expect("profile");
    assert_eq!(profile.display_name.as_deref(), Some("本地主号"));
    assert_eq!(profile.content_pillars, vec!["改造".to_string()]);
    db.update_local_profile_stats(1, Some(4200), Some(28), Some(31.5), Some(4.0), Some(12.0))
        .expect("update local profile statistics");
    let profile = db
        .snapshot()
        .expect("read profile statistics")
        .profile
        .unwrap();
    assert_eq!(profile.followers, 4200);
    assert_eq!(profile.total_notes, 28);
    assert_eq!(profile.avg_likes, 31.5);
    assert_eq!(profile.avg_comments, 4.0);
    assert_eq!(profile.avg_collects, 12.0);
    assert!(db
        .update_local_profile_stats(2, Some(1), None, None, None, None)
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn persists_local_inspirations_with_dedupe_and_explicit_conversion() {
    let (db, dir) = temp_db();
    db.save_local_inspiration(LocalInspirationCreate {
        id: "inspiration-a".to_string(),
        account_pool_id: 1,
        title: "租房客厅收纳".to_string(),
        source_url: "https://example.com/a".to_string(),
        body: "观察到收纳筐与墙面颜色形成对比".to_string(),
        observed_at: "2026-09-17T10:00:00.000Z".to_string(),
        reason: "可借鉴配色".to_string(),
        material_type: Some("web_material".to_string()),
        author: Some(String::new()),
        capture_modules: Some(vec![]),
        dedupe_key: Some("1|https://example.com/a|租房客厅收纳".to_string()),
    })
    .expect("save local inspiration");
    assert_eq!(
        db.local_inspirations(Some(1))
            .expect("list inspirations")
            .len(),
        1
    );

    db.save_local_inspiration(LocalInspirationCreate {
        id: "inspiration-a-retry".to_string(),
        account_pool_id: 1,
        title: "租房客厅收纳（更新）".to_string(),
        source_url: "https://example.com/a".to_string(),
        body: "补充了材质观察".to_string(),
        observed_at: "2026-09-17T10:01:00.000Z".to_string(),
        reason: "更适合当前选题".to_string(),
        material_type: Some("web_material".to_string()),
        author: Some(String::new()),
        capture_modules: Some(vec![]),
        dedupe_key: Some("1|https://example.com/a|租房客厅收纳".to_string()),
    })
    .expect("replace duplicate inspiration");
    let deduped = db
        .local_inspirations(Some(1))
        .expect("list deduped inspirations");
    assert_eq!(deduped.len(), 1);
    assert_eq!(deduped[0].id, "inspiration-a-retry");

    let draft = db.create_local_draft("灵感草稿").expect("create draft");
    let converted = db
        .convert_local_inspiration("inspiration-a-retry", 1, draft.id)
        .expect("convert inspiration");
    assert_eq!(converted.status, "converted");
    assert_eq!(converted.note_id, Some(draft.id));
    db.save_local_inspiration(LocalInspirationCreate {
        id: "inspiration-after-convert".to_string(),
        account_pool_id: 1,
        title: "租房客厅收纳（再次补充）".to_string(),
        source_url: "https://example.com/a".to_string(),
        body: "不应丢失已关联草稿".to_string(),
        observed_at: "2026-09-17T10:02:00.000Z".to_string(),
        reason: "补充观察".to_string(),
        material_type: Some("web_material".to_string()),
        author: Some(String::new()),
        capture_modules: Some(vec![]),
        dedupe_key: Some("1|https://example.com/a|租房客厅收纳".to_string()),
    })
    .expect("update converted inspiration without duplicating it");
    let preserved = db
        .local_inspirations(Some(1))
        .expect("read converted inspiration");
    assert_eq!(preserved.len(), 1);
    assert_eq!(preserved[0].status, "converted");
    assert_eq!(preserved[0].note_id, Some(draft.id));
    assert!(db
        .convert_local_inspiration("inspiration-a-retry", 1, draft.id)
        .is_err());
    assert!(db
        .save_local_inspiration(LocalInspirationCreate {
            id: "bad-url".to_string(),
            account_pool_id: 1,
            title: "非法来源".to_string(),
            source_url: "file:///tmp/a".to_string(),
            body: String::new(),
            observed_at: "2026-09-17T10:00:00.000Z".to_string(),
            reason: String::new(),
            material_type: Some("web_material".to_string()),
            author: Some(String::new()),
            capture_modules: Some(vec![]),
            dedupe_key: None,
        })
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn persists_local_reference_accounts_with_account_boundary() {
    let (db, dir) = temp_db();
    db.create_local_reference_account(LocalReferenceAccountCreate {
        account_pool_id: 1,
        account_id: "reference-001".to_string(),
        name: Some("收纳榜样".to_string()),
        followers: 1200,
    })
    .expect("create local reference account");
    let first = db.snapshot().expect("read reference accounts");
    assert_eq!(first.reference_accounts.len(), 1);
    assert_eq!(first.reference_accounts[0].followers, 1200);

    db.update_local_reference_account(LocalReferenceAccountUpdate {
        id: first.reference_accounts[0].id,
        account_pool_id: 1,
        account_id: "reference-001".to_string(),
        name: Some("收纳榜样-更新".to_string()),
        followers: 1500,
        content_style: Some("{\"keywords\":[\"实用\"]}".to_string()),
        note_count: None,
        avg_likes: None,
        avg_comments: None,
        avg_collects: None,
    })
    .expect("update local reference account");
    let updated = db.snapshot().expect("read updated reference account");
    assert_eq!(
        updated.reference_accounts[0].name.as_deref(),
        Some("收纳榜样-更新")
    );
    assert_eq!(
        updated.reference_accounts[0].content_style.as_deref(),
        Some("{\"keywords\":[\"实用\"]}")
    );

    db.create_local_reference_account(LocalReferenceAccountCreate {
        account_pool_id: 1,
        account_id: "reference-001".to_string(),
        name: Some("幂等更新".to_string()),
        followers: 1600,
    })
    .expect("upsert local reference account");
    assert_eq!(
        db.snapshot()
            .expect("read idempotent account")
            .reference_accounts
            .len(),
        1
    );

    db.delete_local_reference_account(updated.reference_accounts[0].id, 1)
        .expect("delete local reference account");
    assert!(db
        .snapshot()
        .expect("read after delete")
        .reference_accounts
        .is_empty());
    assert!(db
        .create_local_reference_account(LocalReferenceAccountCreate {
            account_pool_id: 1,
            account_id: "".to_string(),
            name: None,
            followers: 0,
        })
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn upserts_full_manual_reference_account_metrics_and_top_notes() {
    let (db, dir) = temp_db();
    db.upsert_local_reference_account_manual(LocalReferenceAccountManualUpsert {
        account_pool_id: 1,
        account_id: "manual-ref-01".to_string(),
        name: "手动榜样".to_string(),
        followers: 3200,
        note_count: 12,
        avg_likes: 45.5,
        avg_comments: 6.0,
        avg_collects: 18.0,
        content_style: Some("生活化、实用".to_string()),
        top_notes: vec![ReferenceNote {
            title: "出租屋收纳实测".to_string(),
            likes: 0,
            url: Some(String::new()),
        }],
    })
    .expect("save complete manual reference account");
    let first = db.snapshot().expect("read manually saved account");
    assert_eq!(first.reference_accounts.len(), 1);
    let saved = &first.reference_accounts[0];
    assert_eq!(saved.account_id, "manual-ref-01");
    assert_eq!(saved.followers, 3200);
    assert_eq!(saved.note_count, 12);
    assert_eq!(saved.avg_likes, 45.5);
    assert_eq!(saved.avg_comments, 6.0);
    assert_eq!(saved.avg_collects, 18.0);
    assert_eq!(saved.total_likes, 546);
    assert_eq!(saved.top_notes[0].title, "出租屋收纳实测");
    assert_eq!(saved.top_notes[0].url.as_deref(), Some(""));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(saved.content_style.as_deref().unwrap()).unwrap()
            ["description"],
        "生活化、实用"
    );

    db.upsert_local_reference_account_manual(LocalReferenceAccountManualUpsert {
        account_pool_id: 1,
        account_id: "manual-ref-01".to_string(),
        name: "手动榜样更新".to_string(),
        followers: 3400,
        note_count: 12,
        avg_likes: 50.0,
        avg_comments: 6.0,
        avg_collects: 19.0,
        content_style: None,
        top_notes: vec![],
    })
    .expect("upsert existing manual reference account");
    let updated = db.snapshot().expect("read updated account");
    assert_eq!(updated.reference_accounts.len(), 1);
    assert_eq!(
        updated.reference_accounts[0].name.as_deref(),
        Some("手动榜样更新")
    );
    assert_eq!(updated.reference_accounts[0].followers, 3400);
    assert_eq!(updated.reference_accounts[0].total_likes, 600);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn imports_scoped_image_with_hash_and_compensation() {
    let (db, dir) = temp_db();
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let tiny_jpeg = "/9j/";
    let imported = db
        .import_local_image(LocalImageImport {
            account_pool_id: 1,
            file_name: "客厅.png".to_string(),
            mime_type: Some("image/png".to_string()),
            data_base64: png.to_string(),
            thumbnail_data_base64: Some(tiny_jpeg.to_string()),
        })
        .expect("import image");
    assert_eq!(imported.title, "客厅");
    assert_eq!(imported.image_version, 1);
    assert_eq!(imported.content_hash.as_deref().map(str::len), Some(64));
    assert!(imported.image_path.starts_with("assets/1/"));
    assert!(dir.join(&imported.image_path).is_file());
    assert!(imported
        .thumbnail_path
        .as_deref()
        .map(|path| dir.join(path).is_file())
        .unwrap_or(false));

    let duplicate = db
        .import_local_image(LocalImageImport {
            account_pool_id: 1,
            file_name: "同一内容.png".to_string(),
            mime_type: Some("image/png".to_string()),
            data_base64: png.to_string(),
            thumbnail_data_base64: None,
        })
        .expect("deduplicate image");
    assert_eq!(duplicate.id, imported.id);
    assert_eq!(db.snapshot().expect("snapshot").item_count, 1);

    let draft = db
        .create_local_draft_from_items(&[imported.id], Some(1))
        .expect("create material draft");
    assert_eq!(draft.item_ids, vec![imported.id]);
    assert_eq!(draft.item_id, Some(imported.id));

    let edited = db
        .update_local_item_metadata(LocalItemMetadataUpdate {
            item_id: imported.id,
            account_pool_id: 1,
            expected_metadata_version: 1,
            title: "更新后的客厅".to_string(),
            tags: vec!["家居".to_string(), "客厅".to_string()],
            style: Some("原木".to_string()),
            material: None,
            scene: Some("室内".to_string()),
            color: Some("暖白".to_string()),
        })
        .expect("update metadata");
    assert_eq!(edited.title, "更新后的客厅");
    assert_eq!(edited.tags, vec!["家居".to_string(), "客厅".to_string()]);
    assert_eq!(edited.metadata_version, 2);
    assert!(db
        .update_local_item_metadata(LocalItemMetadataUpdate {
            item_id: imported.id,
            account_pool_id: 1,
            expected_metadata_version: 1,
            title: "旧回执".to_string(),
            tags: Vec::new(),
            style: None,
            material: None,
            scene: None,
            color: None,
        })
        .is_err());

    // Removing the managed file simulates a broken reference. Re-importing
    // the same content restores it and bumps only the image version.
    fs::remove_file(dir.join(&imported.image_path)).expect("remove broken image");
    let missing = db.snapshot().expect("snapshot with missing image");
    assert_eq!(missing.missing_image_ids, vec![imported.id]);
    let repaired = db
        .repair_local_image(LocalImageRepair {
            item_id: imported.id,
            account_pool_id: 1,
            expected_image_version: 1,
            file_name: "恢复.png".to_string(),
            mime_type: Some("image/png".to_string()),
            data_base64: png.to_string(),
            thumbnail_data_base64: None,
        })
        .expect("repair image");
    assert_eq!(repaired.id, imported.id);
    assert_eq!(repaired.image_version, 2);
    assert!(dir.join(&repaired.image_path).is_file());
    assert!(db
        .snapshot()
        .expect("snapshot after repair")
        .missing_image_ids
        .is_empty());
    assert!(db
        .repair_local_image(LocalImageRepair {
            item_id: imported.id,
            account_pool_id: 1,
            expected_image_version: 1,
            file_name: "过期.png".to_string(),
            mime_type: Some("image/png".to_string()),
            data_base64: png.to_string(),
            thumbnail_data_base64: None,
        })
        .is_err());

    db.delete_local_item(imported.id, 1)
        .expect("soft delete image");
    let trashed = db.snapshot().expect("snapshot with trash");
    assert_eq!(trashed.item_count, 0);
    assert_eq!(trashed.items.len(), 0);
    assert_eq!(trashed.trash_items.len(), 1);
    let restored = db
        .restore_local_item(imported.id, 1)
        .expect("restore image");
    assert_eq!(restored.id, imported.id);
    assert_eq!(db.snapshot().expect("snapshot after restore").item_count, 1);

    let invalid_name = db.import_local_image(LocalImageImport {
        account_pool_id: 1,
        file_name: "../escape.png".to_string(),
        mime_type: Some("image/png".to_string()),
        data_base64: png.to_string(),
        thumbnail_data_base64: None,
    });
    assert!(invalid_name.is_err());
    let invalid_bytes = db.import_local_image(LocalImageImport {
        account_pool_id: 1,
        file_name: "bad.png".to_string(),
        mime_type: Some("image/png".to_string()),
        data_base64: STANDARD.encode(b"not an image"),
        thumbnail_data_base64: None,
    });
    assert!(invalid_bytes.is_err());
    let wrong_account = db.import_local_image(LocalImageImport {
        account_pool_id: 999,
        file_name: "wrong.png".to_string(),
        mime_type: Some("image/png".to_string()),
        data_base64: png.to_string(),
        thumbnail_data_base64: None,
    });
    assert!(wrong_account.is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn stores_image_analysis_without_overwriting_custom_title_or_stale_image() {
    let (db, dir) = temp_db();
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let imported = db
        .import_local_image(LocalImageImport {
            account_pool_id: 1,
            file_name: "tmp-chair.png".to_string(),
            mime_type: Some("image/png".to_string()),
            data_base64: png.to_string(),
            thumbnail_data_base64: None,
        })
        .expect("import test image");
    let analysis = serde_json::json!({
        "title": "藤编椅",
        "style": "北欧",
        "material": "藤编",
        "scene": "客厅",
        "color": "原木色",
        "tags": ["北欧", "藤编"],
        "_raw_response": "{\"title\":\"藤编椅\"}"
    });
    let analyzed = db
        .update_local_item_analysis(
            imported.id,
            1,
            imported.image_version,
            &analysis,
            LocalItemAnalysisTitlePolicy::Force,
        )
        .expect("save image analysis");
    assert_eq!(analyzed.title, "藤编椅");
    assert_eq!(analyzed.style.as_deref(), Some("北欧"));
    assert_eq!(analyzed.tags, vec!["北欧".to_string(), "藤编".to_string()]);
    assert_eq!(analyzed.metadata_version, imported.metadata_version + 1);
    let stored: serde_json::Value = serde_json::from_str(analyzed.analysis_raw.as_deref().unwrap())
        .expect("analysis JSON should round trip");
    assert_eq!(stored["_raw_response"], "{\"title\":\"藤编椅\"}");

    let edited = db
        .update_local_item_metadata(LocalItemMetadataUpdate {
            item_id: analyzed.id,
            account_pool_id: 1,
            expected_metadata_version: analyzed.metadata_version,
            title: "手工指定名称".to_string(),
            tags: analyzed.tags.clone(),
            style: analyzed.style.clone(),
            material: analyzed.material.clone(),
            scene: analyzed.scene.clone(),
            color: analyzed.color.clone(),
        })
        .expect("set a custom title");
    let analyzed_again = db
        .update_local_item_analysis(
            edited.id,
            1,
            edited.image_version,
            &analysis,
            LocalItemAnalysisTitlePolicy::Preserve,
        )
        .expect("save analysis while keeping the custom title");
    assert_eq!(analyzed_again.title, "手工指定名称");

    assert!(db
        .update_local_item_analysis(
            imported.id,
            1,
            imported.image_version + 1,
            &analysis,
            LocalItemAnalysisTitlePolicy::IfDefault,
        )
        .unwrap_err()
        .contains("图片版本已变化"));
    fs::remove_dir_all(dir).ok();
}

#[test]
fn preserves_existing_note_with_legacy_over_limit_items_when_editing_text() {
    let (db, dir) = temp_db();
    let item_ids: Vec<i64> = (1..=10).collect();
    let item_ids_json = serde_json::to_string(&item_ids).expect("serialize legacy item ids");
    let conn = db.connect().expect("open local db");
    for item_id in &item_ids {
        conn.execute(
            "INSERT INTO items (id, title, image_path, account_pool_id)
                 VALUES (?1, ?2, ?3, 1)",
            params![
                item_id,
                format!("素材 {item_id}"),
                format!("assets/{item_id}.jpg")
            ],
        )
        .expect("seed legacy item");
    }
    conn.execute(
        "INSERT INTO notes (item_id, item_ids, title, body, status, account_pool_id)
             VALUES (?1, ?2, '历史十图笔记', '旧正文', 'draft', 1)",
        params![item_ids[0], item_ids_json],
    )
    .expect("seed legacy note");
    let note_id = conn.last_insert_rowid();
    drop(conn);

    let updated = db
        .update_local_note(LocalNoteUpdate {
            note_id,
            account_pool_id: 1,
            expected_version: 1,
            title: "历史十图笔记".to_string(),
            body: "只改正文也应能保存".to_string(),
            tags: Vec::new(),
            note_type: "text".to_string(),
            item_ids,
            video_path: None,
        })
        .expect("preserve existing over-limit association");
    assert_eq!(updated.body.as_deref(), Some("只改正文也应能保存"));
    assert_eq!(updated.content_version, 2);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn rejects_stale_account_context_before_local_write() {
    let (db, dir) = temp_db();
    assert!(db.snapshot_for_account(Some(999)).is_err());
    assert!(db
        .create_local_draft_for_account("不应写入", Some(999))
        .is_err());
    let snapshot = db.snapshot().expect("read unchanged snapshot");
    assert_eq!(snapshot.note_count, 0);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn persists_local_knowledge_preferences_with_account_boundary() {
    let (db, dir) = temp_db();
    let defaults = db
        .local_knowledge_preferences(Some(1))
        .expect("read default knowledge preferences");
    assert!(defaults.use_my_samples);
    assert!(defaults.use_reference_samples);
    assert!(defaults.use_inspirations);

    let saved = db
        .save_local_knowledge_preferences(LocalKnowledgePreferencesUpdate {
            account_pool_id: 1,
            disabled_rule_keys: vec!["top_tag".to_string()],
            use_my_samples: false,
            use_reference_samples: true,
            use_inspirations: false,
        })
        .expect("save knowledge preferences");
    assert_eq!(saved.disabled_rule_keys, vec!["top_tag".to_string()]);
    assert!(!saved.use_my_samples);
    assert!(!saved.use_inspirations);
    assert!(db
        .save_local_knowledge_preferences(LocalKnowledgePreferencesUpdate {
            account_pool_id: 1,
            disabled_rule_keys: vec!["top_tag".to_string(), " top_tag ".to_string()],
            use_my_samples: true,
            use_reference_samples: true,
            use_inspirations: true,
        })
        .is_err());

    drop(db);
    let reopened = LocalDb::open(dir.join("app.db")).expect("reopen local db");
    let restored = reopened
        .local_knowledge_preferences(Some(1))
        .expect("restore knowledge preferences");
    assert_eq!(restored.disabled_rule_keys, vec!["top_tag".to_string()]);
    assert!(!restored.use_my_samples);
    assert!(reopened
        .save_local_knowledge_preferences(LocalKnowledgePreferencesUpdate {
            account_pool_id: 999,
            disabled_rule_keys: Vec::new(),
            use_my_samples: true,
            use_reference_samples: true,
            use_inspirations: true,
        })
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn migrates_disabled_python_knowledge_rules_separately_from_prompt_configs() {
    let (db, dir) = temp_db();
    let conn = db.connect().expect("connect test db");
    conn.execute_batch(
        "CREATE TABLE prompt_configs (
             key TEXT PRIMARY KEY, label TEXT NOT NULL, prompt TEXT NOT NULL,
             sort_order INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1
         );
         INSERT INTO prompt_configs (key, label, prompt, sort_order, enabled) VALUES
             ('quick_title', '生成标题', '给笔记生成标题', 0, 1),
             ('rule_title_len', '标题字数', '', 10, 0),
             ('rule_best_hour', '最佳发布时段', '', 11, 1);",
    )
    .expect("create legacy Python prompt settings");
    drop(conn);

    let preferences = db
        .local_knowledge_preferences(Some(1))
        .expect("import legacy disabled rules");
    assert_eq!(preferences.disabled_rule_keys, vec!["rule_title_len"]);
    let prompts = db
        .list_prompt_configs(Some(1))
        .expect("load legacy quick prompt configs");
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0].key, "quick_title");

    let context = db
        .local_content_knowledge_context(Some(1))
        .expect("build context using migrated switch");
    assert!(!context.rules.iter().any(|rule| rule.contains("字标题")));
    fs::remove_dir_all(dir).ok();
}

#[test]
fn builds_account_scoped_content_knowledge_context() {
    let (db, dir) = temp_db();
    let conn = db.connect().expect("connect test db");
    conn.execute(
        "INSERT INTO account_pool (id, alias, role, user_data_dir, status)
         VALUES (2, 'Other', 'operation', 'browser_profiles/Other', 'active')",
        [],
    )
    .expect("insert isolated account");
    conn.execute(
        "INSERT INTO notes (title, body, tags, status, likes, comments, collects,
                            published_at, use_as_reference, account_pool_id)
         VALUES
            ('收纳神器', '自己账号里值得参考的笔记正文，补充细节。', '[\"#收纳\",\"租房\"]', 'published', 100, 8, 50, '2026-09-20 10:12:00', 1, 1),
            ('租房好物', '第二条参考', '[\"#收纳\"]', 'published', 80, 6, 20, '2026-09-20 10:35:00', 0, 1),
            ('另一个账号', '不能混入当前上下文', '[\"串号\"]', 'published', 9999, 0, 0, '2026-09-20 22:00:00', 1, 2)",
        [],
    )
    .expect("insert sample notes");
    conn.execute(
        "INSERT INTO reference_accounts (account_pool_id, account_id, name, top_notes)
         VALUES (1, 'ref-1', '收纳榜样', '[{\"title\":\"榜样标题\",\"body\":\"榜样正文内容\",\"likes\":321}]')",
        [],
    )
    .expect("insert reference account");
    conn.execute(
        "INSERT INTO inspirations (id, account_pool_id, title, observed_at, status, created_at)
         VALUES ('inspiration-1', 1, '周末整理灵感', '2026-09-20', 'saved', '2026-09-20')",
        [],
    )
    .expect("insert inspiration");
    drop(conn);

    let context = db
        .local_content_knowledge_context(Some(1))
        .expect("build local knowledge context");
    assert!(context.rules.iter().any(|rule| rule.contains("<10 字标题")));
    assert!(context
        .rules
        .iter()
        .any(|rule| rule.contains("10:00 段互动最高")));
    assert!(context
        .rules
        .iter()
        .any(|rule| rule.contains("#收纳 高频且高赞")));
    assert!(context
        .rules
        .iter()
        .any(|rule| rule.contains("收藏/点赞比可达 50%")));
    assert_eq!(context.my_samples.len(), 1);
    assert_eq!(context.my_samples[0].title, "收纳神器");
    assert!(context.my_samples[0].body_preview.starts_with("自己账号"));
    assert_eq!(context.reference_samples.len(), 1);
    assert_eq!(
        context.reference_samples[0].account.as_deref(),
        Some("收纳榜样")
    );
    assert_eq!(context.reference_samples[0].body_preview, "榜样正文内容");
    assert_eq!(context.inspirations, vec!["周末整理灵感"]);
    assert!(!context
        .my_samples
        .iter()
        .any(|sample| sample.title == "另一个账号"));

    let conn = db.connect().expect("connect for legacy ref_notes");
    conn.execute(
        "ALTER TABLE reference_accounts ADD COLUMN ref_notes TEXT DEFAULT '[]'",
        [],
    )
    .expect("add legacy Python reference notes column");
    conn.execute(
        "UPDATE reference_accounts SET ref_notes = ?1 WHERE account_pool_id = 1",
        [r#"[{"title":"旧榜样正文","body":"旧库中保留的参考正文","likes":654}]"#],
    )
    .expect("store legacy reference note");
    drop(conn);
    let legacy = db
        .local_content_knowledge_context(Some(1))
        .expect("read legacy reference notes");
    assert_eq!(legacy.reference_samples[0].title, "旧榜样正文");
    assert_eq!(
        legacy.reference_samples[0].body_preview,
        "旧库中保留的参考正文"
    );

    db.save_local_knowledge_preferences(LocalKnowledgePreferencesUpdate {
        account_pool_id: 1,
        disabled_rule_keys: vec!["rule_title_len".to_string()],
        use_my_samples: false,
        use_reference_samples: false,
        use_inspirations: false,
    })
    .expect("disable knowledge sources");
    let disabled = db
        .local_content_knowledge_context(Some(1))
        .expect("read disabled context");
    assert!(!disabled.rules.iter().any(|rule| rule.contains("字标题")));
    assert!(disabled.my_samples.is_empty());
    assert!(disabled.reference_samples.is_empty());
    assert!(disabled.inspirations.is_empty());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn lists_and_toggles_account_scoped_knowledge_samples() {
    let (db, dir) = temp_db();
    let conn = db.connect().expect("connect test db");
    conn.execute(
        "INSERT INTO account_pool (id, alias, role, user_data_dir, status)
         VALUES (2, 'Other', 'operation', 'browser_profiles/Other', 'active')",
        [],
    )
    .expect("insert isolated account");
    conn.execute(
        "INSERT INTO notes (title, body, tags, status, likes, comments, collects,
                            published_at, note_url, use_as_reference, account_pool_id)
         VALUES
            ('高赞样本', '  正文预览内容', '[\"#收纳\"]', 'published', 80, 4, 12,
             '2026-09-20 10:00:00', 'https://example.test/note/1', 0, 1),
            ('普通样本', '普通正文', '[]', 'published', 10, 1, 2, NULL, NULL, 1, 1),
            ('草稿不应出现', 'draft body', '[]', 'draft', 999, 0, 0, NULL, NULL, 1, 1),
            ('已删除不应出现', 'deleted body', '[]', 'published', 999, 0, 0, NULL, NULL, 1, 1),
            ('其他账号不应出现', 'foreign body', '[]', 'published', 9999, 0, 0, NULL, NULL, 1, 2)",
        [],
    )
    .expect("insert sample notes");
    conn.execute(
        "UPDATE notes SET deleted_at = datetime('now') WHERE title = '已删除不应出现'",
        [],
    )
    .expect("soft-delete sample note");
    drop(conn);

    let samples = db
        .local_knowledge_my_samples(Some(1))
        .expect("read own knowledge samples");
    assert_eq!(samples.len(), 2);
    assert_eq!(samples[0].title.as_deref(), Some("高赞样本"));
    assert_eq!(samples[0].body_preview, "正文预览内容");
    assert_eq!(samples[0].tags, vec!["#收纳"]);
    assert_eq!(samples[0].likes, 80);
    assert!(!samples[0].use_as_reference);
    assert_eq!(samples[1].title.as_deref(), Some("普通样本"));
    assert!(samples[1].use_as_reference);

    db.set_local_note_reference_usage(samples[0].id, 1, true)
        .expect("enable sample");
    assert!(db.local_knowledge_my_samples(Some(1)).unwrap()[0].use_as_reference);
    assert!(db
        .set_local_note_reference_usage(i64::MAX, 1, true)
        .is_err());
    assert!(db
        .set_local_note_reference_usage(samples[0].id, 2, false)
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn preserves_and_manages_reference_samples_in_legacy_and_current_columns() {
    let (db, dir) = temp_db();
    db.create_local_reference_account(LocalReferenceAccountCreate {
        account_pool_id: 1,
        account_id: "knowledge-ref".to_string(),
        name: Some("经验榜样".to_string()),
        followers: 100,
    })
    .expect("create reference account");
    let conn = db.connect().expect("connect test db");
    conn.execute(
        "UPDATE reference_accounts SET top_notes = ?1 WHERE account_id = 'knowledge-ref'",
        [r#"[{"title":"当前字段样本","body":"当前正文","likes":25,"url":"https://example.test/current"}]"#],
    )
    .expect("seed current top_notes");
    drop(conn);

    let current = db
        .local_knowledge_reference_samples(Some(1))
        .expect("read current reference samples");
    assert_eq!(current.len(), 1);
    assert_eq!(current[0].account_id, "knowledge-ref");
    assert_eq!(current[0].name, "经验榜样");
    assert_eq!(current[0].notes[0].title, "当前字段样本");
    assert_eq!(
        current[0].notes[0].note_url.as_deref(),
        Some("https://example.test/current")
    );

    assert_eq!(
        db.add_local_knowledge_reference_sample(
            "knowledge-ref",
            1,
            "当前字段样本",
            None,
            25,
            None,
        )
        .unwrap(),
        (true, 1),
    );
    assert_eq!(
        db.add_local_knowledge_reference_sample(
            "knowledge-ref",
            1,
            "新添加样本",
            Some("补充正文"),
            80,
            Some("https://example.test/new"),
        )
        .unwrap(),
        (false, 2),
    );
    assert_eq!(
        db.delete_local_knowledge_reference_sample("knowledge-ref", 1, 0)
            .unwrap(),
        1,
    );
    let remaining = db.local_knowledge_reference_samples(Some(1)).unwrap();
    assert_eq!(remaining[0].notes.len(), 1);
    assert_eq!(remaining[0].notes[0].title, "新添加样本");
    assert_eq!(remaining[0].notes[0].body, "补充正文");
    assert!(db
        .delete_local_knowledge_reference_sample("knowledge-ref", 1, 1)
        .is_err());
    assert!(db
        .add_local_knowledge_reference_sample("knowledge-ref", 999, "串号", None, 0, None)
        .is_err());

    let conn = db.connect().expect("connect legacy test db");
    conn.execute(
        "ALTER TABLE reference_accounts ADD COLUMN ref_notes TEXT DEFAULT '[]'",
        [],
    )
    .expect("add legacy reference notes column");
    conn.execute(
        "UPDATE reference_accounts SET ref_notes = ?1 WHERE account_id = 'knowledge-ref'",
        [r#"[{"title":"旧字段样本","body":"旧正文","likes":654,"note_url":"https://example.test/legacy","external_key":"keep-me"}]"#],
    )
    .expect("seed legacy ref_notes");
    drop(conn);

    let legacy = db
        .local_knowledge_reference_samples(Some(1))
        .expect("read legacy reference samples");
    assert_eq!(legacy.len(), 1);
    assert_eq!(legacy[0].notes[0].title, "旧字段样本");
    assert_eq!(legacy[0].notes[0].body, "旧正文");
    assert_eq!(
        legacy[0].notes[0].note_url.as_deref(),
        Some("https://example.test/legacy")
    );
    let old_contract = db.legacy_knowledge_reference_samples(Some(1)).unwrap();
    assert_eq!(old_contract[0]["notes"][0]["external_key"], "keep-me");
    assert_eq!(
        db.add_local_knowledge_reference_sample("knowledge-ref", 1, "旧字段新增", None, 2, None,)
            .unwrap(),
        (false, 2),
    );
    fs::remove_dir_all(dir).ok();
}

#[test]
fn creates_local_prompt_draft_with_ordered_items_and_audit_trail() {
    let (db, dir) = temp_db();
    let conn = db.connect().expect("connect test db");
    conn.execute(
        "INSERT INTO items (id, title, image_path, account_pool_id) VALUES
             (1201, '先搭配的物品', 'fixtures/one.png', 1),
             (1202, '后搭配的物品', 'fixtures/two.png', 1)",
        [],
    )
    .expect("insert account items");
    drop(conn);

    let note = db
        .create_local_prompt_draft_from_items(
            &[1202, 1201],
            1,
            Some("reference-1"),
            "prompt audit text",
        )
        .expect("create prompt draft");
    assert_eq!(note.item_ids, vec![1202, 1201]);
    assert_eq!(note.item_id, Some(1202));
    assert_eq!(note.account_ref.as_deref(), Some("reference-1"));
    assert_eq!(note.prompt_used.as_deref(), Some("prompt audit text"));
    assert!(db
        .create_local_prompt_draft_from_items(&[1201], 999, None, "must not save")
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn moves_local_note_to_trash_and_restores_with_account_boundary() {
    let (db, dir) = temp_db();
    let note = db
        .create_local_draft("可恢复的本地笔记")
        .expect("create note");
    let deleted = db
        .delete_local_note(note.id, 1)
        .expect("move note to trash");
    assert!(deleted.deleted_at.is_some());
    let trashed = db.snapshot().expect("snapshot with note trash");
    assert!(trashed.notes.is_empty());
    assert_eq!(trashed.trash_notes.len(), 1);
    assert!(db.delete_local_note(note.id, 1).is_err());
    assert!(db.restore_local_note(note.id, 999).is_err());
    let restored = db.restore_local_note(note.id, 1).expect("restore note");
    assert!(restored.deleted_at.is_none());
    let after = db.snapshot().expect("snapshot after note restore");
    assert_eq!(after.notes.len(), 1);
    assert!(after.trash_notes.is_empty());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn permanently_purges_only_unreferenced_trashed_items() {
    let (db, dir) = temp_db();
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let imported = db
        .import_local_image(LocalImageImport {
            account_pool_id: 1,
            file_name: "需保护.png".to_string(),
            mime_type: Some("image/png".to_string()),
            data_base64: png.to_string(),
            thumbnail_data_base64: None,
        })
        .expect("import item");
    let note = db
        .create_local_draft_from_items(&[imported.id], Some(1))
        .expect("create associated note");
    db.delete_local_item(imported.id, 1)
        .expect("move item to trash");
    let blocked = db.purge_local_items(&[imported.id], 1);
    assert!(blocked.is_err());
    assert!(dir.join(&imported.image_path).is_file());

    // A trashed note still protects its referenced material.
    db.delete_local_note(note.id, 1)
        .expect("move associated note to trash");
    assert!(db.purge_local_items(&[imported.id], 1).is_err());

    let conn = db.connect().expect("connect to clear test association");
    conn.execute(
        "UPDATE notes SET item_id = NULL, item_ids = '[]' WHERE id = ?1",
        params![note.id],
    )
    .expect("clear test association");
    drop(conn);
    let purged = db
        .purge_local_items(&[imported.id], 1)
        .expect("purge unreferenced item");
    assert_eq!(purged.purged_ids, vec![imported.id]);
    assert!(!dir.join(&imported.image_path).exists());
    let count: i64 = db
        .connect()
        .expect("reopen after purge")
        .query_row(
            "SELECT COUNT(*) FROM items WHERE id = ?1",
            params![imported.id],
            |row| row.get(0),
        )
        .expect("read purged item count");
    assert_eq!(count, 0);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn persists_local_ai_runs_with_scope_and_status() {
    let (db, dir) = temp_db();
    let note = db
        .create_local_draft_for_account("AI 测试", Some(1))
        .expect("create note");
    let started = db
        .upsert_local_ai_run(LocalAIRunUpsert {
            run_id: "run-local-1".to_string(),
            account_pool_id: Some(1),
            note_id: Some(note.id),
            item_id: None,
            provider: "local-cli".to_string(),
            started_at: "2026-09-17T10:00:00Z".to_string(),
            status: "running".to_string(),
            finished_at: None,
            error: None,
        })
        .expect("save running metadata");
    assert_eq!(started.status, "running");
    let latest = db
        .latest_local_ai_run(Some(1), Some(note.id), None)
        .expect("read latest run")
        .expect("run exists");
    assert_eq!(latest.run_id, "run-local-1");
    let completed = db
        .update_local_ai_run(LocalAIRunUpdate {
            run_id: "run-local-1".to_string(),
            account_pool_id: Some(1),
            status: "completed".to_string(),
            finished_at: Some("2026-09-17T10:00:01Z".to_string()),
            error: None,
        })
        .expect("finish run");
    assert_eq!(completed.status, "completed");
    let preserved = db
        .upsert_local_ai_run(LocalAIRunUpsert {
            run_id: "run-local-1".to_string(),
            account_pool_id: Some(1),
            note_id: Some(note.id),
            item_id: None,
            provider: "local-cli".to_string(),
            started_at: "2026-09-17T10:00:00Z".to_string(),
            status: "running".to_string(),
            finished_at: None,
            error: None,
        })
        .expect("late start write is idempotent");
    assert_eq!(preserved.status, "completed");
    let artifact = db
        .save_local_ai_artifact(LocalAIRunArtifactCreate {
            run_id: "run-local-1".to_string(),
            account_pool_id: Some(1),
            note_id: Some(note.id),
            item_id: None,
            kind: "assistant_text".to_string(),
            content: "第一版输出".to_string(),
        })
        .expect("save artifact");
    assert_eq!(artifact.content, "第一版输出");
    let replaced = db
        .save_local_ai_artifact(LocalAIRunArtifactCreate {
            run_id: "run-local-1".to_string(),
            account_pool_id: Some(1),
            note_id: Some(note.id),
            item_id: None,
            kind: "assistant_text".to_string(),
            content: "最终输出".to_string(),
        })
        .expect("replace artifact idempotently");
    assert_eq!(replaced.id, artifact.id);
    let artifacts = db
        .local_ai_artifacts(Some(1), Some(note.id), None)
        .expect("read artifacts");
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].content, "最终输出");
    assert!(db
        .save_local_ai_artifact(LocalAIRunArtifactCreate {
            run_id: "run-local-1".to_string(),
            account_pool_id: Some(2),
            note_id: Some(note.id),
            item_id: None,
            kind: "assistant_text".to_string(),
            content: "越权输出".to_string(),
        })
        .is_err());
    assert!(db
        .latest_local_ai_run(Some(2), Some(note.id), None)
        .is_err());
    assert!(db
        .upsert_local_ai_run(LocalAIRunUpsert {
            run_id: "run-local-2".to_string(),
            account_pool_id: None,
            note_id: Some(note.id),
            item_id: None,
            provider: "local-cli".to_string(),
            started_at: "2026-09-17T10:00:00Z".to_string(),
            status: "running".to_string(),
            finished_at: None,
            error: None,
        })
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn persists_publish_outbox_and_blocks_duplicate_snapshot_submission() {
    let (db, dir) = temp_db();
    let note = db
        .create_local_draft_for_account("发布 outbox 测试", Some(1))
        .expect("create note");
    let snapshot = LocalPublishOutboxPrepare {
        attempt_id: "publish-test-attempt-1".to_string(),
        account_pool_id: 1,
        note_id: note.id,
        snapshot_key: format!("1:note:{}:v{}", note.id, note.content_version),
        content_version: note.content_version,
        snapshot_json: r#"{"title":"发布 outbox 测试","body":"正文","tags":[],"itemIds":[]}"#
            .to_string(),
    };
    let prepared = db
        .prepare_local_publish(snapshot.clone())
        .expect("prepare local publish");
    assert_eq!(prepared.status, "prepared");
    let submitted = db
        .update_local_publish(LocalPublishOutboxUpdate {
            attempt_id: prepared.attempt_id.clone(),
            account_pool_id: 1,
            status: "submitted".to_string(),
            platform_url: None,
            error: None,
        })
        .expect("record submitted");
    assert_eq!(submitted.status, "submitted");
    let duplicate = db
        .prepare_local_publish(LocalPublishOutboxPrepare {
            attempt_id: "publish-test-attempt-2".to_string(),
            ..snapshot
        })
        .expect("reuse submitted snapshot without creating duplicate");
    assert_eq!(duplicate.attempt_id, prepared.attempt_id);
    let history = db
        .local_publish_outbox(Some(1), Some(note.id))
        .expect("read publish history");
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, "submitted");
    assert!(db
        .update_local_publish(LocalPublishOutboxUpdate {
            attempt_id: prepared.attempt_id,
            account_pool_id: 2,
            status: "confirmed".to_string(),
            platform_url: None,
            error: None,
        })
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn reads_existing_workspace_history_without_recreating_it() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "aichihongshu-legacy-db-{}-{suffix}",
        std::process::id()
    ));
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
                     display_name TEXT, niche TEXT, followers INTEGER DEFAULT 0,
                     total_notes INTEGER DEFAULT 0
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
    assert_eq!(snapshot.notes[0].video_path, None);
    assert_eq!(
        snapshot.reference_accounts[0].name.as_deref(),
        Some("历史榜样")
    );
    assert_eq!(
        snapshot.reference_accounts[0].top_notes[0].title,
        "参考笔记"
    );
    let migrated_profile = snapshot.profile.expect("legacy profile");
    assert_eq!(migrated_profile.display_name.as_deref(), Some("历史账号"));
    let legacy_created_at = migrated_profile
        .created_at
        .clone()
        .filter(|value| !value.is_empty())
        .expect("backfill profile creation timestamp from a legacy schema");
    db.update_local_profile(LocalProfileUpdate {
        account_pool_id: 1,
        account_id: Some("history-user-updated".to_string()),
        display_name: Some("迁移后人设".to_string()),
        niche: Some("家居改造".to_string()),
        target_audience: Some("租房人群".to_string()),
        content_pillars: vec!["收纳".to_string()],
        followers: None,
        persona_name: Some("历史主号人设".to_string()),
        persona_bio: Some("兼容旧表结构".to_string()),
        persona_tone: Some("清晰".to_string()),
        persona_taboos: vec![],
        preferred_styles: vec!["实用".to_string()],
        preferred_scenes: vec!["客厅".to_string()],
        hashtag_pool: vec!["家居改造".to_string()],
        posting_rhythm: Some("每周三篇".to_string()),
        avatar_url: None,
        xhs_bio: None,
        xhs_follows: None,
        ip_location: None,
        xhs_tags: None,
        risk_warning_ack: None,
    })
    .expect("update profile on legacy table without unique constraint");
    let updated = db.snapshot().expect("read updated legacy profile");
    assert_eq!(
        updated.profile.as_ref().unwrap().display_name.as_deref(),
        Some("迁移后人设")
    );
    assert_eq!(
        updated.profile.unwrap().created_at.as_deref(),
        Some(legacy_created_at.as_str())
    );

    let second_account = db
        .create_local_account(LocalAccountCreate {
            alias: "新主号".to_string(),
            role: "operation".to_string(),
            notes: None,
        })
        .expect("create profile on a migrated legacy schema without a column default");
    db.activate_account(second_account)
        .expect("activate second account");
    let created_profile = db
        .snapshot()
        .expect("read profile created after migration")
        .profile
        .expect("second account profile");
    assert!(created_profile
        .created_at
        .as_deref()
        .is_some_and(|value| !value.is_empty()));
    fs::remove_dir_all(dir).ok();
}

#[test]
fn migrates_legacy_inspirations_before_creating_scope_indexes() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "aichihongshu-legacy-inspiration-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).expect("create temp dir");
    let path = dir.join("app.db");
    let legacy = Connection::open(&path).expect("open legacy db");
    legacy
        .execute_batch(
            "CREATE TABLE account_pool (
                     id INTEGER PRIMARY KEY, alias TEXT NOT NULL, role TEXT NOT NULL,
                     user_data_dir TEXT NOT NULL, status TEXT NOT NULL
                 );
                 CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
                 CREATE TABLE inspirations (
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     title TEXT NOT NULL,
                     keyword TEXT,
                     source TEXT DEFAULT 'ai',
                     likes_ref INTEGER DEFAULT 0,
                     note_ref TEXT,
                     saved INTEGER DEFAULT 1,
                     created_at TEXT
                 );
                 INSERT INTO account_pool VALUES (1, '主号', 'operation', '/tmp/profile', 'active');
                 INSERT INTO app_settings VALUES ('active_account_id', '1', NULL);
                 INSERT INTO inspirations
                   (id, title, keyword, source, likes_ref, note_ref, saved, created_at)
                 VALUES
                   (7, '旧灵感', '旧观察', 'ai', 321, '旧笔记链接', 1, '2026-09-18 10:00:00'),
                   (8, '已删除灵感', '不应显示', 'crawl', 8, '旧链接', 0, '2026-09-17 10:00:00');",
        )
        .expect("seed legacy inspirations");
    drop(legacy);

    let db = LocalDb::open(path.clone()).expect("migrate legacy inspirations");
    let migrated = db
        .local_inspirations(Some(1))
        .expect("read migrated inspirations");
    assert_eq!(migrated.len(), 1);
    assert_eq!(migrated[0].id, "legacy-7");
    assert_eq!(migrated[0].title, "旧灵感");
    assert_eq!(migrated[0].body, "旧观察");
    assert_eq!(migrated[0].reason, "ai");
    assert_eq!(migrated[0].source_url, "");
    let legacy_rows = db
        .legacy_knowledge_inspirations(Some(1))
        .expect("read legacy-compatible inspiration fields");
    assert_eq!(legacy_rows.len(), 1);
    assert_eq!(legacy_rows[0].id, 7);
    assert_eq!(legacy_rows[0].keyword.as_deref(), Some("旧观察"));
    assert_eq!(legacy_rows[0].source, "ai");
    assert_eq!(legacy_rows[0].likes_ref, 321);
    assert_eq!(legacy_rows[0].note_ref.as_deref(), Some("旧笔记链接"));
    assert!(legacy_rows[0].saved);

    let created_legacy = db
        .create_legacy_knowledge_inspiration(
            "新手工灵感",
            Some("租房收纳"),
            "manual",
            12,
            Some("https://example.test/reference"),
        )
        .expect("create legacy-compatible inspiration");
    assert!(created_legacy.id > 8);
    assert_eq!(created_legacy.keyword.as_deref(), Some("租房收纳"));
    assert_eq!(created_legacy.likes_ref, 12);
    db.delete_legacy_knowledge_inspiration(created_legacy.id, 1)
        .expect("soft-delete legacy-compatible inspiration");
    assert_eq!(db.legacy_knowledge_inspirations(Some(1)).unwrap().len(), 1);

    db.save_local_inspiration(LocalInspirationCreate {
        id: "new-inspiration".to_string(),
        account_pool_id: 1,
        title: "新灵感".to_string(),
        source_url: "https://example.com/note".to_string(),
        body: "新观察".to_string(),
        observed_at: "2026-09-18T11:00:00Z".to_string(),
        reason: "手工".to_string(),
        material_type: Some("web_material".to_string()),
        author: Some(String::new()),
        capture_modules: Some(vec![]),
        dedupe_key: None,
    })
    .expect("write UUID-like inspiration id after migration");
    drop(db);

    let reopened = LocalDb::open(path.clone()).expect("reopen migrated inspirations");
    let restored = reopened
        .local_inspirations(Some(1))
        .expect("read restored inspirations");
    assert_eq!(restored.len(), 2);
    let conn = reopened.connect().expect("open migrated database");
    let legacy_table_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'inspirations_legacy_v1'",
            [],
            |row| row.get(0),
        )
        .expect("check legacy table cleanup");
    assert_eq!(legacy_table_count, 0);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn persists_local_prompt_configs_and_note_stats_with_account_and_version_guards() {
    let (db, dir) = temp_db();
    let defaults = db
        .list_prompt_configs(Some(1))
        .expect("list default prompts");
    assert_eq!(defaults.len(), 4);
    db.upsert_prompt_config(PromptConfigUpsert {
        account_pool_id: 1,
        key: "custom_test".to_string(),
        label: "测试动作".to_string(),
        prompt: "请检查这篇笔记".to_string(),
        sort_order: 10,
        enabled: true,
    })
    .expect("save local prompt");
    let prompts = db.list_prompt_configs(Some(1)).expect("read local prompts");
    assert_eq!(
        prompts.last().map(|prompt| prompt.key.as_str()),
        Some("custom_test")
    );
    db.delete_prompt_config("custom_test", 1)
        .expect("delete local prompt");
    assert!(db
        .list_prompt_configs(Some(1))
        .expect("read prompts after delete")
        .iter()
        .all(|prompt| prompt.key != "custom_test"));

    let draft = db
        .create_local_draft("互动数据测试")
        .expect("create stats note");
    let updated = db
        .update_local_note_stats(LocalNoteStatsUpdate {
            note_id: draft.id,
            account_pool_id: 1,
            expected_version: draft.content_version,
            field: "likes".to_string(),
            value: 42,
        })
        .expect("update local stats");
    assert_eq!(updated.likes, 42);
    assert!(db
        .update_local_note_stats(LocalNoteStatsUpdate {
            note_id: draft.id,
            account_pool_id: 1,
            expected_version: draft.content_version,
            field: "likes".to_string(),
            value: 99,
        })
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn imports_legacy_prompt_configs_into_account_scoped_settings() {
    let (db, dir) = temp_db();
    let conn = db.connect().expect("open local db");
    conn.execute_batch(
        "CREATE TABLE prompt_configs (
                 key TEXT PRIMARY KEY,
                 label TEXT NOT NULL,
                 prompt TEXT NOT NULL,
                 sort_order INTEGER NOT NULL DEFAULT 0,
                 enabled INTEGER NOT NULL DEFAULT 1
             );
             INSERT INTO prompt_configs (key, label, prompt, sort_order, enabled)
             VALUES ('legacy_prompt', '旧提示词', '保留历史配置', 7, 0);",
    )
    .expect("seed legacy prompt configs");
    drop(conn);

    let prompts = db
        .list_prompt_configs(Some(1))
        .expect("import legacy prompt configs");
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0].key, "legacy_prompt");
    assert!(!prompts[0].enabled);

    let conn = db.connect().expect("reopen local db");
    let stored: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'prompt_configs:1'",
            [],
            |row| row.get(0),
        )
        .expect("read account scoped prompt config");
    assert!(stored.contains("legacy_prompt"));
    fs::remove_dir_all(dir).ok();
}

#[test]
fn stages_note_images_in_upload_order_and_clears_after_confirm() {
    let (db, dir) = temp_db();
    let assets_dir = dir.join("assets").join("fixtures");
    fs::create_dir_all(&assets_dir).expect("create fixture assets");
    fs::write(assets_dir.join("a.png"), b"image-a").expect("write fixture a");
    fs::write(assets_dir.join("b.png"), b"image-b").expect("write fixture b");

    let conn = db.connect().expect("connect test db");
    conn.execute(
        "INSERT INTO items (id, title, image_path, account_pool_id) VALUES
             (2001, '第一张', 'fixtures/a.png', 1),
             (2002, '第二张', 'fixtures/b.png', 1)",
        [],
    )
    .expect("insert items");
    let note = db.create_local_draft("暂存顺序测试").expect("create draft");
    // 关联顺序与素材 id 顺序相反，验证暂存序号跟随笔记关联顺序。
    conn.execute(
        "UPDATE notes SET item_ids = '[2002, 2001]' WHERE id = ?1",
        params![note.id],
    )
    .expect("set note item order");

    let stage_dir = dir.join("publish_staging").join(note.id.to_string());
    // 模拟上一次暂存遗留的旧文件，重新准备时必须清理。
    fs::create_dir_all(&stage_dir).expect("create stale stage dir");
    fs::write(stage_dir.join("99_stale.png"), b"stale").expect("write stale file");
    drop(conn);

    let staged = db
        .stage_local_note_images(note.id, None)
        .expect("stage note images");
    assert_eq!(staged.note_id, note.id);
    assert_eq!(staged.stage_dir, stage_dir.display().to_string());
    assert_eq!(staged.files.len(), 2);
    assert_eq!(staged.files[0].index, 1);
    assert_eq!(staged.files[0].item_id, 2002);
    assert_eq!(staged.files[0].filename, "01_b.png");
    assert_eq!(staged.files[0].title, "第二张");
    assert_eq!(staged.files[1].index, 2);
    assert_eq!(staged.files[1].item_id, 2001);
    assert_eq!(staged.files[1].filename, "02_a.png");
    assert!(stage_dir.join("01_b.png").is_file());
    assert!(stage_dir.join("02_a.png").is_file());
    assert_eq!(
        db.local_note_stage_image_bytes(note.id, None, "01_b.png")
            .unwrap(),
        b"image-b"
    );
    assert!(db
        .local_note_stage_image_bytes(note.id, None, "../app.db")
        .is_err());
    assert!(db
        .local_note_stage_image_bytes(note.id, Some(999), "01_b.png")
        .is_err());
    #[cfg(unix)]
    {
        let outside_file = dir.join("outside.png");
        fs::write(&outside_file, b"outside-stage").expect("write external staged image target");
        std::os::unix::fs::symlink(&outside_file, stage_dir.join("link.png"))
            .expect("create staging symlink");
        assert!(db
            .local_note_stage_image_bytes(note.id, None, "link.png")
            .is_err());
    }
    assert!(
        !stage_dir.join("99_stale.png").exists(),
        "重新准备必须清掉上次遗留文件"
    );

    // 账号不匹配时既不能暂存，也不能解析暂存目录。
    assert!(db.stage_local_note_images(note.id, Some(999)).is_err());
    assert!(db.local_note_stage_dir(note.id, Some(999)).is_err());
    // 不存在的笔记不能解析暂存目录。
    assert!(db.local_note_stage_dir(987654, None).is_err());

    db.clear_local_note_stage(note.id, None)
        .expect("clear stage after confirm");
    assert!(!stage_dir.exists());
    // 重复清理幂等。
    db.clear_local_note_stage(note.id, None)
        .expect("clear stage again");

    fs::remove_dir_all(dir).ok();
}

fn sample_memory_create(content: &str) -> MemoryEntryCreate {
    MemoryEntryCreate {
        account_pool_id: 1,
        origin: "pc".to_string(),
        kind: "fact".to_string(),
        content: content.to_string(),
        subject: Some("门后置物架".to_string()),
        scope: Some("租房".to_string()),
        source: Some("用户口述".to_string()),
        source_type: Some("user".to_string()),
        occurred_at: Some("2026-03".to_string()),
        confirm_status: Some("candidate".to_string()),
        enabled: None,
    }
}

#[test]
fn creates_filters_and_deletes_memory_entries() {
    let (db, dir) = temp_db();
    let created = db
        .create_memory_entry(sample_memory_create("旧塑料架踢脚线卡住"))
        .expect("create memory");
    assert_eq!(created.confirm_status, "candidate");
    assert_eq!(created.origin, "pc");
    assert_eq!(created.kind, "fact");
    assert_eq!(created.occurred_at.as_deref(), Some("2026-03"));

    let mobile = db
        .create_memory_entry(MemoryEntryCreate {
            origin: "mobile".to_string(),
            confirm_status: Some("confirmed".to_string()),
            ..sample_memory_create("手机随手记：阳台推拉门尺寸 1.8m")
        })
        .expect("create mobile memory");
    assert_eq!(mobile.origin, "mobile");

    let pc_only = db
        .list_memory_entries(MemoryEntryFilter {
            account_pool_id: Some(1),
            origin: Some("pc".to_string()),
            kind: None,
            confirm_status: None,
            enabled: None,
        })
        .expect("list pc");
    assert_eq!(pc_only.len(), 1);
    assert_eq!(pc_only[0].id, created.id);

    let candidates = db
        .list_memory_entries(MemoryEntryFilter {
            account_pool_id: Some(1),
            origin: None,
            kind: Some("fact".to_string()),
            confirm_status: Some("candidate".to_string()),
            enabled: None,
        })
        .expect("list candidates");
    assert_eq!(candidates.len(), 1);

    let updated = db
        .update_memory_entry(MemoryEntryUpdate {
            id: created.id,
            account_pool_id: 1,
            kind: "event".to_string(),
            content: "旧塑料架踢脚线卡住，已更换金属架".to_string(),
            subject: Some("门后置物架".to_string()),
            scope: Some("租房".to_string()),
            source: Some("用户口述".to_string()),
            source_type: Some("user".to_string()),
            occurred_at: Some("2026-03".to_string()),
        })
        .expect("update memory");
    assert_eq!(updated.kind, "event");

    db.delete_memory_entry(created.id, 1).expect("delete");
    let after = db
        .list_memory_entries(MemoryEntryFilter {
            account_pool_id: Some(1),
            origin: None,
            kind: None,
            confirm_status: None,
            enabled: None,
        })
        .expect("list after delete");
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, mobile.id);
    assert!(db.delete_memory_entry(created.id, 1).is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn enforces_memory_status_machine_and_replacement() {
    let (db, dir) = temp_db();
    let candidate = db
        .create_memory_entry(sample_memory_create("油烟机漏烟（AI 稿推断）"))
        .expect("create");
    // 候选 → 过时 非法
    assert!(db
        .transition_memory_entry_status(MemoryEntryTransition {
            id: candidate.id,
            account_pool_id: 1,
            next_status: "outdated".to_string(),
            replaced_by: None,
        })
        .is_err());

    let confirmed = db
        .transition_memory_entry_status(MemoryEntryTransition {
            id: candidate.id,
            account_pool_id: 1,
            next_status: "confirmed".to_string(),
            replaced_by: None,
        })
        .expect("confirm");
    assert_eq!(confirmed.confirm_status, "confirmed");
    assert_eq!(confirmed.valid_status, "valid");

    // 确认 → 候选 不可逆
    assert!(db
        .transition_memory_entry_status(MemoryEntryTransition {
            id: candidate.id,
            account_pool_id: 1,
            next_status: "candidate".to_string(),
            replaced_by: None,
        })
        .is_err());

    let successor = db
        .create_memory_entry(MemoryEntryCreate {
            confirm_status: Some("confirmed".to_string()),
            ..sample_memory_create("油烟机已换新，漏烟问题解决")
        })
        .expect("create successor");

    // 替代条目必须已确认；候选不能当替代目标
    let pending = db
        .create_memory_entry(sample_memory_create("临时候选"))
        .expect("create pending");
    assert!(db
        .transition_memory_entry_status(MemoryEntryTransition {
            id: candidate.id,
            account_pool_id: 1,
            next_status: "outdated".to_string(),
            replaced_by: Some(pending.id),
        })
        .is_err());

    let outdated = db
        .transition_memory_entry_status(MemoryEntryTransition {
            id: candidate.id,
            account_pool_id: 1,
            next_status: "outdated".to_string(),
            replaced_by: Some(successor.id),
        })
        .expect("outdate");
    assert_eq!(outdated.confirm_status, "outdated");
    assert_eq!(outdated.valid_status, "invalid");
    assert_eq!(outdated.replaced_by, Some(successor.id));

    // 被替代引用的条目不可删
    assert!(db.delete_memory_entry(successor.id, 1).is_err());

    let rejected = db
        .create_memory_entry(sample_memory_create("未确认推断"))
        .expect("create reject");
    let rejected = db
        .transition_memory_entry_status(MemoryEntryTransition {
            id: rejected.id,
            account_pool_id: 1,
            next_status: "rejected".to_string(),
            replaced_by: None,
        })
        .expect("reject");
    assert_eq!(rejected.valid_status, "invalid");
    assert!(db
        .transition_memory_entry_status(MemoryEntryTransition {
            id: rejected.id,
            account_pool_id: 1,
            next_status: "confirmed".to_string(),
            replaced_by: None,
        })
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn isolates_memory_and_prompts_by_account() {
    let (db, dir) = temp_db();
    let entry = db
        .create_memory_entry(sample_memory_create("账号一的私有事实"))
        .expect("create a");
    db.upsert_experience_prompt(ExperiencePromptUpsert {
        account_pool_id: 1,
        origin: "pc".to_string(),
        id: None,
        title: "账号一经验".to_string(),
        content: "仅账号一可见".to_string(),
        enabled: true,
        apply_scope: None,
        apply_target: None,
        source: None,
        sort_order: None,
    })
    .expect("create prompt");

    // 账号不匹配时拒绝读写
    assert!(db
        .update_memory_entry(MemoryEntryUpdate {
            id: entry.id,
            account_pool_id: 999,
            kind: "fact".to_string(),
            content: "越权改写".to_string(),
            subject: None,
            scope: None,
            source: None,
            source_type: None,
            occurred_at: None,
        })
        .is_err());
    assert!(db.delete_memory_entry(entry.id, 999).is_err());
    assert!(db.list_experience_prompts(Some(999), None).is_err());

    // 切到第二个账号后看不到账号一记忆与经验提示词
    db.create_local_account(LocalAccountCreate {
        alias: "记忆隔离测试号".to_string(),
        role: "operation".to_string(),
        notes: None,
    })
    .expect("create second account");
    db.set_app_setting("active_account_id", "2")
        .expect("switch active account");
    let second_memories = db
        .list_memory_entries(MemoryEntryFilter {
            account_pool_id: Some(2),
            origin: None,
            kind: None,
            confirm_status: None,
            enabled: None,
        })
        .expect("list second account");
    assert!(second_memories.is_empty());
    let second_prompts = db
        .list_experience_prompts(Some(2), None)
        .expect("list second prompts");
    assert!(second_prompts.is_empty());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn caps_enabled_experience_prompts_and_validates_fields() {
    let (db, dir) = temp_db();
    for index in 0..10 {
        db.upsert_experience_prompt(ExperiencePromptUpsert {
            account_pool_id: 1,
            origin: "pc".to_string(),
            id: None,
            title: format!("经验{index}"),
            content: format!("内容{index}"),
            enabled: true,
            apply_scope: Some("account".to_string()),
            apply_target: Some("compose".to_string()),
            source: Some("user".to_string()),
            sort_order: Some(index),
        })
        .expect("fill enabled prompts");
    }
    let overflow = db.upsert_experience_prompt(ExperiencePromptUpsert {
        account_pool_id: 1,
        origin: "pc".to_string(),
        id: None,
        title: "第11条".to_string(),
        content: "应被拒绝".to_string(),
        enabled: true,
        apply_scope: None,
        apply_target: None,
        source: None,
        sort_order: None,
    });
    assert!(overflow.is_err());

    // 停用一条后可再启用新的
    let list = db
        .list_experience_prompts(Some(1), Some("pc".to_string()))
        .expect("list");
    db.upsert_experience_prompt(ExperiencePromptUpsert {
        account_pool_id: 1,
        origin: "pc".to_string(),
        id: Some(list[0].id),
        title: list[0].title.clone(),
        content: list[0].content.clone(),
        enabled: false,
        apply_scope: Some(list[0].apply_scope.clone()),
        apply_target: Some(list[0].apply_target.clone()),
        source: Some(list[0].source.clone()),
        sort_order: Some(list[0].sort_order),
    })
    .expect("disable one");
    db.upsert_experience_prompt(ExperiencePromptUpsert {
        account_pool_id: 1,
        origin: "pc".to_string(),
        id: None,
        title: "第11条".to_string(),
        content: "应被接受".to_string(),
        enabled: true,
        apply_scope: None,
        apply_target: None,
        source: None,
        sort_order: None,
    })
    .expect("accept after disable");

    assert!(db
        .upsert_experience_prompt(ExperiencePromptUpsert {
            account_pool_id: 1,
            origin: "pc".to_string(),
            id: None,
            title: "".to_string(),
            content: "无标题".to_string(),
            enabled: true,
            apply_scope: None,
            apply_target: None,
            source: None,
            sort_order: None,
        })
        .is_err());
    let long = "字".repeat(5001);
    assert!(db
        .upsert_experience_prompt(ExperiencePromptUpsert {
            account_pool_id: 1,
            origin: "pc".to_string(),
            id: None,
            title: "超长".to_string(),
            content: long,
            enabled: true,
            apply_scope: None,
            apply_target: None,
            source: None,
            sort_order: None,
        })
        .is_err());

    // mobile 池独立计数
    db.upsert_experience_prompt(ExperiencePromptUpsert {
        account_pool_id: 1,
        origin: "mobile".to_string(),
        id: None,
        title: "手机经验".to_string(),
        content: "薯🍠".repeat(2500),
        enabled: true,
        apply_scope: None,
        apply_target: None,
        source: None,
        sort_order: None,
    })
    .expect("mobile pool has own quota");
    let mobile_list = db
        .list_experience_prompts(Some(1), Some("mobile".to_string()))
        .expect("list mobile");
    assert_eq!(mobile_list.len(), 1);
    assert_eq!(mobile_list[0].content, "薯🍠".repeat(2500));
    db.delete_experience_prompt(mobile_list[0].id, 1, "mobile".to_string())
        .expect("delete mobile prompt");
    fs::remove_dir_all(dir).ok();
}

#[test]
fn stores_and_resets_memory_l1_override() {
    let (db, dir) = temp_db();
    let rules = db.read_memory_system_rules().expect("read defaults");
    assert!(!rules.l1_is_override);
    assert_eq!(rules.l1_active, rules.l1_default);
    assert!(!rules.l0.is_empty());

    let overridden = db
        .save_memory_l1_override("自定义方法论：先列三条避坑点。")
        .expect("save override");
    assert!(overridden.l1_is_override);
    assert_eq!(overridden.l1_active, "自定义方法论：先列三条避坑点。");
    assert_eq!(overridden.l1_default, rules.l1_default);

    assert!(db.save_memory_l1_override("   ").is_err());
    assert!(db.save_memory_l1_override(&"字".repeat(2001)).is_err());

    let reset = db.reset_memory_l1_override().expect("reset");
    assert!(!reset.l1_is_override);
    assert_eq!(reset.l1_active, reset.l1_default);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn persists_browser_snapshots_for_selected_account_and_deduplicates_requests() {
    let (db, dir) = temp_db();
    db.create_local_account(LocalAccountCreate {
        alias: "快照目标账号".to_string(),
        role: "operation".to_string(),
        notes: None,
    })
    .expect("create selected capture account");
    let selected_account_id = db
        .account_pool()
        .expect("read accounts")
        .items
        .into_iter()
        .find(|account| account.alias == "快照目标账号")
        .expect("selected capture account")
        .id;

    let make_snapshot =
        |request_id: &str, observed_at: &str, like: Option<i64>| PageSnapshotCreate {
            account_pool_id: selected_account_id,
            kind: "note_snapshot".to_string(),
            source_url: "https://www.xiaohongshu.com/explore/capture-test".to_string(),
            title: "单篇采样测试".to_string(),
            author: "测试作者".to_string(),
            body_excerpt: "采样证据".to_string(),
            metrics: PageSnapshotMetrics {
                like,
                collect: None,
                comment: Some(2),
                share: None,
                followers: None,
                note_count: None,
                capture_details: serde_json::json!({
                    "images": [{"url": "https://sns.example/image.jpg", "order": 0}],
                    "comments": [{"author": "读者", "text": "保留所选摘录", "truncated": false}]
                }),
            },
            reference_account_id: None,
            request_id: Some(request_id.to_string()),
            observed_at: observed_at.to_string(),
        };

    let first = db
        .save_browser_page_snapshot(make_snapshot(
            "capture-request-1",
            "2026-09-28T10:00:00Z",
            Some(12),
        ))
        .expect("persist snapshot to selected account");
    let retry = db
        .save_browser_page_snapshot(make_snapshot(
            "capture-request-1",
            "2026-09-28T10:00:00Z",
            Some(12),
        ))
        .expect("same request is idempotent");
    assert_eq!(retry.id, first.id);
    assert!(db
        .save_browser_page_snapshot(make_snapshot(
            "capture-request-1",
            "2026-09-28T10:00:00Z",
            Some(99),
        ))
        .is_err());

    let second = db
        .save_browser_page_snapshot(make_snapshot(
            "capture-request-2",
            "2026-09-28T11:00:00Z",
            Some(10),
        ))
        .expect("new manual request preserves another sample");
    assert_ne!(first.id, second.id);

    // The extension may target this local account without changing the app's active account.
    assert_eq!(db.current_active_account().expect("active account").id, 1);
    db.set_app_setting("active_account_id", &selected_account_id.to_string())
        .expect("switch to selected capture account for history read");
    let history = db
        .list_page_snapshots(Some(selected_account_id), &first.source_url, Some(10))
        .expect("read selected account history");
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].id, second.id);
    assert_eq!(history[0].like_count, Some(10));
    assert_eq!(history[0].collect_count, None);
    let metrics: serde_json::Value =
        serde_json::from_str(&history[0].metrics_json).expect("decode metrics evidence");
    assert_eq!(metrics["captureDetails"]["comments"][0]["author"], "读者");
    assert_eq!(metrics["captureDetails"]["images"][0]["order"], 0);

    let context = db
        .lookup_browser_page_context_for_account(
            "https://www.xiaohongshu.com/explore/capture-test?xsec_token=temporary",
            "note",
            selected_account_id,
        )
        .expect("look up the same note with a tracking query removed");
    assert_eq!(context.match_type, "known_snapshot");
    assert_eq!(
        context.last_snapshot_at.as_deref(),
        Some("2026-09-28T11:00:00Z")
    );
    let prior_metrics = context.last_snapshot_metrics.expect("same-object metrics");
    assert_eq!(prior_metrics.like, Some(10));
    assert_eq!(prior_metrics.comment, Some(2));
    assert_eq!(
        prior_metrics.collect, None,
        "missing values remain unknown, not zero"
    );

    let other_account_context = db
        .lookup_browser_page_context_for_account(&first.source_url, "note", 1)
        .expect("look up the URL under another account");
    assert!(other_account_context.last_snapshot_metrics.is_none());
    assert!(db
        .list_page_snapshots(Some(1), &first.source_url, Some(10))
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn saved_image_material_context_is_recognized_as_existing_clip() {
    let (db, dir) = temp_db();
    let source_url = "https://www.xiaohongshu.com/explore/saved-image-material";
    db.save_browser_capture_inspiration(LocalInspirationCreate {
        id: "saved-image-material-context".to_string(),
        account_pool_id: 1,
        title: "图片素材剪藏".to_string(),
        source_url: source_url.to_string(),
        body: String::new(),
        observed_at: "2026-10-04T10:00:00Z".to_string(),
        reason: String::new(),
        dedupe_key: None,
        material_type: Some("image_material".to_string()),
        author: Some("素材作者".to_string()),
        capture_modules: Some(vec!["images".to_string()]),
    })
    .expect("save a standalone image material clipping");

    let context = db
        .lookup_browser_page_context_for_account(source_url, "web", 1)
        .expect("recognize the saved material page");
    assert_eq!(context.match_type, "saved_image_material");
    assert_eq!(context.page_type, "web");
    assert_eq!(context.default_action, "update_data");
    assert_eq!(context.matched_title.as_deref(), Some("图片素材剪藏"));
    fs::remove_dir_all(dir).ok();
}

#[test]
fn verifies_browser_capture_outcomes_by_request_and_selected_account() {
    let (db, dir) = temp_db();
    db.create_local_account(LocalAccountCreate {
        alias: "核实结果账号".to_string(),
        role: "operation".to_string(),
        notes: None,
    })
    .expect("create capture verification account");
    let selected_account_id = db
        .account_pool()
        .expect("read account pool")
        .items
        .into_iter()
        .find(|account| account.alias == "核实结果账号")
        .expect("selected account")
        .id;
    let request_id = "capture-verification-1";
    let collection_id = format!("bc:{selected_account_id}:{request_id}");

    let empty = db
        .lookup_browser_capture_request(selected_account_id, request_id)
        .expect("query an unknown request safely");
    assert!(!empty.collection_saved && !empty.snapshot_saved);

    db.save_browser_capture_inspiration(LocalInspirationCreate {
        id: collection_id.clone(),
        account_pool_id: selected_account_id,
        title: "等待核实".to_string(),
        source_url: "https://www.xiaohongshu.com/explore/verify".to_string(),
        body: "正文".to_string(),
        observed_at: "2026-09-29T10:00:00Z".to_string(),
        reason: "浏览器采集".to_string(),
        dedupe_key: None,
        material_type: Some("note_material".to_string()),
        author: Some("作者".to_string()),
        capture_modules: Some(vec!["titleBody".to_string()]),
    })
    .expect("save browser collection");
    let partial = db
        .lookup_browser_capture_request(selected_account_id, request_id)
        .expect("query partial outcomes");
    assert!(partial.collection_saved);
    assert!(!partial.capture_details_saved && !partial.snapshot_saved);

    db.save_browser_capture_payload(
        &collection_id,
        selected_account_id,
        r#"{"images":[],"comments":[]}"#,
    )
    .expect("save optional details");
    let snapshot = db
        .save_browser_page_snapshot(PageSnapshotCreate {
            account_pool_id: selected_account_id,
            kind: "note_snapshot".to_string(),
            source_url: "https://www.xiaohongshu.com/explore/verify".to_string(),
            title: "等待核实".to_string(),
            author: "作者".to_string(),
            body_excerpt: "正文".to_string(),
            metrics: PageSnapshotMetrics::default(),
            reference_account_id: None,
            request_id: Some(request_id.to_string()),
            observed_at: "2026-09-29T10:00:00Z".to_string(),
        })
        .expect("save selected-account snapshot");
    let completed = db
        .lookup_browser_capture_request(selected_account_id, request_id)
        .expect("query completed outcomes");
    assert!(completed.collection_saved && completed.capture_details_saved);
    assert!(completed.snapshot_saved);
    assert_eq!(completed.snapshot_id, Some(snapshot.id));
    assert!(
        !db.lookup_browser_capture_request(1, request_id)
            .unwrap()
            .collection_saved
    );
    assert!(db
        .lookup_browser_capture_request(selected_account_id, "\n")
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn verifies_profile_note_sync_outcome_and_keeps_same_request_idempotent() {
    let (db, dir) = temp_db();
    let request_id = "profile-notes-verification";
    let input = PageSnapshotCreate {
        account_pool_id: 1,
        kind: "ref_snapshot".to_string(),
        source_url: "https://www.xiaohongshu.com/user/profile/unknown-creator".to_string(),
        title: "主页快照".to_string(),
        author: "创作者".to_string(),
        body_excerpt: String::new(),
        metrics: PageSnapshotMetrics {
            capture_details: serde_json::json!({
                "profileNotesState": "complete",
                "profileNotes": [{"noteUrl":"https://www.xiaohongshu.com/explore/profile-note-verify"}]
            }),
            ..PageSnapshotMetrics::default()
        },
        reference_account_id: None,
        request_id: Some(request_id.to_string()),
        observed_at: "2026-09-29T10:00:00Z".to_string(),
    };
    let first = db
        .save_browser_page_snapshot(input.clone())
        .expect("save profile snapshot");
    db.save_browser_profile_notes_outcome(
        first.id,
        1,
        &serde_json::json!({
            "saved": true,
            "state": "complete",
            "imported": 1,
            "updated": 0,
            "skipped": false,
            "error": null,
        }),
    )
    .expect("save profile-note sync outcome");
    let recovered = db
        .lookup_browser_capture_request(1, request_id)
        .expect("recover profile-note status");
    assert!(recovered.snapshot_saved && recovered.profile_notes_saved);
    assert_eq!(recovered.profile_notes_imported, 1);
    assert_eq!(recovered.profile_notes_state.as_deref(), Some("complete"));
    let retry = db
        .save_browser_page_snapshot(input)
        .expect("same original request remains idempotent after adding its outcome");
    assert_eq!(first.id, retry.id);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn persists_selected_browser_image_and_comment_details_idempotently() {
    let (db, dir) = temp_db();
    db.create_local_account(LocalAccountCreate {
        alias: "详情目标账号".to_string(),
        role: "operation".to_string(),
        notes: None,
    })
    .expect("create selected detail account");
    let selected_account_id = db
        .account_pool()
        .expect("read accounts")
        .items
        .into_iter()
        .find(|account| account.alias == "详情目标账号")
        .expect("selected detail account")
        .id;
    db.save_browser_capture_inspiration(LocalInspirationCreate {
        id: "capture-details-request".to_string(),
        account_pool_id: selected_account_id,
        title: "带图片与评论的网页收藏".to_string(),
        source_url: "https://www.xiaohongshu.com/explore/details-test".to_string(),
        body: "页面摘录".to_string(),
        observed_at: "2026-09-28T12:00:00Z".to_string(),
        reason: "浏览器选择的素材".to_string(),
        dedupe_key: None,
        material_type: Some("note_material".to_string()),
        author: Some("测试作者".to_string()),
        capture_modules: Some(vec!["collect".to_string()]),
    })
    .expect("persist capture for selected account");

    let payload = serde_json::json!({
        "images": [{"url": "https://sns.example/image.jpg", "width": 640, "height": 800, "order": 0}],
        "comments": [{"author": "读者", "text": "我选中的评论", "likes": 3, "truncated": false}]
    })
    .to_string();
    db.save_browser_capture_payload("capture-details-request", selected_account_id, &payload)
        .expect("persist selected details");
    db.save_browser_capture_payload("capture-details-request", selected_account_id, &payload)
        .expect("identical details retry is idempotent");
    assert!(db
        .save_browser_capture_payload(
            "capture-details-request",
            selected_account_id,
            r#"{"comments":[{"text":"different request payload"}]}"#,
        )
        .is_err());
    assert!(db
        .save_browser_capture_payload("capture-details-request", 1, &payload)
        .is_err());
    assert!(db
        .save_browser_capture_payload(
            "capture-details-request",
            selected_account_id,
            &format!("{{\"large\":\"{}\"}}", "x".repeat(65 * 1024)),
        )
        .is_err());

    db.set_app_setting("active_account_id", &selected_account_id.to_string())
        .expect("switch to selected detail account");
    let saved = db
        .local_inspirations(Some(selected_account_id))
        .expect("read selected inspiration");
    assert_eq!(saved.len(), 1);
    let stored: serde_json::Value =
        serde_json::from_str(&saved[0].capture_payload).expect("decode capture details");
    assert_eq!(stored["images"][0]["order"], 0);
    assert_eq!(stored["comments"][0]["author"], "读者");
    assert_eq!(stored["comments"][0]["text"], "我选中的评论");
    fs::remove_dir_all(dir).ok();
}

#[test]
fn localizes_selected_collection_images_with_scoped_retry_and_shared_asset_retention() {
    let (db, dir) = temp_db();
    db.create_local_account(LocalAccountCreate {
        alias: "本地图片隔离账号".to_string(),
        role: "operation".to_string(),
        notes: None,
    })
    .expect("create isolated account");
    let target_account = db
        .account_pool()
        .expect("read accounts")
        .items
        .into_iter()
        .find(|account| account.alias == "本地图片隔离账号")
        .expect("target account")
        .id;
    let id = format!("bc:{target_account}:collection-image-request");
    db.save_browser_capture_inspiration(LocalInspirationCreate {
        id: id.clone(),
        account_pool_id: target_account,
        title: "选中图片收藏".to_string(),
        source_url: "https://www.xiaohongshu.com/explore/local-image".to_string(),
        body: "正文始终先保存".to_string(),
        observed_at: "2026-10-03T10:00:00Z".to_string(),
        reason: "原备注".to_string(),
        dedupe_key: None,
        material_type: Some("note_material".to_string()),
        author: Some("本地作者".to_string()),
        capture_modules: Some(vec!["images".to_string()]),
    })
    .expect("save collection body first");
    db.save_browser_capture_payload(
        &id,
        target_account,
        r#"{"images":[{"url":"https://cdn.example/first.jpg","order":0},{"url":"https://cdn.example/third.jpg","order":2}],"comments":[]}"#,
    )
    .expect("save only selected image references");

    db.set_app_setting("active_account_id", &target_account.to_string())
        .expect("switch to target account");
    let listed = db
        .local_inspirations(Some(target_account))
        .expect("read collection");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].body, "正文始终先保存");
    assert_eq!(listed[0].collection_images.len(), 2);
    assert_eq!(listed[0].collection_images[0].position, 0);
    assert_eq!(
        listed[0].collection_images[0].source_url,
        "https://cdn.example/first.jpg"
    );
    assert_eq!(
        listed[0].collection_images[1].source_url,
        "https://cdn.example/third.jpg"
    );
    assert!(listed[0]
        .collection_images
        .iter()
        .all(|image| image.status == "pending"));
    assert!(listed[0]
        .collection_images
        .iter()
        .all(|image| image.source_kind == "legacy_url"));
    let conn = db.connect().expect("simulate an interrupted download");
    conn.execute(
        "UPDATE inspiration_images SET status = 'downloading',
            updated_at = datetime('now', 'localtime', '-3 minutes')
         WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = 1",
        params![target_account, id],
    )
    .expect("seed a stale in-flight state");
    drop(conn);
    let recovered = db
        .local_inspirations(Some(target_account))
        .expect("recover stale in-flight image");
    assert_eq!(recovered[0].collection_images[1].status, "failed");
    assert_eq!(
        recovered[0].collection_images[1].error.as_deref(),
        Some("上次下载中断，可重试")
    );
    db.report_browser_collection_image_prepare_error(
        &id,
        target_account,
        0,
        "图片下载任务未完成初始化；可在收藏详情重试",
    )
    .expect("preserve a retry hint on a still-pending image");
    let reported = db
        .local_inspirations(Some(target_account))
        .expect("read a pending image retry hint");
    assert_eq!(reported[0].collection_images[0].status, "pending");
    assert_eq!(
        reported[0].collection_images[0].error.as_deref(),
        Some("图片下载任务未完成初始化；可在收藏详情重试")
    );
    let png = STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pS8AAAAASUVORK5CYII=")
        .expect("decode 1px PNG fixture");
    let tiny_jpeg_thumbnail = [0xff, 0xd8, 0xff, 0xd9];

    assert!(
        db.claim_browser_collection_image(&id, 1, 0).is_err(),
        "another account cannot claim a target collection image"
    );
    let first_attempt = db
        .claim_browser_collection_image(&id, target_account, 0)
        .expect("claim first selected image");
    assert_eq!(first_attempt.source_url, "https://cdn.example/first.jpg");
    assert_eq!(
        first_attempt.request_id.as_deref(),
        Some("collection-image-request")
    );
    assert!(
        db.claim_browser_collection_image(&id, target_account, 0)
            .is_err(),
        "an in-flight download cannot be duplicated"
    );
    db.fail_browser_collection_image(
        &id,
        target_account,
        0,
        &first_attempt.source_url,
        first_attempt.request_id.as_deref(),
        "temporary timeout",
    )
    .expect("persist individual image failure");
    let retry = db
        .claim_browser_collection_image(&id, target_account, 0)
        .expect("retry the same failed attachment");
    assert_eq!(retry.source_url, first_attempt.source_url);
    assert_eq!(retry.request_id, first_attempt.request_id);
    db.set_app_setting("active_account_id", "1")
        .expect("switch away while the selected image is downloading");
    assert!(
        db.save_browser_collection_image(BrowserCollectionImageSave {
            id: &id,
            account_pool_id: target_account,
            position: 0,
            expected_source_url: &retry.source_url,
            expected_request_id: retry.request_id.as_deref(),
            bytes: &png,
            mime_type: "image/png",
            thumbnail_bytes: &tiny_jpeg_thumbnail,
            width: 1,
            height: 1,
        })
        .is_err(),
        "a response cannot persist after the active account changes"
    );
    db.fail_browser_collection_image(
        &id,
        target_account,
        0,
        &retry.source_url,
        retry.request_id.as_deref(),
        "账号上下文已变化",
    )
    .expect("record the account-boundary failure for the original collection");
    db.set_app_setting("active_account_id", &target_account.to_string())
        .expect("switch back to the target account");
    let restored_attempt = db
        .claim_browser_collection_image(&id, target_account, 0)
        .expect("retry after restoring the original account");
    assert_eq!(restored_attempt.request_id, retry.request_id);
    let second_attempt = db
        .claim_browser_collection_image(&id, target_account, 1)
        .expect("second selected URL remains a separate ordered attachment");
    db.fail_browser_collection_image(
        &id,
        target_account,
        1,
        &second_attempt.source_url,
        second_attempt.request_id.as_deref(),
        "fixture skip",
    )
    .expect("return second image to failed state");

    assert!(
        db.save_browser_collection_image(BrowserCollectionImageSave {
            id: &id,
            account_pool_id: target_account,
            position: 0,
            expected_source_url: "https://cdn.example/replaced.jpg",
            expected_request_id: first_attempt.request_id.as_deref(),
            bytes: &png,
            mime_type: "image/png",
            thumbnail_bytes: &tiny_jpeg_thumbnail,
            width: 1,
            height: 1,
        })
        .is_err(),
        "an old network response cannot be written to a changed source URL"
    );
    assert!(
        db.save_browser_collection_image(BrowserCollectionImageSave {
            id: &id,
            account_pool_id: target_account,
            position: 0,
            expected_source_url: &first_attempt.source_url,
            expected_request_id: Some("different-request"),
            bytes: &png,
            mime_type: "image/png",
            thumbnail_bytes: &tiny_jpeg_thumbnail,
            width: 1,
            height: 1,
        })
        .is_err(),
        "an old network response cannot cross requestId"
    );
    let conn = db.connect().expect("simulate a full collection quota");
    conn.execute(
        "UPDATE inspiration_images SET status = 'ready', byte_size = 33554432
         WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = 1",
        params![target_account, id],
    )
    .expect("seed the collection byte limit");
    drop(conn);
    assert!(
        db.save_browser_collection_image(BrowserCollectionImageSave {
            id: &id,
            account_pool_id: target_account,
            position: 0,
            expected_source_url: &first_attempt.source_url,
            expected_request_id: first_attempt.request_id.as_deref(),
            bytes: &png,
            mime_type: "image/png",
            thumbnail_bytes: &tiny_jpeg_thumbnail,
            width: 1,
            height: 1,
        })
        .is_err(),
        "a collection cannot exceed the aggregate byte limit"
    );
    let conn = db.connect().expect("restore collection test state");
    conn.execute(
        "UPDATE inspiration_images SET status = 'failed', byte_size = NULL
         WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = 1",
        params![target_account, id],
    )
    .expect("restore the failed second attachment");
    drop(conn);
    db.save_browser_collection_image(BrowserCollectionImageSave {
        id: &id,
        account_pool_id: target_account,
        position: 0,
        expected_source_url: &first_attempt.source_url,
        expected_request_id: first_attempt.request_id.as_deref(),
        bytes: &png,
        mime_type: "image/png",
        thumbnail_bytes: &tiny_jpeg_thumbnail,
        width: 1,
        height: 1,
    })
    .expect("persist original and independent thumbnail");
    assert!(
        db.claim_browser_collection_image(&id, target_account, 0)
            .is_err(),
        "a successful image is not fetched again"
    );
    let ready = db
        .local_inspirations(Some(target_account))
        .expect("read localized state");
    assert_eq!(ready[0].collection_images[0].status, "ready");
    assert_eq!(ready[0].collection_images[0].source_kind, "legacy_url");
    assert!(ready[0].collection_images[0].original_available);
    assert!(ready[0].collection_images[0].thumbnail_available);
    assert_eq!(ready[0].collection_images[1].status, "failed");
    let original = db
        .read_browser_collection_image(&id, target_account, 0, false)
        .expect("read original locally");
    let thumbnail = db
        .read_browser_collection_image(&id, target_account, 0, true)
        .expect("read independent thumbnail locally");
    assert!(original.starts_with("data:image/png;base64,"));
    assert!(thumbnail.starts_with("data:image/jpeg;base64,"));
    assert!(
        db.read_browser_collection_image(&id, 1, 0, false).is_err(),
        "image read stays scoped to its recorded account"
    );

    db.update_local_inspiration_details(
        &id,
        target_account,
        "长期保留的备注",
        &["复盘".to_string(), "教程".to_string(), "复盘".to_string()],
    )
    .expect("save note and labels");
    let annotated = db
        .local_inspirations(Some(target_account))
        .expect("read annotations");
    assert_eq!(annotated[0].reason, "长期保留的备注");
    assert_eq!(annotated[0].collection_tags, vec!["复盘", "教程"]);

    let reused_item = db
        .add_browser_collection_image_to_library(&id, target_account, 0)
        .expect("explicitly reuse image as creator asset");
    let payload: serde_json::Value = serde_json::from_str(
        &db.local_inspirations(Some(target_account)).unwrap()[0].capture_payload,
    )
    .expect("read explicit item link");
    assert_eq!(payload["importedItemIds"][0], reused_item.id);
    db.remove_local_inspiration(&id, target_account)
        .expect("remove collection reference");
    assert!(db
        .local_inspirations(Some(target_account))
        .unwrap()
        .is_empty());
    let item = db
        .get_local_item_for_cli(reused_item.id)
        .expect("read shared creator asset")
        .1
        .expect("creator asset remains");
    assert!(
        dir.join(&item.image_path).is_file(),
        "cancelling collection does not delete shared image"
    );
    assert!(item
        .thumbnail_path
        .as_ref()
        .is_some_and(|path| dir.join(path).is_file()));
    fs::remove_dir_all(dir).ok();
}

#[test]
fn migrates_old_collection_urls_without_rewriting_capture_payload() {
    let (db, dir) = temp_db();
    db.create_local_account(LocalAccountCreate {
        alias: "旧收藏图片迁移账号".to_string(),
        role: "operation".to_string(),
        notes: None,
    })
    .expect("create isolated account");
    let account_id = db
        .account_pool()
        .expect("read accounts")
        .items
        .into_iter()
        .find(|account| account.alias == "旧收藏图片迁移账号")
        .expect("target account")
        .id;
    let id = format!("bc:{account_id}:old-request");
    db.save_browser_capture_inspiration(LocalInspirationCreate {
        id: id.clone(),
        account_pool_id: account_id,
        title: "已有文字收藏".to_string(),
        source_url: "https://www.xiaohongshu.com/explore/old-collection".to_string(),
        body: "旧收藏正文不变".to_string(),
        observed_at: "2026-10-01T10:00:00Z".to_string(),
        reason: "保留原备注".to_string(),
        dedupe_key: None,
        material_type: Some("note_material".to_string()),
        author: Some("旧作者".to_string()),
        capture_modules: Some(vec!["images".to_string()]),
    })
    .expect("save old collection row");

    let old_payload = r#"{"images":[{"url":"https://cdn.example/first.jpg","order":0},{"url":"https://cdn.example/third.jpg","order":1}],"comments":[{"author":"读者","text":"既有评论"}]}"#;
    let conn = db.connect().expect("open seed database");
    conn.execute(
        "UPDATE inspirations SET capture_payload = ?1 WHERE id = ?2 AND account_pool_id = ?3",
        params![old_payload, id, account_id],
    )
    .expect("seed pre-localization payload");
    conn.execute_batch(
        "DROP TABLE inspiration_images;
         ALTER TABLE inspirations DROP COLUMN collection_tags;",
    )
    .expect("simulate the previous schema");
    drop(conn);

    let migrated = LocalDb::open(dir.join("app.db")).expect("migrate old database in place");
    migrated
        .set_app_setting("active_account_id", &account_id.to_string())
        .expect("activate target account");
    let items = migrated
        .local_inspirations(Some(account_id))
        .expect("read migrated old collection");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].body, "旧收藏正文不变");
    assert_eq!(items[0].reason, "保留原备注");
    assert_eq!(items[0].collection_tags, Vec::<String>::new());
    assert_eq!(items[0].collection_images.len(), 2);
    assert_eq!(
        items[0].collection_images[0].source_url,
        "https://cdn.example/first.jpg"
    );
    assert_eq!(items[0].collection_images[0].source_kind, "legacy_url");
    assert_eq!(
        items[0].collection_images[1].source_url,
        "https://cdn.example/third.jpg"
    );
    assert_eq!(items[0].collection_images[1].source_kind, "legacy_url");
    assert_eq!(items[0].capture_payload, old_payload);
    fs::remove_dir_all(dir).ok();
}

#[test]
fn extension_image_upload_resumes_idempotently_and_stays_scoped_to_request_and_account() {
    let (db, dir) = temp_db();
    db.create_local_account(LocalAccountCreate {
        alias: "剪藏分块上传隔离账号".to_string(),
        role: "operation".to_string(),
        notes: None,
    })
    .expect("create a second isolated account");
    let second_account_id = db
        .account_pool()
        .expect("read account pool")
        .items
        .into_iter()
        .find(|account| account.alias == "剪藏分块上传隔离账号")
        .expect("second account")
        .id;
    let account_id = 1;
    let request_id = "extension-byte-transfer-fixture";
    let inspiration_id = format!("bc:{account_id}:{request_id}");
    let image_bytes = b"original-image-bytes-for-resume";
    let sha256 = format!("{:x}", Sha256::digest(image_bytes));

    db.save_browser_capture_inspiration(LocalInspirationCreate {
        id: inspiration_id.clone(),
        account_pool_id: account_id,
        title: "分块上传隔离 fixture".to_string(),
        source_url: "https://www.xiaohongshu.com/explore/upload-fixture".to_string(),
        body: "本地 fixture 正文".to_string(),
        observed_at: "2026-10-04T10:00:00Z".to_string(),
        reason: "extension byte upload fixture".to_string(),
        dedupe_key: None,
        material_type: Some("note_material".to_string()),
        author: Some("fixture author".to_string()),
        capture_modules: Some(vec!["images".to_string()]),
    })
    .expect("save isolated clipping text");
    db.save_browser_capture_payload(
        &inspiration_id,
        account_id,
        r#"{"images":[{"url":"https://cdn.fixture.invalid/image.png","order":0}],"comments":[]}"#,
    )
    .expect("save selected image metadata");
    db.register_browser_capture_request(account_id, request_id, &inspiration_id, true)
        .expect("register original request id");
    assert_eq!(
        db.browser_collection_image_positions(&inspiration_id, account_id)
            .expect("hydrate one selected image"),
        vec![0]
    );

    let start = || BrowserCaptureImageUploadStart {
        id: &inspiration_id,
        account_pool_id: account_id,
        position: 0,
        request_id,
        total_bytes: image_bytes.len(),
        sha256: &sha256,
        mime_type: "image/png",
    };
    let begun = db
        .begin_browser_capture_image_upload(start())
        .expect("begin original image upload");
    assert_eq!(begun.next_offset, 0);
    assert_eq!(begun.total_bytes, image_bytes.len());
    assert!(!begun.already_ready);
    assert!(
        db.begin_browser_capture_image_upload(BrowserCaptureImageUploadStart {
            account_pool_id: second_account_id,
            ..start()
        })
        .is_err(),
        "another account must not address the same clip"
    );
    assert!(
        db.begin_browser_capture_image_upload(BrowserCaptureImageUploadStart {
            request_id: "different-request-id",
            ..start()
        })
        .is_err(),
        "a different request id must not resume this image"
    );

    let split = 9;
    let first = &image_bytes[..split];
    let first_ack = db
        .append_browser_capture_image_upload_chunk(
            &inspiration_id,
            account_id,
            0,
            request_id,
            0,
            first,
        )
        .expect("write first durable chunk");
    assert_eq!(first_ack.next_offset, split);
    assert_eq!(
        db.append_browser_capture_image_upload_chunk(
            &inspiration_id,
            account_id,
            0,
            request_id,
            0,
            first,
        )
        .expect("repeat identical chunk after an ambiguous ack")
        .next_offset,
        split
    );
    assert!(
        db.append_browser_capture_image_upload_chunk(
            &inspiration_id,
            account_id,
            0,
            request_id,
            0,
            b"different",
        )
        .is_err(),
        "duplicate bytes must be identical"
    );
    assert!(
        db.append_browser_capture_image_upload_chunk(
            &inspiration_id,
            account_id,
            0,
            request_id,
            split + 1,
            &image_bytes[split + 1..],
        )
        .is_err(),
        "out-of-order chunks must be rejected"
    );

    let resumed = db
        .begin_browser_capture_image_upload(start())
        .expect("recover the original upload after reopening its state");
    assert_eq!(resumed.next_offset, split);
    let upload_temp_name = {
        let conn = db.connect().expect("read isolated upload metadata");
        conn.query_row(
            "SELECT temp_name FROM inspiration_image_uploads
             WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = 0 AND request_id = ?3",
            params![account_id, inspiration_id, request_id],
            |row| row.get::<_, String>(0),
        )
        .expect("upload temporary name")
    };
    let recovered_upload = BrowserCollectionImageUpload {
        inspiration_id: inspiration_id.clone(),
        account_pool_id: account_id,
        position: 0,
        request_id: request_id.to_string(),
        source_url: "https://cdn.fixture.invalid/image.png".to_string(),
        total_bytes: image_bytes.len(),
        sha256: sha256.clone(),
        mime_type: "image/png".to_string(),
        temp_name: upload_temp_name,
        next_offset: split,
        already_ready: false,
    };
    let partial_upload_path = dir
        .join("assets")
        .join(account_id.to_string())
        .join("uploads")
        .join(&recovered_upload.temp_name);
    assert_eq!(
        fs::read(partial_upload_path).expect("read durable acknowledged prefix"),
        first
    );
    let status = db
        .lookup_browser_capture_request(account_id, request_id)
        .expect("recover image progress using the original request id");
    assert_eq!(status.images_total, 1);
    assert_eq!(status.images_ready, 0);
    assert_eq!(status.images_failed, 0);
    assert!(
        !db.lookup_browser_capture_request(second_account_id, request_id)
            .expect("cross-account lookup stays isolated")
            .collection_saved
    );

    db.fail_browser_capture_image_upload(
        &inspiration_id,
        account_id,
        0,
        request_id,
        "fixture interrupted",
    )
    .expect("record explicit failed item and remove partial file");
    let failed = db
        .lookup_browser_capture_request(account_id, request_id)
        .expect("read partial failure");
    assert_eq!(failed.images_failed, 1);
    let retry = db
        .begin_browser_capture_image_upload(start())
        .expect("retry the failed image with original request id");
    assert_eq!(retry.next_offset, 0);
    assert!(!retry.already_ready);
    assert_eq!(
        db.local_inspirations(Some(account_id))
            .expect("read source kind after transfer begins")[0]
            .collection_images[0]
            .source_kind,
        "extension_bytes"
    );
    fs::remove_dir_all(dir).ok();
}

#[test]
fn clipping_links_are_scoped_idempotent_and_non_owning() {
    let (db, dir) = temp_db();
    let save_clip = |id: &str, title: &str| {
        db.save_local_inspiration(LocalInspirationCreate {
            id: id.to_string(),
            account_pool_id: 1,
            title: title.to_string(),
            source_url: format!("https://example.com/{id}"),
            body: format!("{title} body"),
            observed_at: "2026-10-04T10:00:00Z".to_string(),
            reason: String::new(),
            dedupe_key: None,
            material_type: Some("web_material".to_string()),
            author: Some("fixture author".to_string()),
            capture_modules: Some(vec!["titleBody".to_string()]),
        })
    };
    save_clip("clip-link-source", "被引用的剪藏").expect("save source clipping");
    save_clip("clip-link-target", "引用目标剪藏").expect("save target clipping");

    let linked = db
        .link_local_inspiration_to_target("clip-link-source", 1, "inspiration", "clip-link-target")
        .expect("link one clipping to another");
    assert!(linked.created && linked.target_exists);
    let duplicate = db
        .link_local_inspiration_to_target("clip-link-source", 1, "inspiration", "clip-link-target")
        .expect("retry the same reference idempotently");
    assert!(!duplicate.created);
    let references = db
        .local_inspiration_references("clip-link-source", 1)
        .expect("read explicit clipping references");
    assert_eq!(references.len(), 1);
    assert!(references[0].target_exists);

    assert!(db
        .unlink_local_inspiration_from_target(
            "clip-link-source",
            1,
            "inspiration",
            "clip-link-target"
        )
        .expect("remove only the relationship"));
    assert!(!db
        .unlink_local_inspiration_from_target(
            "clip-link-source",
            1,
            "inspiration",
            "clip-link-target"
        )
        .expect("removing the same link again is harmless"));
    assert!(db
        .local_inspiration_references("clip-link-source", 1)
        .expect("read no remaining links")
        .is_empty());
    assert_eq!(
        db.local_inspirations(Some(1))
            .expect("both clippings remain available")
            .len(),
        2
    );

    db.create_local_account(LocalAccountCreate {
        alias: "引用目标隔离账号".to_string(),
        role: "operation".to_string(),
        notes: None,
    })
    .expect("create another account");
    let other_account_id = db
        .account_pool()
        .expect("read account pool")
        .items
        .into_iter()
        .find(|account| account.alias == "引用目标隔离账号")
        .expect("other account")
        .id;
    db.set_app_setting("active_account_id", &other_account_id.to_string())
        .expect("switch to other account");
    assert!(db
        .link_local_inspiration_to_target(
            "clip-link-source",
            other_account_id,
            "topic",
            "另一个账号不可引用"
        )
        .is_err());
    fs::remove_dir_all(dir).ok();
}

#[test]
fn creating_draft_from_note_clipping_copies_text_and_keeps_source_reference_idempotently() {
    let (db, dir) = temp_db();
    let inspiration_id = "clip-to-draft-source";
    let source_url = "https://www.xiaohongshu.com/explore/clip-to-draft";
    db.save_browser_capture_inspiration(LocalInspirationCreate {
        id: inspiration_id.to_string(),
        account_pool_id: 1,
        title: "收纳灵感标题".to_string(),
        source_url: source_url.to_string(),
        body: "正文保留原样\n#收纳 #家居 #收纳".to_string(),
        observed_at: "2026-10-04T10:00:00Z".to_string(),
        reason: "用户备注不覆盖".to_string(),
        dedupe_key: None,
        material_type: Some("note_material".to_string()),
        author: Some("来源作者".to_string()),
        capture_modules: Some(vec!["titleBody".to_string(), "authorSource".to_string()]),
    })
    .expect("save source clipping");

    let created = db
        .create_draft_from_local_inspiration(inspiration_id, 1)
        .expect("create a populated draft from the clipping");
    assert_eq!(created.inspiration.status, "converted");
    assert_eq!(created.inspiration.note_id, Some(created.note.id));
    assert_eq!(created.inspiration.source_url, source_url);
    assert_eq!(created.inspiration.author, "来源作者");
    assert_eq!(created.inspiration.reason, "用户备注不覆盖");
    assert_eq!(created.note.status, "draft");
    assert_eq!(created.note.note_type, "text");
    assert_eq!(created.note.title.as_deref(), Some("收纳灵感标题"));
    assert_eq!(
        created.note.body.as_deref(),
        Some("正文保留原样\n#收纳 #家居 #收纳")
    );
    assert_eq!(created.note.tags, vec!["收纳", "家居"]);

    let retry = db
        .create_draft_from_local_inspiration(inspiration_id, 1)
        .expect("retry returns the same draft");
    assert_eq!(retry.note.id, created.note.id);
    assert_eq!(retry.inspiration.id, inspiration_id);
    let references = db
        .local_inspiration_references(inspiration_id, 1)
        .expect("read source-to-draft relationship");
    assert_eq!(references.len(), 1);
    assert_eq!(references[0].target_kind, "note");
    assert_eq!(references[0].target_id, created.note.id.to_string());
    assert!(references[0].target_exists);

    assert!(
        db.create_draft_from_local_inspiration(inspiration_id, 2)
            .is_err(),
        "conversion must stay scoped to its source account"
    );
    fs::remove_dir_all(dir).ok();
}

#[test]
fn promoting_account_clipping_preserves_existing_reference_account_analysis() {
    let (db, dir) = temp_db();
    db.save_local_inspiration(LocalInspirationCreate {
        id: "profile-clip-for-reference".to_string(),
        account_pool_id: 1,
        title: "外部作者主页".to_string(),
        source_url: "https://www.xiaohongshu.com/user/profile/creator-42?xsec_token=fixture"
            .to_string(),
        body: String::new(),
        observed_at: "2026-10-04T10:00:00Z".to_string(),
        reason: String::new(),
        dedupe_key: None,
        material_type: Some("profile_material".to_string()),
        author: Some("剪藏作者昵称".to_string()),
        capture_modules: Some(vec!["authorSource".to_string()]),
    })
    .expect("save external account clipping");
    db.save_browser_capture_payload(
        "profile-clip-for-reference",
        1,
        r#"{"metrics":{"followers":1200},"profile":{"bio":"creator bio"}}"#,
    )
    .expect("save account clipping fields");
    db.create_local_reference_account(LocalReferenceAccountCreate {
        account_pool_id: 1,
        account_id: "creator-42".to_string(),
        name: Some("手工保留名称".to_string()),
        followers: 900,
    })
    .expect("create existing manually curated exemplar");
    let conn = db.connect().expect("seed existing exemplar analysis");
    conn.execute(
        "UPDATE reference_accounts SET content_style = 'existing analysis',
           top_notes = '[{\"title\":\"existing note\",\"likes\":18}]'
         WHERE account_pool_id = 1 AND account_id = 'creator-42'",
        [],
    )
    .expect("seed analysis and note that promotion must preserve");
    drop(conn);

    let promoted = db
        .promote_local_inspiration_to_reference_account("profile-clip-for-reference", 1)
        .expect("explicitly promote the account clipping");
    assert_eq!(promoted.platform_account_id, "creator-42");
    assert_eq!(promoted.name.as_deref(), Some("手工保留名称"));
    assert!(promoted.reference_account_id > 0);
    assert!(promoted.link_created);
    let retry = db
        .promote_local_inspiration_to_reference_account("profile-clip-for-reference", 1)
        .expect("repeat promotion idempotently");
    assert_eq!(retry.reference_account_id, promoted.reference_account_id);
    assert!(!retry.link_created);
    let conn = db
        .connect()
        .expect("verify preserved reference account fields");
    let (name, followers, style, notes): (Option<String>, i64, Option<String>, String) = conn
        .query_row(
            "SELECT name, followers, content_style, top_notes FROM reference_accounts
             WHERE id = ?1 AND account_pool_id = 1",
            params![promoted.reference_account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read preserved exemplar");
    assert_eq!(name.as_deref(), Some("手工保留名称"));
    assert_eq!(followers, 900);
    assert_eq!(style.as_deref(), Some("existing analysis"));
    assert!(notes.contains("existing note"));
    drop(conn);

    assert!(db
        .unlink_local_inspiration_from_target(
            "profile-clip-for-reference",
            1,
            "reference_account",
            "creator-42"
        )
        .expect("unlink without deleting the exemplar"));
    assert_eq!(
        db.local_inspiration_references("profile-clip-for-reference", 1)
            .expect("read removed backlink")
            .len(),
        0
    );
    assert!(db
        .local_inspirations(Some(1))
        .expect("clipping is retained")
        .iter()
        .any(|item| item.id == "profile-clip-for-reference"));
    fs::remove_dir_all(dir).ok();
}
