use super::*;

fn inspiration_draft_tags(body: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for token in body.split_whitespace() {
        let Some(candidate) = token.strip_prefix('#') else {
            continue;
        };
        let tag = candidate
            .chars()
            .take_while(|character| {
                !matches!(
                    character,
                    '#' | ','
                        | '，'
                        | '.'
                        | '。'
                        | '!'
                        | '！'
                        | '?'
                        | '？'
                        | ';'
                        | '；'
                        | ':'
                        | '：'
                        | '('
                        | ')'
                        | '（'
                        | '）'
                        | '['
                        | ']'
                        | '【'
                        | '】'
                )
            })
            .take(80)
            .collect::<String>();
        if !tag.is_empty() && !tags.iter().any(|existing| existing == &tag) {
            tags.push(tag);
            if tags.len() == 20 {
                break;
            }
        }
    }
    tags
}

fn note_summary_from_browser_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteSummary> {
    let tags: String = row.get(5)?;
    Ok(NoteSummary {
        id: row.get(0)?,
        item_id: row.get(1)?,
        item_ids: parse_json_vec(row.get(2)?),
        title: row.get(3)?,
        body: row.get(4)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
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
        content_version: row.get(18)?,
        deleted_at: row.get(19)?,
        video_path: row.get(20)?,
    })
}

fn strip_profile_notes_outcome(raw: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    if let Some(details) = value
        .get_mut("captureDetails")
        .and_then(serde_json::Value::as_object_mut)
    {
        details.remove("profileNotesSync");
    }
    serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string())
}

fn validate_local_inspiration_reference_identity(
    inspiration_id: &str,
    target_kind: &str,
    target_id: &str,
) -> Result<(), String> {
    if inspiration_id.is_empty()
        || inspiration_id.len() > 120
        || inspiration_id.chars().any(char::is_control)
    {
        return Err("剪藏 ID 无效".to_string());
    }
    if !matches!(
        target_kind,
        "topic" | "reference_account" | "inspiration" | "note" | "item"
    ) {
        return Err("剪藏引用类型无效".to_string());
    }
    let maximum = 200;
    if target_id.is_empty()
        || target_id.chars().count() > maximum
        || target_id.chars().any(char::is_control)
    {
        return Err("剪藏引用目标无效".to_string());
    }
    if matches!(target_kind, "note" | "item") {
        let parsed = target_id
            .parse::<i64>()
            .map_err(|_| "笔记或素材引用必须使用本地正整数 ID".to_string())?;
        if parsed <= 0 || parsed.to_string() != target_id {
            return Err("笔记或素材引用必须使用本地正整数 ID".to_string());
        }
    }
    Ok(())
}

fn xhs_profile_account_id(source_url: &str) -> Option<String> {
    let path = source_url.strip_prefix("https://www.xiaohongshu.com/user/profile/")?;
    let account_id = path.split(['?', '#', '/']).next()?.trim();
    if account_id.is_empty()
        || account_id.len() > 128
        || !account_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    Some(account_id.to_string())
}

fn local_inspiration_link_target_exists(
    conn: &Connection,
    account_pool_id: i64,
    target_kind: &str,
    target_id: &str,
) -> Result<bool, String> {
    match target_kind {
        // Topics are labels discovered or entered by the user; this project
        // does not have a persisted topic entity to reference.
        "topic" => Ok(true),
        "reference_account" => conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM reference_accounts
                 WHERE account_pool_id = ?1 AND account_id = ?2)",
                params![account_pool_id, target_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("校验榜样账号引用失败: {error}")),
        "inspiration" => conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM inspirations
                 WHERE account_pool_id = ?1 AND id = ?2 AND saved = 1)",
                params![account_pool_id, target_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("校验剪藏引用目标失败: {error}")),
        "note" => {
            let id = target_id
                .parse::<i64>()
                .map_err(|_| "笔记引用 ID 无效".to_string())?;
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM notes
                 WHERE account_pool_id = ?1 AND id = ?2 AND deleted_at IS NULL)",
                params![account_pool_id, id],
                |row| row.get(0),
            )
            .map_err(|error| format!("校验笔记引用失败: {error}"))
        }
        "item" => {
            let id = target_id
                .parse::<i64>()
                .map_err(|_| "素材引用 ID 无效".to_string())?;
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM items
                 WHERE account_pool_id = ?1 AND id = ?2)",
                params![account_pool_id, id],
                |row| row.get(0),
            )
            .map_err(|error| format!("校验素材引用失败: {error}"))
        }
        _ => Err("剪藏引用类型无效".to_string()),
    }
}

