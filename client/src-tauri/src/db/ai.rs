use super::*;

impl LocalDb {
    /// Persist only AI run metadata. Prompts and generated text stay in the
    /// bounded frontend history so credentials and sensitive content are not
    /// copied into the durable database by the run tracker.
    pub fn upsert_local_ai_run(&self, input: LocalAIRunUpsert) -> Result<AIRunSummary, String> {
        validate_local_ai_run(
            &input.run_id,
            &input.provider,
            &input.started_at,
            &input.status,
            input.finished_at.as_deref(),
            input.error.as_deref(),
        )?;
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, input.account_pool_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        validate_ai_object_scope(&conn, input.account_pool_id, input.note_id, input.item_id)?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开启 AI 运行事务失败: {error}"))?;
        if let Some(existing_account) = tx
            .query_row(
                "SELECT account_pool_id FROM ai_runs WHERE run_id = ?1",
                params![input.run_id.trim()],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(|error| format!("读取 AI 运行失败: {error}"))?
        {
            if existing_account != input.account_pool_id {
                return Err("AI 运行不属于当前账号上下文".to_string());
            }
        }
        tx.execute(
            "INSERT INTO ai_runs (
                 run_id, account_pool_id, note_id, item_id, provider,
                 started_at, status, finished_at, error
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(run_id) DO UPDATE SET
                 account_pool_id = excluded.account_pool_id,
                 note_id = excluded.note_id,
                 item_id = excluded.item_id,
                 provider = excluded.provider,
                 started_at = excluded.started_at,
                 status = excluded.status,
                 finished_at = excluded.finished_at,
                 error = excluded.error,
                 updated_at = datetime('now', 'localtime')
             WHERE NOT (
                 ai_runs.status IN ('completed', 'failed', 'cancelled', 'interrupted')
                 AND excluded.status = 'running'
             )",
            params![
                input.run_id.trim(),
                input.account_pool_id,
                input.note_id,
                input.item_id,
                input.provider.trim(),
                input.started_at.trim(),
                input.status.trim(),
                input.finished_at.as_deref().map(str::trim),
                input.error.as_deref().map(str::trim),
            ],
        )
        .map_err(|error| format!("保存 AI 运行失败: {error}"))?;
        let result = tx
            .query_row(
                "SELECT run_id, account_pool_id, note_id, item_id, provider,
                        started_at, status, finished_at, error
                 FROM ai_runs WHERE run_id = ?1",
                params![input.run_id.trim()],
                ai_run_from_row,
            )
            .map_err(|error| format!("读取已保存的 AI 运行失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交 AI 运行失败: {error}"))?;
        Ok(result)
    }

    pub fn update_local_ai_run(&self, input: LocalAIRunUpdate) -> Result<AIRunSummary, String> {
        validate_local_ai_run_status(&input.status)?;
        if input.run_id.trim().is_empty() || input.run_id.chars().count() > 120 {
            return Err("AI 运行 ID 无效".to_string());
        }
        if input
            .finished_at
            .as_deref()
            .is_some_and(|value| value.chars().count() > 64)
        {
            return Err("AI 运行完成时间无效".to_string());
        }
        if input
            .error
            .as_deref()
            .is_some_and(|value| value.chars().count() > 240)
        {
            return Err("AI 运行错误信息过长".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, input.account_pool_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let changed = conn
            .execute(
                "UPDATE ai_runs
                 SET status = ?1, finished_at = ?2, error = ?3,
                     updated_at = datetime('now', 'localtime')
                 WHERE run_id = ?4
                   AND ((account_pool_id IS NULL AND ?5 IS NULL) OR account_pool_id = ?5)",
                params![
                    input.status.trim(),
                    input.finished_at.as_deref().map(str::trim),
                    input.error.as_deref().map(str::trim),
                    input.run_id.trim(),
                    input.account_pool_id,
                ],
            )
            .map_err(|error| format!("更新 AI 运行失败: {error}"))?;
        if changed != 1 {
            return Err("AI 运行不存在或不属于当前账号".to_string());
        }
        conn.query_row(
            "SELECT run_id, account_pool_id, note_id, item_id, provider,
                    started_at, status, finished_at, error
             FROM ai_runs WHERE run_id = ?1",
            params![input.run_id.trim()],
            ai_run_from_row,
        )
        .map_err(|error| format!("读取更新后的 AI 运行失败: {error}"))
    }

    pub fn latest_local_ai_run(
        &self,
        account_pool_id: Option<i64>,
        note_id: Option<i64>,
        item_id: Option<i64>,
    ) -> Result<Option<AIRunSummary>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, account_pool_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        validate_ai_object_scope(&conn, account_pool_id, note_id, item_id)?;
        conn.query_row(
            "SELECT run_id, account_pool_id, note_id, item_id, provider,
                    started_at, status, finished_at, error
             FROM ai_runs
             WHERE ((account_pool_id IS NULL AND ?1 IS NULL) OR account_pool_id = ?1)
               AND ((note_id IS NULL AND ?2 IS NULL) OR note_id = ?2)
               AND ((item_id IS NULL AND ?3 IS NULL) OR item_id = ?3)
             ORDER BY updated_at DESC, started_at DESC
             LIMIT 1",
            params![account_pool_id, note_id, item_id],
            ai_run_from_row,
        )
        .optional()
        .map_err(|error| format!("读取最近 AI 运行失败: {error}"))
    }

    /// Persist a bounded generated artifact separately from run metadata.
    /// The artifact is scoped to the same account/object as its run and is
    /// replaced idempotently for the same run and kind.
    pub fn save_local_ai_artifact(
        &self,
        input: LocalAIRunArtifactCreate,
    ) -> Result<AIRunArtifactSummary, String> {
        validate_local_ai_artifact(&input)?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, input.account_pool_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        validate_ai_object_scope(&conn, input.account_pool_id, input.note_id, input.item_id)?;
        let run_scope: Option<(Option<i64>, Option<i64>, Option<i64>)> = conn
            .query_row(
                "SELECT account_pool_id, note_id, item_id FROM ai_runs WHERE run_id = ?1",
                params![input.run_id.trim()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("读取 AI 运行归属失败: {error}"))?;
        let Some(run_scope) = run_scope else {
            return Err("AI 运行不存在，不能保存产物".to_string());
        };
        if run_scope != (input.account_pool_id, input.note_id, input.item_id) {
            return Err("AI 产物不属于当前运行或账号上下文".to_string());
        }
        conn.execute(
            "INSERT INTO ai_run_artifacts (
                 run_id, account_pool_id, note_id, item_id, kind, content
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(run_id, kind) DO UPDATE SET
                 account_pool_id = excluded.account_pool_id,
                 note_id = excluded.note_id,
                 item_id = excluded.item_id,
                 content = excluded.content,
                 created_at = datetime('now', 'localtime')",
            params![
                input.run_id.trim(),
                input.account_pool_id,
                input.note_id,
                input.item_id,
                input.kind.trim(),
                input.content.trim(),
            ],
        )
        .map_err(|error| format!("保存 AI 产物失败: {error}"))?;
        conn.query_row(
            "SELECT id, run_id, account_pool_id, note_id, item_id, kind, content, created_at
             FROM ai_run_artifacts WHERE run_id = ?1 AND kind = ?2",
            params![input.run_id.trim(), input.kind.trim()],
            ai_run_artifact_from_row,
        )
        .map_err(|error| format!("读取已保存的 AI 产物失败: {error}"))
    }

    pub fn local_ai_artifacts(
        &self,
        account_pool_id: Option<i64>,
        note_id: Option<i64>,
        item_id: Option<i64>,
    ) -> Result<Vec<AIRunArtifactSummary>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, account_pool_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        validate_ai_object_scope(&conn, account_pool_id, note_id, item_id)?;
        let mut statement = conn
            .prepare(
                "SELECT id, run_id, account_pool_id, note_id, item_id, kind, content, created_at
                 FROM ai_run_artifacts
                 WHERE ((account_pool_id IS NULL AND ?1 IS NULL) OR account_pool_id = ?1)
                   AND ((note_id IS NULL AND ?2 IS NULL) OR note_id = ?2)
                   AND ((item_id IS NULL AND ?3 IS NULL) OR item_id = ?3)
                 ORDER BY id DESC
                 LIMIT 20",
            )
            .map_err(|error| format!("准备 AI 产物查询失败: {error}"))?;
        let rows = statement
            .query_map(
                params![account_pool_id, note_id, item_id],
                ai_run_artifact_from_row,
            )
            .map_err(|error| format!("读取 AI 产物失败: {error}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("读取 AI 产物失败: {error}"))
    }
}
