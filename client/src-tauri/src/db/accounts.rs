use super::*;

impl LocalDb {
    /// Apply visible profile data from an explicitly captured page to the
    /// matching active account. A different creator's URL cannot overwrite
    /// the operator's own profile.
    pub fn update_profile_from_browser_snapshot(
        &self,
        snapshot: BrowserProfileSnapshot<'_>,
    ) -> Result<bool, String> {
        let BrowserProfileSnapshot {
            account_pool_id,
            profile_account_id,
            display_name,
            followers,
            total_notes,
            avatar_url,
            xhs_bio,
            xhs_follows,
            ip_location,
            xhs_tags,
        } = snapshot;
        let profile_account_id = profile_account_id.trim();
        if profile_account_id.is_empty() || profile_account_id.chars().count() > 128 {
            return Err("主页账号 ID 无效".to_string());
        }
        if followers.is_some_and(|value| value < 0)
            || total_notes.is_some_and(|value| value < 0)
            || xhs_follows.is_some_and(|value| value < 0)
        {
            return Err("主页统计不能小于 0".to_string());
        }
        if avatar_url.is_some_and(|value| value.chars().count() > 2_000)
            || xhs_bio.is_some_and(|value| value.chars().count() > 2_000)
            || ip_location.is_some_and(|value| value.chars().count() > 100)
            || xhs_tags.is_some_and(|values| {
                values.len() > 30
                    || values
                        .iter()
                        .any(|value| value.is_empty() || value.chars().count() > 80)
            })
        {
            return Err("主页资料字段超出长度限制".to_string());
        }
        if avatar_url.is_some_and(|value| !value.starts_with("https://")) {
            return Err("主页头像必须使用 HTTPS 链接".to_string());
        }
        let display_name = display_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(200).collect::<String>());
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;

