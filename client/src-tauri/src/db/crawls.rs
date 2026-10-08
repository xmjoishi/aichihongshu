use super::*;

impl LocalDb {
    pub fn list_local_crawl_logs(
        &self,
        account_pool_id: i64,
        limit: usize,
    ) -> Result<Vec<CrawlLogSummary>, String> {
        if !(1..=100).contains(&limit) {
            return Err("采集历史条数必须在 1 到 100 之间".into());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败：{error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前账号失败：{error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("采集历史账号上下文已变化：{error}"))?;
        let mut statement = conn
            .prepare(
                "SELECT id, keywords, count, source_file, created_at
                 FROM crawl_logs
                 WHERE account_pool_id = ?1
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?2",
            )
            .map_err(|error| format!("读取采集历史失败：{error}"))?;
        let rows = statement
            .query_map(params![account_pool_id, limit as i64], |row| {
                Ok(CrawlLogSummary {
                    id: row.get(0)?,
                    keywords: row.get(1)?,
                    count: row.get(2)?,
                    source_file: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|error| format!("读取采集历史失败：{error}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("解析采集历史失败：{error}"))
    }

    /// Return the first 50 keyword batches for the active account, matching
    /// the legacy analytics scan while keeping migrated, unscoped rows private.
    pub fn list_local_crawl_keywords_for_analytics(
        &self,
        account_pool_id: i64,
    ) -> Result<Vec<String>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败：{error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前账号失败：{error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("采集关键词账号上下文已变化：{error}"))?;
        let mut statement = conn
            .prepare(
                "SELECT keywords FROM crawl_logs
                 WHERE account_pool_id = ?1 AND keywords IS NOT NULL
                 ORDER BY id ASC
                 LIMIT 50",
            )
            .map_err(|error| format!("读取采集关键词失败：{error}"))?;
        let rows = statement
            .query_map(params![account_pool_id], |row| row.get(0))
            .map_err(|error| format!("读取采集关键词失败：{error}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("解析采集关键词失败：{error}"))
    }

    pub fn record_local_crawl_log(
        &self,
        account_pool_id: i64,
        keywords: &str,
        count: i64,
        source_file: Option<&str>,
    ) -> Result<i64, String> {
        let keywords = keywords.trim();
        if keywords.is_empty() || keywords.chars().count() > 500 || count < 0 {
            return Err("采集关键词或笔记数量无效".into());
        }
        if source_file.is_some_and(|path| path.chars().count() > 4_000) {
            return Err("采集文件路径超出长度限制".into());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败：{error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前账号失败：{error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("采集记录账号上下文已变化：{error}"))?;
        conn.execute(
            "INSERT INTO crawl_logs (keywords, count, source_file, account_pool_id)
             VALUES (?1, ?2, ?3, ?4)",
            params![keywords, count, source_file, account_pool_id],
        )
        .map_err(|error| format!("保存采集记录失败：{error}"))?;
        Ok(conn.last_insert_rowid())
    }
}
