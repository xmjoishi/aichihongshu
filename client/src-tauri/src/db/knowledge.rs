use super::*;

#[derive(Default)]
struct TagStats {
    count: i64,
    total_likes: i64,
}

impl LocalDb {
    /// Return published notes for the knowledge editor, scoped to the active account.
    pub fn local_knowledge_my_samples(
        &self,
        expected_account_id: Option<i64>,
    ) -> Result<Vec<KnowledgeMySample>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let mut statement = conn
            .prepare(
                "SELECT id, title, body, tags, likes, comments, collects,
                        published_at, note_url, use_as_reference
                 FROM notes
                 WHERE account_pool_id = ?1 AND status = 'published' AND deleted_at IS NULL
                 ORDER BY likes DESC",
            )
            .map_err(|error| format!("准备高赞样本查询失败: {error}"))?;
        let rows = statement
            .query_map(params![active.id], |row| {
                let body: Option<String> = row.get(2)?;
                let tags = row
                    .get::<_, Option<String>>(3)?
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
                    .unwrap_or_default();
                let body_preview = body
                    .as_deref()
                    .unwrap_or_default()
                    .chars()
                    .take(80)
                    .collect::<String>()
                    .trim()
                    .to_string();
                Ok(KnowledgeMySample {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    body,
                    tags,
                    likes: row.get::<_, Option<i64>>(4)?.unwrap_or_default(),
                    comments: row.get::<_, Option<i64>>(5)?.unwrap_or_default(),
                    collects: row.get::<_, Option<i64>>(6)?.unwrap_or_default(),
                    published_at: row.get(7)?,
                    note_url: row.get(8)?,
                    body_preview,
                    use_as_reference: row.get::<_, Option<i64>>(9)?.unwrap_or_default() != 0,
                })
            })
            .map_err(|error| format!("读取高赞样本失败: {error}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("读取高赞样本失败: {error}"))
    }

    /// Toggle whether a published note participates in local knowledge context.
    pub fn set_local_note_reference_usage(
        &self,
        note_id: i64,
        expected_account_id: i64,
        enabled: bool,
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
                "UPDATE notes SET use_as_reference = ?, updated_at = datetime('now', 'localtime')
                 WHERE id = ? AND account_pool_id = ? AND status = 'published' AND deleted_at IS NULL",
                params![enabled as i64, note_id, active.id],
            )
            .map_err(|error| format!("更新高赞样本状态失败: {error}"))?;
        if changed != 1 {
            return Err("已发布笔记不存在或不属于当前账号".to_string());
        }
        Ok(())
    }

