use super::*;
use std::io::{Read, Seek, SeekFrom};

const MAX_LOCAL_VIDEO_BYTES: u64 = 500 * 1024 * 1024;
const MAX_LOCAL_VIDEO_CHUNK_BYTES: usize = 96 * 1024;

fn local_video_extension(filename: &str, mime_type: &str) -> Result<&'static str, String> {
    use std::path::Path;
    let path = Path::new(filename);
    if filename.is_empty()
        || filename.chars().count() > 255
        || filename.contains('/')
        || filename.contains('\\')
    {
        return Err("视频文件名无效".to_string());
    }
    match (
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        mime_type,
    ) {
        ("mp4", "video/mp4") => Ok("mp4"),
        ("mov", "video/quicktime") => Ok("mov"),
        ("m4v", "video/x-m4v" | "video/mp4") => Ok("m4v"),
        ("webm", "video/webm") => Ok("webm"),
        _ => Err("视频仅支持 MIME 匹配的 MP4、MOV、M4V 或 WebM 文件".to_string()),
    }
}

impl LocalDb {
    fn local_video_account_dir(&self, account_id: i64) -> Result<PathBuf, String> {
        let data_dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        let videos_dir = data_dir.join("videos");
        let account_dir = videos_dir.join(account_id.to_string());
        fs::create_dir_all(&account_dir)
            .map_err(|error| format!("创建视频素材目录失败: {error}"))?;
        let data_canonical = data_dir
            .canonicalize()
            .map_err(|error| format!("解析本地数据目录失败: {error}"))?;
        for directory in [&videos_dir, &account_dir] {
            let metadata = fs::symlink_metadata(directory)
                .map_err(|error| format!("校验视频素材目录失败: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("视频素材目录不能是符号链接".to_string());
            }
        }
        let canonical = account_dir
            .canonicalize()
            .map_err(|error| format!("解析视频素材目录失败: {error}"))?;
        if canonical != data_canonical.join("videos").join(account_id.to_string()) {
            return Err("视频素材目录越出本地数据目录".to_string());
        }
        Ok(canonical)
    }

    /// Stream a user-selected video into an account-owned directory and attach it to a note.
    pub fn import_local_video_chunk(
        &self,
        request: LocalVideoImportChunk,
    ) -> Result<LocalVideoImportResult, String> {
        if request.total_bytes == 0 || request.total_bytes > MAX_LOCAL_VIDEO_BYTES {
            return Err("视频大小必须在 1B 到 500MiB 之间".to_string());
        }
        if request.upload_id.len() != 36
            || !request
                .upload_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        {
            return Err("视频上传 ID 无效".to_string());
        }
        let extension = local_video_extension(&request.filename, &request.mime_type)?;
        let bytes = STANDARD
            .decode(&request.data_base64)
            .map_err(|_| "视频分块编码无效".to_string())?;
        if bytes.is_empty() || bytes.len() > MAX_LOCAL_VIDEO_CHUNK_BYTES {
            return Err("视频分块大小必须在 1B 到 96KiB 之间".to_string());
        }
        if request.offset.saturating_add(bytes.len() as u64) > request.total_bytes
            || request.done != (request.offset + bytes.len() as u64 == request.total_bytes)
        {
            return Err("视频分块范围或完成标记无效".to_string());
        }

        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(request.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let current_version: Option<i64> = conn
            .query_row(
                "SELECT content_version FROM notes
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![request.note_id, active.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取视频目标笔记失败: {error}"))?;
        let Some(current_version) = current_version else {
            return Err("视频目标笔记不存在或不属于当前账号".to_string());
        };
        if current_version != request.expected_version {
            return Err("笔记内容已变化，请刷新后重新选择视频".to_string());
        }

        let account_dir = self.local_video_account_dir(active.id)?;
        let staging_path = account_dir.join(format!(".upload-{}.part", request.upload_id));
        let mut file = if request.offset == 0 {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging_path)
                .map_err(|error| format!("创建视频暂存文件失败: {error}"))?
        } else {
            let metadata = fs::symlink_metadata(&staging_path)
                .map_err(|error| format!("视频暂存已失效，请重新选择: {error}"))?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() != request.offset
            {
                return Err("视频暂存分块偏移不连续或文件无效".to_string());
            }
            OpenOptions::new()
                .write(true)
                .open(&staging_path)
                .map_err(|error| format!("打开视频暂存文件失败: {error}"))?
        };
        file.seek(SeekFrom::Start(request.offset))
            .map_err(|error| format!("定位视频分块失败: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("写入视频暂存分块失败: {error}"))?;
        let received_bytes = request.offset + bytes.len() as u64;
        if !request.done {
            return Ok(LocalVideoImportResult {
                completed: false,
                received_bytes,
                total_bytes: request.total_bytes,
                note: None,
            });
        }
        file.sync_all()
            .map_err(|error| format!("同步视频暂存文件失败: {error}"))?;
        drop(file);

        let metadata = fs::symlink_metadata(&staging_path)
            .map_err(|error| format!("读取视频暂存文件失败: {error}"))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() != request.total_bytes
        {
            return Err("视频暂存文件大小或类型无效".to_string());
        }
        let mut source = fs::File::open(&staging_path)
            .map_err(|error| format!("读取视频暂存文件失败: {error}"))?;
        let mut signature = [0_u8; 16];
        let signature_len = source
            .read(&mut signature)
            .map_err(|error| format!("验证视频格式失败: {error}"))?;
        let signature_valid = match extension {
            "webm" => signature_len >= 4 && signature[..4] == [0x1a, 0x45, 0xdf, 0xa3],
            _ => signature_len >= 12 && &signature[4..8] == b"ftyp",
        };
        if !signature_valid {
            let _ = fs::remove_file(&staging_path);
            return Err("视频内容签名与扩展名不匹配".to_string());
        }
        source
            .rewind()
            .map_err(|error| format!("重读视频暂存文件失败: {error}"))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 128 * 1024];
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|error| format!("计算视频摘要失败: {error}"))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        let digest = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let filename = format!("{digest}.{extension}");
        let stored_path = format!("videos/{}/{filename}", active.id);
        let final_path = account_dir.join(&filename);
        let mut created_final = false;
        match fs::symlink_metadata(&final_path) {
            Ok(existing) if existing.file_type().is_symlink() || !existing.is_file() => {
                let _ = fs::remove_file(&staging_path);
                return Err("视频素材目标不能是符号链接或目录".to_string());
            }
            Ok(existing) if existing.len() != request.total_bytes => {
                let _ = fs::remove_file(&staging_path);
                return Err("同摘要视频文件大小不匹配".to_string());
            }
            Ok(_) => {
                fs::remove_file(&staging_path)
                    .map_err(|error| format!("清理重复视频暂存文件失败: {error}"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::rename(&staging_path, &final_path)
                    .map_err(|error| format!("保存视频素材失败: {error}"))?;
                created_final = true;
            }
            Err(error) => return Err(format!("检查视频素材目标失败: {error}")),
        }

        let tx = conn
            .transaction()
            .map_err(|error| format!("开始关联视频笔记失败: {error}"))?;
        let changed = tx
            .execute(
                "UPDATE notes SET note_type = 'video', video_path = ?1,
                    content_version = content_version + 1,
                    updated_at = datetime('now', 'localtime')
                 WHERE id = ?2 AND account_pool_id = ?3 AND deleted_at IS NULL
                   AND content_version = ?4",
                params![
                    stored_path,
                    request.note_id,
                    active.id,
                    request.expected_version
                ],
            )
            .map_err(|error| format!("保存视频笔记失败: {error}"))?;
        if changed != 1 {
            drop(tx);
            if created_final {
                let _ = fs::remove_file(&final_path);
            }
            return Err("笔记内容已变化，视频没有关联，请刷新后重试".to_string());
        }
        let note = read_note_summary(&tx, request.note_id, active.id)
            .map_err(|error| format!("读取已更新的视频笔记失败: {error}"))?;
        if let Err(error) = tx.commit() {
            if created_final {
                let _ = fs::remove_file(&final_path);
            }
            return Err(format!("提交视频笔记失败: {error}"));
        }
        Ok(LocalVideoImportResult {
            completed: true,
            received_bytes,
            total_bytes: request.total_bytes,
            note: Some(note),
        })
    }

    pub fn abort_local_video_upload(
        &self,
        upload_id: &str,
        expected_account_id: i64,
    ) -> Result<(), String> {
        if upload_id.len() != 36
            || !upload_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        {
            return Err("视频上传 ID 无效".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(expected_account_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let account_dir = self.local_video_account_dir(active.id)?;
        let staging_path = account_dir.join(format!(".upload-{upload_id}.part"));
        match fs::symlink_metadata(&staging_path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                Err("拒绝清理无效的视频暂存路径".to_string())
            }
            Ok(_) => {
                fs::remove_file(&staging_path).map_err(|error| format!("清理视频暂存失败: {error}"))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("检查视频暂存失败: {error}")),
        }
    }

    /// Read one active-account note for CLI operations without the workspace snapshot cap.
    pub fn get_local_note_for_legacy(
        &self,
        note_id: i64,
    ) -> Result<(i64, Option<NoteSummary>), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        let note = conn
            .query_row(
                "SELECT id, item_id, item_ids, title, body, tags, status, note_type,
                        likes, comments, collects, published_at, note_url, account_ref,
                        cover_desc, prompt_used, created_at, updated_at, content_version, deleted_at,
                        video_path
                 FROM notes
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![note_id, active.id],
                note_summary_from_row,
            )
            .optional()
            .map_err(|error| format!("读取笔记失败: {error}"))?;
        Ok((active.id, note))
    }

    /// Query the legacy note list, including its truthy filters and sort order.
    ///
    /// Both the CLI and MCP use this query so their result is not truncated by
    /// the workspace snapshot's UI-oriented 5000-row limit.
    pub fn list_local_notes_for_legacy(
        &self,
        status: Option<&str>,
        item_id: Option<i64>,
    ) -> Result<(i64, Vec<NoteSummary>), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        let status = status.filter(|value| !value.is_empty());
        let item_id = item_id.filter(|value| *value != 0);
        let mut statement = conn
            .prepare(
                "SELECT id, item_id, item_ids, title, body, tags, status, note_type,
                        likes, comments, collects, published_at, note_url, account_ref,
                        cover_desc, prompt_used, created_at, updated_at, content_version, deleted_at,
                        video_path
                 FROM notes
                 WHERE account_pool_id = ?1 AND deleted_at IS NULL
                   AND (?2 IS NULL OR status = ?2)
                   AND (?3 IS NULL OR item_id = ?3)
                 ORDER BY created_at DESC",
            )
            .map_err(|error| format!("查询笔记列表失败: {error}"))?;
        let rows = statement
            .query_map(params![active.id, status, item_id], note_summary_from_row)
            .map_err(|error| format!("读取笔记列表失败: {error}"))?;
        let notes = rows
            .collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("读取笔记列表失败: {error}"))?;
        Ok((active.id, notes))
    }

    /// Read all published note tags in the legacy SQLite row order for analytics.
    pub fn list_local_published_note_tags_for_analytics(
        &self,
        account_pool_id: i64,
    ) -> Result<Vec<Vec<String>>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("笔记统计账号上下文已变化: {error}"))?;
        let mut statement = conn
            .prepare(
                "SELECT tags FROM notes
                 WHERE account_pool_id = ?1 AND status = 'published'
                   AND tags IS NOT NULL AND deleted_at IS NULL
                 ORDER BY id ASC",
            )
            .map_err(|error| format!("读取已发布笔记标签失败: {error}"))?;
        let rows = statement
            .query_map(params![account_pool_id], |row| {
                Ok(parse_json_vec::<String>(row.get(0)?))
            })
            .map_err(|error| format!("读取已发布笔记标签失败: {error}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("解析已发布笔记标签失败: {error}"))
    }

    /// Read all published notes for the legacy analytics ranking without the UI snapshot cap.
    pub fn list_local_published_notes_for_analytics(
        &self,
        account_pool_id: i64,
        sort: &str,
    ) -> Result<Vec<(NoteSummary, Option<String>)>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("笔记统计账号上下文已变化: {error}"))?;
        let order_column = match sort {
            "collects" => "n.collects",
            "comments" => "n.comments",
            _ => "n.likes",
        };
        let sql = format!(
            "SELECT n.id, n.item_id, n.item_ids, n.title, n.body, n.tags, n.status, n.note_type,
                    n.likes, n.comments, n.collects, n.published_at, n.note_url, n.account_ref,
                    n.cover_desc, n.prompt_used, n.created_at, n.updated_at,
                    n.content_version, n.deleted_at, n.video_path, i.image_path
             FROM notes n
             LEFT JOIN items i
               ON i.id = n.item_id AND i.account_pool_id = n.account_pool_id
                  AND i.deleted_at IS NULL
             WHERE n.account_pool_id = ?1 AND n.status = 'published' AND n.deleted_at IS NULL
             ORDER BY {order_column} DESC"
        );
        let mut statement = conn
            .prepare(&sql)
            .map_err(|error| format!("查询已发布笔记排行失败: {error}"))?;
        let rows = statement
            .query_map(params![account_pool_id], |row| {
                Ok((note_summary_from_row(row)?, row.get(21)?))
            })
            .map_err(|error| format!("读取已发布笔记排行失败: {error}"))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("读取已发布笔记排行失败: {error}"))
    }

    /// Create a note using the legacy REST contract while keeping account and asset checks in Rust.
    pub fn create_local_note(&self, input: LocalNoteCreate) -> Result<NoteSummary, String> {
        if input.item_ids.len() > 9 {
            return Err("一篇笔记最多关联 9 张图片".to_string());
        }
        if input
            .title
            .as_deref()
            .is_some_and(|value| value.chars().count() > 200)
        {
            return Err("标题不能超过 200 个字符".to_string());
        }
        if input
            .body
            .as_deref()
            .is_some_and(|value| value.chars().count() > 100_000)
        {
            return Err("正文不能超过 100000 个字符".to_string());
        }
        if input
            .cover_desc
            .as_deref()
            .is_some_and(|value| value.chars().count() > 200)
        {
            return Err("封面文案不能超过 200 个字符".to_string());
        }
        if input
            .prompt_used
            .as_deref()
            .is_some_and(|value| value.chars().count() > 100_000)
        {
            return Err("创作 prompt 超过 100000 个字符".to_string());
        }
        if !matches!(
            input.note_type.as_str(),
            "text" | "image" | "video" | "article"
        ) {
            return Err("不支持的笔记类型".to_string());
        }
        if input
            .video_path
            .as_deref()
            .is_some_and(|value| value.chars().count() > 4096)
        {
            return Err("视频路径不能超过 4096 个字符".to_string());
        }
        if input.video_path.is_some() && input.note_type != "video" {
            return Err("仅视频笔记可以关联视频文件".to_string());
        }

        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始创建笔记失败: {error}"))?;
        for item_id in &input.item_ids {
            let owned: Option<i64> = tx
                .query_row(
                    "SELECT id FROM items WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                    params![item_id, active.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("校验笔记素材失败: {error}"))?;
            if owned.is_none() {
                return Err(format!("素材 {item_id} 不存在或不属于当前账号"));
            }
        }
        let item_ids = serde_json::to_string(&input.item_ids)
            .map_err(|error| format!("序列化笔记素材失败: {error}"))?;
        let tags = serde_json::to_string(&input.tags)
            .map_err(|error| format!("序列化笔记标签失败: {error}"))?;
        tx.execute(
            "INSERT INTO notes
                (item_id, item_ids, account_ref, title, body, tags, status, note_type,
                 cover_desc, prompt_used, account_pool_id, video_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', ?7, ?8, ?9, ?10, ?11)",
            params![
                input.item_ids.first().copied(),
                item_ids,
                input.account_ref,
                input.title,
                input.body,
                tags,
                input.note_type,
                input.cover_desc,
                input.prompt_used,
                active.id,
                input.video_path,
            ],
        )
        .map_err(|error| format!("创建本地笔记失败: {error}"))?;
        let note_id = tx.last_insert_rowid();
        let note = read_note_summary(&tx, note_id, active.id)
            .map_err(|error| format!("读取新建笔记失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交本地笔记失败: {error}"))?;
        Ok(note)
    }

    /// Create a draft with a prompt audit trail from a single account-owned item.
    pub fn create_local_prompt_draft(
        &self,
        item_id: i64,
        account_pool_id: i64,
        account_ref: Option<&str>,
        prompt: &str,
    ) -> Result<NoteSummary, String> {
        if prompt.chars().count() > 100_000 {
            return Err("创作 prompt 超过 100000 个字符".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始创建创作草稿失败: {error}"))?;
        let item_title: Option<String> = tx
            .query_row(
                "SELECT title FROM items
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![item_id, account_pool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取创作素材失败: {error}"))?;
        let Some(item_title) = item_title else {
            return Err("素材不存在或不属于当前账号".to_string());
        };
        tx.execute(
            "INSERT INTO notes (item_id, item_ids, account_ref, title, prompt_used,
                                tags, status, account_pool_id)
             VALUES (?1, ?2, ?3, ?4, ?5, '[]', 'draft', ?6)",
            params![
                item_id,
                serde_json::to_string(&[item_id])
                    .map_err(|error| format!("编码草稿素材失败: {error}"))?,
                account_ref,
                item_title,
                prompt,
                account_pool_id,
            ],
        )
        .map_err(|error| format!("创建创作草稿失败: {error}"))?;
        let note_id = tx.last_insert_rowid();
        let note = read_note_summary(&tx, note_id, account_pool_id)
            .map_err(|error| format!("读取创作草稿失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交创作草稿失败: {error}"))?;
        Ok(note)
    }

    #[cfg(test)]
    pub(super) fn create_local_draft(&self, title: &str) -> SqlResult<NoteSummary> {
        self.create_local_draft_for_account(title, None)
    }

    pub fn create_local_draft_for_account(
        &self,
        title: &str,
        expected_account_id: Option<i64>,
    ) -> SqlResult<NoteSummary> {
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

        let conn = self.connect()?;
        let active = ensure_active_account(&conn, &self.path)?;
        ensure_expected_account(&active, expected_account_id)?;
        conn.execute(
            "INSERT INTO notes (item_id, item_ids, title, tags, status, account_pool_id)
             VALUES (NULL, '[]', ?1, '[]', 'draft', ?2)",
            params![title, active.id],
        )?;
        let note_id = conn.last_insert_rowid();
        conn.query_row(
                "SELECT id, item_id, item_ids, title, body, tags, status, note_type,
                        likes, comments, collects, published_at, note_url, account_ref,
                        cover_desc, prompt_used, created_at, updated_at, content_version, deleted_at,
                        video_path
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
                    video_path: row.get(20)?,
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
                })
            },
        )
    }

    /// 将当前账号笔记移入回收站。关联素材保留，不随笔记删除。
    pub fn delete_local_note(
        &self,
        note_id: i64,
        account_pool_id: i64,
    ) -> Result<NoteSummary, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始笔记回收站事务失败: {error}"))?;
        let deleted_at: Option<String> = tx
            .query_row(
                "SELECT deleted_at FROM notes WHERE id = ?1 AND account_pool_id = ?2",
                params![note_id, active.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取笔记回收站状态失败: {error}"))?
            .flatten();
        if deleted_at.is_some() {
            return Err("笔记已在回收站，未重复删除".to_string());
        }
        let exists: Option<i64> = tx
            .query_row(
                "SELECT id FROM notes WHERE id = ?1 AND account_pool_id = ?2",
                params![note_id, active.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("检查笔记是否存在失败: {error}"))?;
        if exists.is_none() {
            return Err("笔记不存在或不属于当前账号".to_string());
        }
        let changed = tx
            .execute(
                "UPDATE notes SET deleted_at = datetime('now', 'localtime'),
                    updated_at = datetime('now', 'localtime')
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![note_id, active.id],
            )
            .map_err(|error| format!("移入笔记回收站失败: {error}"))?;
        if changed != 1 {
            return Err("笔记已被其他操作删除，未写入".to_string());
        }
        let deleted = read_note_summary(&tx, note_id, active.id)
            .map_err(|error| format!("读取已删除笔记失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交笔记回收站变更失败: {error}"))?;
        Ok(deleted)
    }

    /// 从当前账号笔记回收站恢复笔记；其关联素材不自动恢复。
    pub fn restore_local_note(
        &self,
        note_id: i64,
        account_pool_id: i64,
    ) -> Result<NoteSummary, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let changed = conn
            .execute(
                "UPDATE notes SET deleted_at = NULL,
                    updated_at = datetime('now', 'localtime')
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NOT NULL",
                params![note_id, active.id],
            )
            .map_err(|error| format!("恢复本地笔记失败: {error}"))?;
        if changed != 1 {
            return Err("笔记不在当前账号回收站，未恢复".to_string());
        }
        read_note_summary(&conn, note_id, active.id)
            .map_err(|error| format!("读取已恢复笔记失败: {error}"))
    }

    /// 从当前账号素材原子创建草稿，避免前端先写空笔记再异步补关联。
    pub fn create_local_draft_from_items(
        &self,
        item_ids: &[i64],
        expected_account_id: Option<i64>,
    ) -> Result<NoteSummary, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        drop(conn);
        self.create_local_draft_from_items_for_account(item_ids, active.id)
    }

    /// 按显式账号创建素材草稿（PC Harness 任务链路），不依赖 UI 激活账号。
    pub fn create_local_draft_from_items_for_account(
        &self,
        item_ids: &[i64],
        account_pool_id: i64,
    ) -> Result<NoteSummary, String> {
        self.create_local_draft_from_items_with_prompt(item_ids, account_pool_id, None, None)
    }

    /// Atomically create a composition draft with its account-scoped prompt audit trail.
    pub fn create_local_prompt_draft_from_items(
        &self,
        item_ids: &[i64],
        expected_account_id: i64,
        account_ref: Option<&str>,
        prompt: &str,
    ) -> Result<NoteSummary, String> {
        if prompt.chars().count() > 100_000 {
            return Err("创作 prompt 超过 100000 个字符".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(expected_account_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        drop(conn);
        self.create_local_draft_from_items_with_prompt(
            item_ids,
            expected_account_id,
            account_ref,
            Some(prompt),
        )
    }

    fn create_local_draft_from_items_with_prompt(
        &self,
        item_ids: &[i64],
        account_pool_id: i64,
        account_ref: Option<&str>,
        prompt: Option<&str>,
    ) -> Result<NoteSummary, String> {
        if item_ids.is_empty() || item_ids.len() > 9 {
            return Err("草稿需要关联 1 到 9 张素材".to_string());
        }
        if account_ref.is_some_and(|value| value.chars().count() > 200) {
            return Err("榜样账号标识不能超过 200 个字符".to_string());
        }
        if prompt.is_some_and(|value| value.chars().count() > 100_000) {
            return Err("创作 prompt 超过 100000 个字符".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始创建素材草稿失败: {error}"))?;
        for item_id in item_ids {
            let owned: Option<i64> = tx
                .query_row(
                    "SELECT id FROM items WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                    params![item_id, account_pool_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("校验草稿素材失败: {error}"))?;
            if owned.is_none() {
                return Err(format!("素材 {item_id} 不存在或不属于目标账号"));
            }
        }
        let item_ids_json = serde_json::to_string(item_ids)
            .map_err(|error| format!("序列化草稿素材失败: {error}"))?;
        let first_title: String = tx
            .query_row(
                "SELECT title FROM items WHERE id = ?1 AND account_pool_id = ?2",
                params![item_ids[0], account_pool_id],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| "素材草稿".to_string());
        tx.execute(
            "INSERT INTO notes (item_id, item_ids, account_ref, title, prompt_used,
                                tags, status, account_pool_id)
             VALUES (?1, ?2, ?3, ?4, ?5, '[]', 'draft', ?6)",
            params![
                item_ids[0],
                item_ids_json,
                account_ref,
                first_title,
                prompt,
                account_pool_id
            ],
        )
        .map_err(|error| format!("写入素材草稿失败: {error}"))?;
        let note_id = tx.last_insert_rowid();
        let note = read_note_summary(&tx, note_id, account_pool_id)
            .map_err(|error| format!("读取素材草稿失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交素材草稿失败: {error}"))?;
        Ok(note)
    }

    /// 按显式账号创建纯文字草稿（无素材时的主题种子稿件）。
    pub fn create_local_draft_for_account_id(
        &self,
        title: &str,
        account_pool_id: i64,
    ) -> Result<NoteSummary, String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("草稿标题不能为空".to_string());
        }
        if title.chars().count() > 200 {
            return Err("草稿标题不能超过 200 个字符".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        conn.execute(
            "INSERT INTO notes (item_id, item_ids, title, tags, status, account_pool_id)
             VALUES (NULL, '[]', ?1, '[]', 'draft', ?2)",
            params![title, account_pool_id],
        )
        .map_err(|error| format!("创建本地草稿失败: {error}"))?;
        let note_id = conn.last_insert_rowid();
        read_note_summary(&conn, note_id, account_pool_id)
            .map_err(|error| format!("读取本地草稿失败: {error}"))
    }

    /// 更新指定账号下的笔记正文/标题/标签（Companion 稿件种子）。
    pub fn update_local_note_for_account(
        &self,
        account_pool_id: i64,
        note_id: i64,
        title: &str,
        body: &str,
        tags: &[String],
        item_ids: &[i64],
    ) -> Result<NoteSummary, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let tags_json =
            serde_json::to_string(tags).map_err(|error| format!("序列化标签失败: {error}"))?;
        let item_ids_json = serde_json::to_string(item_ids)
            .map_err(|error| format!("序列化素材列表失败: {error}"))?;
        let now = local_timestamp();
        conn.execute(
            "UPDATE notes
             SET title = ?2, body = ?3, tags = ?4, item_ids = ?5,
                 item_id = ?6, updated_at = ?7, content_version = content_version + 1
             WHERE id = ?1 AND account_pool_id = ?8 AND deleted_at IS NULL",
            params![
                note_id,
                title,
                body,
                tags_json,
                item_ids_json,
                item_ids.first().copied(),
                now,
                account_pool_id
            ],
        )
        .map_err(|error| format!("保存 Companion 草稿失败: {error}"))?;
        read_note_summary(&conn, note_id, account_pool_id)
            .map_err(|error| format!("读取 Companion 草稿失败: {error}"))
    }

    /// 原子更新本地笔记编辑字段。expected_version 用于阻止旧编辑器回执覆盖新版本。
    pub fn update_local_note(&self, update: LocalNoteUpdate) -> Result<NoteSummary, String> {
        self.update_local_note_with_cover(update, None)
    }

    /// Update the legacy cover-copy field alongside the regular edit fields.
    /// Existing Tauri callers keep their current contract through
    /// `update_local_note`; CLI/HTTP adapters can opt into the complete field set.
    pub fn update_local_note_with_cover(
        &self,
        update: LocalNoteUpdate,
        cover_desc: Option<String>,
    ) -> Result<NoteSummary, String> {
        let title = update.title.trim();
        if title.chars().count() > 200 {
            return Err("标题不能超过 200 个字符".to_string());
        }
        if !matches!(
            update.note_type.as_str(),
            "text" | "image" | "video" | "article"
        ) {
            return Err("不支持的笔记类型".to_string());
        }
        if update
            .video_path
            .as_deref()
            .is_some_and(|value| value.chars().count() > 4096)
        {
            return Err("视频路径不能超过 4096 个字符".to_string());
        }
        if update.video_path.is_some() && update.note_type != "video" {
            return Err("仅视频笔记可以关联视频文件".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(update.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;

        let tx = conn
            .transaction()
            .map_err(|error| format!("开始本地笔记保存失败: {error}"))?;
        let (current_version, current_item_ids_raw): (i64, Option<String>) = tx
            .query_row(
                "SELECT content_version, item_ids FROM notes
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![update.note_id, active.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("读取本地笔记版本失败: {error}"))?
            .ok_or_else(|| "笔记不存在或不属于当前账号".to_string())?;
        let current_item_ids: Vec<i64> = parse_json_vec(current_item_ids_raw);
        if update.item_ids.len() > 9 && update.item_ids != current_item_ids {
            return Err("一篇笔记最多关联 9 张图片；请先移除历史超限素材".to_string());
        }
        if current_version != update.expected_version {
            return Err(format!(
                "笔记版本冲突：当前为 {current_version}，保存请求为 {}，请刷新后重试",
                update.expected_version
            ));
        }

        for item_id in &update.item_ids {
            let owned: Option<i64> = tx
                .query_row(
                    "SELECT id FROM items
                     WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                    params![item_id, active.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("校验关联素材失败: {error}"))?;
            if owned.is_none() {
                return Err(format!("素材 {item_id} 不存在或不属于当前账号"));
            }
        }

        let tags = serde_json::to_string(&update.tags)
            .map_err(|error| format!("序列化笔记标签失败: {error}"))?;
        let item_ids = serde_json::to_string(&update.item_ids)
            .map_err(|error| format!("序列化关联素材失败: {error}"))?;
        if cover_desc
            .as_deref()
            .is_some_and(|value| value.chars().count() > 200)
        {
            return Err("封面文案不能超过 200 个字符".to_string());
        }
        let primary_item_id = update.item_ids.first().copied();
        let changed = tx
            .execute(
                "UPDATE notes SET title = ?1, body = ?2, tags = ?3,
                    note_type = ?4, item_id = ?5, item_ids = ?6,
                    cover_desc = COALESCE(?7, cover_desc),
                    video_path = CASE WHEN ?4 = 'video' THEN COALESCE(?8, video_path) ELSE NULL END,
                    content_version = content_version + 1,
                    updated_at = datetime('now', 'localtime')
                 WHERE id = ?9 AND account_pool_id = ?10 AND deleted_at IS NULL
                   AND content_version = ?11",
                params![
                    title,
                    update.body,
                    tags,
                    update.note_type,
                    primary_item_id,
                    item_ids,
                    cover_desc,
                    update.video_path,
                    update.note_id,
                    active.id,
                    update.expected_version,
                ],
            )
            .map_err(|error| format!("保存本地笔记失败: {error}"))?;
        if changed != 1 {
            return Err("笔记版本冲突，保存未写入，请刷新后重试".to_string());
        }
        let updated = read_note_summary(&tx, update.note_id, active.id)
            .map_err(|error| format!("读取已保存笔记失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交本地笔记失败: {error}"))?;
        Ok(updated)
    }

    /// Preserve the legacy MCP save_note behavior when the caller submits no editable fields.
    pub fn touch_local_note_for_account(
        &self,
        note_id: i64,
        account_pool_id: i64,
    ) -> Result<NoteSummary, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始本地笔记保存失败: {error}"))?;
        let changed = tx
            .execute(
                "UPDATE notes SET updated_at = datetime('now', 'localtime')
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![note_id, active.id],
            )
            .map_err(|error| format!("保存本地笔记失败: {error}"))?;
        if changed != 1 {
            return Err("笔记不存在或不属于当前账号".to_string());
        }
        let note = read_note_summary(&tx, note_id, active.id)
            .map_err(|error| format!("读取已保存笔记失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交本地笔记失败: {error}"))?;
        Ok(note)
    }

    /// 原子更新本地笔记状态，保留 draft/ready/published 旧语义并参与版本校验。
    pub fn update_local_note_status(
        &self,
        update: LocalNoteStatusUpdate,
    ) -> Result<NoteSummary, String> {
        if !matches!(update.status.as_str(), "draft" | "ready" | "published") {
            return Err("status 必须是 draft / ready / published".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(update.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始本地状态保存失败: {error}"))?;
        let changed = tx
            .execute(
                "UPDATE notes SET status = ?1, note_url = COALESCE(?2, note_url),
                    content_version = content_version + 1,
                    updated_at = datetime('now', 'localtime')
                 WHERE id = ?3 AND account_pool_id = ?4 AND deleted_at IS NULL
                   AND content_version = ?5",
                params![
                    update.status,
                    update.note_url,
                    update.note_id,
                    active.id,
                    update.expected_version,
                ],
            )
            .map_err(|error| format!("保存本地笔记状态失败: {error}"))?;
        if changed != 1 {
            return Err("笔记不存在或版本冲突，状态未写入".to_string());
        }
        let updated = read_note_summary(&tx, update.note_id, active.id)
            .map_err(|error| format!("读取已保存笔记状态失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交本地笔记状态失败: {error}"))?;
        Ok(updated)
    }

    /// 将当前笔记的不可变发布快照写入本地 outbox。该操作只准备本地记录，永远不触发平台提交。
    /// 对同一快照，submitted/confirmed/unknown 都会阻止再次准备，避免断线后自动重复发布。
    pub fn prepare_local_publish(
        &self,
        input: LocalPublishOutboxPrepare,
    ) -> Result<PublishOutboxSummary, String> {
        validate_publish_outbox_prepare(&input)?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;

        let note_version: Option<i64> = conn
            .query_row(
                "SELECT content_version FROM notes
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![input.note_id, active.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取发布笔记版本失败: {error}"))?;
        let note_version = note_version.ok_or_else(|| "笔记不存在或不属于当前账号".to_string())?;
        if note_version != input.content_version {
            return Err(format!(
                "发布快照版本过期：当前为 {note_version}，请求为 {}，请重新准备",
                input.content_version
            ));
        }

        if let Some(existing) = read_publish_outbox_by_id(&conn, &input.attempt_id)
            .map_err(|error| format!("读取发布准备记录失败: {error}"))?
        {
            if existing.account_pool_id != active.id {
                return Err("发布准备记录不属于当前账号".to_string());
            }
            return Ok(existing);
        }

        let previous: Option<PublishOutboxSummary> = conn
            .query_row(
                "SELECT attempt_id, account_pool_id, note_id, snapshot_key,
                        content_version, snapshot_json, status, platform_url, error,
                        fill_status, fill_expires_at, fill_result_json, created_at, updated_at
                 FROM publish_outbox
                 WHERE account_pool_id = ?1 AND snapshot_key = ?2
                 ORDER BY rowid DESC LIMIT 1",
                params![active.id, input.snapshot_key],
                publish_outbox_from_row,
            )
            .optional()
            .map_err(|error| format!("读取同快照发布状态失败: {error}"))?;
        if let Some(previous) = previous {
            match previous.status.as_str() {
                "submitted" | "confirmed" | "unknown" => return Ok(previous),
                "prepared" => return Ok(previous),
                "failed" => {}
                _ => return Err("发布准备记录状态无效".to_string()),
            }
        }

        conn.execute(
            "INSERT INTO publish_outbox (
                attempt_id, account_pool_id, note_id, snapshot_key, content_version,
                snapshot_json, status, platform_url, error, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared', NULL, NULL,
                       datetime('now', 'localtime'), datetime('now', 'localtime'))",
            params![
                input.attempt_id,
                active.id,
                input.note_id,
                input.snapshot_key,
                input.content_version,
                input.snapshot_json,
            ],
        )
        .map_err(|error| format!("保存发布准备记录失败: {error}"))?;
        read_publish_outbox_by_id(&conn, &input.attempt_id)
            .map_err(|error| format!("读取发布准备结果失败: {error}"))?
            .ok_or_else(|| "发布准备记录写入后无法读取".to_string())
    }

    /// 更新本地 outbox 状态，仅记录平台外部动作结果，不执行任何平台请求。
    pub fn update_local_publish(
        &self,
        input: LocalPublishOutboxUpdate,
    ) -> Result<PublishOutboxSummary, String> {
        validate_publish_outbox_update(&input)?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let current = read_publish_outbox_by_id(&conn, &input.attempt_id)
            .map_err(|error| format!("读取发布记录失败: {error}"))?
            .ok_or_else(|| "发布准备记录不存在".to_string())?;
        if current.account_pool_id != active.id {
            return Err("发布准备记录不属于当前账号".to_string());
        }
        if !valid_publish_transition(&current.status, &input.status) {
            return Err(format!(
                "不允许将发布状态从 {} 改为 {}",
                current.status, input.status
            ));
        }
        if matches!(input.status.as_str(), "submitted" | "confirmed") {
            let duplicate: Option<String> = conn
                .query_row(
                    "SELECT attempt_id FROM publish_outbox
                     WHERE account_pool_id = ?1 AND snapshot_key = ?2
                       AND attempt_id <> ?3 AND status IN ('submitted', 'confirmed')
                     LIMIT 1",
                    params![active.id, current.snapshot_key, input.attempt_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("检查重复发布状态失败: {error}"))?;
            if duplicate.is_some() {
                return Err("该快照已有提交或确认记录，禁止重复提交".to_string());
            }
        }
        conn.execute(
            "UPDATE publish_outbox SET status = ?1, platform_url = COALESCE(?2, platform_url),
                error = ?3, updated_at = datetime('now', 'localtime')
             WHERE attempt_id = ?4 AND account_pool_id = ?5",
            params![
                input.status,
                input.platform_url,
                input.error,
                input.attempt_id,
                active.id,
            ],
        )
        .map_err(|error| format!("更新发布结果失败: {error}"))?;
        read_publish_outbox_by_id(&conn, &input.attempt_id)
            .map_err(|error| format!("读取更新后的发布结果失败: {error}"))?
            .ok_or_else(|| "发布结果写入后无法读取".to_string())
    }

    /// 读取当前账号的发布 outbox，供发布页恢复上次准备、失败或待核查状态。
    pub fn local_publish_outbox(
        &self,
        expected_account_id: Option<i64>,
        note_id: Option<i64>,
    ) -> Result<Vec<PublishOutboxSummary>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let mut statement = conn
            .prepare(
                "SELECT attempt_id, account_pool_id, note_id, snapshot_key,
                        content_version, snapshot_json, status, platform_url, error,
                        fill_status, fill_expires_at, fill_result_json, created_at, updated_at
                 FROM publish_outbox
                 WHERE account_pool_id = ?1 AND (?2 IS NULL OR note_id = ?2)
                 ORDER BY updated_at DESC, rowid DESC
                 LIMIT 500",
            )
            .map_err(|error| format!("读取发布历史失败: {error}"))?;
        let result = statement
            .query_map(params![active.id, note_id], publish_outbox_from_row)
            .map_err(|error| format!("读取发布历史失败: {error}"))?
            .collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("解析发布历史失败: {error}"));
        result
    }

    /// 笔记的发布图片暂存目录，位于数据库同级的 publish_staging/{note_id}。
    /// 只由本层根据账号归属的笔记计算，不接受前端传入的任意路径。
    fn publish_stage_dir(&self, note_id: i64) -> PathBuf {
        let data_dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        data_dir.join("publish_staging").join(note_id.to_string())
    }

    /// 校验笔记属于当前账号后返回其暂存目录路径，供宿主在文件管理器中打开。
    pub fn local_note_stage_dir(
        &self,
        note_id: i64,
        expected_account_id: Option<i64>,
    ) -> Result<PathBuf, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let exists: Option<i64> = conn
            .query_row(
                "SELECT id FROM notes WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![note_id, active.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取发布笔记失败: {error}"))?;
        if exists.is_none() {
            return Err("笔记不存在或不属于当前账号".to_string());
        }
        Ok(self.publish_stage_dir(note_id))
    }

    /// Read one file from an account-owned publish staging directory. The
    /// filename is restricted to a single regular file inside that directory.
    pub fn local_note_stage_image_bytes(
        &self,
        note_id: i64,
        expected_account_id: Option<i64>,
        filename: &str,
    ) -> Result<Vec<u8>, String> {
        if filename.is_empty()
            || filename == "."
            || filename == ".."
            || filename.contains('/')
            || filename.contains('\\')
        {
            return Err("暂存图片文件名无效".to_string());
        }
        let stage_dir = self.local_note_stage_dir(note_id, expected_account_id)?;
        let stage_root = stage_dir
            .parent()
            .ok_or_else(|| "暂存目录路径无效".to_string())?;
        let root_metadata = fs::symlink_metadata(stage_root)
            .map_err(|_| "暂存目录不存在，请先准备图片".to_string())?;
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            return Err("暂存根目录路径无效".to_string());
        }
        let canonical_stage_root = stage_root
            .canonicalize()
            .map_err(|error| format!("读取暂存根目录失败: {error}"))?;
        let canonical_stage_dir = stage_dir
            .canonicalize()
            .map_err(|_| "暂存目录不存在，请先准备图片".to_string())?;
        if canonical_stage_dir.parent() != Some(canonical_stage_root.as_path()) {
            return Err("暂存目录路径超出根目录范围".to_string());
        }
        let image_path = stage_dir.join(filename);
        let metadata = fs::symlink_metadata(&image_path)
            .map_err(|_| "暂存图片不存在，请先准备图片".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("暂存图片路径无效".to_string());
        }
        if metadata.len() > 50 * 1024 * 1024 {
            return Err("暂存图片超过 50 MiB 限制".to_string());
        }
        let canonical_image = image_path
            .canonicalize()
            .map_err(|error| format!("读取暂存图片路径失败: {error}"))?;
        if canonical_image.parent() != Some(canonical_stage_dir.as_path()) {
            return Err("暂存图片路径超出目录范围".to_string());
        }
        fs::read(canonical_image).map_err(|error| format!("读取暂存图片失败: {error}"))
    }

    /// 把笔记关联素材按上传顺序复制到本地暂存目录，文件名带序号前缀，
    /// 供用户按编号手动拖拽上传；不访问平台、不修改素材库。
    pub fn stage_local_note_images(
        &self,
        note_id: i64,
        expected_account_id: Option<i64>,
    ) -> Result<StagedImagesSummary, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;

        let association: Option<(Option<i64>, Option<String>)> = conn
            .query_row(
                "SELECT item_id, item_ids FROM notes
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![note_id, active.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("读取笔记素材关联失败: {error}"))?;
        let Some((primary_item_id, item_ids_json)) = association else {
            return Err("笔记不存在或不属于当前账号".to_string());
        };
        let mut item_ids = parse_json_vec::<i64>(item_ids_json);
        if item_ids.is_empty() {
            if let Some(item_id) = primary_item_id {
                item_ids.push(item_id);
            }
        }

        let stage_dir = self.publish_stage_dir(note_id);
        // 每次准备都重建暂存目录，避免上一次更多图片时的残留文件混入本次上传。
        if stage_dir.exists() {
            fs::remove_dir_all(&stage_dir).map_err(|error| {
                format!("清理旧暂存目录失败（{}）: {error}", stage_dir.display())
            })?;
        }
        fs::create_dir_all(&stage_dir)
            .map_err(|error| format!("创建暂存目录失败（{}）: {error}", stage_dir.display()))?;

        let mut files = Vec::new();
        for item_id in item_ids {
            let record: Option<(Option<String>, String)> = conn
                .query_row(
                    "SELECT title, image_path FROM items
                     WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                    params![item_id, active.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| format!("读取暂存素材失败: {error}"))?;
            let Some((title, stored_path)) = record else {
                continue;
            };
            let source = self.resolve_image_path(&stored_path);
            if !source.is_file() {
                continue;
            }
            let source_name = source
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or("image");
            // 序号前缀保证 Finder 按文件名排序即上传顺序。
            let index = files.len() as i64 + 1;
            let filename = format!("{index:02}_{source_name}");
            fs::copy(&source, stage_dir.join(&filename)).map_err(|error| {
                format!(
                    "复制暂存图片失败（{} → {}）: {error}",
                    source.display(),
                    filename
                )
            })?;
            files.push(StagedImageFile {
                index,
                filename,
                item_id,
                title: title.unwrap_or_default(),
            });
        }

        Ok(StagedImagesSummary {
            note_id,
            stage_dir: stage_dir.display().to_string(),
            files,
        })
    }

    /// 确认发布后清理笔记暂存目录；目录不存在时视为已清理。
    pub fn clear_local_note_stage(
        &self,
        note_id: i64,
        expected_account_id: Option<i64>,
    ) -> Result<(), String> {
        let stage_dir = self.local_note_stage_dir(note_id, expected_account_id)?;
        if stage_dir.exists() {
            fs::remove_dir_all(&stage_dir)
                .map_err(|error| format!("清理暂存目录失败（{}）: {error}", stage_dir.display()))?;
        }
        Ok(())
    }

    /// 原子更新本地笔记的素材关联顺序，复用笔记版本和账号归属校验。
    pub fn update_local_note_items(
        &self,
        update: LocalNoteItemsUpdate,
    ) -> Result<NoteSummary, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(update.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始本地素材关联保存失败: {error}"))?;
        let (current_version, current_item_ids_raw): (i64, Option<String>) = tx
            .query_row(
                "SELECT content_version, item_ids FROM notes
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![update.note_id, active.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("读取本地笔记版本失败: {error}"))?
            .ok_or_else(|| "笔记不存在或不属于当前账号".to_string())?;
        let current_item_ids: Vec<i64> = parse_json_vec(current_item_ids_raw);
        if update.item_ids.len() > 9 && update.item_ids != current_item_ids {
            return Err("一篇笔记最多关联 9 张图片；请先移除历史超限素材".to_string());
        }
        if current_version != update.expected_version {
            return Err(format!(
                "笔记版本冲突：当前为 {current_version}，保存请求为 {}，请刷新后重试",
                update.expected_version
            ));
        }
        for item_id in &update.item_ids {
            let owned: Option<i64> = tx
                .query_row(
                    "SELECT id FROM items
                     WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                    params![item_id, active.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("校验关联素材失败: {error}"))?;
            if owned.is_none() {
                return Err(format!("素材 {item_id} 不存在或不属于当前账号"));
            }
        }
        let item_ids = serde_json::to_string(&update.item_ids)
            .map_err(|error| format!("序列化关联素材失败: {error}"))?;
        let changed = tx
            .execute(
                "UPDATE notes SET item_id = ?1, item_ids = ?2,
                    content_version = content_version + 1,
                    updated_at = datetime('now', 'localtime')
                 WHERE id = ?3 AND account_pool_id = ?4 AND deleted_at IS NULL
                   AND content_version = ?5",
                params![
                    update.item_ids.first().copied(),
                    item_ids,
                    update.note_id,
                    active.id,
                    update.expected_version,
                ],
            )
            .map_err(|error| format!("保存本地素材关联失败: {error}"))?;
        if changed != 1 {
            return Err("笔记版本冲突，素材关联未写入，请刷新后重试".to_string());
        }
        let updated = read_note_summary(&tx, update.note_id, active.id)
            .map_err(|error| format!("读取已保存素材关联失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交本地素材关联失败: {error}"))?;
        Ok(updated)
    }

    /// 更新当前账号笔记的互动统计。字段白名单和版本校验避免旧页面覆盖新数据。
    pub fn update_local_note_stats(
        &self,
        input: LocalNoteStatsUpdate,
    ) -> Result<NoteSummary, String> {
        if input.value < 0 {
            return Err("互动数据不能为负数".to_string());
        }
        let column = match input.field.as_str() {
            "likes" | "comments" | "collects" => input.field.as_str(),
            _ => return Err("不支持的互动数据字段".to_string()),
        };
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始本地互动数据保存失败: {error}"))?;
        let current_version: i64 = tx
            .query_row(
                "SELECT content_version FROM notes
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![input.note_id, active.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取本地笔记版本失败: {error}"))?
            .ok_or_else(|| "笔记不存在或不属于当前账号".to_string())?;
        if current_version != input.expected_version {
            return Err(format!(
                "笔记版本冲突：当前为 {current_version}，保存请求为 {}，请刷新后重试",
                input.expected_version
            ));
        }
        let sql = format!(
            "UPDATE notes SET {column} = ?1, content_version = content_version + 1,
             updated_at = datetime('now', 'localtime')
             WHERE id = ?2 AND account_pool_id = ?3 AND deleted_at IS NULL
               AND content_version = ?4"
        );
        let changed = tx
            .execute(
                &sql,
                params![
                    input.value,
                    input.note_id,
                    active.id,
                    input.expected_version
                ],
            )
            .map_err(|error| format!("保存本地互动数据失败: {error}"))?;
        if changed != 1 {
            return Err("笔记版本冲突，互动数据未写入，请刷新后重试".to_string());
        }
        let updated = read_note_summary(&tx, input.note_id, active.id)
            .map_err(|error| format!("读取已保存互动数据失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交本地互动数据失败: {error}"))?;
        Ok(updated)
    }
}
