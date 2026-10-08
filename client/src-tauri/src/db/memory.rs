use super::*;

impl LocalDb {
    /// 读取当前运营账号的经验库开关。缺少记录时使用安全默认值：所有经验来源启用。
    pub fn local_knowledge_preferences(
        &self,
        expected_account_id: Option<i64>,
    ) -> Result<LocalKnowledgePreferences, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let key = knowledge_preferences_key(active.id);
        let stored: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT value, updated_at FROM app_settings WHERE key = ?1",
                params![key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("读取经验库偏好失败: {error}"))?;
        if let Some((Some(raw), updated_at)) = stored {
            if let Ok(mut preferences) = serde_json::from_str::<LocalKnowledgePreferences>(&raw) {
                preferences.account_pool_id = active.id;
                preferences.updated_at = updated_at;
                if validate_local_knowledge_preferences(&preferences.disabled_rule_keys).is_ok() {
                    return Ok(preferences);
                }
            }
        }
        let mut defaults = default_local_knowledge_preferences(active.id, None);
        defaults.disabled_rule_keys = legacy_disabled_rule_keys(&conn);
        if !defaults.disabled_rule_keys.is_empty() {
            let value = serde_json::to_string(&defaults)
                .map_err(|error| format!("迁移旧版经验规律开关失败: {error}"))?;
            conn.execute(
                "INSERT INTO app_settings (key, value, updated_at)
                 VALUES (?1, ?2, datetime('now', 'localtime'))
                 ON CONFLICT(key) DO NOTHING",
                params![key, value],
            )
            .map_err(|error| format!("保存旧版经验规律开关失败: {error}"))?;
        }
        Ok(defaults)
    }

    /// 保存当前账号的经验库开关；仅写入 app_settings，不写入提示词、凭据或外部来源正文。
    pub fn save_local_knowledge_preferences(
        &self,
        input: LocalKnowledgePreferencesUpdate,
    ) -> Result<LocalKnowledgePreferences, String> {
        let disabled_rule_keys = input
            .disabled_rule_keys
            .iter()
            .map(|key| key.trim().to_string())
            .collect::<Vec<_>>();
        validate_local_knowledge_preferences(&disabled_rule_keys)?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let key = knowledge_preferences_key(active.id);
        let payload = LocalKnowledgePreferences {
            account_pool_id: active.id,
            disabled_rule_keys,
            use_my_samples: input.use_my_samples,
            use_reference_samples: input.use_reference_samples,
            use_inspirations: input.use_inspirations,
            updated_at: None,
        };
        let value = serde_json::to_string(&payload)
            .map_err(|error| format!("序列化经验库偏好失败: {error}"))?;
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at)
             VALUES (?1, ?2, datetime('now', 'localtime'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value,
             updated_at = excluded.updated_at",
            params![key, value],
        )
        .map_err(|error| format!("保存经验库偏好失败: {error}"))?;
        let updated_at: Option<String> = conn
            .query_row(
                "SELECT updated_at FROM app_settings WHERE key = ?1",
                params![knowledge_preferences_key(active.id)],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取经验库偏好时间失败: {error}"))?
            .flatten();
        Ok(LocalKnowledgePreferences {
            updated_at,
            ..payload
        })
    }

    /// 读取应用级设置项（非账号作用域）。
    pub fn get_app_setting(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let stored: Option<Option<String>> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取应用设置失败: {error}"))?;
        Ok(stored.flatten())
    }

    /// 写入应用级设置项（非账号作用域）。
    pub fn set_app_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at)
             VALUES (?1, ?2, datetime('now', 'localtime'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value,
             updated_at = excluded.updated_at",
            params![key, value],
        )
        .map_err(|error| format!("保存应用设置失败: {error}"))?;
        Ok(())
    }

    /// 读取当前账号的本地 AI 快捷操作。运行时配置保存在账号作用域的
    /// app_settings 中；仅在首次读取时兼容迁移旧 FastAPI 的 prompt_configs 表。
    pub fn list_prompt_configs(
        &self,
        expected_account_id: Option<i64>,
    ) -> Result<Vec<PromptConfig>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let key = prompt_configs_key(active.id);
        let stored: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取本地提示词失败: {error}"))?;
        let prompts = if stored.is_some() {
            read_prompt_configs_value(&conn, &key)?.unwrap_or_else(default_prompt_configs)
        } else {
            let prompts = legacy_prompt_configs(&conn).unwrap_or_else(default_prompt_configs);
            write_prompt_configs_value(&conn, &key, &prompts)?;
            prompts
        };
        validate_prompt_configs(&prompts)?;
        Ok(prompts)
    }

    /// 新增或更新当前账号的本地 AI 快捷操作。
    pub fn upsert_prompt_config(
        &self,
        input: PromptConfigUpsert,
    ) -> Result<Vec<PromptConfig>, String> {
        validate_prompt_config_fields(&input.key, &input.label, &input.prompt, input.sort_order)?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let key = prompt_configs_key(active.id);
        let mut prompts =
            read_prompt_configs_value(&conn, &key)?.unwrap_or_else(default_prompt_configs);
        if let Some(existing) = prompts.iter_mut().find(|prompt| prompt.key == input.key) {
            existing.label = input.label;
            existing.prompt = input.prompt;
            existing.sort_order = input.sort_order;
            existing.enabled = input.enabled;
        } else {
            prompts.push(PromptConfig {
                key: input.key,
                label: input.label,
                prompt: input.prompt,
                sort_order: input.sort_order,
                enabled: input.enabled,
            });
        }
        prompts.sort_by_key(|prompt| (prompt.sort_order, prompt.key.clone()));
        validate_prompt_configs(&prompts)?;
        write_prompt_configs_value(&conn, &key, &prompts)?;
        Ok(prompts)
    }

    /// 删除当前账号的本地 AI 快捷操作。
    pub fn delete_prompt_config(
        &self,
        key_to_delete: &str,
        expected_account_id: i64,
    ) -> Result<Vec<PromptConfig>, String> {
        if key_to_delete.trim().is_empty() {
            return Err("提示词标识不能为空".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(expected_account_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let key = prompt_configs_key(active.id);
        let mut prompts =
            read_prompt_configs_value(&conn, &key)?.unwrap_or_else(default_prompt_configs);
        prompts.retain(|prompt| prompt.key != key_to_delete);
        validate_prompt_configs(&prompts)?;
        write_prompt_configs_value(&conn, &key, &prompts)?;
        Ok(prompts)
    }

    /// 列出记忆条目（L3）。按账号隔离，可按 origin/kind/confirm_status 过滤。
    pub fn list_memory_entries(
        &self,
        filter: MemoryEntryFilter,
    ) -> Result<Vec<MemoryEntry>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, filter.account_pool_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        validate_origin(filter.origin.as_deref())?;
        if let Some(kind) = filter.kind.as_deref() {
            validate_memory_kind(kind)?;
        }
        if let Some(status) = filter.confirm_status.as_deref() {
            validate_confirm_status(status)?;
        }
        let mut sql = String::from(
            "SELECT id, account_pool_id, origin, kind, content, subject, scope, source, source_type,
                    occurred_at, confirm_status, valid_status, enabled, replaced_by, created_at, updated_at
             FROM memory_entries WHERE account_pool_id = ?1",
        );
        let mut bind: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(active.id)];
        if let Some(origin) = filter.origin.as_deref() {
            sql.push_str(" AND origin = ?");
            bind.push(Box::new(origin.to_string()));
        }
        if let Some(kind) = filter.kind.as_deref() {
            sql.push_str(" AND kind = ?");
            bind.push(Box::new(kind.to_string()));
        }
        if let Some(status) = filter.confirm_status.as_deref() {
            sql.push_str(" AND confirm_status = ?");
            bind.push(Box::new(status.to_string()));
        }
        if let Some(enabled) = filter.enabled {
            sql.push_str(" AND enabled = ?");
            bind.push(Box::new(enabled as i64));
        }
        sql.push_str(" ORDER BY updated_at DESC, id DESC");
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|error| format!("准备记忆查询失败: {error}"))?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(bind.iter().map(|value| value.as_ref())),
                |row| {
                    Ok(MemoryEntry {
                        id: row.get(0)?,
                        account_pool_id: row.get(1)?,
                        origin: row.get(2)?,
                        kind: row.get(3)?,
                        content: row.get(4)?,
                        subject: row.get(5)?,
                        scope: row.get(6)?,
                        source: row.get(7)?,
                        source_type: row.get(8)?,
                        occurred_at: row.get(9)?,
                        confirm_status: row.get(10)?,
                        valid_status: row.get(11)?,
                        enabled: row.get::<_, i64>(12)? != 0,
                        replaced_by: row.get(13)?,
                        created_at: row.get(14)?,
                        updated_at: row.get(15)?,
                    })
                },
            )
            .map_err(|error| format!("读取记忆条目失败: {error}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("读取记忆条目失败: {error}"))
    }

    /// 新增记忆条目。手工录入默认候选；仅允许显式 candidate/confirmed。
    pub fn create_memory_entry(&self, input: MemoryEntryCreate) -> Result<MemoryEntry, String> {
        validate_memory_content(&input.content)?;
        validate_origin(Some(&input.origin))?;
        validate_memory_kind(&input.kind)?;
        validate_source_type(input.source_type.as_deref())?;
        let confirm_status = input.confirm_status.as_deref().unwrap_or("candidate");
        validate_confirm_status(confirm_status)?;
        if confirm_status == "rejected" || confirm_status == "outdated" {
            return Err("新建记忆只能是候选或已确认".to_string());
        }
        let subject = input.subject.unwrap_or_default().trim().to_string();
        let scope = input.scope.unwrap_or_else(|| "account".to_string());
        let source = input.source.unwrap_or_default().trim().to_string();
        let source_type = input.source_type.unwrap_or_else(|| "user".to_string());
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        conn.execute(
            "INSERT INTO memory_entries (
                account_pool_id, origin, kind, content, subject, scope, source, source_type,
                occurred_at, confirm_status, valid_status, enabled
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'valid', ?11)",
            params![
                active.id,
                input.origin,
                input.kind,
                input.content.trim(),
                subject,
                scope,
                source,
                source_type,
                input.occurred_at,
                confirm_status,
                input.enabled.unwrap_or(true) as i64,
            ],
        )
        .map_err(|error| format!("保存记忆条目失败: {error}"))?;
        let id = conn.last_insert_rowid();
        self.memory_entry_by_id(&conn, active.id, id)
    }

    /// 启用/停用记忆条目（停用后不再注入 AI）。
    pub fn set_memory_entry_enabled(
        &self,
        id: i64,
        account_pool_id: i64,
        enabled: bool,
    ) -> Result<MemoryEntry, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let changed = conn
            .execute(
                "UPDATE memory_entries SET enabled = ?1, updated_at = datetime('now', 'localtime')
                 WHERE id = ?2 AND account_pool_id = ?3",
                params![enabled as i64, id, active.id],
            )
            .map_err(|error| format!("更新记忆启用状态失败: {error}"))?;
        if changed == 0 {
            return Err("记忆条目不存在或不属于当前账号".to_string());
        }
        self.memory_entry_by_id(&conn, active.id, id)
    }

    /// 编辑记忆内容字段。不改确认状态、origin 和替代关系。
    pub fn update_memory_entry(&self, input: MemoryEntryUpdate) -> Result<MemoryEntry, String> {
        validate_memory_content(&input.content)?;
        validate_memory_kind(&input.kind)?;
        validate_source_type(input.source_type.as_deref())?;
        let subject = input.subject.unwrap_or_default().trim().to_string();
        let scope = input.scope.unwrap_or_else(|| "account".to_string());
        let source = input.source.unwrap_or_default().trim().to_string();
        let source_type = input.source_type.unwrap_or_else(|| "user".to_string());
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let changed = conn
            .execute(
                "UPDATE memory_entries
                 SET kind = ?1, content = ?2, subject = ?3, scope = ?4, source = ?5,
                     source_type = ?6, occurred_at = ?7, updated_at = datetime('now', 'localtime')
                 WHERE id = ?8 AND account_pool_id = ?9",
                params![
                    input.kind,
                    input.content.trim(),
                    subject,
                    scope,
                    source,
                    source_type,
                    input.occurred_at,
                    input.id,
                    active.id,
                ],
            )
            .map_err(|error| format!("更新记忆条目失败: {error}"))?;
        if changed == 0 {
            return Err("记忆条目不存在或不属于当前账号".to_string());
        }
        self.memory_entry_by_id(&conn, active.id, input.id)
    }

    /// 删除记忆条目。删除后新任务不再检索；本批次不保留撤回占位（历史产物回填在批次四）。
    pub fn delete_memory_entry(&self, id: i64, expected_account_id: i64) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(expected_account_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let referenced: Option<i64> = conn
            .query_row(
                "SELECT id FROM memory_entries
                 WHERE account_pool_id = ?1 AND replaced_by = ?2 LIMIT 1",
                params![active.id, id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("检查记忆替代关系失败: {error}"))?;
        if referenced.is_some() {
            return Err("该记忆被其他条目的替代关系引用，请先解除引用".to_string());
        }
        let deleted = conn
            .execute(
                "DELETE FROM memory_entries WHERE id = ?1 AND account_pool_id = ?2",
                params![id, active.id],
            )
            .map_err(|error| format!("删除记忆条目失败: {error}"))?;
        if deleted == 0 {
            return Err("记忆条目不存在或不属于当前账号".to_string());
        }
        Ok(())
    }

    /// 删除手机同步缓存。手机是源数据，缓存过期时删除必须幂等且不阻止手机重试。
    pub fn delete_mobile_memory_cache_entry(&self, id: i64) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        conn.execute(
            "UPDATE memory_entries SET replaced_by = NULL
             WHERE account_pool_id = ?1 AND origin = 'mobile' AND replaced_by = ?2",
            params![active.id, id],
        )
        .map_err(|error| format!("清理手机记忆缓存引用失败: {error}"))?;
        conn.execute(
            "DELETE FROM memory_entries
             WHERE id = ?1 AND account_pool_id = ?2 AND origin = 'mobile'",
            params![id, active.id],
        )
        .map_err(|error| format!("删除手机记忆缓存失败: {error}"))?;
        Ok(())
    }

    /// 确认状态迁移：候选→确认/否定；确认→过时（可带替代条目）。不可逆向迁移。
    pub fn transition_memory_entry_status(
        &self,
        input: MemoryEntryTransition,
    ) -> Result<MemoryEntry, String> {
        validate_confirm_status(&input.next_status)?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let current_status: String = conn
            .query_row(
                "SELECT confirm_status FROM memory_entries
                 WHERE id = ?1 AND account_pool_id = ?2",
                params![input.id, active.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取记忆状态失败: {error}"))?
            .ok_or_else(|| "记忆条目不存在或不属于当前账号".to_string())?;
        validate_status_transition(&current_status, &input.next_status)?;
        if let Some(replaced_by) = input.replaced_by {
            if input.next_status != "outdated" {
                return Err("替代关系只能在标记过时时写入".to_string());
            }
            if replaced_by == input.id {
                return Err("记忆不能替代自己".to_string());
            }
            let target_status: Option<String> = conn
                .query_row(
                    "SELECT confirm_status FROM memory_entries
                     WHERE id = ?1 AND account_pool_id = ?2",
                    params![replaced_by, active.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("检查替代记忆失败: {error}"))?;
            let target_status =
                target_status.ok_or_else(|| "替代条目不存在或不属于当前账号".to_string())?;
            if target_status != "confirmed" {
                return Err("替代条目必须是已确认记忆".to_string());
            }
        }
        conn.execute(
            "UPDATE memory_entries
             SET confirm_status = ?1,
                 valid_status = CASE WHEN ?1 IN ('rejected', 'outdated') THEN 'invalid' ELSE valid_status END,
                 replaced_by = ?2,
                 updated_at = datetime('now', 'localtime')
             WHERE id = ?3 AND account_pool_id = ?4",
            params![input.next_status, input.replaced_by, input.id, active.id],
        )
        .map_err(|error| format!("更新记忆状态失败: {error}"))?;
        self.memory_entry_by_id(&conn, active.id, input.id)
    }

    fn memory_entry_by_id(
        &self,
        conn: &Connection,
        account_pool_id: i64,
        id: i64,
    ) -> Result<MemoryEntry, String> {
        conn.query_row(
            "SELECT id, account_pool_id, origin, kind, content, subject, scope, source, source_type,
                    occurred_at, confirm_status, valid_status, enabled, replaced_by, created_at, updated_at
             FROM memory_entries WHERE id = ?1 AND account_pool_id = ?2",
            params![id, account_pool_id],
            |row| {
                Ok(MemoryEntry {
                    id: row.get(0)?,
                    account_pool_id: row.get(1)?,
                    origin: row.get(2)?,
                    kind: row.get(3)?,
                    content: row.get(4)?,
                    subject: row.get(5)?,
                    scope: row.get(6)?,
                    source: row.get(7)?,
                    source_type: row.get(8)?,
                    occurred_at: row.get(9)?,
                    confirm_status: row.get(10)?,
                    valid_status: row.get(11)?,
                    enabled: row.get::<_, i64>(12)? != 0,
                    replaced_by: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                })
            },
        )
        .map_err(|error| format!("读取记忆条目失败: {error}"))
    }

    /// 列出经验提示词（L2）。按账号 + origin 过滤。
    pub fn list_experience_prompts(
        &self,
        account_pool_id: Option<i64>,
        origin: Option<String>,
    ) -> Result<Vec<ExperiencePrompt>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, account_pool_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        validate_origin(origin.as_deref())?;
        let rows = if let Some(origin) = origin.as_deref() {
            let mut stmt = conn
                .prepare(
                    "SELECT id, account_pool_id, origin, title, content, enabled, apply_scope,
                            apply_target, source, sort_order, created_at, updated_at
                     FROM experience_prompts
                     WHERE account_pool_id = ?1 AND origin = ?2
                     ORDER BY sort_order, id",
                )
                .map_err(|error| format!("准备经验提示词查询失败: {error}"))?;
            let mapped = stmt
                .query_map(params![active.id, origin], |row| {
                    experience_prompt_from_row(row)
                })
                .map_err(|error| format!("读取经验提示词失败: {error}"))?;
            mapped.collect::<SqlResult<Vec<_>>>()
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, account_pool_id, origin, title, content, enabled, apply_scope,
                            apply_target, source, sort_order, created_at, updated_at
                     FROM experience_prompts
                     WHERE account_pool_id = ?1
                     ORDER BY sort_order, id",
                )
                .map_err(|error| format!("准备经验提示词查询失败: {error}"))?;
            let mapped = stmt
                .query_map(params![active.id], experience_prompt_from_row)
                .map_err(|error| format!("读取经验提示词失败: {error}"))?;
            mapped.collect::<SqlResult<Vec<_>>>()
        };
        rows.map_err(|error| format!("读取经验提示词失败: {error}"))
    }

    /// 新增或更新经验提示词。启用条目每池 ≤10 条，单条 ≤5000 个 Unicode 字符。
    pub fn upsert_experience_prompt(
        &self,
        input: ExperiencePromptUpsert,
    ) -> Result<Vec<ExperiencePrompt>, String> {
        self.upsert_experience_prompt_with_id(input)
            .map(|(_, prompts)| prompts)
    }

    /// 与普通 upsert 相同，但同时返回受影响条目的 ID，避免按展示排序猜测新建 ID。
    pub fn upsert_experience_prompt_with_id(
        &self,
        input: ExperiencePromptUpsert,
    ) -> Result<(i64, Vec<ExperiencePrompt>), String> {
        validate_experience_prompt_fields(&input.title, &input.content)?;
        validate_origin(Some(&input.origin))?;
        let apply_scope = input.apply_scope.unwrap_or_else(|| "account".to_string());
        let apply_target = input.apply_target.unwrap_or_else(|| "all".to_string());
        let source = input.source.unwrap_or_else(|| "user".to_string());
        if !matches!(apply_scope.as_str(), "global" | "account") {
            return Err("适用范围只能是 global 或 account".to_string());
        }
        if !matches!(apply_target.as_str(), "all" | "compose" | "chat") {
            return Err("适用目标只能是 all / compose / chat".to_string());
        }
        if !matches!(source.as_str(), "user" | "from_memory" | "sync") {
            return Err("来源只能是 user / from_memory / sync".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        if input.enabled {
            let enabled_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM experience_prompts
                     WHERE account_pool_id = ?1 AND origin = ?2 AND enabled = 1
                       AND (?3 IS NULL OR id != ?3)",
                    params![active.id, input.origin, input.id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("统计经验提示词失败: {error}"))?;
            if enabled_count >= 10 {
                return Err("启用中的经验提示词最多 10 条，请先停用或删除".to_string());
            }
        }
        if let Some(id) = input.id {
            let changed = conn
                .execute(
                    "UPDATE experience_prompts
                     SET title = ?1, content = ?2, enabled = ?3, apply_scope = ?4,
                         apply_target = ?5, source = ?6,
                         sort_order = COALESCE(?7, sort_order),
                         updated_at = datetime('now', 'localtime')
                     WHERE id = ?8 AND account_pool_id = ?9 AND origin = ?10",
                    params![
                        input.title.trim(),
                        input.content.trim(),
                        input.enabled as i64,
                        apply_scope,
                        apply_target,
                        source,
                        input.sort_order,
                        id,
                        active.id,
                        input.origin,
                    ],
                )
                .map_err(|error| format!("更新经验提示词失败: {error}"))?;
            if changed == 0 {
                return Err("经验提示词不存在或不属于当前账号/端".to_string());
            }
        } else {
            conn.execute(
                "INSERT INTO experience_prompts (
                    account_pool_id, origin, title, content, enabled, apply_scope,
                    apply_target, source, sort_order
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    active.id,
                    input.origin,
                    input.title.trim(),
                    input.content.trim(),
                    input.enabled as i64,
                    apply_scope,
                    apply_target,
                    source,
                    input.sort_order.unwrap_or(0),
                ],
            )
            .map_err(|error| format!("保存经验提示词失败: {error}"))?;
        }
        let id = input.id.unwrap_or_else(|| conn.last_insert_rowid());
        let prompts = self.list_experience_prompts(Some(active.id), Some(input.origin))?;
        Ok((id, prompts))
    }

    /// 删除经验提示词条目。
    pub fn delete_experience_prompt(
        &self,
        id: i64,
        account_pool_id: i64,
        origin: String,
    ) -> Result<Vec<ExperiencePrompt>, String> {
        validate_origin(Some(&origin))?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let deleted = conn
            .execute(
                "DELETE FROM experience_prompts
                 WHERE id = ?1 AND account_pool_id = ?2 AND origin = ?3",
                params![id, active.id, origin],
            )
            .map_err(|error| format!("删除经验提示词失败: {error}"))?;
        if deleted == 0 {
            return Err("经验提示词不存在或不属于当前账号/端".to_string());
        }
        self.list_experience_prompts(Some(active.id), Some(origin))
    }

    /// 读取 L0/L1 系统经验规则。L0 不可改；L1 可覆盖并可恢复默认。
    pub fn read_memory_system_rules(&self) -> Result<MemorySystemRules, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let _ = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        let override_value: Option<Option<String>> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![MEMORY_L1_OVERRIDE_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取系统规则覆盖失败: {error}"))?;
        let stored = override_value.flatten();
        let (l1_active, l1_is_override) = match stored {
            Some(value) if !value.trim().is_empty() => (value, true),
            _ => (DEFAULT_MEMORY_L1.to_string(), false),
        };
        Ok(MemorySystemRules {
            l0: DEFAULT_MEMORY_L0.to_string(),
            l1_default: DEFAULT_MEMORY_L1.to_string(),
            l1_active,
            l1_is_override,
        })
    }

    /// 保存 L1 覆盖文本（非空）。
    pub fn save_memory_l1_override(&self, content: &str) -> Result<MemorySystemRules, String> {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return Err("L1 覆盖内容不能为空；如需恢复默认请调用 reset".to_string());
        }
        if trimmed.chars().count() > 2000 {
            return Err("L1 覆盖内容最多 2000 字".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let _ = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at)
             VALUES (?1, ?2, datetime('now', 'localtime'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value,
             updated_at = excluded.updated_at",
            params![MEMORY_L1_OVERRIDE_KEY, trimmed],
        )
        .map_err(|error| format!("保存系统规则覆盖失败: {error}"))?;
        self.read_memory_system_rules()
    }

    /// 恢复 L1 默认，删除覆盖。
    pub fn reset_memory_l1_override(&self) -> Result<MemorySystemRules, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let _ = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        conn.execute(
            "DELETE FROM app_settings WHERE key = ?1",
            params![MEMORY_L1_OVERRIDE_KEY],
        )
        .map_err(|error| format!("清除系统规则覆盖失败: {error}"))?;
        self.read_memory_system_rules()
    }
}