    /// Read saved reference-note samples for reference accounts in the active pool.
    pub fn local_knowledge_reference_samples(
        &self,
        expected_account_id: Option<i64>,
    ) -> Result<Vec<KnowledgeReferenceGroup>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let notes_column = reference_notes_column(&conn)?;
        let query = format!(
            "SELECT account_id, name, {notes_column} FROM reference_accounts
             WHERE account_pool_id = ?1 ORDER BY name, account_id"
        );
        let mut statement = conn
            .prepare(&query)
            .map_err(|error| format!("准备榜样样本查询失败: {error}"))?;
        let rows = statement
            .query_map(params![active.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|error| format!("读取榜样样本失败: {error}"))?;
        let mut groups = Vec::new();
        for row in rows {
            let (account_id, name, raw_notes) =
                row.map_err(|error| format!("读取榜样样本失败: {error}"))?;
            let notes = parse_knowledge_reference_samples(raw_notes.as_deref());
            if notes.is_empty() {
                continue;
            }
            groups.push(KnowledgeReferenceGroup {
                name: name
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| account_id.clone()),
                account_id,
                notes,
            });
        }
        Ok(groups)
    }

    /// Return reference-note groups in the old HTTP shape without discarding
    /// fields that older databases may have stored on individual notes.
    pub fn legacy_knowledge_reference_samples(
        &self,
        expected_account_id: Option<i64>,
    ) -> Result<Vec<serde_json::Value>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let notes_column = reference_notes_column(&conn)?;
        let query = format!(
            "SELECT account_id, name, {notes_column} FROM reference_accounts
             WHERE account_pool_id = ?1 ORDER BY name, account_id"
        );
        let mut statement = conn
            .prepare(&query)
            .map_err(|error| format!("准备榜样样本查询失败: {error}"))?;
        let rows = statement
            .query_map(params![active.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|error| format!("读取榜样样本失败: {error}"))?;
        let mut groups = Vec::new();
        for row in rows {
            let (account_id, name, raw_notes) =
                row.map_err(|error| format!("读取榜样样本失败: {error}"))?;
            let notes = raw_notes
                .as_deref()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                .unwrap_or_else(|| serde_json::json!([]));
            let has_notes = match &notes {
                serde_json::Value::Null => false,
                serde_json::Value::Bool(value) => *value,
                serde_json::Value::Number(value) => value.as_f64().unwrap_or_default() != 0.0,
                serde_json::Value::String(value) => !value.is_empty(),
                serde_json::Value::Array(value) => !value.is_empty(),
                serde_json::Value::Object(value) => !value.is_empty(),
            };
            if !has_notes {
                continue;
            }
            let name = name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| account_id.clone());
            groups.push(serde_json::json!({
                "account_id": account_id,
                "name": name,
                "notes": notes,
            }));
        }
        Ok(groups)
    }

    /// Add a reference note to a reference account owned by the active account pool.
    pub fn add_local_knowledge_reference_sample(
        &self,
        account_id: &str,
        expected_account_id: i64,
        title: &str,
        body: Option<&str>,
        likes: i64,
        note_url: Option<&str>,
    ) -> Result<(bool, usize), String> {
        let account_id = account_id.trim();
        let title = title.trim();
        let body = body.unwrap_or_default().trim();
        let note_url = note_url.unwrap_or_default().trim();
        if account_id.is_empty() || account_id.chars().count() > 200 {
            return Err("榜样账号 ID 无效".to_string());
        }
        if title.is_empty() || title.chars().count() > 500 {
            return Err("样本标题不能为空且最多 500 字".to_string());
        }
        if body.chars().count() > 20_000 || note_url.chars().count() > 2_000 {
            return Err("样本正文最多 20000 字，链接最多 2000 字".to_string());
        }
        if likes < 0 {
            return Err("点赞数不能小于 0".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(expected_account_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let notes_column = reference_notes_column(&conn)?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开启榜样样本事务失败: {error}"))?;
        let query = format!(
            "SELECT {notes_column} FROM reference_accounts
             WHERE account_id = ?1 AND account_pool_id = ?2"
        );
        let raw_notes: Option<Option<String>> = tx
            .query_row(&query, params![account_id, active.id], |row| row.get(0))
            .optional()
            .map_err(|error| format!("读取榜样账号样本失败: {error}"))?;
        let Some(raw_notes) = raw_notes else {
            return Err(format!("榜样账号 {account_id} 不存在"));
        };
        let mut notes = parse_reference_notes_value(raw_notes.as_deref());
        if notes
            .iter()
            .any(|note| note.get("title").and_then(serde_json::Value::as_str) == Some(title))
        {
            return Ok((true, notes.len()));
        }
        notes.push(serde_json::json!({
            "title": title,
            "body": body,
            "likes": likes,
            "note_url": note_url,
        }));
        let serialized = serde_json::to_string(&notes)
            .map_err(|error| format!("序列化榜样样本失败: {error}"))?;
        let update = format!(
            "UPDATE reference_accounts SET {notes_column} = ?1
             WHERE account_id = ?2 AND account_pool_id = ?3"
        );
        let changed = tx
            .execute(&update, params![serialized, account_id, active.id])
            .map_err(|error| format!("保存榜样样本失败: {error}"))?;
        if changed != 1 {
            return Err(format!("榜样账号 {account_id} 不存在"));
        }
        let count = notes.len();
        tx.commit()
            .map_err(|error| format!("提交榜样样本事务失败: {error}"))?;
        Ok((false, count))
    }

    /// Delete a saved reference note by its displayed index, scoped to the active pool.
    pub fn delete_local_knowledge_reference_sample(
        &self,
        account_id: &str,
        expected_account_id: i64,
        index: i64,
    ) -> Result<usize, String> {
        let account_id = account_id.trim();
        if index < 0 {
            return Err("索引超出范围".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(expected_account_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let notes_column = reference_notes_column(&conn)?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开启榜样样本事务失败: {error}"))?;
        let query = format!(
            "SELECT {notes_column} FROM reference_accounts
             WHERE account_id = ?1 AND account_pool_id = ?2"
        );
        let raw_notes: Option<Option<String>> = tx
            .query_row(&query, params![account_id, active.id], |row| row.get(0))
            .optional()
            .map_err(|error| format!("读取榜样账号样本失败: {error}"))?;
        let Some(raw_notes) = raw_notes else {
            return Err(format!("榜样账号 {account_id} 不存在"));
        };
        let mut notes = parse_reference_notes_value(raw_notes.as_deref());
        let index = usize::try_from(index).map_err(|_| "索引超出范围".to_string())?;
        if index >= notes.len() {
            return Err("索引超出范围".to_string());
        }
        notes.remove(index);
        let serialized = serde_json::to_string(&notes)
            .map_err(|error| format!("序列化榜样样本失败: {error}"))?;
        let update = format!(
            "UPDATE reference_accounts SET {notes_column} = ?1
             WHERE account_id = ?2 AND account_pool_id = ?3"
        );
        tx.execute(&update, params![serialized, account_id, active.id])
            .map_err(|error| format!("删除榜样样本失败: {error}"))?;
        let count = notes.len();
        tx.commit()
            .map_err(|error| format!("提交榜样样本事务失败: {error}"))?;
        Ok(count)
    }

    /// Build the account-scoped knowledge context used by composition prompts.
    /// This preserves the legacy Python signals while honoring the newer
    /// per-account experience switches and never mixing data from other pools.
    pub fn local_content_knowledge_context(
        &self,
        expected_account_id: Option<i64>,
    ) -> Result<LocalContentKnowledgeContext, String> {
        let preferences = self.local_knowledge_preferences(expected_account_id)?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;

        let disabled = preferences
            .disabled_rule_keys
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let mut context = LocalContentKnowledgeContext::default();

        let title_rule = conn
            .query_row(
                "SELECT bucket, avg_likes FROM (
                    SELECT CASE
                        WHEN length(title) < 10 THEN '<10'
                        WHEN length(title) < 20 THEN '10-20'
                        WHEN length(title) < 30 THEN '20-30'
                        ELSE '30+'
                    END AS bucket, AVG(likes) AS avg_likes, COUNT(*) AS cnt
                    FROM notes
                    WHERE account_pool_id = ?1 AND status = 'published'
                      AND title IS NOT NULL AND title != '' AND deleted_at IS NULL
                    GROUP BY bucket HAVING cnt >= 2
                    ORDER BY avg_likes DESC LIMIT 1
                 )",
                params![active.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?)),
            )
            .optional()
            .map_err(|error| format!("计算标题规律失败: {error}"))?;
        if let Some((bucket, average)) = title_rule {
            push_rule(
                &mut context,
                &disabled,
                "rule_title_len",
                "标题字数",
                serde_json::json!(bucket.clone()),
                format!("{bucket} 字标题均赞最高（均赞 {}）", average.round() as i64),
            );
        }

        let hour_rule = conn
            .query_row(
                "SELECT hour, avg_likes FROM (
                    SELECT strftime('%H', published_at) AS hour,
                           AVG(likes) AS avg_likes, COUNT(*) AS cnt
                    FROM notes
                    WHERE account_pool_id = ?1 AND status = 'published'
                      AND published_at IS NOT NULL AND deleted_at IS NULL
                    GROUP BY hour HAVING cnt >= 2
                    ORDER BY avg_likes DESC LIMIT 1
                 )",
                params![active.id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, f64>(1)?)),
            )
            .optional()
            .map_err(|error| format!("计算发布时间规律失败: {error}"))?;
        if let Some((hour, average)) = hour_rule {
            push_rule(
                &mut context,
                &disabled,
                "rule_best_hour",
                "最佳发布时段",
                hour.as_ref()
                    .map_or(serde_json::Value::Null, |value| serde_json::json!(value)),
                format!(
                    "{}:00 段互动最高（均赞 {}）",
                    hour.as_deref().unwrap_or("None"),
                    average.round() as i64
                ),
            );
        }

        let mut tag_stats = Vec::<(String, TagStats)>::new();
        let mut tag_indexes = BTreeMap::<String, usize>::new();
        {
            let mut statement = conn
                .prepare(
                    "SELECT tags, likes FROM notes
                     WHERE account_pool_id = ?1 AND status = 'published'
                       AND tags != '[]' AND deleted_at IS NULL
                     ORDER BY id",
                )
                .map_err(|error| format!("读取标签规律失败: {error}"))?;
            let rows = statement
                .query_map(params![active.id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(|error| format!("读取标签规律失败: {error}"))?;
            for row in rows {
                let (raw_tags, likes) =
                    row.map_err(|error| format!("读取标签规律失败: {error}"))?;
                let Ok(tags) = serde_json::from_str::<Vec<String>>(&raw_tags) else {
                    continue;
                };
                for raw_tag in tags {
                    let tag = raw_tag.trim().trim_start_matches('#').to_string();
                    if tag.is_empty() {
                        continue;
                    }
                    let index = match tag_indexes.get(&tag) {
                        Some(index) => *index,
                        None => {
                            let index = tag_stats.len();
                            tag_indexes.insert(tag.clone(), index);
                            tag_stats.push((tag, TagStats::default()));
                            index
                        }
                    };
                    tag_stats[index].1.count += 1;
                    tag_stats[index].1.total_likes += likes;
                }
            }
        }
        let mut frequent_tags = tag_stats
            .into_iter()
            .filter(|(_, stats)| stats.count >= 2)
            .collect::<Vec<_>>();
        // Stable ties mirror Python's stable sort while using first-seen tag order.
        frequent_tags.sort_by(|left, right| {
            let left_avg = left.1.total_likes as f64 / left.1.count as f64;
            let right_avg = right.1.total_likes as f64 / right.1.count as f64;
            right_avg.total_cmp(&left_avg)
        });
        for (index, (tag, stats)) in frequent_tags.into_iter().take(3).enumerate() {
            let average = (stats.total_likes as f64 / stats.count as f64).round() as i64;
            push_rule(
                &mut context,
                &disabled,
                &format!("rule_tag_{index}"),
                "高效标签",
                serde_json::json!(tag.clone()),
                format!(
                    "#{tag} 高频且高赞（出现 {} 次，均赞 {average}）",
                    stats.count
                ),
            );
        }

        let collection_ratio = conn
            .query_row(
                "SELECT CAST(collects AS REAL) / NULLIF(likes, 0)
                 FROM notes
                 WHERE account_pool_id = ?1 AND status = 'published'
                   AND likes > 0 AND deleted_at IS NULL
                 ORDER BY CAST(collects AS REAL) / NULLIF(likes, 0) DESC LIMIT 1",
                params![active.id],
                |row| row.get::<_, f64>(0),
            )
            .optional()
            .map_err(|error| format!("计算收藏规律失败: {error}"))?;
        if let Some(ratio) = collection_ratio.filter(|ratio| *ratio > 0.3) {
            push_rule(
                &mut context,
                &disabled,
                "rule_collect_ratio",
                "收藏率",
                serde_json::json!(format!("{ratio:.2}")),
                format!(
                    "高收藏笔记收藏/点赞比可达 {}%，注重实用干货",
                    (ratio * 100.0).round() as i64
                ),
            );
        }

        if preferences.use_my_samples {
            let mut statement = conn
                .prepare(
                    "SELECT title, body, likes FROM notes
                     WHERE account_pool_id = ?1 AND status = 'published'
                       AND use_as_reference = 1 AND deleted_at IS NULL
                     ORDER BY likes DESC LIMIT 3",
                )
                .map_err(|error| format!("读取我的参考笔记失败: {error}"))?;
            context.my_samples = statement
                .query_map(params![active.id], |row| {
                    Ok(LocalKnowledgeSample {
                        title: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        body_preview: preview(row.get::<_, Option<String>>(1)?.as_deref()),
                        likes: row.get::<_, Option<i64>>(2)?.unwrap_or_default(),
                        account: None,
                    })
                })
                .map_err(|error| format!("读取我的参考笔记失败: {error}"))?
                .collect::<SqlResult<Vec<_>>>()
                .map_err(|error| format!("读取我的参考笔记失败: {error}"))?;
        }

        if preferences.use_reference_samples {
            let ref_column = if table_has_column(&conn, "reference_accounts", "ref_notes")? {
                "ref_notes"
            } else {
                "top_notes"
            };
            let query = format!(
                "SELECT name, account_id, {ref_column} FROM reference_accounts
                 WHERE account_pool_id = ?1 ORDER BY id"
            );
            let mut statement = conn
                .prepare(&query)
                .map_err(|error| format!("读取榜样笔记失败: {error}"))?;
            let rows = statement
                .query_map(params![active.id], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .map_err(|error| format!("读取榜样笔记失败: {error}"))?;
            for row in rows {
                let (name, account_id, raw_notes) =
                    row.map_err(|error| format!("读取榜样笔记失败: {error}"))?;
                let account = name.unwrap_or(account_id);
                let notes = raw_notes
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(raw).ok())
                    .unwrap_or_default();
                for note in notes.iter().take(2) {
                    context.reference_samples.push(LocalKnowledgeSample {
                        title: note
                            .get("title")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        body_preview: preview(note.get("body").and_then(serde_json::Value::as_str)),
                        likes: note
                            .get("likes")
                            .and_then(serde_json::Value::as_i64)
                            .unwrap_or(0),
                        account: Some(account.clone()),
                    });
                }
                if context.reference_samples.len() >= 3 {
                    break;
                }
            }
            context.reference_samples.truncate(3);
        }

        if preferences.use_inspirations {
            let mut statement = conn
                .prepare(
                    "SELECT title FROM inspirations
                     WHERE account_pool_id = ?1 AND status = 'saved' AND saved = 1
                     ORDER BY created_at DESC LIMIT 3",
                )
                .map_err(|error| format!("读取选题灵感失败: {error}"))?;
            context.inspirations = statement
                .query_map(params![active.id], |row| row.get::<_, String>(0))
                .map_err(|error| format!("读取选题灵感失败: {error}"))?
                .collect::<SqlResult<Vec<_>>>()
                .map_err(|error| format!("读取选题灵感失败: {error}"))?;
        }

        Ok(context)
    }
}

fn push_rule(
    context: &mut LocalContentKnowledgeContext,
    disabled: &HashSet<&str>,
    key: &str,
    label: &str,
    value: serde_json::Value,
    description: String,
) {
    let enabled = !disabled.contains(key);
    context.rule_summaries.push(LocalKnowledgeRule {
        key: key.to_string(),
        label: label.to_string(),
        desc: description.clone(),
        value,
        enabled,
    });
    if enabled {
        context.rules.push(description);
    }
}

fn preview(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .chars()
        .take(80)
        .collect::<String>()
        .trim()
        .to_string()
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("读取 {table} 结构失败: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("读取 {table} 结构失败: {error}"))?;
    for name in rows {
        if name.map_err(|error| format!("读取 {table} 结构失败: {error}"))? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn reference_notes_column(conn: &Connection) -> Result<&'static str, String> {
    if table_has_column(conn, "reference_accounts", "ref_notes")? {
        Ok("ref_notes")
    } else {
        Ok("top_notes")
    }
}

fn parse_reference_notes_value(raw: Option<&str>) -> Vec<serde_json::Value> {
    raw.and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(raw).ok())
        .unwrap_or_default()
}

fn parse_knowledge_reference_samples(raw: Option<&str>) -> Vec<KnowledgeReferenceSample> {
    parse_reference_notes_value(raw)
        .into_iter()
        .map(|note| KnowledgeReferenceSample {
            title: note
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            body: note
                .get("body")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            likes: note
                .get("likes")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default(),
            note_url: note
                .get("note_url")
                .or_else(|| note.get("url"))
                .and_then(serde_json::Value::as_str)
                .filter(|url| !url.is_empty())
                .map(str::to_string),
        })
        .collect()
}