impl LocalDb {
    /// Explicitly promote an external-account clipping into the existing
    /// reference-account collection and retain a non-owning back-link.
    /// Existing analysis, notes, labels, and known metrics are not replaced.
    pub fn promote_local_inspiration_to_reference_account(
        &self,
        inspiration_id: &str,
        account_pool_id: i64,
    ) -> Result<LocalInspirationReferenceAccountResult, String> {
        let inspiration_id = inspiration_id.trim();
        if inspiration_id.is_empty() || inspiration_id.len() > 120 {
            return Err("剪藏 ID 无效".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("开启账号剪藏转榜样事务失败: {error}"))?;
        let (material_type, source_url, author, capture_payload): (
            String,
            String,
            String,
            Option<String>,
        ) = tx
            .query_row(
                "SELECT material_type, source_url, author, capture_payload
                 FROM inspirations
                 WHERE id = ?1 AND account_pool_id = ?2 AND saved = 1",
                params![inspiration_id, account_pool_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| format!("读取账号剪藏失败: {error}"))?
            .ok_or_else(|| "账号剪藏不存在或不属于当前账号".to_string())?;
        if material_type != "profile_material" {
            return Err("只有账号剪藏可以显式加入榜样账号".to_string());
        }
        let platform_account_id = xhs_profile_account_id(&source_url)
            .ok_or_else(|| "账号剪藏来源不是可识别的小红书作者主页".to_string())?;
        let name = (!author.trim().is_empty()).then(|| author.trim().to_string());
        let payload = capture_payload
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        let followers = payload
            .get("metrics")
            .and_then(|metrics| metrics.get("followers"))
            .and_then(serde_json::Value::as_i64)
            .filter(|value| *value >= 0);
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM reference_accounts
                 WHERE account_pool_id = ?1 AND account_id = ?2 ORDER BY id LIMIT 1",
                params![account_pool_id, platform_account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("查找已有榜样账号失败: {error}"))?;
        if let Some(reference_account_id) = existing {
            tx.execute(
                "UPDATE reference_accounts SET
                    name = CASE
                      WHEN name IS NULL OR trim(name) = '' OR trim(name) = account_id
                      THEN COALESCE(?1, name) ELSE name END,
                    followers = CASE
                      WHEN followers IS NULL OR followers = 0
                      THEN COALESCE(?2, followers, 0) ELSE followers END
                 WHERE id = ?3 AND account_pool_id = ?4",
                params![name, followers, reference_account_id, account_pool_id],
            )
            .map_err(|error| format!("更新已有榜样账号的空字段失败: {error}"))?;
        } else {
            tx.execute(
                "INSERT INTO reference_accounts (account_pool_id, account_id, name, followers)
                 VALUES (?1, ?2, ?3, COALESCE(?4, 0))",
                params![account_pool_id, platform_account_id, name, followers],
            )
            .map_err(|error| format!("从账号剪藏创建榜样账号失败: {error}"))?;
        }
        let reference_account_id: i64 = tx
            .query_row(
                "SELECT id FROM reference_accounts
                 WHERE account_pool_id = ?1 AND account_id = ?2 ORDER BY id LIMIT 1",
                params![account_pool_id, platform_account_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("读取新建榜样账号 ID 失败: {error}"))?;
        let stored_name: Option<String> = tx
            .query_row(
                "SELECT name FROM reference_accounts
                 WHERE id = ?1 AND account_pool_id = ?2",
                params![reference_account_id, account_pool_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("读取榜样账号名称失败: {error}"))?;
        let link_created = tx
            .execute(
                "INSERT OR IGNORE INTO inspiration_links
                    (account_pool_id, inspiration_id, target_kind, target_id)
                 VALUES (?1, ?2, 'reference_account', ?3)",
                params![account_pool_id, inspiration_id, platform_account_id],
            )
            .map_err(|error| format!("关联账号剪藏与榜样账号失败: {error}"))?
            == 1;
        tx.commit()
            .map_err(|error| format!("提交账号剪藏转榜样事务失败: {error}"))?;
        Ok(LocalInspirationReferenceAccountResult {
            inspiration_id: inspiration_id.to_string(),
            account_pool_id,
            reference_account_id,
            platform_account_id,
            name: stored_name,
            link_created,
        })
    }

    /// Add a removable, account-scoped reference without copying or owning the
    /// target. `target_kind` and target identity are validated before the link
    /// is recorded; duplicate links are idempotent.
    pub fn link_local_inspiration_to_target(
        &self,
        inspiration_id: &str,
        account_pool_id: i64,
        target_kind: &str,
        target_id: &str,
    ) -> Result<LocalInspirationReferenceSummary, String> {
        let inspiration_id = inspiration_id.trim();
        let target_kind = target_kind.trim();
        let target_id = target_id.trim();
        validate_local_inspiration_reference_identity(inspiration_id, target_kind, target_id)?;
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("开启剪藏引用事务失败: {error}"))?;
        let source_exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM inspirations
                 WHERE id = ?1 AND account_pool_id = ?2 AND saved = 1)",
                params![inspiration_id, account_pool_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("校验剪藏引用来源失败: {error}"))?;
        if !source_exists {
            return Err("剪藏不存在或不属于当前账号".to_string());
        }
        let target_exists =
            local_inspiration_link_target_exists(&tx, account_pool_id, target_kind, target_id)?;
        if !target_exists {
            return Err("引用目标不存在或不属于当前账号".to_string());
        }
        if target_kind == "inspiration" && target_id == inspiration_id {
            return Err("剪藏不能引用自身".to_string());
        }
        let created = tx
            .execute(
                "INSERT OR IGNORE INTO inspiration_links
                    (account_pool_id, inspiration_id, target_kind, target_id)
                 VALUES (?1, ?2, ?3, ?4)",
                params![account_pool_id, inspiration_id, target_kind, target_id],
            )
            .map_err(|error| format!("记录剪藏引用失败: {error}"))?
            == 1;
        tx.commit()
            .map_err(|error| format!("提交剪藏引用失败: {error}"))?;
        Ok(LocalInspirationReferenceSummary {
            inspiration_id: inspiration_id.to_string(),
            account_pool_id,
            target_kind: target_kind.to_string(),
            target_id: target_id.to_string(),
            target_exists: true,
            created,
        })
    }

    /// Remove only the relationship row. The clipping, target, and files are
    /// deliberately left intact.
    pub fn unlink_local_inspiration_from_target(
        &self,
        inspiration_id: &str,
        account_pool_id: i64,
        target_kind: &str,
        target_id: &str,
    ) -> Result<bool, String> {
        let inspiration_id = inspiration_id.trim();
        let target_kind = target_kind.trim();
        let target_id = target_id.trim();
        validate_local_inspiration_reference_identity(inspiration_id, target_kind, target_id)?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let source_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM inspirations
                 WHERE id = ?1 AND account_pool_id = ?2)",
                params![inspiration_id, account_pool_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("校验剪藏引用来源失败: {error}"))?;
        if !source_exists {
            return Err("剪藏不存在或不属于当前账号".to_string());
        }
        let changed = conn
            .execute(
                "DELETE FROM inspiration_links
                 WHERE account_pool_id = ?1 AND inspiration_id = ?2
                   AND target_kind = ?3 AND target_id = ?4",
                params![account_pool_id, inspiration_id, target_kind, target_id],
            )
            .map_err(|error| format!("移除剪藏引用失败: {error}"))?;
        Ok(changed == 1)
    }

    pub fn local_inspiration_references(
        &self,
        inspiration_id: &str,
        expected_account_id: i64,
    ) -> Result<Vec<LocalInspirationReferenceSummary>, String> {
        let inspiration_id = inspiration_id.trim();
        if inspiration_id.is_empty() || inspiration_id.len() > 120 {
            return Err("剪藏 ID 无效".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(expected_account_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let source_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM inspirations
                 WHERE id = ?1 AND account_pool_id = ?2)",
                params![inspiration_id, expected_account_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("校验剪藏引用来源失败: {error}"))?;
        if !source_exists {
            return Err("剪藏不存在或不属于当前账号".to_string());
        }
        let mut statement = conn
            .prepare(
                "SELECT target_kind, target_id FROM inspiration_links
                 WHERE account_pool_id = ?1 AND inspiration_id = ?2
                 ORDER BY created_at, target_kind, target_id",
            )
            .map_err(|error| format!("准备剪藏引用查询失败: {error}"))?;
        let links = statement
            .query_map(params![expected_account_id, inspiration_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("读取剪藏引用失败: {error}"))?
            .collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("解析剪藏引用失败: {error}"))?;
        links
            .into_iter()
            .map(|(target_kind, target_id)| {
                Ok(LocalInspirationReferenceSummary {
                    inspiration_id: inspiration_id.to_string(),
                    account_pool_id: expected_account_id,
                    target_exists: local_inspiration_link_target_exists(
                        &conn,
                        expected_account_id,
                        &target_kind,
                        &target_id,
                    )?,
                    target_kind,
                    target_id,
                    created: false,
                })
            })
            .collect()
    }

    pub fn register_browser_capture_request(
        &self,
        account_pool_id: i64,
        request_id: &str,
        inspiration_id: &str,
        capture_details_saved: bool,
    ) -> Result<(), String> {
        let request_id = request_id.trim();
        let inspiration_id = inspiration_id.trim();
        if request_id.is_empty()
            || request_id.len() > 128
            || request_id.chars().any(char::is_control)
            || inspiration_id.is_empty()
            || inspiration_id.len() > 120
        {
            return Err("剪藏 requestId 映射无效".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("剪藏目标账号不可用: {error}"))?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("开启剪藏 requestId 登记事务失败: {error}"))?;
        let existing: Option<String> = tx.query_row(
            "SELECT inspiration_id FROM browser_capture_requests WHERE account_pool_id = ?1 AND request_id = ?2",
            params![account_pool_id, request_id], |row| row.get(0),
        ).optional().map_err(|error| format!("读取剪藏 requestId 映射失败: {error}"))?;
        if existing
            .as_deref()
            .is_some_and(|saved| saved != inspiration_id)
        {
            return Err("requestId 已绑定到另一条剪藏，拒绝改绑".to_string());
        }
        tx.execute(
            "INSERT INTO browser_capture_requests (account_pool_id, request_id, inspiration_id, capture_details_saved)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_pool_id, request_id) DO UPDATE SET
               capture_details_saved = MAX(browser_capture_requests.capture_details_saved, excluded.capture_details_saved)",
            params![account_pool_id, request_id, inspiration_id, i64::from(capture_details_saved)],
        ).map_err(|error| format!("登记剪藏 requestId 映射失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交剪藏 requestId 映射失败: {error}"))?;
        Ok(())
    }

    /// 读取当前运营账号的本地灵感/剪藏，不依赖 WebView localStorage。
    pub fn local_inspirations(
        &self,
        expected_account_id: Option<i64>,
    ) -> Result<Vec<InspirationSummary>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        conn.execute(
            "UPDATE inspiration_images SET status = 'failed', error = '上次下载中断，可重试',
                updated_at = datetime('now', 'localtime')
             WHERE account_pool_id = ?1 AND status = 'downloading'
               AND updated_at < datetime('now', 'localtime', '-2 minutes')",
            params![active.id],
        )
        .map_err(|error| format!("恢复中断的收藏图片状态失败: {error}"))?;
        let mut statement = conn
            .prepare(
                "SELECT id, account_pool_id, title, source_url, body, observed_at,
                        reason, status, note_id, dedupe_key, material_type, author, capture_modules, capture_payload
                 FROM inspirations
                 WHERE account_pool_id = ?1 AND saved = 1
                 ORDER BY observed_at DESC, id DESC",
            )
            .map_err(|error| format!("读取本地灵感失败: {error}"))?;
        let mut inspirations = statement
            .query_map(params![active.id], inspiration_from_row)
            .map_err(|error| format!("读取本地灵感失败: {error}"))?
            .collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("解析本地灵感失败: {error}"))?;
        drop(statement);
        for inspiration in &mut inspirations {
            self.hydrate_collection_summary(&conn, inspiration)?;
        }
        Ok(inspirations)
    }

    /// Read the legacy topic-inspiration API shape from the account-scoped store.
    pub fn legacy_knowledge_inspirations(
        &self,
        expected_account_id: Option<i64>,
    ) -> Result<Vec<LegacyKnowledgeInspiration>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let mut statement = conn
            .prepare(
                "SELECT COALESCE(legacy_id, rowid), title, keyword, source,
                        likes_ref, note_ref, saved, created_at
                 FROM inspirations
                 WHERE account_pool_id = ?1 AND saved = 1
                 ORDER BY created_at DESC, rowid DESC",
            )
            .map_err(|error| format!("准备旧版灵感列表失败: {error}"))?;
        let rows = statement
            .query_map(params![active.id], |row| {
                Ok(LegacyKnowledgeInspiration {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    keyword: row.get(2)?,
                    source: row.get(3)?,
                    likes_ref: row.get(4)?,
                    note_ref: row.get(5)?,
                    saved: row.get::<_, i64>(6)? != 0,
                    created_at: row.get(7)?,
                })
            })
            .map_err(|error| format!("读取旧版灵感列表失败: {error}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("读取旧版灵感列表失败: {error}"))
    }

    /// Add a legacy-format inspiration while storing it in the active account's local database.
    pub fn create_legacy_knowledge_inspiration(
        &self,
        title: &str,
        keyword: Option<&str>,
        source: &str,
        likes_ref: i64,
        note_ref: Option<&str>,
    ) -> Result<LegacyKnowledgeInspiration, String> {
        let title = title.trim();
        let source = source.trim();
        if title.chars().count() > 200 || source.chars().count() > 80 {
            return Err("灵感标题最多 200 字，来源最多 80 字".to_string());
        }
        if keyword.is_some_and(|value| value.chars().count() > 2_000)
            || note_ref.is_some_and(|value| value.chars().count() > 2_000)
        {
            return Err("关键词或参考链接最多 2000 字".to_string());
        }
        if likes_ref < 0 {
            return Err("参考点赞数不能小于 0".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开启灵感事务失败: {error}"))?;
        let legacy_id: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(legacy_id), 0) + 1 FROM inspirations",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("生成兼容灵感 ID 失败: {error}"))?;
        let id = format!("legacy-api-{}-{legacy_id}", active.id);
        let note_ref = note_ref.map(str::trim).filter(|value| !value.is_empty());
        tx.execute(
            "INSERT INTO inspirations (
                id, account_pool_id, title, source_url, body, observed_at, reason,
                status, note_id, dedupe_key, keyword, source, likes_ref, note_ref,
                saved, legacy_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now', 'localtime'), ?6,
                       'saved', NULL, NULL, ?5, ?6, ?7, ?4, 1, ?8)",
            params![
                id,
                active.id,
                title,
                note_ref.unwrap_or_default(),
                keyword.unwrap_or_default().trim(),
                source,
                likes_ref,
                legacy_id,
            ],
        )
        .map_err(|error| format!("保存灵感失败: {error}"))?;
        let created = tx
            .query_row(
                "SELECT COALESCE(legacy_id, rowid), title, keyword, source,
                        likes_ref, note_ref, saved, created_at
                 FROM inspirations WHERE id = ?1 AND account_pool_id = ?2",
                params![id, active.id],
                |row| {
                    Ok(LegacyKnowledgeInspiration {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        keyword: row.get(2)?,
                        source: row.get(3)?,
                        likes_ref: row.get(4)?,
                        note_ref: row.get(5)?,
                        saved: row.get::<_, i64>(6)? != 0,
                        created_at: row.get(7)?,
                    })
                },
            )
            .map_err(|error| format!("读取新建灵感失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交灵感失败: {error}"))?;
        Ok(created)
    }

    /// Soft-delete a legacy inspiration without touching records in other account pools.
    pub fn delete_legacy_knowledge_inspiration(
        &self,
        inspiration_id: i64,
        expected_account_id: i64,
    ) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(expected_account_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let changed = conn
            .execute(
                "UPDATE inspirations SET saved = 0, updated_at = datetime('now', 'localtime')
                 WHERE account_pool_id = ?1 AND saved = 1
                   AND (legacy_id = ?2 OR (legacy_id IS NULL AND rowid = ?2))",
                params![active.id, inspiration_id],
            )
            .map_err(|error| format!("删除灵感失败: {error}"))?;
        if changed != 1 {
            return Err("灵感不存在或不属于当前账号".to_string());
        }
        Ok(())
    }

    /// Save the bounded, sanitized images/comments evidence selected in the extension popup.
    pub fn save_browser_capture_payload(
        &self,
        id: &str,
        account_pool_id: i64,
        payload_json: &str,
    ) -> Result<(), String> {
        if payload_json.len() > 64 * 1024 {
            return Err("图片与评论摘录超过 64KB 限制".to_string());
        }
        let payload: serde_json::Value =
            serde_json::from_str(payload_json).map_err(|_| "图片与评论摘录格式无效".to_string())?;
        if !payload.is_object() {
            return Err("图片与评论摘录格式无效".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("浏览器目标账号不可用: {error}"))?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT capture_payload FROM inspirations WHERE id = ?1 AND account_pool_id = ?2",
                params![id.trim(), account_pool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取图片与评论摘录失败: {error}"))?;
        let Some(existing) = existing else {
            return Err("目标网页收藏不存在或不属于所选账号".to_string());
        };
        let mut previous: serde_json::Value =
            serde_json::from_str(&existing).unwrap_or_else(|_| serde_json::json!({}));
        if previous != serde_json::json!({}) {
            if let Some(object) = previous.as_object_mut() {
                object.remove("importedItemIds");
            }
            if previous != payload {
                return Err("requestId 已用于不同的图片或评论摘录，拒绝覆盖".to_string());
            }
            drop(conn);
            self.browser_collection_image_positions(id, account_pool_id)?;
            return Ok(());
        }
        let changed = conn.execute(
            "UPDATE inspirations SET capture_payload = ?1, updated_at = datetime('now', 'localtime')
             WHERE id = ?2 AND account_pool_id = ?3",
            params![payload_json, id.trim(), account_pool_id],
        ).map_err(|error| format!("保存浏览器图片与评论摘录失败: {error}"))?;
        if changed != 1 {
            return Err("目标网页收藏不存在或不属于所选账号".to_string());
        }
        drop(conn);
        self.browser_collection_image_positions(id, account_pool_id)?;
        Ok(())
    }

    /// Persist the result of syncing profile note cards into the matching
    /// request's snapshot so a timed-out extension can verify the write.
    pub fn save_browser_profile_notes_outcome(
        &self,
        snapshot_id: i64,
        account_pool_id: i64,
        outcome: &serde_json::Value,
    ) -> Result<(), String> {
        if snapshot_id <= 0 || !outcome.is_object() {
            return Err("主页笔记同步回执无效".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("浏览器目标账号不可用: {error}"))?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT metrics_json FROM page_snapshots WHERE id = ?1 AND account_pool_id = ?2",
                params![snapshot_id, account_pool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取主页快照回执失败: {error}"))?;
        let Some(raw) = raw else {
            return Err("主页快照不存在或不属于所选账号".to_string());
        };
        let mut metrics: serde_json::Value =
            serde_json::from_str(&raw).map_err(|error| format!("解析主页快照回执失败: {error}"))?;
        let details = metrics
            .get_mut("captureDetails")
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| "主页快照缺少采集详情".to_string())?;
        details.insert("profileNotesSync".to_string(), outcome.clone());
        let updated = conn
            .execute(
                "UPDATE page_snapshots SET metrics_json = ?1 WHERE id = ?2 AND account_pool_id = ?3",
                params![serde_json::to_string(&metrics).map_err(|error| error.to_string())?, snapshot_id, account_pool_id],
            )
            .map_err(|error| format!("保存主页笔记同步回执失败: {error}"))?;
        if updated != 1 {
            return Err("主页快照不存在或不属于所选账号".to_string());
        }
        Ok(())
    }

    /// Read persisted outcomes for a timed-out extension capture. The selected account is
    /// mandatory so a result from another workspace/account can never satisfy verification.
    pub fn lookup_browser_capture_request(
        &self,
        account_pool_id: i64,
        request_id: &str,
    ) -> Result<BrowserCaptureRequestStatus, String> {
        let request_id = request_id.trim();
        if request_id.is_empty()
            || request_id.chars().count() > 128
            || request_id.chars().any(char::is_control)
        {
            return Err("采集 requestId 无效".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("浏览器目标账号不可用: {error}"))?;
        let legacy_collection_id = format!(
            "bc:{account_pool_id}:{}",
            request_id.chars().take(96).collect::<String>()
        );
        let collection_id = conn
            .query_row(
                "SELECT inspiration_id FROM browser_capture_requests
             WHERE account_pool_id = ?1 AND request_id = ?2",
                params![account_pool_id, request_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("读取剪藏 requestId 映射失败: {error}"))?
            .unwrap_or(legacy_collection_id);
        let capture_payload: Option<Option<String>> = conn
            .query_row(
                "SELECT capture_payload FROM inspirations WHERE id = ?1 AND account_pool_id = ?2 AND saved = 1",
                params![collection_id, account_pool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("核实网页收藏结果失败: {error}"))?;
        let image_counts = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)
             FROM inspiration_images WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND request_id = ?3",
            params![account_pool_id, collection_id, request_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
        ).map_err(|error| format!("核实剪藏图片结果失败: {error}"))?;
        let payload_image_count = capture_payload
            .as_ref()
            .and_then(Option::as_deref)
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|payload| {
                payload
                    .get("images")
                    .and_then(serde_json::Value::as_array)
                    .map(Vec::len)
            })
            .unwrap_or_default();
        let images_total = (image_counts.0.max(0) as usize).max(payload_image_count);
        let snapshot = conn
            .query_row(
                "SELECT id, metrics_json FROM page_snapshots
                 WHERE account_pool_id = ?1 AND request_id = ?2
                 ORDER BY id DESC LIMIT 1",
                params![account_pool_id, request_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| format!("核实数据快照结果失败: {error}"))?;
        let snapshot_id = snapshot.as_ref().map(|(id, _)| *id);
        let profile_note_outcome = snapshot
            .as_ref()
            .and_then(|(_, raw)| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|metrics| metrics.get("captureDetails").cloned())
            .and_then(|details| details.get("profileNotesSync").cloned())
            .unwrap_or(serde_json::Value::Null);
        Ok(BrowserCaptureRequestStatus {
            request_id: request_id.to_string(),
            target_account_id: account_pool_id,
            collection_saved: capture_payload.is_some(),
            capture_details_saved: capture_payload
                .as_ref()
                .and_then(Option::as_deref)
                .and_then(|payload| serde_json::from_str::<serde_json::Value>(payload).ok())
                .is_some_and(|payload| {
                    payload
                        .get("images")
                        .and_then(serde_json::Value::as_array)
                        .is_some()
                        && payload
                            .get("comments")
                            .and_then(serde_json::Value::as_array)
                            .is_some()
                }),
            images_total,
            images_ready: image_counts.1.max(0) as usize,
            images_failed: image_counts.2.max(0) as usize,
            snapshot_saved: snapshot_id.is_some(),
            snapshot_id,
            profile_notes_saved: profile_note_outcome
                .get("saved")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            profile_notes_imported: profile_note_outcome
                .get("imported")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default() as usize,
            profile_notes_updated: profile_note_outcome
                .get("updated")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default() as usize,
            profile_notes_skipped: profile_note_outcome
                .get("skipped")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            profile_notes_state: profile_note_outcome
                .get("state")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            profile_notes_error: profile_note_outcome
                .get("error")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        })
    }

    /// Associate locally imported creator assets with the source collection card.
    pub fn attach_browser_capture_assets(
        &self,
        id: &str,
        account_pool_id: i64,
        item_ids: &[i64],
    ) -> Result<(), String> {
        if item_ids.len() > 12 || item_ids.iter().any(|id| *id <= 0) {
            return Err("素材关联列表无效".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开启素材关联事务失败: {error}"))?;
        for item_id in item_ids {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM items WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL)",
                params![item_id, account_pool_id],
                |row| row.get(0),
            ).map_err(|error| format!("校验创作素材归属失败: {error}"))?;
            if !exists {
                return Err("一个或多个素材不存在或不属于当前账号".to_string());
            }
        }
        let raw: Option<String> = tx
            .query_row(
                "SELECT capture_payload FROM inspirations WHERE id = ?1 AND account_pool_id = ?2",
                params![id.trim(), account_pool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取网页收藏素材关联失败: {error}"))?;
        let Some(raw) = raw else {
            return Err("目标网页收藏不存在或不属于当前账号".to_string());
        };
        let mut payload: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
        let object = payload
            .as_object_mut()
            .ok_or_else(|| "网页收藏素材信息格式无效".to_string())?;
        object.insert("importedItemIds".to_string(), serde_json::json!(item_ids));
        let serialized = serde_json::to_string(&payload)
            .map_err(|error| format!("序列化素材关联失败: {error}"))?;
        tx.execute(
            "UPDATE inspirations SET capture_payload = ?1, updated_at = datetime('now', 'localtime') WHERE id = ?2 AND account_pool_id = ?3",
            params![serialized, id.trim(), account_pool_id],
        ).map_err(|error| format!("更新网页收藏素材关联失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交素材关联失败: {error}"))?;
        Ok(())
    }

    /// 保存一条当前账号的灵感/剪藏。相同 dedupe key 会替换旧的未采用记录，
    /// 防止浏览器重复发送造成列表膨胀；已转草稿的记录仍保留其转换状态。
    pub fn save_local_inspiration(&self, input: LocalInspirationCreate) -> Result<(), String> {
        self.save_local_inspiration_scoped(input, true)
    }

    /// Browser capture may target another explicitly selected local account without
    /// changing the desktop's globally active account.
    pub fn save_browser_capture_inspiration(
        &self,
        input: LocalInspirationCreate,
    ) -> Result<(), String> {
        self.save_local_inspiration_scoped(input, false)
    }

    fn save_local_inspiration_scoped(
        &self,
        input: LocalInspirationCreate,
        require_active: bool,
    ) -> Result<(), String> {
        validate_local_inspiration(&input)?;
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        if require_active {
            let active = ensure_active_account(&conn, &self.path)
                .map_err(|error| format!("读取激活账号失败: {error}"))?;
            ensure_expected_account(&active, Some(input.account_pool_id))
                .map_err(|error| format!("账号上下文已变化: {error}"))?;
        } else {
            ensure_capture_account(&conn, input.account_pool_id)
                .map_err(|error| format!("浏览器目标账号不可用: {error}"))?;
        }
        let tx = conn
            .transaction()
            .map_err(|error| format!("开启本地灵感事务失败: {error}"))?;
        let existing: Option<(i64, String, String, String, String, String)> = tx
            .query_row(
                "SELECT account_pool_id, title, source_url, body, author, capture_modules
                 FROM inspirations WHERE id = ?1",
                params![input.id.trim()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("校验本地灵感归属失败: {error}"))?;
        if existing
            .as_ref()
            .is_some_and(|saved| saved.0 != input.account_pool_id)
        {
            return Err("灵感 ID 已属于其他账号，拒绝覆盖".to_string());
        }
        if !require_active {
            if let Some(saved) = existing.as_ref() {
                let capture_modules =
                    serde_json::to_string(input.capture_modules.as_deref().unwrap_or(&[]))
                        .unwrap_or_else(|_| "[]".to_string());
                if saved.1 != input.title.trim()
                    || saved.2 != input.source_url.trim()
                    || saved.3 != input.body.trim()
                    || saved.4 != input.author.as_deref().unwrap_or("").trim()
                    || saved.5 != capture_modules
                {
                    return Err("requestId 已用于不同收藏内容，拒绝覆盖".to_string());
                }
            }
        }
        if let Some(dedupe_key) = input.dedupe_key.as_deref() {
            if !dedupe_key.is_empty() {
                let converted_id: Option<String> = tx
                    .query_row(
                        "SELECT id FROM inspirations
                         WHERE account_pool_id = ?1 AND dedupe_key = ?2
                           AND status = 'converted'
                         ORDER BY updated_at DESC, id DESC LIMIT 1",
                        params![input.account_pool_id, dedupe_key.trim()],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| format!("读取已转换灵感失败: {error}"))?;
                if let Some(converted_id) = converted_id {
                    tx.execute(
                        "UPDATE inspirations SET
                           title = ?1, source_url = ?2, body = ?3,
                           observed_at = ?4, reason = ?5, updated_at = datetime('now', 'localtime')
                         WHERE id = ?6 AND account_pool_id = ?7",
                        params![
                            input.title.trim(),
                            input.source_url.trim(),
                            input.body.trim(),
                            input.observed_at.trim(),
                            input.reason.trim(),
                            converted_id,
                            input.account_pool_id,
                        ],
                    )
                    .map_err(|error| format!("更新已转换灵感失败: {error}"))?;
                    tx.commit()
                        .map_err(|error| format!("提交本地灵感失败: {error}"))?;
                    return Ok(());
                }
                tx.execute(
                    "DELETE FROM inspirations
                     WHERE account_pool_id = ?1 AND dedupe_key = ?2 AND id <> ?3
                       AND status = 'saved' AND saved = 1",
                    params![input.account_pool_id, dedupe_key, input.id],
                )
                .map_err(|error| format!("清理重复灵感失败: {error}"))?;
            }
        }
        tx.execute(
            "INSERT INTO inspirations (
               id, account_pool_id, title, source_url, body, observed_at, reason,
               status, note_id, dedupe_key, material_type, author, capture_modules,
               created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'saved', NULL, ?8, ?9, ?10, ?11,
                       datetime('now', 'localtime'), datetime('now', 'localtime'))
             ON CONFLICT(id) DO UPDATE SET
               account_pool_id = excluded.account_pool_id,
               title = excluded.title,
               source_url = excluded.source_url,
               body = excluded.body,
               observed_at = excluded.observed_at,
               reason = excluded.reason,
               dedupe_key = excluded.dedupe_key,
               material_type = excluded.material_type,
               author = excluded.author,
               capture_modules = excluded.capture_modules,
               saved = 1,
               updated_at = excluded.updated_at",
            params![
                input.id,
                input.account_pool_id,
                input.title.trim(),
                input.source_url.trim(),
                input.body.trim(),
                input.observed_at.trim(),
                input.reason.trim(),
                input.dedupe_key.as_deref().map(str::trim),
                input
                    .material_type
                    .as_deref()
                    .unwrap_or("web_material")
                    .trim(),
                input.author.as_deref().unwrap_or("").trim(),
                serde_json::to_string(input.capture_modules.as_deref().unwrap_or(&[]))
                    .unwrap_or_else(|_| "[]".to_string()),
            ],
        )
        .map_err(|error| format!("保存本地灵感失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交本地灵感失败: {error}"))?;
        Ok(())
    }

    /// 将本地灵感显式关联到当前账号的一条草稿，转换动作幂等且不自动发布。
    pub fn convert_local_inspiration(
        &self,
        id: &str,
        account_pool_id: i64,
        note_id: i64,
    ) -> Result<InspirationSummary, String> {
        if id.trim().is_empty() || id.chars().count() > 120 {
            return Err("灵感 ID 无效".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开启灵感转换事务失败: {error}"))?;
        let note_exists: Option<i64> = tx
            .query_row(
                "SELECT id FROM notes
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![note_id, account_pool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("校验灵感草稿归属失败: {error}"))?;
        if note_exists.is_none() {
            return Err("目标草稿不存在或不属于当前账号".to_string());
        }
        let changed = tx
            .execute(
                "UPDATE inspirations
                 SET status = 'converted', note_id = ?1, updated_at = datetime('now', 'localtime')
                 WHERE id = ?2 AND account_pool_id = ?3 AND status = 'saved' AND saved = 1",
                params![note_id, id.trim(), account_pool_id],
            )
            .map_err(|error| format!("转换本地灵感失败: {error}"))?;
        if changed != 1 {
            return Err("灵感不存在、已转为草稿或不属于当前账号".to_string());
        }
        let converted = tx
            .query_row(
                "SELECT id, account_pool_id, title, source_url, body, observed_at,
                        reason, status, note_id, dedupe_key, material_type, author, capture_modules, capture_payload
                 FROM inspirations
                 WHERE id = ?1 AND account_pool_id = ?2",
                params![id.trim(), account_pool_id],
                inspiration_from_row,
            )
            .map_err(|error| format!("读取已转换灵感失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交灵感转换失败: {error}"))?;
        Ok(converted)
    }

    /// Create a draft from a clipping in one transaction, retaining a non-owning
    /// back-reference so source text and media remain available from both views.
    pub fn create_draft_from_local_inspiration(
        &self,
        id: &str,
        account_pool_id: i64,
    ) -> Result<LocalInspirationDraftResult, String> {
        if id.trim().is_empty() || id.chars().count() > 120 {
            return Err("剪藏 ID 无效".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("开启剪藏转草稿事务失败: {error}"))?;
        let mut inspiration = tx
            .query_row(
                "SELECT id, account_pool_id, title, source_url, body, observed_at,
                        reason, status, note_id, dedupe_key, material_type, author,
                        capture_modules, capture_payload
                 FROM inspirations
                 WHERE id = ?1 AND account_pool_id = ?2 AND saved = 1",
                params![id.trim(), account_pool_id],
                inspiration_from_row,
            )
            .optional()
            .map_err(|error| format!("读取剪藏转草稿来源失败: {error}"))?
            .ok_or_else(|| "剪藏不存在或不属于当前账号".to_string())?;
        if !matches!(
            inspiration.material_type.as_str(),
            "note_material" | "web_material"
        ) {
            return Err("只有笔记或网页剪藏可以转为草稿".to_string());
        }

        let note_id = if inspiration.status == "converted" {
            inspiration
                .note_id
                .ok_or_else(|| "剪藏已转换但找不到关联草稿".to_string())?
        } else if inspiration.status == "saved" {
            let title = inspiration.title.trim();
            if title.is_empty() || title.chars().count() > 200 {
                return Err("剪藏标题为空或超过草稿标题长度限制".to_string());
            }
            if inspiration.body.chars().count() > 100_000 {
                return Err("剪藏正文超过草稿正文长度限制，原剪藏仍保留".to_string());
            }
            let tags = inspiration_draft_tags(&inspiration.body);
            let tags_json = serde_json::to_string(&tags)
                .map_err(|error| format!("序列化剪藏话题失败: {error}"))?;
            let note_type = if inspiration.material_type == "web_material" {
                "article"
            } else {
                "text"
            };
            tx.execute(
                "INSERT INTO notes
                    (item_ids, title, body, tags, status, note_type, account_pool_id)
                 VALUES ('[]', ?1, ?2, ?3, 'draft', ?4, ?5)",
                params![
                    title,
                    inspiration.body,
                    tags_json,
                    note_type,
                    account_pool_id
                ],
            )
            .map_err(|error| format!("创建剪藏草稿失败: {error}"))?;
            let note_id = tx.last_insert_rowid();
            let changed = tx
                .execute(
                    "UPDATE inspirations SET status = 'converted', note_id = ?1,
                        updated_at = datetime('now', 'localtime')
                     WHERE id = ?2 AND account_pool_id = ?3 AND status = 'saved' AND saved = 1",
                    params![note_id, id.trim(), account_pool_id],
                )
                .map_err(|error| format!("更新剪藏转换状态失败: {error}"))?;
            if changed != 1 {
                return Err("剪藏状态已变化，草稿未关联".to_string());
            }
            inspiration.status = "converted".to_string();
            inspiration.note_id = Some(note_id);
            note_id
        } else {
            return Err("剪藏已删除或不能转换为草稿".to_string());
        };

        let note = tx
            .query_row(
                "SELECT id, item_id, item_ids, title, body, tags, status, note_type,
                        likes, comments, collects, published_at, note_url, account_ref,
                        cover_desc, prompt_used, created_at, updated_at, content_version,
                        deleted_at, video_path
                 FROM notes
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![note_id, account_pool_id],
                note_summary_from_browser_row,
            )
            .optional()
            .map_err(|error| format!("读取剪藏草稿失败: {error}"))?
            .ok_or_else(|| "关联草稿不存在或不属于当前账号".to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO inspiration_links
                (account_pool_id, inspiration_id, target_kind, target_id)
             VALUES (?1, ?2, 'note', ?3)",
            params![account_pool_id, id.trim(), note_id.to_string()],
        )
        .map_err(|error| format!("保存剪藏草稿引用失败: {error}"))?;
        self.hydrate_collection_summary(&tx, &mut inspiration)?;
        tx.commit()
            .map_err(|error| format!("提交剪藏转草稿事务失败: {error}"))?;
        Ok(LocalInspirationDraftResult { inspiration, note })
    }

    /// 根据当前激活账号的本地记录识别扩展当前页，供旧调用保持兼容。
    pub fn lookup_browser_page_context(
        &self,
        source_url: &str,
        requested_page_type: &str,
    ) -> Result<BrowserPageContext, String> {
        let account = self.current_active_account()?;
        self.lookup_browser_page_context_for_account(source_url, requested_page_type, account.id)
    }

    pub fn lookup_browser_page_context_for_account(
        &self,
        source_url: &str,
        requested_page_type: &str,
        account_pool_id: i64,
    ) -> Result<BrowserPageContext, String> {
        let normalized_url = normalize_browser_lookup_url(source_url)
            .ok_or_else(|| "当前页链接无效，必须是 http(s) 链接".to_string())?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("浏览器目标账号不可用: {error}"))?;
        let target_account_id = account_pool_id;

        let own_note = {
            let mut statement = conn
                .prepare(
                    "SELECT title, note_url FROM notes
                     WHERE account_pool_id = ?1 AND deleted_at IS NULL AND note_url IS NOT NULL",
                )
                .map_err(|error| format!("查询当前账号笔记失败: {error}"))?;
            let rows = statement
                .query_map(params![target_account_id], |row| {
                    Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| format!("读取当前账号笔记失败: {error}"))?;
            let matched = rows.filter_map(Result::ok).find(|(_, url)| {
                normalize_browser_lookup_url(url).as_deref() == Some(normalized_url.as_str())
            });
            matched
        };

        let mut reference_note: Option<(i64, Option<String>, Option<String>)> = None;
        let mut reference_profile: Option<(i64, Option<String>)> = None;
        {
            let mut statement = conn
                .prepare(
                    "SELECT id, account_id, name, top_notes FROM reference_accounts
                     WHERE account_pool_id = ?1 ORDER BY id DESC",
                )
                .map_err(|error| format!("查询当前账号榜样失败: {error}"))?;
            let rows = statement
                .query_map(params![target_account_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|error| format!("读取当前账号榜样失败: {error}"))?;
            for row in rows {
                let (id, account_id, name, top_notes) =
                    row.map_err(|error| format!("解析当前账号榜样失败: {error}"))?;
                let notes =
                    serde_json::from_str::<Vec<ReferenceNote>>(&top_notes).unwrap_or_default();
                if let Some(note) = notes.iter().find(|note| {
                    note.url
                        .as_deref()
                        .and_then(normalize_browser_lookup_url)
                        .as_deref()
                        == Some(normalized_url.as_str())
                }) {
                    reference_note = Some((id, name.clone(), Some(note.title.clone())));
                    break;
                }
                if requested_page_type == "profile" && url_has_path_segment(source_url, &account_id)
                {
                    reference_profile = Some((id, name));
                    break;
                }
            }
        }

        let prior_snapshots = {
            let mut statement = conn
                .prepare(
                    "SELECT kind, title, observed_at, source_url, reference_account_id, metrics_json FROM page_snapshots
                     WHERE account_pool_id = ?1
                     ORDER BY observed_at DESC, id DESC LIMIT 2000",
                )
                .map_err(|error| format!("查询页面快照历史失败: {error}"))?;
            let rows = statement
                .query_map(params![target_account_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })
                .map_err(|error| format!("读取页面快照历史失败: {error}"))?;
            let mut found = Vec::new();
            for row in rows {
                let snapshot = row.map_err(|error| format!("解析页面快照历史失败: {error}"))?;
                if normalize_browser_lookup_url(&snapshot.3).as_deref()
                    == Some(normalized_url.as_str())
                    && matches!(snapshot.0.as_str(), "note_snapshot" | "ref_snapshot")
                {
                    found.push(snapshot);
                }
            }
            found
        };
        let note_snapshot = prior_snapshots
            .iter()
            .find(|snapshot| snapshot.0 == "note_snapshot")
            .cloned();
        let reference_snapshot = prior_snapshots
            .iter()
            .find(|snapshot| snapshot.0 == "ref_snapshot")
            .cloned();

        let saved_material = {
            let mut statement = conn
                .prepare(
                    "SELECT title, source_url, material_type FROM inspirations
                     WHERE account_pool_id = ?1 AND source_url != ''
                     ORDER BY updated_at DESC, id DESC",
                )
                .map_err(|error| format!("查询已收藏材料失败: {error}"))?;
            let rows = statement
                .query_map(params![target_account_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .map_err(|error| format!("读取已收藏材料失败: {error}"))?;
            let mut found = None;
            for row in rows {
                let item = row.map_err(|error| format!("解析已收藏材料失败: {error}"))?;
                if normalize_browser_lookup_url(&item.1).as_deref() == Some(normalized_url.as_str())
                {
                    found = Some(item);
                    break;
                }
            }
            found
        };

        if let Some((title, _)) = own_note {
            let last_snapshot_at = note_snapshot.as_ref().map(|snapshot| snapshot.2.clone());
            let last_snapshot_metrics = note_snapshot
                .as_ref()
                .and_then(|snapshot| browser_page_snapshot_metrics(&snapshot.5));
            return Ok(browser_page_context(
                "own_note",
                "note",
                Some("note_snapshot"),
                None,
                title,
                last_snapshot_at,
                last_snapshot_metrics,
            ));
        }
        if let Some((reference_account_id, name, note_title)) = reference_note {
            let last_snapshot_at = reference_snapshot
                .as_ref()
                .map(|snapshot| snapshot.2.clone());
            let last_snapshot_metrics = reference_snapshot
                .as_ref()
                .and_then(|snapshot| browser_page_snapshot_metrics(&snapshot.5));
            return Ok(browser_page_context(
                "reference_note",
                "note",
                Some("ref_snapshot"),
                Some(reference_account_id),
                reference_snapshot
                    .as_ref()
                    .map(|snapshot| snapshot.1.clone())
                    .or(note_title)
                    .or(name),
                last_snapshot_at,
                last_snapshot_metrics,
            ));
        }
        if let Some((reference_account_id, name)) = reference_profile {
            let last_snapshot_at = reference_snapshot
                .as_ref()
                .map(|snapshot| snapshot.2.clone());
            let last_snapshot_metrics = reference_snapshot
                .as_ref()
                .and_then(|snapshot| browser_page_snapshot_metrics(&snapshot.5));
            return Ok(browser_page_context(
                "reference_profile",
                "profile",
                Some("ref_snapshot"),
                Some(reference_account_id),
                reference_snapshot
                    .as_ref()
                    .map(|snapshot| snapshot.1.clone())
                    .or(name),
                last_snapshot_at,
                last_snapshot_metrics,
            ));
        }
        let prior_snapshot = prior_snapshots.first().cloned();
        if let Some((kind, title, observed_at, _, reference_account_id, metrics_json)) =
            prior_snapshot
        {
            if kind == "note_snapshot" || kind == "ref_snapshot" {
                let page_type = if kind == "note_snapshot" {
                    "note"
                } else if requested_page_type == "profile" {
                    "profile"
                } else {
                    "note"
                };
                return Ok(browser_page_context(
                    "known_snapshot",
                    page_type,
                    Some(&kind),
                    reference_account_id,
                    Some(title),
                    Some(observed_at),
                    browser_page_snapshot_metrics(&metrics_json),
                ));
            }
        }
        if let Some((title, _, Some(material_type))) = saved_material {
            let (match_type, page_type) = match material_type.as_str() {
                "note_material" => ("saved_note_material", "note"),
                "profile_material" => ("saved_profile_material", "profile"),
                "image_material" => ("saved_image_material", "web"),
                _ => ("", "web"),
            };
            if !match_type.is_empty() {
                return Ok(browser_page_context(
                    match_type,
                    page_type,
                    Some("ref_snapshot"),
                    None,
                    Some(title),
                    None,
                    None,
                ));
            }
        }

        Ok(BrowserPageContext {
            match_type: "unknown".to_string(),
            default_action: "collect_material".to_string(),
            page_type: requested_page_type.to_string(),
            snapshot_kind: None,
            reference_account_id: None,
            matched_title: None,
            last_snapshot_at: None,
            last_snapshot_metrics: None,
        })
    }

    /// 保存一条页面快照（单篇刷新 / 扩展解析当前页）。
    /// 快照是数据记录，不走灵感待确认队列；指标缺失保持 NULL，不编造数字。
    pub fn save_page_snapshot(
        &self,
        input: PageSnapshotCreate,
    ) -> Result<PageSnapshotSummary, String> {
        self.save_page_snapshot_scoped(input, true)
    }

    pub fn save_browser_page_snapshot(
        &self,
        input: PageSnapshotCreate,
    ) -> Result<PageSnapshotSummary, String> {
        self.save_page_snapshot_scoped(input, false)
    }

    fn save_page_snapshot_scoped(
        &self,
        input: PageSnapshotCreate,
        require_active: bool,
    ) -> Result<PageSnapshotSummary, String> {
        validate_page_snapshot(&input)?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let account_id = if require_active {
            let active = ensure_active_account(&conn, &self.path)
                .map_err(|error| format!("读取激活账号失败: {error}"))?;
            ensure_expected_account(&active, Some(input.account_pool_id))
                .map_err(|error| format!("账号上下文已变化: {error}"))?;
            active.id
        } else {
            ensure_capture_account(&conn, input.account_pool_id)
                .map_err(|error| format!("浏览器目标账号不可用: {error}"))?;
            input.account_pool_id
        };
        let reference_account_id = if let Some(reference_account_id) = input.reference_account_id {
            let belongs_to_active: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM reference_accounts
                     WHERE id = ?1 AND account_pool_id = ?2)",
                    params![reference_account_id, account_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("校验榜样归属失败: {error}"))?;
            if !belongs_to_active {
                return Err("榜样不存在或不属于当前账号".to_string());
            }
            Some(reference_account_id)
        } else {
            None
        };
        let metrics_json = serde_json::to_string(&input.metrics)
            .map_err(|error| format!("序列化快照指标失败: {error}"))?;
        // 同一 request_id 幂等：重复投递不追加新行。
        if let Some(request_id) = input.request_id.as_deref() {
            if !request_id.is_empty() {
                let existing: Option<i64> = conn
                    .query_row(
                        "SELECT id FROM page_snapshots
                         WHERE account_pool_id = ?1 AND request_id = ?2",
                        params![account_id, request_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| format!("校验快照幂等失败: {error}"))?;
                if let Some(id) = existing {
                    let saved = self.page_snapshot_by_id(id)?;
                    if !require_active
                        && (saved.kind != input.kind
                            || saved.source_url != input.source_url.trim()
                            || saved.title != input.title.trim()
                            || saved.author != input.author.trim()
                            || saved.body_excerpt != input.body_excerpt.trim()
                            || saved.reference_account_id != reference_account_id
                            || strip_profile_notes_outcome(&saved.metrics_json)
                                != strip_profile_notes_outcome(&metrics_json)
                            || saved.observed_at != input.observed_at.trim())
                    {
                        return Err("requestId 已用于不同快照内容，拒绝覆盖".to_string());
                    }
                    return Ok(saved);
                }
            }
        }
        let note_id = if input.kind == "note_snapshot" {
            resolve_note_id_by_url(&conn, account_id, &input.source_url)
                .map_err(|error| format!("解析笔记链接失败: {error}"))?
        } else {
            None
        };
        let now = input.observed_at.trim().to_string();
        conn.execute(
            "INSERT INTO page_snapshots (
                account_pool_id, kind, source_url, title, author, body_excerpt,
                like_count, collect_count, comment_count, metrics_json,
                note_id, reference_account_id, request_id, observed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                account_id,
                input.kind,
                input.source_url.trim(),
                input.title.trim(),
                input.author.trim(),
                input.body_excerpt.trim(),
                input.metrics.like,
                input.metrics.collect,
                input.metrics.comment,
                metrics_json,
                note_id,
                reference_account_id,
                input.request_id.as_deref().unwrap_or("").trim(),
                now,
            ],
        )
        .map_err(|error| format!("写入页面快照失败: {error}"))?;
        // 自己笔记快照顺手更新 notes 上的即时指标，便于列表直接读。
        if let Some(note_id) = note_id {
            conn.execute(
                "UPDATE notes
                 SET likes = COALESCE(?2, likes),
                     collects = COALESCE(?3, collects),
                     comments = COALESCE(?4, comments),
                     updated_at = datetime('now', 'localtime')
                 WHERE id = ?1 AND account_pool_id = ?5 AND deleted_at IS NULL",
                params![
                    note_id,
                    input.metrics.like,
                    input.metrics.collect,
                    input.metrics.comment,
                    account_id
                ],
            )
            .map_err(|error| format!("更新笔记即时指标失败: {error}"))?;
        }
        if let Some(reference_account_id) = reference_account_id {
            conn.execute(
                "UPDATE reference_accounts
                 SET followers = COALESCE(?1, followers),
                     note_count = COALESCE(?2, note_count)
                 WHERE id = ?3 AND account_pool_id = ?4",
                params![
                    input.metrics.followers,
                    input.metrics.note_count,
                    reference_account_id,
                    account_id,
                ],
            )
            .map_err(|error| format!("更新榜样主页即时数据失败: {error}"))?;
        }
        let id: i64 = conn
            .query_row("SELECT last_insert_rowid()", [], |row| row.get(0))
            .map_err(|error| format!("读取快照 ID 失败: {error}"))?;
        drop(conn);
        self.page_snapshot_by_id(id)
    }

    pub fn page_snapshot_by_id(&self, id: i64) -> Result<PageSnapshotSummary, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        conn.query_row(
            "SELECT id, account_pool_id, kind, source_url, title, author, body_excerpt,
                    like_count, collect_count, comment_count, metrics_json,
                    note_id, reference_account_id, request_id, observed_at, created_at
             FROM page_snapshots WHERE id = ?1",
            params![id],
            page_snapshot_from_row,
        )
        .map_err(|error| format!("读取页面快照失败: {error}"))
    }

    /// 按来源 URL 读取快照历史（新到旧）。limit 上限 200，防止列表膨胀。
    pub fn list_page_snapshots(
        &self,
        account_pool_id: Option<i64>,
        source_url: &str,
        limit: Option<i64>,
    ) -> Result<Vec<PageSnapshotSummary>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        let expected = account_pool_id.unwrap_or(active.id);
        ensure_expected_account(&active, Some(expected)).map_err(|error| error.to_string())?;
        let take = limit.unwrap_or(50).clamp(1, 200);
        let mut statement = conn
            .prepare(
                "SELECT id, account_pool_id, kind, source_url, title, author, body_excerpt,
                        like_count, collect_count, comment_count, metrics_json,
                        note_id, reference_account_id, request_id, observed_at, created_at
                 FROM page_snapshots
                 WHERE account_pool_id = ?1 AND source_url = ?2
                 ORDER BY observed_at DESC, id DESC
                 LIMIT ?3",
            )
            .map_err(|error| format!("读取页面快照历史失败: {error}"))?;
        let rows = statement
            .query_map(
                params![active.id, source_url.trim(), take],
                page_snapshot_from_row,
            )
            .map_err(|error| format!("读取页面快照历史失败: {error}"))?
            .collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("解析页面快照历史失败: {error}"))?;
        Ok(rows)
    }
}