        let matched = conn
            .query_row(
                "SELECT p.id, p.account_id, p.display_name
                 FROM my_profile p
                 WHERE p.account_pool_id = ?1
                   AND (p.account_id = ?2 OR EXISTS (
                     SELECT 1 FROM account_pool a
                     WHERE a.id = p.account_pool_id AND a.xhs_user_id = ?2
                   ))
                 ORDER BY p.id LIMIT 1",
                params![account_pool_id, profile_account_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("核对主页账号失败: {error}"))?;
        let Some((profile_id, stored_account_id, current_display_name)) = matched else {
            return Ok(false);
        };
        let usable_name = display_name.filter(|_| {
            current_display_name.as_deref().is_none_or(|current| {
                current.trim().is_empty() || Some(current.trim()) == stored_account_id.as_deref()
            })
        });
        let xhs_tags = xhs_tags
            .filter(|values| !values.is_empty())
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| format!("序列化主页标签失败: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开启主页同步事务失败: {error}"))?;
        tx.execute(
            "UPDATE my_profile SET
               display_name = COALESCE(?1, display_name),
               followers = COALESCE(?2, followers),
               total_notes = COALESCE(?3, total_notes),
               avatar_url = COALESCE(?4, avatar_url),
               xhs_bio = COALESCE(?5, xhs_bio),
               xhs_follows = COALESCE(?6, xhs_follows),
               ip_location = COALESCE(?7, ip_location),
               xhs_tags = COALESCE(?8, xhs_tags),
               crawled_at = datetime('now', 'localtime'),
               updated_at = datetime('now', 'localtime')
             WHERE id = ?9 AND account_pool_id = ?10",
            params![
                usable_name,
                followers,
                total_notes,
                avatar_url,
                xhs_bio,
                xhs_follows,
                ip_location,
                xhs_tags,
                profile_id,
                account_pool_id
            ],
        )
        .map_err(|error| format!("更新主页统计失败: {error}"))?;
        if let Some(followers) = followers {
            tx.execute(
                "UPDATE account_pool SET followers = ?1 WHERE id = ?2",
                params![followers, account_pool_id],
            )
            .map_err(|error| format!("更新账号粉丝数失败: {error}"))?;
        }
        tx.commit()
            .map_err(|error| format!("提交主页同步事务失败: {error}"))?;
        Ok(true)
    }

    /// Import the bounded, user-confirmed recent profile cards without replacing
    /// titles or bodies that the operator may already have edited locally.
    pub fn sync_profile_notes_from_browser_snapshot(
        &self,
        account_pool_id: i64,
        profile_account_id: &str,
        reference_account_id: Option<i64>,
        complete: bool,
        notes: &[BrowserProfileNote],
    ) -> Result<BrowserProfileNoteSync, String> {
        if account_pool_id <= 0
            || profile_account_id.trim().is_empty()
            || profile_account_id.chars().count() > 128
            || notes.len() > 30
        {
            return Err("主页笔记同步参数无效".to_string());
        }
        for note in notes {
            if !safe_profile_note_url(&note.note_url)
                || note.title.trim().is_empty()
                || note.title.chars().count() > 200
                || note.body.chars().count() > 1_200
                || note.tags.len() > 20
                || note
                    .tags
                    .iter()
                    .any(|tag| tag.is_empty() || tag.chars().count() > 80)
                || note
                    .published_at
                    .as_ref()
                    .is_some_and(|value| value.chars().count() > 80)
                || [note.likes, note.comments, note.collects]
                    .into_iter()
                    .flatten()
                    .any(|value| !(0..=1_000_000_000_000).contains(&value))
            {
                return Err("主页笔记字段无效或超出上限".to_string());
            }
        }

        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("主页笔记目标账号不可用: {error}"))?;
        let profile_row = conn
            .query_row(
                "SELECT p.id FROM my_profile p
                 WHERE p.account_pool_id = ?1
                   AND (p.account_id = ?2 OR EXISTS (
                     SELECT 1 FROM account_pool a
                     WHERE a.id = p.account_pool_id AND a.xhs_user_id = ?2
                   ))
                 ORDER BY p.id LIMIT 1",
                params![account_pool_id, profile_account_id.trim()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("核对本人主页账号失败: {error}"))?;
        let reference_row = if let Some(reference_account_id) = reference_account_id {
            if reference_account_id <= 0 {
                return Err("榜样账号 ID 无效".to_string());
            }
            conn.query_row(
                "SELECT id FROM reference_accounts
                 WHERE id = ?1 AND account_pool_id = ?2 AND account_id = ?3",
                params![
                    reference_account_id,
                    account_pool_id,
                    profile_account_id.trim()
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("核对榜样主页账号失败: {error}"))?
        } else {
            None
        };
        let mut outcome = BrowserProfileNoteSync {
            matched_profile: profile_row.is_some(),
            matched_reference: reference_row.is_some(),
            ..BrowserProfileNoteSync::default()
        };
        if profile_row.is_none() && reference_row.is_none() {
            return Ok(outcome);
        }
        if notes.is_empty() {
            return Ok(outcome);
        }

        let mut unique_notes = Vec::with_capacity(notes.len());
        for note in notes {
            if unique_notes
                .iter()
                .any(|saved: &&BrowserProfileNote| saved.note_url == note.note_url)
            {
                continue;
            }
            unique_notes.push(note);
        }
        let conn_tx = conn
            .transaction()
            .map_err(|error| format!("开启主页笔记同步事务失败: {error}"))?;
        let mut total_likes = 0_i64;
        let mut total_collects = 0_i64;
        let mut likes = Vec::new();
        let mut comments = Vec::new();
        let mut collects = Vec::new();
        for note in &unique_notes {
            if let Some(value) = note.likes {
                total_likes = total_likes
                    .checked_add(value)
                    .ok_or_else(|| "主页笔记获赞统计超出范围".to_string())?;
                likes.push(value as f64);
            }
            if let Some(value) = note.comments {
                comments.push(value as f64);
            }
            if let Some(value) = note.collects {
                total_collects = total_collects
                    .checked_add(value)
                    .ok_or_else(|| "主页笔记收藏统计超出范围".to_string())?;
                collects.push(value as f64);
            }
            // Reference cards feed the reference profile's raw_data/top_notes only;
            // inserting them into the operator's own published notes would corrupt
            // the notes list and analytics.
            if profile_row.is_none() {
                continue;
            }
            let existing = conn_tx
                .query_row(
                    "SELECT id FROM notes WHERE account_pool_id = ?1 AND note_url = ?2
                     ORDER BY id LIMIT 1",
                    params![account_pool_id, note.note_url],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|error| format!("查找已有主页笔记失败: {error}"))?;
            let tags = serde_json::to_string(&note.tags)
                .map_err(|error| format!("序列化主页笔记标签失败: {error}"))?;
            if let Some(note_id) = existing {
                conn_tx
                    .execute(
                        "UPDATE notes SET likes = COALESCE(?1, likes),
                           comments = COALESCE(?2, comments), collects = COALESCE(?3, collects),
                           published_at = COALESCE(published_at, ?4),
                           updated_at = datetime('now','localtime')
                         WHERE id = ?5 AND account_pool_id = ?6",
                        params![
                            note.likes,
                            note.comments,
                            note.collects,
                            note.published_at,
                            note_id,
                            account_pool_id
                        ],
                    )
                    .map_err(|error| format!("更新主页笔记互动数据失败: {error}"))?;
                outcome.updated += 1;
            } else {
                conn_tx
                    .execute(
                        "INSERT INTO notes
                           (title, body, tags, status, note_url, likes, comments, collects,
                            published_at, account_pool_id, created_at, updated_at)
                         VALUES (?1, ?2, ?3, 'published', ?4, ?5, ?6, ?7, ?8, ?9,
                            datetime('now','localtime'), datetime('now','localtime'))",
                        params![
                            note.title.trim(),
                            note.body,
                            tags,
                            note.note_url,
                            note.likes,
                            note.comments,
                            note.collects,
                            note.published_at,
                            account_pool_id
                        ],
                    )
                    .map_err(|error| format!("导入主页笔记失败: {error}"))?;
                outcome.imported += 1;
            }
        }
        let has_likes = complete
            && !unique_notes.is_empty()
            && unique_notes.iter().all(|note| note.likes.is_some());
        let has_collects = complete
            && !unique_notes.is_empty()
            && unique_notes.iter().all(|note| note.collects.is_some());
        let has_comments = complete
            && !unique_notes.is_empty()
            && unique_notes.iter().all(|note| note.comments.is_some());
        let has_likes_sample = !likes.is_empty();
        let has_comments_sample = !comments.is_empty();
        let has_collects_sample = !collects.is_empty();
        let average_likes = average_known(&likes);
        let average_comments = average_known(&comments);
        let average_collects = average_known(&collects);
        if let Some(profile_id) = profile_row {
            conn_tx
                .execute(
                    "UPDATE my_profile SET
                       total_likes = CASE WHEN ?1 AND ?2 THEN ?3 ELSE total_likes END,
                       total_collects = CASE WHEN ?1 AND ?4 THEN ?5 ELSE total_collects END,
                       avg_likes = CASE WHEN ?11 THEN COALESCE(?6, avg_likes) ELSE avg_likes END,
                       avg_comments = CASE WHEN ?12 THEN COALESCE(?7, avg_comments) ELSE avg_comments END,
                       avg_collects = CASE WHEN ?13 THEN COALESCE(?8, avg_collects) ELSE avg_collects END,
                       updated_at = datetime('now','localtime')
                     WHERE id = ?9 AND account_pool_id = ?10",
                    params![complete, has_likes, total_likes, has_collects, total_collects,
                        average_likes, average_comments, average_collects,
                        profile_id, account_pool_id, has_likes, has_comments, has_collects],
                )
                .map_err(|error| format!("更新本人主页互动汇总失败: {error}"))?;
        }
        if let Some(reference_id) = reference_row {
            let known_samples = serde_json::json!({
                "likes": likes.len(),
                "comments": comments.len(),
                "collects": collects.len(),
            });
            let raw_data = serde_json::to_string(&serde_json::json!({
                "schemaVersion": 2,
                "source": "browser-profile-capture",
                "sampledAt": chrono::Local::now().to_rfc3339(),
                "scope": {
                    "state": if complete { "complete" } else { "partial" },
                    "loadedNotes": unique_notes.len(),
                    "capturedNotes": notes.len(),
                    "maximumNotes": 30,
                },
                "metricSamples": known_samples,
                "notes": unique_notes,
            }))
            .map_err(|error| format!("序列化榜样主页笔记失败: {error}"))?;
            let top_notes = reference_top_notes(&unique_notes)?;
            conn_tx
                .execute(
                    "UPDATE reference_accounts SET
                       total_likes = CASE WHEN ?1 AND ?2 THEN ?3 ELSE total_likes END,
                       avg_likes = CASE WHEN ?12 THEN COALESCE(?4, avg_likes) ELSE avg_likes END,
                       avg_comments = CASE WHEN ?13 THEN COALESCE(?5, avg_comments) ELSE avg_comments END,
                       avg_collects = CASE WHEN ?14 THEN COALESCE(?6, avg_collects) ELSE avg_collects END,
                       top_notes = ?7,
                       raw_data = ?8,
                       crawled_at = datetime('now','localtime')
                     WHERE id = ?9 AND account_pool_id = ?10 AND account_id = ?11",
                    params![complete, has_likes, total_likes, average_likes, average_comments,
                        average_collects, top_notes, raw_data, reference_id,
                        account_pool_id, profile_account_id.trim(), has_likes_sample,
                        has_comments_sample, has_collects_sample],
                )
                .map_err(|error| format!("更新榜样笔记统计失败: {error}"))?;
        }
        conn_tx
            .commit()
            .map_err(|error| format!("提交主页笔记同步失败: {error}"))?;
        Ok(outcome)
    }

    /// Refresh the visible counters of a tracked reference account from its
    /// explicitly captured profile page, scoped to the owning operator.
    pub fn update_reference_account_from_browser_snapshot(
        &self,
        account_pool_id: i64,
        reference_account_id: i64,
        profile_account_id: &str,
        display_name: Option<&str>,
        followers: Option<i64>,
        note_count: Option<i64>,
    ) -> Result<bool, String> {
        let profile_account_id = profile_account_id.trim();
        if reference_account_id <= 0
            || profile_account_id.is_empty()
            || profile_account_id.chars().count() > 128
        {
            return Err("榜样主页账号信息无效".to_string());
        }
        if followers.is_some_and(|value| value < 0) || note_count.is_some_and(|value| value < 0) {
            return Err("榜样主页统计不能小于 0".to_string());
        }
        let display_name = display_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(200).collect::<String>());
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("浏览器目标账号不可用: {error}"))?;
        let current_name = conn
            .query_row(
                "SELECT name FROM reference_accounts
                 WHERE id = ?1 AND account_pool_id = ?2 AND account_id = ?3",
                params![reference_account_id, account_pool_id, profile_account_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| format!("核对榜样主页账号失败: {error}"))?;
        let Some(current_name) = current_name else {
            return Ok(false);
        };
        let usable_name = display_name.filter(|_| {
            current_name.as_deref().is_none_or(|current| {
                current.trim().is_empty() || current.trim() == profile_account_id
            })
        });
        conn.execute(
            "UPDATE reference_accounts SET
               name = COALESCE(?1, name),
               followers = COALESCE(?2, followers),
               note_count = COALESCE(?3, note_count),
               crawled_at = datetime('now', 'localtime')
             WHERE id = ?4 AND account_pool_id = ?5 AND account_id = ?6",
            params![
                usable_name,
                followers,
                note_count,
                reference_account_id,
                account_pool_id,
                profile_account_id
            ],
        )
        .map_err(|error| format!("更新榜样主页统计失败: {error}"))?;
        Ok(true)
    }

    pub fn local_reference_account_id_for_capture(
        &self,
        account_pool_id: i64,
        profile_account_id: &str,
    ) -> Result<Option<i64>, String> {
        let profile_account_id = profile_account_id.trim();
        if account_pool_id <= 0
            || profile_account_id.is_empty()
            || profile_account_id.chars().count() > 128
        {
            return Err("榜样主页账号信息无效".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        conn.query_row(
            "SELECT id FROM reference_accounts
             WHERE account_pool_id = ?1 AND account_id = ?2
             ORDER BY id LIMIT 1",
            params![account_pool_id, profile_account_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("查找当前账号下的榜样主页失败: {error}"))
    }

    /// Update the account statistics that the legacy profile CLI exposes.
    pub fn update_local_profile_stats(
        &self,
        account_pool_id: i64,
        followers: Option<i64>,
        total_notes: Option<i64>,
        avg_likes: Option<f64>,
        avg_comments: Option<f64>,
        avg_collects: Option<f64>,
    ) -> Result<(), String> {
        if followers.is_none()
            && total_notes.is_none()
            && avg_likes.is_none()
            && avg_comments.is_none()
            && avg_collects.is_none()
        {
            return Err("没有可更新的账号统计字段".to_string());
        }
        if followers.is_some_and(|value| value < 0)
            || total_notes.is_some_and(|value| value < 0)
            || avg_likes.is_some_and(|value| !value.is_finite() || value < 0.0)
            || avg_comments.is_some_and(|value| !value.is_finite() || value < 0.0)
            || avg_collects.is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            return Err("账号统计值不能小于 0 且必须是有限数字".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let existing_profile: Option<i64> = conn
            .query_row(
                "SELECT id FROM my_profile WHERE account_pool_id = ?1 ORDER BY id LIMIT 1",
                params![account_pool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取账号人设失败: {error}"))?;
        let Some(profile_id) = existing_profile else {
            return Err("当前账号尚未初始化人设".to_string());
        };
        let changed = conn
            .execute(
                "UPDATE my_profile SET
                followers = COALESCE(?1, followers), total_notes = COALESCE(?2, total_notes),
                avg_likes = COALESCE(?3, avg_likes), avg_comments = COALESCE(?4, avg_comments),
                avg_collects = COALESCE(?5, avg_collects), updated_at = datetime('now','localtime')
             WHERE id = ?6 AND account_pool_id = ?7",
                params![
                    followers,
                    total_notes,
                    avg_likes,
                    avg_comments,
                    avg_collects,
                    profile_id,
                    account_pool_id
                ],
            )
            .map_err(|error| format!("更新账号统计失败: {error}"))?;
        if changed != 1 {
            return Err("账号人设已变化，统计未保存".to_string());
        }
        Ok(())
    }

    /// Upsert all manually entered reference-account metrics supported by the
    /// legacy CLI without overwriting browser-captured data in another pool.
    pub fn upsert_local_reference_account_manual(
        &self,
        input: LocalReferenceAccountManualUpsert,
    ) -> Result<(), String> {
        validate_local_reference_account(&input.account_id, Some(&input.name), input.followers)?;
        if input.note_count < 0
            || !input.avg_likes.is_finite()
            || !input.avg_comments.is_finite()
            || !input.avg_collects.is_finite()
            || input.avg_likes < 0.0
            || input.avg_comments < 0.0
            || input.avg_collects < 0.0
        {
            return Err("榜样账号统计值不能小于 0".to_string());
        }
        if input
            .content_style
            .as_deref()
            .is_some_and(|value| value.chars().count() > 20_000)
        {
            return Err("风格描述不能超过 20000 个字符".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let top_notes = serde_json::to_string(&input.top_notes)
            .map_err(|error| format!("编码榜样热门笔记失败: {error}"))?;
        let content_style = input
            .content_style
            .map(|description| serde_json::json!({"description": description}).to_string());
        let total_likes = (input.avg_likes * input.note_count as f64) as i64;
        let raw_data = serde_json::json!({"source":"manual"}).to_string();
        let existing_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM reference_accounts
                 WHERE account_pool_id = ?1 AND account_id = ?2
                 ORDER BY id LIMIT 1",
                params![input.account_pool_id, input.account_id.trim()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取榜样账号失败: {error}"))?;
        if let Some(id) = existing_id {
            conn.execute(
                "UPDATE reference_accounts SET name = ?1, followers = ?2, total_likes = ?3,
                    note_count = ?4, avg_likes = ?5, avg_comments = ?6, avg_collects = ?7,
                    content_style = ?8, top_notes = ?9, raw_data = ?10,
                    crawled_at = datetime('now','localtime')
                 WHERE id = ?11 AND account_pool_id = ?12",
                params![
                    input.name.trim(),
                    input.followers,
                    total_likes,
                    input.note_count,
                    input.avg_likes,
                    input.avg_comments,
                    input.avg_collects,
                    content_style,
                    top_notes,
                    raw_data,
                    id,
                    input.account_pool_id
                ],
            )
            .map_err(|error| format!("更新榜样账号失败: {error}"))?;
        } else {
            conn.execute(
                "INSERT INTO reference_accounts
                    (account_pool_id, account_id, name, followers, total_likes, note_count,
                     avg_likes, avg_comments, avg_collects, content_style, top_notes, raw_data, crawled_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, datetime('now','localtime'))",
                params![input.account_pool_id, input.account_id.trim(), input.name.trim(),
                    input.followers, total_likes, input.note_count, input.avg_likes,
                    input.avg_comments, input.avg_collects, content_style, top_notes, raw_data],
            )
            .map_err(|error| format!("保存榜样账号失败: {error}"))?;
        }
        Ok(())
    }

    /// Delete a reference account identified by its platform id under the
    /// active account only.
    pub fn delete_local_reference_account_by_platform_id(
        &self,
        platform_account_id: &str,
        account_pool_id: i64,
    ) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let changed = conn
            .execute(
                "DELETE FROM reference_accounts WHERE account_id = ?1 AND account_pool_id = ?2",
                params![platform_account_id.trim(), account_pool_id],
            )
            .map_err(|error| format!("删除榜样账号失败: {error}"))?;
        if changed != 1 {
            return Err("榜样账号不存在或不属于当前账号".to_string());
        }
        Ok(())
    }

    /// 读取当前激活运营账号，供浏览器剪藏回传等宿主侧链路盖章使用。
    /// 语义与其他读取一致：无激活账号时确保默认账号存在。
    pub fn current_active_account(&self) -> Result<ActiveAccount, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))
    }

    pub fn account_pool(&self) -> SqlResult<AccountPoolSnapshot> {
        let conn = self.connect()?;
        let active = ensure_active_account(&conn, &self.path)?;
        let mut stmt = conn.prepare(
            "SELECT id, alias, role, user_data_dir, xhs_user_id, display_name,
                    followers, status, ban_count, notes, created_at, last_used_at
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
                    user_data_dir: row.get(3)?,
                    xhs_user_id: row.get(4)?,
                    display_name: row.get(5)?,
                    followers: row.get(6)?,
                    is_active: id == active.id,
                    status: row.get(7)?,
                    ban_count: row.get(8)?,
                    notes: row.get(9)?,
                    created_at: row.get(10)?,
                    last_used_at: row.get(11)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(AccountPoolSnapshot { items })
    }

    /// 创建本地账号池记录。只创建空的受管目录，不复制或读取浏览器登录态。
    pub fn create_local_account(&self, input: LocalAccountCreate) -> Result<i64, String> {
        let alias = input.alias.trim();
        if alias.is_empty() || alias.chars().count() > 80 {
            return Err("账号别名不能为空且不能超过 80 个字符".to_string());
        }
        if !matches!(input.role.as_str(), "operation" | "assistant") {
            return Err("账号角色只能是 operation 或 assistant".to_string());
        }
        if input
            .notes
            .as_deref()
            .is_some_and(|value| value.chars().count() > 2_000)
        {
            return Err("账号备注不能超过 2000 个字符".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let browser_root = self
            .path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("browser_profiles");
        fs::create_dir_all(&browser_root).map_err(|error| format!("创建账号目录失败: {error}"))?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("读取系统时间失败: {error}"))?
            .as_nanos();
        let user_data_dir = browser_root.join(format!("local-{nonce}"));
        fs::create_dir_all(&user_data_dir).map_err(|error| format!("创建账号目录失败: {error}"))?;
        let result = (|| {
            let mut conn = conn;
            let tx = conn
                .transaction()
                .map_err(|error| format!("开始创建本地账号事务失败: {error}"))?;
            tx.execute(
                "INSERT INTO account_pool (alias, role, user_data_dir, status, notes)
                 VALUES (?1, ?2, ?3, 'active', ?4)",
                params![
                    alias,
                    input.role,
                    user_data_dir.display().to_string(),
                    input.notes
                ],
            )
            .map_err(|error| format!("创建本地账号失败: {error}"))?;
            let account_id = tx.last_insert_rowid();
            if input.role == "operation" {
                tx.execute(
                    "INSERT INTO my_profile (account_pool_id, display_name, created_at)
                     VALUES (?1, ?2, datetime('now', 'localtime'))",
                    params![account_id, alias],
                )
                .map_err(|error| format!("初始化账号人设失败: {error}"))?;
            }
            tx.commit()
                .map_err(|error| format!("保存本地账号失败: {error}"))?;
            Ok(account_id)
        })();
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&user_data_dir);
            return Err(error);
        }
        result
    }

    /// 修改账号池展示字段和角色/状态；不允许让当前激活账号失去可激活资格。
    pub fn update_local_account(&self, input: LocalAccountUpdate) -> Result<(), String> {
        let alias = input.alias.trim();
        if alias.is_empty() || alias.chars().count() > 80 {
            return Err("账号别名不能为空且不能超过 80 个字符".to_string());
        }
        if !matches!(input.role.as_str(), "operation" | "assistant") {
            return Err("账号角色只能是 operation 或 assistant".to_string());
        }
        if !matches!(
            input.status.as_str(),
            "active" | "banned" | "suspended" | "retired"
        ) {
            return Err("账号状态不合法".to_string());
        }
        if input
            .display_name
            .as_deref()
            .is_some_and(|value| value.chars().count() > 120)
        {
            return Err("账号显示名不能超过 120 个字符".to_string());
        }
        if input
            .xhs_user_id
            .as_deref()
            .is_some_and(|value| value.chars().count() > 200)
        {
            return Err("小红书账号 ID 不能超过 200 个字符".to_string());
        }
        if input.followers.is_some_and(|value| value < 0) {
            return Err("粉丝数不能小于 0".to_string());
        }
        if input
            .notes
            .as_deref()
            .is_some_and(|value| value.chars().count() > 2_000)
        {
            return Err("账号备注不能超过 2000 个字符".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active_id =
            active_account_id(&conn).map_err(|error| format!("读取激活账号失败: {error}"))?;
        let current: Option<(String, String)> = conn
            .query_row(
                "SELECT role, status FROM account_pool WHERE id = ?1",
                params![input.account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("读取账号失败: {error}"))?;
        if current.is_none() {
            return Err("账号不存在".to_string());
        }
        if active_id == Some(input.account_id)
            && (input.role != "operation" || input.status != "active")
        {
            return Err("不能让当前激活账号变为辅助、停用或退休，请先切换其他运营账号".to_string());
        }
        conn.execute(
            "UPDATE account_pool
             SET alias = ?1, role = ?2, display_name = ?3, status = ?4,
                 xhs_user_id = COALESCE(?5, xhs_user_id),
                 followers = COALESCE(?6, followers),
                 notes = COALESCE(?7, notes)
             WHERE id = ?8",
            params![
                alias,
                input.role,
                input.display_name,
                input.status,
                input.xhs_user_id,
                input.followers,
                input.notes,
                input.account_id,
            ],
        )
        .map_err(|error| format!("保存本地账号失败: {error}"))?;
        Ok(())
    }

    /// 将非激活账号标记为退休，保留其业务数据和受管目录。
    pub fn retire_local_account(&self, account_id: i64) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        if active_account_id(&conn).map_err(|error| format!("读取激活账号失败: {error}"))?
            == Some(account_id)
        {
            return Err("不能退休当前激活账号，请先切换其他运营账号".to_string());
        }
        let changed = conn
            .execute(
                "UPDATE account_pool SET status = 'retired' WHERE id = ?1 AND status <> 'retired'",
                params![account_id],
            )
            .map_err(|error| format!("退休本地账号失败: {error}"))?;
        if changed != 1 {
            return Err("账号不存在或已经退休".to_string());
        }
        Ok(())
    }

    /// Mark a non-active account as banned and increment its history counter.
    pub fn mark_local_account_banned(&self, account_id: i64) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        if active_account_id(&conn).map_err(|error| format!("读取激活账号失败: {error}"))?
            == Some(account_id)
        {
            return Err("不能封禁当前激活账号，请先切换其他运营账号".to_string());
        }
        let changed = conn
            .execute(
                "UPDATE account_pool SET status = 'banned', ban_count = ban_count + 1
                 WHERE id = ?1 AND status <> 'retired'",
                params![account_id],
            )
            .map_err(|error| format!("标记账号封禁失败: {error}"))?;
        if changed != 1 {
            return Err("账号不存在或已经退休".to_string());
        }
        Ok(())
    }

    /// 保存当前运营账号的人设/内容策略字段，不触碰平台统计字段或浏览器登录态。
    pub fn update_local_profile(&self, input: LocalProfileUpdate) -> Result<(), String> {
        validate_profile_list(&input.content_pillars)?;
        validate_profile_list(&input.persona_taboos)?;
        validate_profile_list(&input.preferred_styles)?;
        validate_profile_list(&input.preferred_scenes)?;
        validate_profile_list(&input.hashtag_pool)?;
        if let Some(values) = &input.xhs_tags {
            validate_profile_list(values)?;
        }
        if input.followers.is_some_and(|value| value < 0) {
            return Err("粉丝数不能小于 0".to_string());
        }
        if input.xhs_follows.is_some_and(|value| value < 0) {
            return Err("关注数不能小于 0".to_string());
        }
        if input
            .risk_warning_ack
            .is_some_and(|value| !matches!(value, 0 | 1))
        {
            return Err("风险确认字段只能是 0 或 1".to_string());
        }
        for value in [
            input.account_id.as_deref(),
            input.display_name.as_deref(),
            input.niche.as_deref(),
            input.target_audience.as_deref(),
            input.persona_name.as_deref(),
            input.persona_bio.as_deref(),
            input.persona_tone.as_deref(),
            input.posting_rhythm.as_deref(),
            input.avatar_url.as_deref(),
            input.xhs_bio.as_deref(),
            input.ip_location.as_deref(),
        ] {
            if value.is_some_and(|text| text.chars().count() > 2000) {
                return Err("人设字段不能超过 2000 个字符".to_string());
            }
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let content_pillars = serde_json::to_string(&input.content_pillars)
            .map_err(|error| format!("编码内容支柱失败: {error}"))?;
        let persona_taboos = serde_json::to_string(&input.persona_taboos)
            .map_err(|error| format!("编码禁忌词失败: {error}"))?;
        let preferred_styles = serde_json::to_string(&input.preferred_styles)
            .map_err(|error| format!("编码偏好风格失败: {error}"))?;
        let preferred_scenes = serde_json::to_string(&input.preferred_scenes)
            .map_err(|error| format!("编码偏好场景失败: {error}"))?;
        let hashtag_pool = serde_json::to_string(&input.hashtag_pool)
            .map_err(|error| format!("编码标签池失败: {error}"))?;
        let xhs_tags = input
            .xhs_tags
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| format!("编码平台标签失败: {error}"))?;
        // 旧版本数据库的 account_pool_id 没有 UNIQUE 约束，不能依赖
        // `ON CONFLICT(account_pool_id)`；先按迁移后的 id 查找，再更新/插入，
        // 这样已有用户数据库也能走同一条保存路径。
        let existing_profile_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM my_profile WHERE account_pool_id = ?1 ORDER BY id LIMIT 1",
                params![input.account_pool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取本地人设失败: {error}"))?;
        if let Some(profile_id) = existing_profile_id {
            conn.execute(
                "UPDATE my_profile SET
                   account_id = ?1,
                   display_name = ?2,
                   niche = ?3,
                   target_audience = ?4,
                   content_pillars = ?5,
                   followers = COALESCE(?6, followers),
                   persona_name = ?7,
                   persona_bio = ?8,
                   persona_tone = ?9,
                   persona_taboos = ?10,
                   preferred_styles = ?11,
                   preferred_scenes = ?12,
                   hashtag_pool = ?13,
                   posting_rhythm = ?14,
                   avatar_url = COALESCE(?15, avatar_url),
                   xhs_bio = COALESCE(?16, xhs_bio),
                   xhs_follows = COALESCE(?17, xhs_follows),
                   ip_location = COALESCE(?18, ip_location),
                   xhs_tags = COALESCE(?19, xhs_tags),
                   risk_warning_ack = COALESCE(?20, risk_warning_ack),
                   risk_warning_ack_at = CASE WHEN ?20 = 1
                     THEN datetime('now', 'localtime') ELSE risk_warning_ack_at END,
                   updated_at = datetime('now', 'localtime')
                 WHERE id = ?21",
                params![
                    input.account_id,
                    input.display_name,
                    input.niche,
                    input.target_audience,
                    content_pillars,
                    input.followers,
                    input.persona_name,
                    input.persona_bio,
                    input.persona_tone,
                    persona_taboos,
                    preferred_styles,
                    preferred_scenes,
                    hashtag_pool,
                    input.posting_rhythm,
                    input.avatar_url,
                    input.xhs_bio,
                    input.xhs_follows,
                    input.ip_location,
                    xhs_tags,
                    input.risk_warning_ack,
                    profile_id,
                ],
            )
        } else {
            conn.execute(
                "INSERT INTO my_profile (
                   account_pool_id, account_id, display_name, niche, target_audience,
                   content_pillars, followers, persona_name, persona_bio, persona_tone, persona_taboos,
                   preferred_styles, preferred_scenes, hashtag_pool, posting_rhythm,
                   avatar_url, xhs_bio, xhs_follows, ip_location, xhs_tags,
                   risk_warning_ack, risk_warning_ack_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, 0), ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                    ?16, ?17, COALESCE(?18, 0), ?19, COALESCE(?20, '[]'), COALESCE(?21, 0),
                    CASE WHEN ?21 = 1 THEN datetime('now', 'localtime') ELSE NULL END,
                    datetime('now', 'localtime'),
                    datetime('now', 'localtime'))",
                params![
                    input.account_pool_id,
                    input.account_id,
                    input.display_name,
                    input.niche,
                    input.target_audience,
                    content_pillars,
                    input.followers,
                    input.persona_name,
                    input.persona_bio,
                    input.persona_tone,
                    persona_taboos,
                    preferred_styles,
                    preferred_scenes,
                    hashtag_pool,
                    input.posting_rhythm,
                    input.avatar_url,
                    input.xhs_bio,
                    input.xhs_follows,
                    input.ip_location,
                    xhs_tags,
                    input.risk_warning_ack,
                ],
            )
        }
        .map_err(|error| format!("保存本地人设失败: {error}"))?;
        Ok(())
    }

    /// 在当前运营账号下保存一个手工榜样账号。平台主页抓取仍由旧服务负责，
    /// 这里只保存用户明确提供的账号标识和可编辑元数据。
    pub fn create_local_reference_account(
        &self,
        input: LocalReferenceAccountCreate,
    ) -> Result<(), String> {
        validate_local_reference_account(
            &input.account_id,
            input.name.as_deref(),
            input.followers,
        )?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let existing_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM reference_accounts
                 WHERE account_pool_id = ?1 AND account_id = ?2
                 ORDER BY id LIMIT 1",
                params![input.account_pool_id, input.account_id.trim()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取榜样账号失败: {error}"))?;
        let name = input
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(id) = existing_id {
            conn.execute(
                "UPDATE reference_accounts
                 SET name = COALESCE(?1, name),
                     followers = CASE WHEN ?2 > 0 THEN ?2 ELSE followers END
                 WHERE id = ?3 AND account_pool_id = ?4",
                params![name, input.followers, id, input.account_pool_id],
            )
            .map_err(|error| format!("更新榜样账号失败: {error}"))?;
        } else {
            conn.execute(
                "INSERT INTO reference_accounts (account_pool_id, account_id, name, followers)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    input.account_pool_id,
                    input.account_id.trim(),
                    name,
                    input.followers,
                ],
            )
            .map_err(|error| format!("保存榜样账号失败: {error}"))?;
        }
        Ok(())
    }

    /// 更新当前账号下榜样账号的手工元数据；None 的 content_style 表示保留原值。
    pub fn update_local_reference_account(
        &self,
        input: LocalReferenceAccountUpdate,
    ) -> Result<(), String> {
        validate_local_reference_account(
            &input.account_id,
            input.name.as_deref(),
            input.followers,
        )?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        if input
            .content_style
            .as_deref()
            .is_some_and(|value| value.chars().count() > 20_000)
        {
            return Err("风格描述不能超过 20000 个字符".to_string());
        }
        if input.note_count.is_some_and(|value| value < 0)
            || [input.avg_likes, input.avg_comments, input.avg_collects]
                .into_iter()
                .flatten()
                .any(|value| !value.is_finite() || value < 0.0)
        {
            return Err("榜样账号统计值不能小于 0 且必须是有限数字".to_string());
        }
        let changed = conn
            .execute(
                "UPDATE reference_accounts
                 SET name = ?1, followers = ?2,
                     content_style = COALESCE(?3, content_style),
                     note_count = COALESCE(?4, note_count),
                     avg_likes = COALESCE(?5, avg_likes),
                     avg_comments = COALESCE(?6, avg_comments),
                     avg_collects = COALESCE(?7, avg_collects)
                 WHERE id = ?8 AND account_pool_id = ?9",
                params![
                    input.name.as_deref().map(str::trim),
                    input.followers,
                    input.content_style,
                    input.note_count,
                    input.avg_likes,
                    input.avg_comments,
                    input.avg_collects,
                    input.id,
                    input.account_pool_id,
                ],
            )
            .map_err(|error| format!("保存榜样账号失败: {error}"))?;
        if changed != 1 {
            return Err("榜样账号不存在或不属于当前账号".to_string());
        }
        Ok(())
    }

    /// Upsert a reference-account record with the field semantics of the legacy Web API.
    pub fn upsert_local_reference_account_api(
        &self,
        input: LocalReferenceAccountApiUpsert,
    ) -> Result<(), String> {
        validate_local_reference_account(
            &input.account_id,
            input.name.as_deref(),
            input.followers,
        )?;
        if input.note_count < 0
            || [input.avg_likes, input.avg_comments, input.avg_collects]
                .into_iter()
                .any(|value| !value.is_finite() || value < 0.0)
        {
            return Err("榜样账号统计值不能小于 0 且必须是有限数字".to_string());
        }
        if input
            .content_style
            .as_deref()
            .is_some_and(|value| value.chars().count() > 20_000)
        {
            return Err("风格描述不能超过 20000 个字符".to_string());
        }
        if input.top_notes.len() > 200
            || input
                .top_notes
                .iter()
                .any(|note| note.title.chars().count() > 1000 || note.likes < 0)
        {
            return Err("热门笔记数据无效".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let top_notes = serde_json::to_string(&input.top_notes)
            .map_err(|error| format!("编码榜样热门笔记失败: {error}"))?;
        let account_id = input.account_id.trim();
        let name = input.name.as_deref().map(str::trim);
        let existing_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM reference_accounts
                 WHERE account_pool_id = ?1 AND account_id = ?2 ORDER BY id LIMIT 1",
                params![input.account_pool_id, account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取榜样账号失败: {error}"))?;
        if let Some(id) = existing_id {
            conn.execute(
                "UPDATE reference_accounts SET name = ?1, followers = ?2, note_count = ?3,
                    avg_likes = ?4, avg_comments = ?5, avg_collects = ?6,
                    content_style = ?7, top_notes = ?8,
                    crawled_at = datetime('now','localtime')
                 WHERE id = ?9 AND account_pool_id = ?10",
                params![
                    name,
                    input.followers,
                    input.note_count,
                    input.avg_likes,
                    input.avg_comments,
                    input.avg_collects,
                    input.content_style,
                    top_notes,
                    id,
                    input.account_pool_id,
                ],
            )
            .map_err(|error| format!("更新榜样账号失败: {error}"))?;
        } else {
            conn.execute(
                "INSERT INTO reference_accounts
                    (account_pool_id, account_id, name, followers, note_count, avg_likes,
                     avg_comments, avg_collects, content_style, top_notes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    input.account_pool_id,
                    account_id,
                    name,
                    input.followers,
                    input.note_count,
                    input.avg_likes,
                    input.avg_comments,
                    input.avg_collects,
                    input.content_style,
                    top_notes,
                ],
            )
            .map_err(|error| format!("保存榜样账号失败: {error}"))?;
        }
        Ok(())
    }

    /// Persist generated style/insight text only to a reference account owned
    /// by the active operation account.
    pub fn store_local_reference_ai_result(
        &self,
        account_pool_id: i64,
        platform_account_id: &str,
        kind: &str,
        content: &str,
    ) -> Result<(), String> {
        if content.chars().count() > 20_000 {
            return Err("榜样 AI 分析结果不能超过 20000 个字符".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let changed = match kind {
            "style" => conn.execute(
                "UPDATE reference_accounts
                 SET content_style = ?1, analyzed_at = datetime('now','localtime')
                 WHERE account_pool_id = ?2 AND account_id = ?3",
                params![content, account_pool_id, platform_account_id],
            ),
            "insights" => conn.execute(
                "UPDATE reference_accounts
                 SET insights = ?1, insights_at = datetime('now','localtime')
                 WHERE account_pool_id = ?2 AND account_id = ?3",
                params![content, account_pool_id, platform_account_id],
            ),
            _ => return Err("未知的榜样 AI 分析类型".to_string()),
        }
        .map_err(|error| format!("保存榜样 AI 分析失败: {error}"))?;
        if changed != 1 {
            return Err("榜样账号不存在或不属于当前账号".to_string());
        }
        Ok(())
    }

    /// 删除当前账号下的榜样账号记录，不影响笔记、素材或浏览器登录态。
    pub fn delete_local_reference_account(
        &self,
        id: i64,
        account_pool_id: i64,
    ) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let changed = conn
            .execute(
                "DELETE FROM reference_accounts WHERE id = ?1 AND account_pool_id = ?2",
                params![id, account_pool_id],
            )
            .map_err(|error| format!("删除榜样账号失败: {error}"))?;
        if changed != 1 {
            return Err("榜样账号不存在或不属于当前账号".to_string());
        }
        Ok(())
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
        conn.execute(
            "UPDATE account_pool SET last_used_at = datetime('now', 'localtime') WHERE id = ?1",
            params![account.id],
        )?;
        Ok(account)
    }
}

fn safe_profile_note_url(raw: &str) -> bool {
    if raw.len() > 2_000 || raw.chars().any(char::is_control) {
        return false;
    }
    let Some(rest) = raw.strip_prefix("https://") else {
        return false;
    };
    let Some((authority, path_and_suffix)) = rest.split_once('/') else {
        return false;
    };
    if authority.contains('@') || authority.contains(':') {
        return false;
    }
    if !matches!(
        authority.to_ascii_lowercase().as_str(),
        "xiaohongshu.com" | "www.xiaohongshu.com"
    ) {
        return false;
    }
    let path = path_and_suffix.split(['?', '#']).next().unwrap_or_default();
    if path.len() != path_and_suffix.len() {
        return false;
    }
    let segments = path.split('/').collect::<Vec<_>>();
    let note_id = match segments.as_slice() {
        ["explore", note_id] if !note_id.is_empty() => *note_id,
        ["discovery", "item", note_id] if !note_id.is_empty() => *note_id,
        _ => return false,
    };
    note_id.len() <= 128
        && note_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn average_known(values: &[f64]) -> Option<f64> {
    (!values.is_empty())
        .then(|| ((values.iter().sum::<f64>() / values.len() as f64) * 10.0).round() / 10.0)
}

fn reference_top_notes(notes: &[&BrowserProfileNote]) -> Result<String, String> {
    let mut ranked = notes.to_vec();
    ranked.sort_by(|left, right| right.likes.cmp(&left.likes));
    let mut seen = HashSet::new();
    let top = ranked
        .into_iter()
        .filter_map(|note| {
            let likes = note.likes?;
            let title = note.title.trim();
            if title.is_empty() || !seen.insert(title.to_lowercase()) {
                return None;
            }
            Some(ReferenceNote {
                title: title.chars().take(50).collect(),
                likes,
                url: Some(note.note_url.clone()),
            })
        })
        .take(5)
        .collect::<Vec<_>>();
    serde_json::to_string(&top).map_err(|error| format!("编码榜样热门笔记失败: {error}"))
}
