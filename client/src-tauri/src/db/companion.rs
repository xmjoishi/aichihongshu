use super::*;

impl LocalDb {
    /// 为 PC Harness 任务创建 companion_tasks 记录；账号在创建时冻结。
    pub fn create_companion_task(
        &self,
        task_id: &str,
        client_task_id: Option<&str>,
        account_pool_id: i64,
        topic: Option<&str>,
    ) -> Result<CompanionTaskSummary, String> {
        if task_id.trim().is_empty() {
            return Err("任务 ID 不能为空".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let account_exists: Option<i64> = conn
            .query_row(
                "SELECT id FROM account_pool WHERE id = ?1",
                params![account_pool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("校验账号失败: {error}"))?;
        if account_exists.is_none() {
            return Err("任务账号不存在".to_string());
        }
        let now = local_timestamp();
        conn.execute(
            "INSERT INTO companion_tasks (
                 task_id, client_task_id, account_pool_id, status, topic,
                 item_ids, tags, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'queued', ?4, '[]', '[]', ?5, ?5)",
            params![task_id, client_task_id, account_pool_id, topic, now],
        )
        .map_err(|error| format!("写入 Companion 任务失败: {error}"))?;
        drop(conn);
        self.companion_task_by_id(task_id)
    }

    pub fn find_companion_task_by_client_id(
        &self,
        account_pool_id: i64,
        client_task_id: &str,
    ) -> Result<Option<CompanionTaskSummary>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let task_id: Option<String> = conn
            .query_row(
                "SELECT task_id FROM companion_tasks
                 WHERE account_pool_id = ?1 AND client_task_id = ?2",
                params![account_pool_id, client_task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("查询 Companion 任务失败: {error}"))?;
        drop(conn);
        match task_id {
            Some(id) => self.companion_task_by_id(&id).map(Some),
            None => Ok(None),
        }
    }

    pub fn companion_task_by_id(&self, task_id: &str) -> Result<CompanionTaskSummary, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        read_companion_task(&conn, task_id)
    }

    pub fn update_companion_task_progress(
        &self,
        progress: CompanionTaskProgress<'_>,
    ) -> Result<CompanionTaskSummary, String> {
        let CompanionTaskProgress {
            task_id,
            status,
            item_ids,
            note_id,
            title,
            body,
            tags,
            content_version,
            error,
        } = progress;
        if !matches!(
            status,
            "queued" | "processing" | "ready" | "failed" | "cancelled"
        ) {
            return Err("Companion 任务状态无效".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let item_ids_json = serde_json::to_string(item_ids)
            .map_err(|error| format!("序列化任务素材失败: {error}"))?;
        let tags_json =
            serde_json::to_string(tags).map_err(|error| format!("序列化任务标签失败: {error}"))?;
        let now = local_timestamp();
        conn.execute(
            "UPDATE companion_tasks
             SET status = ?2, item_ids = ?3, note_id = COALESCE(?4, note_id),
                 title = COALESCE(?5, title), body = COALESCE(?6, body),
                 tags = ?7, content_version = COALESCE(?8, content_version),
                 error = ?9, updated_at = ?10
             WHERE task_id = ?1",
            params![
                task_id,
                status,
                item_ids_json,
                note_id,
                title,
                body,
                tags_json,
                content_version,
                error,
                now
            ],
        )
        .map_err(|error| format!("更新 Companion 任务失败: {error}"))?;
        drop(conn);
        self.companion_task_by_id(task_id)
    }

    pub fn record_companion_publish_receipt(
        &self,
        task_id: &str,
        status: &str,
        note_url: Option<&str>,
        message: Option<&str>,
    ) -> Result<CompanionTaskSummary, String> {
        if !matches!(
            status,
            "prepared" | "submitted" | "confirmed" | "unknown" | "failed"
        ) {
            return Err("发布回填状态无效".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let existing = read_companion_task(&conn, task_id)?;
        if existing.note_id.is_none() {
            return Err("任务尚未生成稿件，无法回填发布结果".to_string());
        }
        let now = local_timestamp();
        conn.execute(
            "UPDATE companion_tasks
             SET publish_status = ?2, publish_note_url = ?3, publish_message = ?4, updated_at = ?5
             WHERE task_id = ?1",
            params![task_id, status, note_url, message, now],
        )
        .map_err(|error| format!("写入发布回填失败: {error}"))?;
        if let Some(note_id) = existing.note_id {
            if matches!(status, "submitted" | "confirmed") {
                conn.execute(
                    "UPDATE notes
                     SET note_url = COALESCE(?2, note_url),
                         status = CASE WHEN ?3 = 'confirmed' THEN 'published' ELSE status END,
                         published_at = COALESCE(published_at, ?4),
                         updated_at = ?4,
                         content_version = content_version + 1
                     WHERE id = ?1 AND account_pool_id = ?5 AND deleted_at IS NULL",
                    params![note_id, note_url, status, now, existing.account_pool_id],
                )
                .map_err(|error| format!("回填笔记发布状态失败: {error}"))?;
            }
        }
        drop(conn);
        self.companion_task_by_id(task_id)
    }
}
