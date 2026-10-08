use super::*;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const MAX_CAPTURE_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_CAPTURE_COLLECTION_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CAPTURE_IMAGE_CHUNK_BYTES: usize = 64 * 1024;

struct CaptureImageUploadState {
    total_bytes: usize,
    sha256: String,
    mime_type: String,
    next_offset: usize,
    temp_name: String,
}

fn read_capture_image_upload(
    conn: &Connection,
    id: &str,
    account_pool_id: i64,
    position: i64,
    request_id: &str,
) -> Result<CaptureImageUploadState, String> {
    conn.query_row(
        "SELECT total_bytes, sha256, mime_type, next_offset, temp_name
         FROM inspiration_image_uploads
         WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = ?3 AND request_id = ?4",
        params![account_pool_id, id.trim(), position, request_id.trim()],
        |row| {
            Ok(CaptureImageUploadState {
                total_bytes: row.get::<_, i64>(0)?.max(0) as usize,
                sha256: row.get(1)?,
                mime_type: row.get(2)?,
                next_offset: row.get::<_, i64>(3)?.max(0) as usize,
                temp_name: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("读取剪藏图片续传状态失败: {error}"))?
    .ok_or_else(|| "剪藏图片续传状态不存在或 requestId 不匹配".to_string())
}

impl LocalDb {
    pub fn begin_browser_capture_image_upload(
        &self,
        input: BrowserCaptureImageUploadStart<'_>,
    ) -> Result<BrowserCaptureImageUploadProgress, String> {
        let BrowserCaptureImageUploadStart {
            id,
            account_pool_id,
            position,
            request_id,
            total_bytes,
            sha256,
            mime_type,
        } = input;
        if id.trim().is_empty()
            || id.len() > 120
            || request_id.trim().is_empty()
            || request_id.len() > 128
            || request_id.chars().any(char::is_control)
            || !(0..12).contains(&position)
            || total_bytes == 0
            || total_bytes > MAX_CAPTURE_IMAGE_BYTES
            || sha256.len() != 64
            || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !matches!(
                mime_type,
                "image/jpeg" | "image/png" | "image/gif" | "image/webp"
            )
        {
            return Err("剪藏图片上传参数无效".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("开启剪藏图片上传事务失败: {error}"))?;
        ensure_capture_account(&tx, account_pool_id)
            .map_err(|error| format!("剪藏目标账号不可用: {error}"))?;
        let image = tx.query_row(
            "SELECT source_url, status, request_id, sha256 FROM inspiration_images
             WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = ?3
               AND EXISTS (SELECT 1 FROM inspirations i WHERE i.id = ?2 AND i.account_pool_id = ?1 AND i.saved = 1)",
            params![account_pool_id, id.trim(), position],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?)),
        ).optional().map_err(|error| format!("读取剪藏图片上传目标失败: {error}"))?
            .ok_or_else(|| "剪藏图片不存在或不属于当前账号".to_string())?;
        if image.2.as_deref() != Some(request_id.trim()) {
            return Err("图片上传 requestId 与原剪藏不匹配，拒绝跨请求写入".to_string());
        }
        if image.1 == "ready" {
            if image.3.as_deref() == Some(sha256) {
                tx.commit()
                    .map_err(|error| format!("提交剪藏图片上传状态失败: {error}"))?;
                return Ok(BrowserCaptureImageUploadProgress {
                    next_offset: total_bytes,
                    total_bytes,
                    already_ready: true,
                });
            }
            return Err("这张剪藏图片已保存为其他内容，拒绝覆盖；请用新的剪藏请求更新".to_string());
        }
        let ready_bytes: i64 = tx.query_row(
            "SELECT COALESCE(SUM(byte_size), 0) FROM inspiration_images
             WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND status = 'ready' AND position <> ?3",
            params![account_pool_id, id.trim(), position], |row| row.get(0),
        ).map_err(|error| format!("核算剪藏图片总量失败: {error}"))?;
        if (ready_bytes.max(0) as u64).saturating_add(total_bytes as u64)
            > MAX_CAPTURE_COLLECTION_BYTES
        {
            return Err("这条剪藏的本地图片总量不能超过 32MB".to_string());
        }
        let digest = Sha256::digest(
            format!(
                "{}\n{}\n{}\n{}",
                account_pool_id,
                id.trim(),
                request_id.trim(),
                position
            )
            .as_bytes(),
        );
        let temp_stem = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let temp_name = format!("{temp_stem}.part");
        let existing = tx.query_row(
            "SELECT total_bytes, sha256, mime_type, next_offset, temp_name
             FROM inspiration_image_uploads
             WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = ?3 AND request_id = ?4",
            params![account_pool_id, id.trim(), position, request_id.trim()],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?)),
        ).optional().map_err(|error| format!("读取剪藏图片续传状态失败: {error}"))?;
        let (next_offset, temp_name) = if let Some((
            saved_total,
            saved_sha,
            saved_mime,
            saved_offset,
            saved_name,
        )) = existing
        {
            if saved_total != total_bytes as i64
                || saved_sha != sha256.to_ascii_lowercase()
                || saved_mime != mime_type
            {
                return Err("同一剪藏 requestId 的图片字节摘要已变化，拒绝覆盖续传".to_string());
            }
            (saved_offset.max(0) as usize, saved_name)
        } else {
            tx.execute(
                "INSERT INTO inspiration_image_uploads
                   (account_pool_id, inspiration_id, position, request_id, total_bytes, sha256, mime_type, next_offset, temp_name)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)",
                params![account_pool_id, id.trim(), position, request_id.trim(), total_bytes as i64, sha256.to_ascii_lowercase(), mime_type, temp_name],
            ).map_err(|error| format!("登记剪藏图片上传失败: {error}"))?;
            tx.execute(
                "UPDATE inspiration_images SET source_kind = 'extension_bytes', status = 'downloading', error = NULL, updated_at = datetime('now', 'localtime')
                 WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = ?3 AND status IN ('pending', 'failed', 'downloading')",
                params![account_pool_id, id.trim(), position],
            ).map_err(|error| format!("标记剪藏图片传输状态失败: {error}"))?;
            (0, temp_name.clone())
        };
        tx.commit()
            .map_err(|error| format!("提交剪藏图片上传事务失败: {error}"))?;
        let temp_path = self.capture_image_upload_path(account_pool_id, &temp_name)?;
        if let Some(parent) = temp_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建剪藏图片暂存目录失败: {error}"))?;
            #[cfg(unix)]
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("保护剪藏图片暂存目录失败: {error}"))?;
        }
        if temp_path.exists() {
            let size = fs::metadata(&temp_path)
                .map_err(|error| format!("读取剪藏图片续传文件失败: {error}"))?
                .len() as usize;
            if size > next_offset {
                OpenOptions::new()
                    .write(true)
                    .open(&temp_path)
                    .and_then(|file| file.set_len(next_offset as u64))
                    .map_err(|error| format!("恢复剪藏图片续传位置失败: {error}"))?;
            } else if size < next_offset {
                return Err("剪藏图片续传文件不完整；请按原 requestId 重新获取图片".to_string());
            }
        } else if next_offset > 0 {
            return Err("剪藏图片续传文件已丢失；请按原 requestId 重新获取图片".to_string());
        }
        let _ = image.0;
        Ok(BrowserCaptureImageUploadProgress {
            next_offset,
            total_bytes,
            already_ready: false,
        })
    }

    pub fn append_browser_capture_image_upload_chunk(
        &self,
        id: &str,
        account_pool_id: i64,
        position: i64,
        request_id: &str,
        offset: usize,
        bytes: &[u8],
    ) -> Result<BrowserCaptureImageUploadProgress, String> {
        if bytes.is_empty()
            || bytes.len() > MAX_CAPTURE_IMAGE_CHUNK_BYTES
            || !(0..12).contains(&position)
        {
            return Err("剪藏图片分块大小或序号无效".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("剪藏目标账号不可用: {error}"))?;
        let upload = read_capture_image_upload(&conn, id, account_pool_id, position, request_id)?;
        if offset.saturating_add(bytes.len()) > upload.total_bytes {
            return Err("剪藏图片分块超过申报长度".to_string());
        }
        let path = self.capture_image_upload_path(account_pool_id, &upload.temp_name)?;
        if offset < upload.next_offset {
            if offset.saturating_add(bytes.len()) > upload.next_offset {
                return Err(format!(
                    "剪藏图片续传位置不匹配；下一分块从 {} 开始",
                    upload.next_offset
                ));
            }
            let mut file = OpenOptions::new()
                .read(true)
                .open(&path)
                .map_err(|error| format!("读取剪藏图片续传分块失败: {error}"))?;
            file.seek(SeekFrom::Start(offset as u64))
                .map_err(|error| format!("定位剪藏图片续传分块失败: {error}"))?;
            let mut saved = vec![0; bytes.len()];
            file.read_exact(&mut saved)
                .map_err(|error| format!("读取已接收的剪藏图片分块失败: {error}"))?;
            if saved != bytes {
                return Err("重复分块内容与已接收字节不一致".to_string());
            }
            return Ok(BrowserCaptureImageUploadProgress {
                next_offset: upload.next_offset,
                total_bytes: upload.total_bytes,
                already_ready: false,
            });
        }
        if offset != upload.next_offset {
            return Err(format!(
                "剪藏图片续传位置不匹配；下一分块从 {} 开始",
                upload.next_offset
            ));
        }
        let mut options = OpenOptions::new();
        options.write(true).create(true);
        #[cfg(unix)]
        options.mode(0o600);
        if offset == 0 {
            options.truncate(true);
        }
        let mut file = options
            .open(&path)
            .map_err(|error| format!("打开剪藏图片暂存文件失败: {error}"))?;
        file.seek(SeekFrom::Start(offset as u64))
            .map_err(|error| format!("定位剪藏图片暂存文件失败: {error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_data())
            .map_err(|error| format!("写入剪藏图片分块失败: {error}"))?;
        let next_offset = offset + bytes.len();
        let changed = conn.execute(
            "UPDATE inspiration_image_uploads SET next_offset = ?1, updated_at = datetime('now', 'localtime')
             WHERE account_pool_id = ?2 AND inspiration_id = ?3 AND position = ?4 AND request_id = ?5 AND next_offset = ?6",
            params![next_offset as i64, account_pool_id, id.trim(), position, request_id.trim(), offset as i64],
        ).map_err(|error| format!("更新剪藏图片续传进度失败: {error}"))?;
        if changed != 1 {
            return Err("剪藏图片续传状态已变化，请按原 requestId 重新检查".to_string());
        }
        Ok(BrowserCaptureImageUploadProgress {
            next_offset,
            total_bytes: upload.total_bytes,
            already_ready: false,
        })
    }

    pub fn complete_browser_capture_image_upload(
        &self,
        id: &str,
        account_pool_id: i64,
        position: i64,
        request_id: &str,
    ) -> Result<super::BrowserCollectionImageUpload, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("剪藏目标账号不可用: {error}"))?;
        let upload = read_capture_image_upload(&conn, id, account_pool_id, position, request_id)?;
        if upload.next_offset != upload.total_bytes {
            return Err(format!(
                "剪藏图片尚未传完：{}/{}",
                upload.next_offset, upload.total_bytes
            ));
        }
        let source_url = conn.query_row(
            "SELECT source_url FROM inspiration_images WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = ?3 AND request_id = ?4 AND status = 'downloading'",
            params![account_pool_id, id.trim(), position, request_id.trim()], |row| row.get(0),
        ).optional().map_err(|error| format!("校验剪藏图片来源失败: {error}"))?
            .ok_or_else(|| "剪藏图片来源或状态已变化".to_string())?;
        Ok(BrowserCollectionImageUpload {
            inspiration_id: id.trim().to_string(),
            account_pool_id,
            position,
            request_id: request_id.trim().to_string(),
            source_url,
            total_bytes: upload.total_bytes,
            sha256: upload.sha256,
            mime_type: upload.mime_type,
            temp_name: upload.temp_name,
            next_offset: upload.next_offset,
            already_ready: false,
        })
    }

    pub fn finish_browser_capture_image_upload(
        &self,
        id: &str,
        account_pool_id: i64,
        position: i64,
        request_id: &str,
    ) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let upload = read_capture_image_upload(&conn, id, account_pool_id, position, request_id)?;
        let path = self.capture_image_upload_path(account_pool_id, &upload.temp_name)?;
        conn.execute("DELETE FROM inspiration_image_uploads WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = ?3 AND request_id = ?4",
            params![account_pool_id, id.trim(), position, request_id.trim()]).map_err(|error| format!("清理剪藏图片续传状态失败: {error}"))?;
        let _ = fs::remove_file(path);
        Ok(())
    }

    pub fn fail_browser_capture_image_upload(
        &self,
        id: &str,
        account_pool_id: i64,
        position: i64,
        request_id: &str,
        message: &str,
    ) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("剪藏目标账号不可用: {error}"))?;
        let temp_name: Option<String> = conn.query_row(
            "SELECT temp_name FROM inspiration_image_uploads WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = ?3 AND request_id = ?4",
            params![account_pool_id, id.trim(), position, request_id.trim()], |row| row.get(0),
        ).optional().map_err(|error| format!("读取剪藏图片临时文件状态失败: {error}"))?;
        let changed = conn.execute(
            "UPDATE inspiration_images SET status = 'failed', error = ?1, updated_at = datetime('now', 'localtime')
             WHERE account_pool_id = ?2 AND inspiration_id = ?3 AND position = ?4 AND request_id = ?5
               AND status IN ('pending', 'downloading', 'failed')
               AND EXISTS (SELECT 1 FROM inspirations i WHERE i.id = ?3 AND i.account_pool_id = ?2 AND i.saved = 1)",
            params![message.chars().take(500).collect::<String>(), account_pool_id, id.trim(), position, request_id.trim()],
        ).map_err(|error| format!("记录剪藏图片失败状态失败: {error}"))?;
        if changed != 1 {
            return Err("剪藏图片不存在、已完成或 requestId 不匹配，拒绝写入失败状态".to_string());
        }
        conn.execute("DELETE FROM inspiration_image_uploads WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = ?3 AND request_id = ?4",
            params![account_pool_id, id.trim(), position, request_id.trim()]).map_err(|error| format!("清理剪藏图片续传状态失败: {error}"))?;
        if let Some(temp_name) = temp_name {
            if let Ok(path) = self.capture_image_upload_path(account_pool_id, &temp_name) {
                let _ = fs::remove_file(path);
            }
        }
        Ok(())
    }

    pub fn read_browser_capture_image_upload(
        &self,
        upload: &super::BrowserCollectionImageUpload,
    ) -> Result<Vec<u8>, String> {
        let path = self.capture_image_upload_path(upload.account_pool_id, &upload.temp_name)?;
        let bytes = fs::read(path).map_err(|error| format!("读取完整剪藏图片失败: {error}"))?;
        if bytes.len() != upload.total_bytes {
            return Err("剪藏图片落盘长度与申报长度不一致".to_string());
        }
        Ok(bytes)
    }

    fn capture_image_upload_path(
        &self,
        account_pool_id: i64,
        temp_name: &str,
    ) -> Result<PathBuf, String> {
        if account_pool_id <= 0
            || temp_name.len() != 69
            || !temp_name.ends_with(".part")
            || !temp_name[..64].bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("剪藏图片暂存路径参数无效".to_string());
        }
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        Ok(parent
            .join("assets")
            .join(account_pool_id.to_string())
            .join("uploads")
            .join(temp_name))
    }

    pub fn browser_collection_image_positions(
        &self,
        id: &str,
        account_pool_id: i64,
    ) -> Result<Vec<i64>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("收藏目标账号不可用: {error}"))?;
        let mut summary = conn
            .query_row(
                "SELECT id, account_pool_id, title, source_url, body, observed_at,
                        reason, status, note_id, dedupe_key, material_type, author,
                        capture_modules, capture_payload
                 FROM inspirations WHERE id = ?1 AND account_pool_id = ?2 AND saved = 1",
                params![id.trim(), account_pool_id],
                inspiration_from_row,
            )
            .optional()
            .map_err(|error| format!("读取网页收藏图片失败: {error}"))?
            .ok_or_else(|| "网页收藏不存在或不属于所选账号".to_string())?;
        self.hydrate_collection_summary(&conn, &mut summary)?;
        let mut statement = conn
            .prepare(
                "SELECT position FROM inspiration_images
                 WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND status = 'pending'
                 ORDER BY position ASC",
            )
            .map_err(|error| format!("读取待下载收藏图片失败: {error}"))?;
        let rows = statement
            .query_map(params![account_pool_id, id.trim()], |row| row.get(0))
            .map_err(|error| format!("读取待下载收藏图片失败: {error}"))?;
        rows.collect::<SqlResult<Vec<i64>>>()
            .map_err(|error| format!("解析待下载收藏图片失败: {error}"))
    }

    /// Preserve a retry hint when a background image job cannot claim a still
    /// pending row. The account and collection scope are explicit, and an
    /// already claimed retry is never overwritten by a late setup error.
    pub fn report_browser_collection_image_prepare_error(
        &self,
        id: &str,
        account_pool_id: i64,
        position: i64,
        message: &str,
    ) -> Result<(), String> {
        if id.trim().is_empty() || id.len() > 120 || position < 0 || message.trim().is_empty() {
            return Err("收藏图片重试提示无效".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("收藏目标账号不可用: {error}"))?;
        conn.execute(
            "UPDATE inspiration_images SET error = ?1, updated_at = datetime('now', 'localtime')
             WHERE account_pool_id = ?2 AND inspiration_id = ?3 AND position = ?4
               AND status = 'pending'
               AND EXISTS (SELECT 1 FROM inspirations i WHERE i.id = ?3
                 AND i.account_pool_id = ?2 AND i.saved = 1)",
            params![
                message.chars().take(500).collect::<String>(),
                account_pool_id,
                id.trim(),
                position
            ],
        )
        .map_err(|error| format!("保存收藏图片重试提示失败: {error}"))?;
        Ok(())
    }

    /// Lazily migrate image URLs from older capture_payload records into the
    /// account-scoped attachment table, then expose metadata without disk paths.
    pub(crate) fn hydrate_collection_summary(
        &self,
        conn: &Connection,
        item: &mut InspirationSummary,
    ) -> Result<(), String> {
        // A crash can leave a row in `downloading`, which otherwise blocks the
        // user's retry button forever. Make abandoned work visible and retryable
        // as soon as the collection is next read.
        conn.execute(
            "UPDATE inspiration_images SET status = 'failed', error = '上次下载中断，可重试',
                updated_at = datetime('now', 'localtime')
             WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND status = 'downloading'
               AND updated_at < datetime('now', 'localtime', '-2 minutes')",
            params![item.account_pool_id, item.id],
        )
        .map_err(|error| format!("恢复中断的收藏图片状态失败: {error}"))?;

        let payload: serde_json::Value =
            serde_json::from_str(&item.capture_payload).unwrap_or_else(|_| serde_json::json!({}));
        let images = payload
            .get("images")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let request_id = item
            .id
            .strip_prefix(&format!("bc:{}:", item.account_pool_id))
            .map(str::to_string);
        for (position, image) in images.iter().take(12).enumerate() {
            let Some(source_url) = image.get("url").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let source_url = source_url.trim();
            if source_url.len() > 2_000
                || !source_url.starts_with("https://")
                || source_url.chars().any(char::is_control)
            {
                continue;
            }
            conn.execute(
                "INSERT OR IGNORE INTO inspiration_images
                   (account_pool_id, inspiration_id, position, source_url, request_id)
                 SELECT ?1, ?2, ?3, ?4, ?5
                 WHERE EXISTS (
                   SELECT 1 FROM inspirations
                   WHERE id = ?2 AND account_pool_id = ?1 AND saved = 1
                 )",
                params![
                    item.account_pool_id,
                    item.id,
                    position as i64,
                    source_url,
                    request_id
                ],
            )
            .map_err(|error| format!("迁移收藏图片引用失败: {error}"))?;
        }

        let tags: Option<String> = conn
            .query_row(
                "SELECT collection_tags FROM inspirations
                 WHERE id = ?1 AND account_pool_id = ?2 AND saved = 1",
                params![item.id, item.account_pool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取收藏标签失败: {error}"))?;
        item.collection_tags = tags
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default();

        let mut statement = conn
            .prepare(
                "SELECT position, source_url, source_kind, status, byte_size, mime_type, width, height,
                        error, image_path, thumbnail_path
                 FROM inspiration_images
                 WHERE account_pool_id = ?1 AND inspiration_id = ?2
                 ORDER BY position ASC",
            )
            .map_err(|error| format!("读取收藏图片状态失败: {error}"))?;
        let rows = statement
            .query_map(params![item.account_pool_id, item.id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                ))
            })
            .map_err(|error| format!("读取收藏图片状态失败: {error}"))?;
        let rows = rows
            .collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("解析收藏图片状态失败: {error}"))?;
        drop(statement);
        for (
            position,
            source_url,
            source_kind,
            mut status,
            byte_size,
            mime_type,
            width,
            height,
            mut error,
            image,
            thumb,
        ) in rows
        {
            let original_available = image
                .as_deref()
                .and_then(|path| self.collection_asset_path(item.account_pool_id, path))
                .is_some_and(|path| path.is_file());
            let thumbnail_available = thumb
                .as_deref()
                .and_then(|path| self.collection_asset_path(item.account_pool_id, path))
                .is_some_and(|path| path.is_file());
            if status == "ready" && (!original_available || !thumbnail_available) {
                status = "failed".to_string();
                error = Some("本地图片文件缺失，可从来源重试".to_string());
                conn.execute(
                    "UPDATE inspiration_images SET status = 'failed', error = ?1,
                        image_path = NULL, thumbnail_path = NULL, sha256 = NULL,
                        byte_size = NULL, mime_type = NULL,
                        updated_at = datetime('now', 'localtime')
                     WHERE account_pool_id = ?2 AND inspiration_id = ?3 AND position = ?4 AND status = 'ready'",
                    params![error, item.account_pool_id, item.id, position],
                )
                .map_err(|error| format!("修复缺失收藏图片状态失败: {error}"))?;
            }
            item.collection_images.push(BrowserCollectionImageSummary {
                position,
                source_url,
                source_kind,
                status,
                byte_size,
                mime_type,
                width,
                height,
                error,
                original_available,
                thumbnail_available,
            });
        }
        Ok(())
    }

    fn collection_asset_path(&self, account_pool_id: i64, relative: &str) -> Option<PathBuf> {
        let root = self
            .path
            .parent()?
            .join("assets")
            .join(account_pool_id.to_string());
        let target = self.path.parent()?.join(relative);
        let root = root.canonicalize().ok()?;
        let target = target.canonicalize().ok()?;
        target.starts_with(root).then_some(target)
    }

    pub fn update_local_inspiration_details(
        &self,
        id: &str,
        account_pool_id: i64,
        note: &str,
        tags: &[String],
    ) -> Result<(), String> {
        if id.trim().is_empty() || id.len() > 120 || note.chars().count() > 4_000 {
            return Err("收藏备注或 ID 超出长度限制".to_string());
        }
        if tags.len() > 20 {
            return Err("收藏标签最多 20 个".to_string());
        }
        let mut normalized = Vec::new();
        for tag in tags {
            let tag = tag.trim();
            if tag.is_empty() {
                continue;
            }
            if tag.chars().count() > 40 || tag.chars().any(char::is_control) {
                return Err("单个收藏标签最多 40 字且不能含控制字符".to_string());
            }
            if !normalized.iter().any(|existing: &String| existing == tag) {
                normalized.push(tag.to_string());
            }
        }
        let tags_json = serde_json::to_string(&normalized)
            .map_err(|error| format!("序列化收藏标签失败: {error}"))?;
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let changed = conn
            .execute(
                "UPDATE inspirations SET reason = ?1, collection_tags = ?2,
                    updated_at = datetime('now', 'localtime')
                 WHERE id = ?3 AND account_pool_id = ?4 AND saved = 1",
                params![note.trim(), tags_json, id.trim(), account_pool_id],
            )
            .map_err(|error| format!("保存收藏备注和标签失败: {error}"))?;
        if changed != 1 {
            return Err("网页收藏不存在或不属于当前账号".to_string());
        }
        Ok(())
    }

    pub fn remove_local_inspiration(&self, id: &str, account_pool_id: i64) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let changed = conn
            .execute(
                "UPDATE inspirations SET saved = 0, updated_at = datetime('now', 'localtime')
                 WHERE id = ?1 AND account_pool_id = ?2 AND saved = 1",
                params![id.trim(), account_pool_id],
            )
            .map_err(|error| format!("取消收藏失败: {error}"))?;
        if changed != 1 {
            return Err("网页收藏不存在或不属于当前账号".to_string());
        }
        // Attachment rows and content-addressed files are retained. A file can be
        // shared with another collection or a creator asset.
        Ok(())
    }

    pub fn claim_browser_collection_image(
        &self,
        id: &str,
        account_pool_id: i64,
        position: i64,
    ) -> Result<BrowserCollectionImageDownload, String> {
        if !(0..12).contains(&position) {
            return Err("收藏图片序号无效".to_string());
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("开启图片下载事务失败: {error}"))?;
        ensure_capture_account(&tx, account_pool_id)
            .map_err(|error| format!("收藏目标账号不可用: {error}"))?;
        let active = ensure_active_account(&tx, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        tx.execute(
            "UPDATE inspiration_images SET status = 'failed', error = '上次下载中断，可重试',
                updated_at = datetime('now', 'localtime')
             WHERE status = 'downloading'
               AND account_pool_id = ?1 AND inspiration_id = ?2
               AND updated_at < datetime('now', 'localtime', '-2 minutes')",
            params![account_pool_id, id.trim()],
        )
        .map_err(|error| format!("恢复中断的收藏图片状态失败: {error}"))?;
        let image = tx
            .query_row(
                "SELECT source_url, request_id, status FROM inspiration_images
                 WHERE inspiration_id = ?1 AND account_pool_id = ?2 AND position = ?3
                   AND EXISTS (SELECT 1 FROM inspirations i WHERE i.id = ?1
                     AND i.account_pool_id = ?2 AND i.saved = 1)",
                params![id.trim(), account_pool_id, position],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("读取待下载收藏图片失败: {error}"))?
            .ok_or_else(|| "收藏图片不存在或不属于当前账号".to_string())?;
        let id_request = id.trim().strip_prefix(&format!("bc:{account_pool_id}:"));
        if image.1.as_deref() != id_request {
            return Err("收藏图片 requestId 与原收藏不匹配，拒绝重试".to_string());
        }
        if image.2 == "ready" {
            return Err("这张图片已经保存在本地".to_string());
        }
        if image.2 == "downloading" {
            return Err("这张图片正在下载".to_string());
        }
        let ready_bytes: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(byte_size), 0) FROM inspiration_images
                 WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND status = 'ready'",
                params![account_pool_id, id.trim()],
                |row| row.get(0),
            )
            .map_err(|error| format!("核算收藏图片大小失败: {error}"))?;
        tx.execute(
            "UPDATE inspiration_images SET status = 'downloading', error = NULL,
                updated_at = datetime('now', 'localtime')
             WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = ?3
               AND status IN ('pending', 'failed')",
            params![account_pool_id, id.trim(), position],
        )
        .map_err(|error| format!("标记收藏图片下载状态失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交图片下载状态失败: {error}"))?;
        Ok(BrowserCollectionImageDownload {
            source_url: image.0,
            request_id: image.1,
            ready_bytes: ready_bytes as u64,
        })
    }

    pub fn fail_browser_collection_image(
        &self,
        id: &str,
        account_pool_id: i64,
        position: i64,
        expected_source_url: &str,
        expected_request_id: Option<&str>,
        message: &str,
    ) -> Result<(), String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, account_pool_id)
            .map_err(|error| format!("收藏目标账号不可用: {error}"))?;
        let changed = conn
            .execute(
                "UPDATE inspiration_images SET status = 'failed', error = ?1,
                    updated_at = datetime('now', 'localtime')
                 WHERE account_pool_id = ?2 AND inspiration_id = ?3 AND position = ?4
                   AND status = 'downloading' AND source_url = ?5
                   AND ((request_id IS NULL AND ?6 IS NULL) OR request_id = ?6)",
                params![
                    message.chars().take(500).collect::<String>(),
                    account_pool_id,
                    id.trim(),
                    position,
                    expected_source_url,
                    expected_request_id,
                ],
            )
            .map_err(|error| format!("记录收藏图片失败状态失败: {error}"))?;
        if changed != 1 {
            return Err("收藏图片下载状态已变化".to_string());
        }
        Ok(())
    }

    pub fn save_browser_collection_image(
        &self,
        input: BrowserCollectionImageSave<'_>,
    ) -> Result<(), String> {
        self.save_browser_collection_image_scoped(input, true)
    }

    /// Extension byte transfers are already bound to an explicitly selected,
    /// active target account by the Native Host. They must not change or depend
    /// on the desktop's globally active account.
    pub fn save_browser_capture_image(
        &self,
        input: BrowserCollectionImageSave<'_>,
    ) -> Result<(), String> {
        self.save_browser_collection_image_scoped(input, false)
    }

    fn save_browser_collection_image_scoped(
        &self,
        input: BrowserCollectionImageSave<'_>,
        require_active: bool,
    ) -> Result<(), String> {
        let BrowserCollectionImageSave {
            id,
            account_pool_id,
            position,
            expected_source_url,
            expected_request_id,
            bytes,
            mime_type,
            thumbnail_bytes,
            width,
            height,
        } = input;
        const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
        const MAX_COLLECTION_BYTES: u64 = 32 * 1024 * 1024;
        if bytes.is_empty()
            || bytes.len() > MAX_IMAGE_BYTES
            || thumbnail_bytes.is_empty()
            || thumbnail_bytes.len() > 4 * 1024 * 1024
        {
            return Err("图片或缩略图大小无效".to_string());
        }
        if width == 0 || height == 0 || width > 20_000 || height > 20_000 {
            return Err("图片像素尺寸超出收藏限制".to_string());
        }
        let extension = match mime_type {
            "image/jpeg" => "jpg",
            "image/png" => "png",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => return Err("不支持此图片格式".to_string()),
        };
        if !collection_image_signature_matches(extension, bytes) {
            return Err("图片实际格式与响应类型不匹配".to_string());
        }
        if !thumbnail_bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            return Err("收藏缩略图实际格式无效".to_string());
        }
        let digest = Sha256::digest(bytes);
        let hash = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let relative_image = format!("assets/{account_pool_id}/{hash}.{extension}");
        let relative_thumb = format!("assets/{account_pool_id}/thumbnails/{hash}.jpg");
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("开启收藏图片写入事务失败: {error}"))?;
        ensure_capture_account(&tx, account_pool_id)
            .map_err(|error| format!("收藏目标账号不可用: {error}"))?;
        if require_active {
            let active = ensure_active_account(&tx, &self.path)
                .map_err(|error| format!("读取激活账号失败: {error}"))?;
            ensure_expected_account(&active, Some(account_pool_id))
                .map_err(|error| format!("账号上下文已变化: {error}"))?;
        }
        let row = tx
            .query_row(
                "SELECT source_url, status, request_id FROM inspiration_images
                 WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND position = ?3",
                params![account_pool_id, id.trim(), position],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("复核收藏图片目标失败: {error}"))?
            .ok_or_else(|| "收藏图片不存在".to_string())?;
        if row.1 != "downloading" {
            return Err("收藏图片下载状态已变化，拒绝写入".to_string());
        }
        if row.0 != expected_source_url || row.2.as_deref() != expected_request_id {
            return Err("收藏图片来源或 requestId 已变化，拒绝写入旧响应".to_string());
        }
        let ready_bytes: u64 = tx
            .query_row(
                "SELECT COALESCE(SUM(byte_size), 0) FROM inspiration_images
                 WHERE account_pool_id = ?1 AND inspiration_id = ?2 AND status = 'ready'
                   AND position <> ?3",
                params![account_pool_id, id.trim(), position],
                |row| row.get::<_, i64>(0).map(|value| value.max(0) as u64),
            )
            .map_err(|error| format!("核算收藏图片大小失败: {error}"))?;
        if ready_bytes.saturating_add(bytes.len() as u64) > MAX_COLLECTION_BYTES {
            return Err("单条收藏的本地图片总量不能超过 32MB".to_string());
        }
        let db_dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        let image_path = db_dir.join(&relative_image);
        let thumb_path = db_dir.join(&relative_thumb);
        persist_content_addressed_file(&image_path, bytes, &hash)?;
        persist_content_addressed_file(&thumb_path, thumbnail_bytes, &hash)?;
        let changed = tx
            .execute(
                "UPDATE inspiration_images SET status = 'ready', image_path = ?1,
                    thumbnail_path = ?2, sha256 = ?3, mime_type = ?4, byte_size = ?5,
                    width = ?6, height = ?7, error = NULL,
                    updated_at = datetime('now', 'localtime')
                 WHERE account_pool_id = ?8 AND inspiration_id = ?9 AND position = ?10
                   AND source_url = ?11 AND status = 'downloading'
                   AND EXISTS (SELECT 1 FROM inspirations i WHERE i.id = ?9
                     AND i.account_pool_id = ?8 AND i.saved = 1)",
                params![
                    relative_image,
                    relative_thumb,
                    hash,
                    mime_type,
                    bytes.len() as i64,
                    width as i64,
                    height as i64,
                    account_pool_id,
                    id.trim(),
                    position,
                    expected_source_url
                ],
            )
            .map_err(|error| format!("保存收藏图片记录失败: {error}"))?;
        if changed != 1 {
            return Err("收藏状态或图片来源已变化，未关联下载文件".to_string());
        }
        tx.commit()
            .map_err(|error| format!("提交收藏图片文件记录失败: {error}"))?;
        Ok(())
    }

    pub fn read_browser_collection_image(
        &self,
        id: &str,
        account_pool_id: i64,
        position: i64,
        thumbnail: bool,
    ) -> Result<String, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = self
            .current_active_account()
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let (stored_path, mime_type): (String, String) = conn
            .query_row(
                "SELECT CASE WHEN ?1 THEN thumbnail_path ELSE image_path END, mime_type
                 FROM inspiration_images
                 WHERE inspiration_id = ?2 AND account_pool_id = ?3 AND position = ?4
                   AND status = 'ready'
                   AND EXISTS (SELECT 1 FROM inspirations i WHERE i.id = ?2
                     AND i.account_pool_id = ?3 AND i.saved = 1)",
                params![thumbnail, id.trim(), account_pool_id, position],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| format!("读取收藏图片失败: {error}"))?;
        let path = self
            .collection_asset_path(account_pool_id, &stored_path)
            .ok_or_else(|| "收藏图片文件不存在或路径无效".to_string())?;
        let bytes = fs::read(path).map_err(|error| format!("读取收藏图片文件失败: {error}"))?;
        Ok(format!(
            "data:{};base64,{}",
            if thumbnail { "image/jpeg" } else { &mime_type },
            STANDARD.encode(bytes)
        ))
    }

    /// Explicitly turn a locally saved collection attachment into a creator
    /// asset row. The content-addressed original/thumbnail files are reused.
    pub fn add_browser_collection_image_to_library(
        &self,
        id: &str,
        account_pool_id: i64,
        position: i64,
    ) -> Result<ItemSummary, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开启创作素材关联事务失败: {error}"))?;
        let (image_path, thumbnail_path, hash, title): (String, String, String, String) = tx
            .query_row(
                "SELECT a.image_path, a.thumbnail_path, a.sha256, i.title
                 FROM inspiration_images a JOIN inspirations i
                   ON i.id = a.inspiration_id AND i.account_pool_id = a.account_pool_id
                 WHERE a.inspiration_id = ?1 AND a.account_pool_id = ?2
                   AND a.position = ?3 AND a.status = 'ready' AND i.saved = 1",
                params![id.trim(), account_pool_id, position],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|error| format!("读取已保存收藏图片失败: {error}"))?;
        let image_abs = self
            .collection_asset_path(account_pool_id, &image_path)
            .ok_or_else(|| "收藏原图文件不可用".to_string())?;
        let thumbnail_abs = self
            .collection_asset_path(account_pool_id, &thumbnail_path)
            .ok_or_else(|| "收藏缩略图文件不可用".to_string())?;
        if !image_abs.is_file() || !thumbnail_abs.is_file() {
            return Err("收藏原图或缩略图文件不可用".to_string());
        }
        if let Some(existing) = read_item_by_hash(&tx, account_pool_id, &hash)
            .map_err(|error| format!("查找相同创作素材失败: {error}"))?
        {
            record_imported_collection_item(&tx, id, account_pool_id, existing.id)?;
            tx.commit()
                .map_err(|error| format!("提交素材关联失败: {error}"))?;
            return Ok(existing);
        }
        let title = title.trim();
        let title = if title.is_empty() {
            "网页收藏图片"
        } else {
            title
        };
        tx.execute(
            "INSERT INTO items (title, image_path, thumbnail_path, tags, account_pool_id,
                image_version, content_hash, metadata_version)
             VALUES (?1, ?2, ?3, '[]', ?4, 1, ?5, 1)",
            params![
                format!("{title} · 图片 {}", position + 1),
                image_path,
                thumbnail_path,
                account_pool_id,
                hash
            ],
        )
        .map_err(|error| format!("添加创作素材失败: {error}"))?;
        let item_id = tx.last_insert_rowid();
        let item = read_item_summary(&tx, item_id, account_pool_id)
            .map_err(|error| format!("读取新建创作素材失败: {error}"))?;
        record_imported_collection_item(&tx, id, account_pool_id, item_id)?;
        tx.commit()
            .map_err(|error| format!("提交创作素材失败: {error}"))?;
        Ok(item)
    }
}

#[derive(Debug, Clone)]
pub struct BrowserCollectionImageDownload {
    pub source_url: String,
    pub request_id: Option<String>,
    pub ready_bytes: u64,
}

fn record_imported_collection_item(
    conn: &Connection,
    id: &str,
    account_pool_id: i64,
    item_id: i64,
) -> Result<(), String> {
    let raw: String = conn
        .query_row(
            "SELECT capture_payload FROM inspirations WHERE id = ?1 AND account_pool_id = ?2 AND saved = 1",
            params![id.trim(), account_pool_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取收藏素材关联失败: {error}"))?;
    let mut payload: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "收藏采集数据格式无效".to_string())?;
    let mut ids = object
        .get("importedItemIds")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !ids.iter().any(|value| value.as_i64() == Some(item_id)) {
        ids.push(serde_json::json!(item_id));
    }
    object.insert("importedItemIds".to_string(), serde_json::Value::Array(ids));
    conn.execute(
        "UPDATE inspirations SET capture_payload = ?1,
            updated_at = datetime('now', 'localtime')
         WHERE id = ?2 AND account_pool_id = ?3 AND saved = 1",
        params![
            serde_json::to_string(&payload).map_err(|error| error.to_string())?,
            id.trim(),
            account_pool_id
        ],
    )
    .map_err(|error| format!("保存收藏素材关联失败: {error}"))?;
    Ok(())
}

fn collection_image_signature_matches(extension: &str, bytes: &[u8]) -> bool {
    match extension {
        "jpg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn persist_content_addressed_file(path: &Path, bytes: &[u8], hash: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "无法定位收藏图片目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建收藏图片目录失败: {error}"))?;
    if path.exists() {
        let existing =
            fs::read(path).map_err(|error| format!("读取已存在的收藏图片失败: {error}"))?;
        if existing == bytes {
            return Ok(());
        }
        return Err("内容摘要路径已存在不同文件，拒绝覆盖".to_string());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let staging = parent.join(format!(".{hash}-{}-{stamp}.staging", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(|error| format!("创建收藏图片暂存文件失败: {error}"))?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        fs::remove_file(&staging).ok();
        return Err(format!("写入收藏图片失败: {error}"));
    }
    if let Err(error) = fs::rename(&staging, path) {
        fs::remove_file(&staging).ok();
        if path.is_file() {
            let existing = fs::read(path)
                .map_err(|read_error| format!("读取竞争写入的收藏图片失败: {read_error}"))?;
            if existing == bytes {
                return Ok(());
            }
        }
        return Err(format!("收藏图片落位失败: {error}"));
    }
    Ok(())
}
