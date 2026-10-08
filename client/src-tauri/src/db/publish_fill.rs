use super::*;
use rusqlite::TransactionBehavior;
use std::io::{Read, Seek, SeekFrom};

const MAX_FILL_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_FILL_TOTAL_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
pub(super) const MAX_FILL_IMAGE_CHUNK_BYTES: usize = 32 * 1024;
const MAX_FILL_VIDEO_BYTES: u64 = 500 * 1024 * 1024;
const MAX_FILL_VIDEO_CHUNK_BYTES: usize = 96 * 1024;

const FILL_REQUEST_SECONDS: i64 = 30 * 60;
const FILL_CLAIM_SECONDS: i64 = 5 * 60;
const MAX_FILL_TITLE_CHARS: usize = 200;
const MAX_FILL_BODY_CHARS: usize = 20_000;
const MAX_FILL_TAGS: usize = 30;
const MAX_FILL_TAG_CHARS: usize = 80;

fn new_claim_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| format!("生成填充授权失败: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn task_from_outbox(entry: PublishOutboxSummary) -> Result<BrowserPublishFillTask, String> {
    let snapshot: serde_json::Value = serde_json::from_str(&entry.snapshot_json)
        .map_err(|_| "发布快照不是有效 JSON，无法生成填充任务".to_string())?;
    let title = snapshot
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let body = snapshot
        .get("body")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let tags = snapshot
        .get("tags")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .map(|tag| tag.trim_start_matches('#'))
                .filter(|tag| !tag.is_empty())
                .take(MAX_FILL_TAGS)
                .map(|tag| tag.chars().take(MAX_FILL_TAG_CHARS).collect())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    if title.is_empty() || body.is_empty() {
        return Err("填充任务缺少标题或正文".to_string());
    }
    if title.chars().count() > MAX_FILL_TITLE_CHARS || body.chars().count() > MAX_FILL_BODY_CHARS {
        return Err("填充任务文字超过安全长度上限".to_string());
    }
    let tag_suffix_chars = if tags.is_empty() {
        0
    } else {
        2 + tags
            .iter()
            .map(|tag| 1 + tag.chars().count())
            .sum::<usize>()
    };
    if body.chars().count() + tag_suffix_chars > MAX_FILL_BODY_CHARS {
        return Err("正文和话题拼接后超过安全长度上限".to_string());
    }
    let is_video = snapshot.get("noteType").and_then(serde_json::Value::as_str) == Some("video");
    let image_count = if is_video {
        0
    } else {
        snapshot
            .get("itemIds")
            .and_then(serde_json::Value::as_array)
            .map_or(0, Vec::len)
    };
    let fill_result =
        serde_json::from_str(&entry.fill_result_json).unwrap_or_else(|_| serde_json::json!({}));
    Ok(BrowserPublishFillTask {
        attempt_id: entry.attempt_id,
        account_pool_id: entry.account_pool_id,
        note_id: entry.note_id,
        content_version: entry.content_version,
        title,
        body,
        tags,
        image_count,
        fill_status: entry.fill_status,
        fill_expires_at: entry.fill_expires_at,
        fill_result,
    })
}

fn ensure_outbox_is_fillable(entry: &PublishOutboxSummary) -> Result<(), String> {
    if entry.status != "prepared" {
        return Err("只有尚未提交的平台发布准备记录可以创建填充任务".to_string());
    }
    Ok(())
}

fn note_item_ids_for_version(
    conn: &Connection,
    note_id: i64,
    account_id: i64,
    content_version: i64,
) -> Result<Vec<i64>, String> {
    let (item_id, raw_item_ids, version): (Option<i64>, String, i64) = conn
        .query_row(
            "SELECT item_id, COALESCE(item_ids, '[]'), content_version FROM notes
             WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
            params![note_id, account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| format!("读取笔记素材关联失败: {error}"))?
        .ok_or_else(|| "填充笔记不存在或账号不匹配".to_string())?;
    if version != content_version {
        return Err("笔记内容已变化，拒绝读取旧发布快照素材".to_string());
    }
    let mut ids: Vec<i64> =
        serde_json::from_str(&raw_item_ids).map_err(|_| "笔记素材关联数据损坏".to_string())?;
    if ids.is_empty() {
        ids.extend(item_id);
    }
    if ids.len() > 9 || ids.iter().any(|id| *id <= 0) {
        return Err("笔记素材关联超出安全范围".to_string());
    }
    let mut unique = HashSet::new();
    if ids.iter().any(|id| !unique.insert(*id)) {
        return Err("笔记素材关联包含重复素材".to_string());
    }
    Ok(ids)
}

fn snapshot_item_ids(entry: &PublishOutboxSummary) -> Result<Vec<i64>, String> {
    let snapshot: serde_json::Value = serde_json::from_str(&entry.snapshot_json)
        .map_err(|_| "发布快照不是有效 JSON".to_string())?;
    let ids = snapshot
        .get("itemIds")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "发布快照缺少有序素材列表".to_string())?
        .iter()
        .map(|value| {
            value
                .as_i64()
                .filter(|id| *id > 0)
                .ok_or_else(|| "发布快照素材 ID 无效".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if ids.len() > 9 {
        return Err("发布快照素材数量超过 9 张".to_string());
    }
    let mut unique = HashSet::new();
    if ids.iter().any(|id| !unique.insert(*id)) {
        return Err("发布快照包含重复素材".to_string());
    }
    Ok(ids)
}

fn safe_fill_image_path(
    db: &LocalDb,
    stored_path: &str,
    account_id: i64,
    expected_hash: &str,
) -> Result<(std::path::PathBuf, String), String> {
    use std::path::{Component, Path};
    let path = Path::new(stored_path);
    let components = path.components().collect::<Vec<_>>();
    if path.is_absolute()
        || components.len() != 3
        || components[0] != Component::Normal("assets".as_ref())
        || components[1] != Component::Normal(account_id.to_string().as_ref())
    {
        return Err("素材路径不在账号受管目录中".to_string());
    }
    let filename = components[2]
        .as_os_str()
        .to_str()
        .ok_or_else(|| "素材文件名无效".to_string())?;
    let filename_path = Path::new(filename);
    let extension = filename_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let stem = filename_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if stem != expected_hash
        || stem.len() != 64
        || !stem.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !matches!(
            extension.as_str(),
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif"
        )
    {
        return Err("素材文件名或类型不符合受管素材规则".to_string());
    }

    let db_dir = db.path.parent().unwrap_or_else(|| Path::new("."));
    let project_root = db_dir.parent().unwrap_or(db_dir);
    let roots = [db_dir, project_root];
    for parent in roots {
        let root = parent.join("assets");
        let Ok(root_metadata) = std::fs::symlink_metadata(&root) else {
            continue;
        };
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            continue;
        }
        let Ok(canonical_parent) = parent.canonicalize() else {
            continue;
        };
        let Ok(canonical_root) = root.canonicalize() else {
            continue;
        };
        if canonical_root != canonical_parent.join("assets") {
            continue;
        }
        let expected_account_dir = canonical_root.join(account_id.to_string());
        let candidate = root.join(account_id.to_string()).join(filename);
        let Ok(link_metadata) = std::fs::symlink_metadata(&candidate) else {
            continue;
        };
        if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
            continue;
        }
        let Ok(canonical_file) = candidate.canonicalize() else {
            continue;
        };
        if canonical_file.parent() != Some(expected_account_dir.as_path()) {
            continue;
        }
        return Ok((canonical_file, extension));
    }
    Err("关联素材文件不存在或不在账号受管目录中".to_string())
}

fn image_metadata(
    db: &LocalDb,
    conn: &Connection,
    account_id: i64,
    item_id: i64,
    index: usize,
) -> Result<(serde_json::Value, std::path::PathBuf), String> {
    let (title, stored_path, content_hash): (String, String, Option<String>) = conn
        .query_row(
            "SELECT title, image_path, content_hash FROM items
             WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
            params![item_id, account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| format!("读取关联素材记录失败: {error}"))?
        .ok_or_else(|| "发布快照素材已删除或不属于目标账号".to_string())?;
    let hash = content_hash.ok_or_else(|| "关联素材缺少内容摘要".to_string())?;
    let (path, extension) = safe_fill_image_path(db, &stored_path, account_id, &hash)?;
    let file = std::fs::File::open(&path).map_err(|error| format!("打开账号素材失败: {error}"))?;
    let file_len = file
        .metadata()
        .map_err(|error| format!("读取图片大小失败: {error}"))?
        .len();
    if file_len == 0 || file_len > MAX_FILL_IMAGE_BYTES {
        return Err("图片必须在 1B 到 25MB 之间".to_string());
    }
    let mut bytes = Vec::with_capacity(file_len as usize);
    file.take(MAX_FILL_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取账号素材失败: {error}"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_FILL_IMAGE_BYTES {
        return Err("图片必须在 1B 到 25MB 之间".to_string());
    }
    if !image_signature_matches(&extension, &bytes) {
        return Err("图片内容与文件扩展名或魔数不匹配".to_string());
    }
    let digest = Sha256::digest(&bytes);
    let actual_hash = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual_hash != hash {
        return Err("图片内容与素材摘要不匹配".to_string());
    }
    let mime = image_mime_for_extension(&extension);
    let filename = format!("image-{:02}.{}", index + 1, extension);
    Ok((
        serde_json::json!({
            "index": index,
            "itemId": item_id,
            "title": title,
            "filename": filename,
            "mimeType": mime,
            "totalBytes": bytes.len(),
            "sha256": actual_hash,
        }),
        path,
    ))
}

fn validated_image_metadata(
    db: &LocalDb,
    conn: &Connection,
    entry: &PublishOutboxSummary,
) -> Result<Vec<serde_json::Value>, String> {
    let snapshot_ids = snapshot_item_ids(entry)?;
    let note_ids = note_item_ids_for_version(
        conn,
        entry.note_id,
        entry.account_pool_id,
        entry.content_version,
    )?;
    if note_ids != snapshot_ids {
        return Err("发布快照素材顺序与笔记当前关联不一致，请重新准备发布快照".to_string());
    }
    let snapshot: serde_json::Value = serde_json::from_str(&entry.snapshot_json)
        .map_err(|_| "发布快照不是有效 JSON".to_string())?;
    if snapshot.get("noteType").and_then(serde_json::Value::as_str) == Some("video") {
        return Ok(Vec::new());
    }
    let mut total_bytes = 0_u64;
    let mut images = Vec::with_capacity(snapshot_ids.len());
    for (index, item_id) in snapshot_ids.into_iter().enumerate() {
        let (metadata, _) = image_metadata(db, conn, entry.account_pool_id, item_id, index)?;
        total_bytes = total_bytes.saturating_add(
            metadata["totalBytes"]
                .as_u64()
                .ok_or_else(|| "素材大小元数据无效".to_string())?,
        );
        if total_bytes > MAX_FILL_TOTAL_IMAGE_BYTES {
            return Err("单条任务图片总大小不能超过 32MiB".to_string());
        }
        images.push(metadata);
    }
    Ok(images)
}

fn managed_video_source(
    db: &LocalDb,
    conn: &Connection,
    entry: &PublishOutboxSummary,
) -> Result<Option<(std::path::PathBuf, serde_json::Value)>, String> {
    let snapshot: serde_json::Value = serde_json::from_str(&entry.snapshot_json)
        .map_err(|_| "发布快照不是有效 JSON".to_string())?;
    if snapshot.get("noteType").and_then(serde_json::Value::as_str) != Some("video") {
        return Ok(None);
    }
    let expected_path = snapshot
        .get("videoPath")
        .and_then(serde_json::Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "视频发布快照缺少受管视频文件".to_string())?;
    let (version, note_type, stored_path): (i64, String, Option<String>) = conn
        .query_row(
            "SELECT content_version, note_type, video_path FROM notes
             WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
            params![entry.note_id, entry.account_pool_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| format!("读取视频笔记失败: {error}"))?
        .ok_or_else(|| "视频笔记不存在或不属于目标账号".to_string())?;
    if version != entry.content_version || note_type != "video" {
        return Err("视频笔记已变化，请重新准备发布快照".to_string());
    }
    if stored_path.as_deref() != Some(expected_path) {
        return Err("视频文件与发布快照不一致，请重新准备发布".to_string());
    }
    let path = std::path::Path::new(expected_path);
    let components = path.components().collect::<Vec<_>>();
    if path.is_absolute()
        || components.len() != 3
        || components[0] != std::path::Component::Normal("videos".as_ref())
        || components[1] != std::path::Component::Normal(entry.account_pool_id.to_string().as_ref())
    {
        return Err("视频路径不在当前账号受管目录中，请重新选择视频".to_string());
    }
    let filename = components[2]
        .as_os_str()
        .to_str()
        .ok_or_else(|| "视频文件名无效".to_string())?;
    let filename_path = std::path::Path::new(filename);
    let extension = filename_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let stem = filename_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if stem.len() != 64
        || !stem.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !matches!(extension.as_str(), "mp4" | "mov" | "m4v" | "webm")
    {
        return Err("视频文件名或类型不符合受管素材规则".to_string());
    }
    let data_dir = db
        .path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let video_root = data_dir.join("videos");
    let account_dir = video_root.join(entry.account_pool_id.to_string());
    for directory in [&video_root, &account_dir] {
        let metadata = std::fs::symlink_metadata(directory)
            .map_err(|error| format!("读取受管视频目录失败: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("视频目录不能是符号链接".to_string());
        }
    }
    let canonical_data = data_dir
        .canonicalize()
        .map_err(|error| format!("解析本地数据目录失败: {error}"))?;
    let canonical_account_dir = account_dir
        .canonicalize()
        .map_err(|error| format!("解析受管视频目录失败: {error}"))?;
    if canonical_account_dir
        != canonical_data
            .join("videos")
            .join(entry.account_pool_id.to_string())
    {
        return Err("受管视频目录越出本地数据目录".to_string());
    }
    let candidate = account_dir.join(filename);
    let metadata = std::fs::symlink_metadata(&candidate)
        .map_err(|error| format!("受管视频文件不存在: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("受管视频文件不能是符号链接或目录".to_string());
    }
    let canonical_file = candidate
        .canonicalize()
        .map_err(|error| format!("解析受管视频文件失败: {error}"))?;
    if canonical_file.parent() != Some(canonical_account_dir.as_path()) {
        return Err("受管视频文件越出账号目录".to_string());
    }
    if metadata.len() == 0 || metadata.len() > MAX_FILL_VIDEO_BYTES {
        return Err("视频大小必须在 1B 到 500MiB 之间".to_string());
    }
    let mime_type = match extension.as_str() {
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "m4v" => "video/x-m4v",
        _ => "video/mp4",
    };
    let metadata_value = serde_json::json!({
        "filename": filename,
        "mimeType": mime_type,
        "totalBytes": metadata.len(),
        "sha256": stem.to_ascii_lowercase(),
    });
    Ok(Some((canonical_file, metadata_value)))
}

fn video_signature_matches(path: &std::path::Path, extension: &str) -> Result<bool, String> {
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("打开受管视频失败: {error}"))?;
    let mut signature = [0_u8; 16];
    let read = file
        .read(&mut signature)
        .map_err(|error| format!("读取视频签名失败: {error}"))?;
    Ok(if extension == "webm" {
        read >= 4 && signature[..4] == [0x1a, 0x45, 0xdf, 0xa3]
    } else {
        read >= 12 && &signature[4..8] == b"ftyp"
    })
}

fn verify_video_digest(path: &std::path::Path, expected: &str) -> Result<(), String> {
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("打开受管视频失败: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("校验视频摘要失败: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual == expected {
        Ok(())
    } else {
        Err("受管视频摘要与文件内容不匹配".to_string())
    }
}

fn ensure_live_claim(
    conn: &Connection,
    attempt_id: &str,
    account_id: i64,
    claim_token: &str,
) -> Result<PublishOutboxSummary, String> {
    if claim_token.len() != 64 {
        return Err("填充授权令牌无效".to_string());
    }
    let entry = read_publish_outbox_by_id(conn, attempt_id)
        .map_err(|error| format!("读取发布填充任务失败: {error}"))?
        .ok_or_else(|| "发布填充任务不存在".to_string())?;
    if entry.account_pool_id != account_id || entry.status != "prepared" {
        return Err("发布填充任务账号无效或已提交，拒绝读取".to_string());
    }
    let (stored_token, expired): (Option<String>, bool) = conn
        .query_row(
            "SELECT fill_claim_token,
                    fill_claim_expires_at IS NULL
                      OR fill_claim_expires_at <= datetime('now', 'localtime')
             FROM publish_outbox WHERE attempt_id = ?1 AND account_pool_id = ?2",
            params![attempt_id, account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("校验填充授权失败: {error}"))?;
    if stored_token.as_deref() != Some(claim_token) || expired {
        return Err("填充授权已失效或过期，请重新领取任务".to_string());
    }
    Ok(entry)
}

impl LocalDb {
    /// 返回被任务 token 锁定的图片清单；扩展只得到素材 ID 与校验元数据，不会得到本地路径。
    pub fn browser_publish_fill_task_images(
        &self,
        attempt_id: &str,
        expected_account_id: i64,
        claim_token: &str,
    ) -> Result<Vec<serde_json::Value>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, expected_account_id)
            .map_err(|error| format!("校验填充目标账号失败: {error}"))?;
        let entry = ensure_live_claim(&conn, attempt_id, expected_account_id, claim_token)?;
        validated_image_metadata(self, &conn, &entry)
    }

    pub fn browser_publish_fill_task_video(
        &self,
        attempt_id: &str,
        expected_account_id: i64,
        claim_token: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, expected_account_id)
            .map_err(|error| format!("校验填充目标账号失败: {error}"))?;
        let entry = ensure_live_claim(&conn, attempt_id, expected_account_id, claim_token)?;
        if note_item_ids_for_version(
            &conn,
            entry.note_id,
            expected_account_id,
            entry.content_version,
        )? != snapshot_item_ids(&entry)?
        {
            return Err("发布快照素材顺序与笔记当前关联不一致".to_string());
        }
        let Some((path, metadata)) = managed_video_source(self, &conn, &entry)? else {
            return Ok(None);
        };
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !video_signature_matches(&path, extension)? {
            return Err("视频内容与文件类型签名不匹配".to_string());
        }
        verify_video_digest(&path, metadata["sha256"].as_str().unwrap_or_default())?;
        Ok(Some(metadata))
    }

    pub fn read_browser_publish_fill_video_chunk(
        &self,
        attempt_id: &str,
        expected_account_id: i64,
        claim_token: &str,
        offset: u64,
        requested_bytes: usize,
    ) -> Result<serde_json::Value, String> {
        if requested_bytes == 0 || requested_bytes > MAX_FILL_VIDEO_CHUNK_BYTES {
            return Err("视频分块大小必须在 1B 到 96KiB 之间".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, expected_account_id)
            .map_err(|error| format!("校验填充目标账号失败: {error}"))?;
        let entry = ensure_live_claim(&conn, attempt_id, expected_account_id, claim_token)?;
        if note_item_ids_for_version(
            &conn,
            entry.note_id,
            expected_account_id,
            entry.content_version,
        )? != snapshot_item_ids(&entry)?
        {
            return Err("发布快照素材顺序与笔记当前关联不一致".to_string());
        }
        let Some((path, metadata)) = managed_video_source(self, &conn, &entry)? else {
            return Err("当前发布快照不包含视频".to_string());
        };
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !video_signature_matches(&path, extension)? {
            return Err("视频内容与文件类型签名不匹配".to_string());
        }
        let mut file =
            std::fs::File::open(&path).map_err(|error| format!("打开受管视频失败: {error}"))?;
        let file_len = file
            .metadata()
            .map_err(|error| format!("读取视频大小失败: {error}"))?
            .len();
        if file_len != metadata["totalBytes"].as_u64().unwrap_or_default() || offset >= file_len {
            return Err("视频文件大小已变化或分块偏移超出范围".to_string());
        }
        let read_len = requested_bytes.min((file_len - offset) as usize);
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| format!("定位视频分块失败: {error}"))?;
        let mut data = vec![0_u8; read_len];
        file.read_exact(&mut data)
            .map_err(|error| format!("读取视频分块失败: {error}"))?;
        let mut chunk = metadata;
        chunk["offset"] = serde_json::json!(offset);
        chunk["dataBase64"] = serde_json::json!(STANDARD.encode(data));
        chunk["done"] = serde_json::json!(offset + read_len as u64 == file_len);
        Ok(chunk)
    }

    /// 以 attempt/account/claim token/item ID 读取受管素材的有界二进制块。
    pub fn read_browser_publish_fill_image_chunk(
        &self,
        attempt_id: &str,
        expected_account_id: i64,
        claim_token: &str,
        item_id: i64,
        offset: u64,
        requested_bytes: usize,
    ) -> Result<serde_json::Value, String> {
        if requested_bytes == 0 || requested_bytes > MAX_FILL_IMAGE_CHUNK_BYTES {
            return Err("图片分块大小必须在 1B 到 32KiB 之间".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, expected_account_id)
            .map_err(|error| format!("校验填充目标账号失败: {error}"))?;
        let entry = ensure_live_claim(&conn, attempt_id, expected_account_id, claim_token)?;
        let snapshot_ids = snapshot_item_ids(&entry)?;
        let note_ids = note_item_ids_for_version(
            &conn,
            entry.note_id,
            expected_account_id,
            entry.content_version,
        )?;
        if note_ids != snapshot_ids {
            return Err("发布快照素材顺序与笔记当前关联不一致".to_string());
        }
        let index = snapshot_ids
            .iter()
            .position(|id| *id == item_id)
            .ok_or_else(|| "素材不属于当前发布快照".to_string())?;
        let (title, stored_path, content_hash): (String, String, Option<String>) = conn
            .query_row(
                "SELECT title, image_path, content_hash FROM items
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![item_id, expected_account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("读取关联素材记录失败: {error}"))?
            .ok_or_else(|| "关联素材已删除或不属于目标账号".to_string())?;
        let hash = content_hash.ok_or_else(|| "关联素材缺少内容摘要".to_string())?;
        let (path, extension) =
            safe_fill_image_path(self, &stored_path, expected_account_id, &hash)?;
        let mut file =
            std::fs::File::open(&path).map_err(|error| format!("打开账号素材失败: {error}"))?;
        let file_len = file
            .metadata()
            .map_err(|error| format!("读取图片大小失败: {error}"))?
            .len();
        if file_len == 0 || file_len > MAX_FILL_IMAGE_BYTES {
            return Err("图片必须在 1B 到 25MB 之间".to_string());
        }
        let mut signature = [0_u8; 16];
        let signature_len = file
            .read(&mut signature)
            .map_err(|error| format!("验证图片类型失败: {error}"))?;
        if !image_signature_matches(&extension, &signature[..signature_len]) {
            return Err("图片内容与文件扩展名或魔数不匹配".to_string());
        }
        if offset > file_len {
            return Err("图片分块偏移超出文件范围".to_string());
        }
        let read_len = requested_bytes.min((file_len - offset) as usize);
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| {
                let mut data = vec![0_u8; read_len];
                file.read_exact(&mut data)?;
                Ok(data)
            })
            .map(|data| {
                serde_json::json!({
                    "itemId": item_id,
                    "index": index,
                    "title": title,
                    "filename": format!("image-{:02}.{}", index + 1, extension),
                    "mimeType": image_mime_for_extension(&extension),
                    "totalBytes": file_len,
                    "sha256": hash,
                    "offset": offset,
                    "dataBase64": STANDARD.encode(data),
                    "done": offset + read_len as u64 == file_len,
                })
            })
            .map_err(|error| format!("读取图片分块失败: {error}"))
    }

    /// 由桌面端用户显式创建短期单条填充任务，不访问平台。
    pub fn request_local_publish_fill(
        &self,
        attempt_id: &str,
        expected_account_id: i64,
    ) -> Result<PublishOutboxSummary, String> {
        let attempt_id = attempt_id.trim();
        if attempt_id.is_empty() || attempt_id.chars().count() > 160 {
            return Err("发布准备记录 ID 无效".to_string());
        }
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(expected_account_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let entry = read_publish_outbox_by_id(&conn, attempt_id)
            .map_err(|error| format!("读取发布准备记录失败: {error}"))?
            .ok_or_else(|| "发布准备记录不存在".to_string())?;
        if entry.account_pool_id != active.id {
            return Err("发布准备记录不属于当前账号".to_string());
        }
        ensure_outbox_is_fillable(&entry)?;
        let _ = task_from_outbox(entry.clone())?;
        let version: Option<i64> = conn
            .query_row(
                "SELECT content_version FROM notes
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![entry.note_id, active.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取笔记版本失败: {error}"))?;
        if version != Some(entry.content_version) {
            return Err("发布准备内容已过期，请重新准备后再创建填充任务".to_string());
        }
        conn.execute(
            "UPDATE publish_outbox
             SET fill_status = 'queued',
                 fill_expires_at = datetime('now', 'localtime', ?1),
                 fill_claim_token = NULL,
                 fill_claim_expires_at = NULL,
                 fill_result_json = '{}',
                 updated_at = datetime('now', 'localtime')
             WHERE attempt_id = ?2 AND account_pool_id = ?3",
            params![
                format!("+{FILL_REQUEST_SECONDS} seconds"),
                attempt_id,
                active.id
            ],
        )
        .map_err(|error| format!("创建发布填充任务失败: {error}"))?;
        read_publish_outbox_by_id(&conn, attempt_id)
            .map_err(|error| format!("读取发布填充任务失败: {error}"))?
            .ok_or_else(|| "发布填充任务写入后无法读取".to_string())
    }

    /// 扩展只在用户点击 popup 且当前标签页是创作页时调用；一次只锁定一条任务。
    pub fn claim_browser_publish_fill_task(
        &self,
        expected_account_id: i64,
    ) -> Result<Option<BrowserPublishFillClaim>, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, expected_account_id)
            .map_err(|error| format!("校验填充目标账号失败: {error}"))?;
        conn.execute(
            "UPDATE publish_outbox
             SET fill_status = 'expired', fill_claim_token = NULL,
                 fill_claim_expires_at = NULL, updated_at = datetime('now', 'localtime')
             WHERE account_pool_id = ?1
               AND fill_status IN ('queued', 'partial', 'claimed')
               AND fill_expires_at <= datetime('now', 'localtime')",
            params![expected_account_id],
        )
        .map_err(|error| format!("清理过期填充任务失败: {error}"))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("锁定填充任务失败: {error}"))?;
        let attempt_id: Option<String> = tx
            .query_row(
                "SELECT attempt_id FROM publish_outbox
                 WHERE account_pool_id = ?1 AND status = 'prepared'
                   AND fill_expires_at > datetime('now', 'localtime')
                   AND (fill_status = 'queued'
                        OR (fill_status IN ('partial', 'claimed')
                            AND (fill_claim_expires_at IS NULL
                                 OR fill_claim_expires_at <= datetime('now', 'localtime'))))
                 ORDER BY updated_at ASC, rowid ASC LIMIT 1",
                params![expected_account_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("查找待填充任务失败: {error}"))?;
        let Some(attempt_id) = attempt_id else {
            tx.commit()
                .map_err(|error| format!("结束填充任务查询失败: {error}"))?;
            return Ok(None);
        };
        let token = new_claim_token()?;
        tx.execute(
            "UPDATE publish_outbox
             SET fill_status = 'claimed', fill_claim_token = ?1,
                 fill_claim_expires_at = datetime('now', 'localtime', ?2),
                 updated_at = datetime('now', 'localtime')
             WHERE attempt_id = ?3 AND account_pool_id = ?4",
            params![
                token,
                format!("+{FILL_CLAIM_SECONDS} seconds"),
                attempt_id,
                expected_account_id
            ],
        )
        .map_err(|error| format!("领取填充任务失败: {error}"))?;
        let entry = read_publish_outbox_by_id(&tx, &attempt_id)
            .map_err(|error| format!("读取已领取任务失败: {error}"))?
            .ok_or_else(|| "已领取任务无法读取".to_string())?;
        let claim_expires_at: String = tx
            .query_row(
                "SELECT fill_claim_expires_at FROM publish_outbox WHERE attempt_id = ?1",
                params![attempt_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("读取填充授权期限失败: {error}"))?;
        let task = task_from_outbox(entry)?;
        let _ = validated_image_metadata(
            self,
            &tx,
            &read_publish_outbox_by_id(&tx, &attempt_id)
                .map_err(|error| format!("校验发布快照素材失败: {error}"))?
                .ok_or_else(|| "已领取任务无法读取".to_string())?,
        )?;
        let claimed_entry = read_publish_outbox_by_id(&tx, &attempt_id)
            .map_err(|error| format!("校验发布快照视频失败: {error}"))?
            .ok_or_else(|| "已领取任务无法读取".to_string())?;
        if let Some((path, metadata)) = managed_video_source(self, &tx, &claimed_entry)? {
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if !video_signature_matches(&path, extension)? {
                return Err("视频内容与文件类型签名不匹配".to_string());
            }
            verify_video_digest(&path, metadata["sha256"].as_str().unwrap_or_default())?;
        }
        tx.commit()
            .map_err(|error| format!("提交填充任务领取失败: {error}"))?;
        Ok(Some(BrowserPublishFillClaim {
            task,
            claim_token: token,
            claim_expires_at,
        }))
    }

    /// 保存字段级结果；只记本地填充状态，不代表平台提交或发布成功。
    pub fn finish_browser_publish_fill_task(
        &self,
        result: BrowserPublishFillResult<'_>,
    ) -> Result<PublishOutboxSummary, String> {
        let BrowserPublishFillResult {
            attempt_id,
            expected_account_id,
            claim_token,
            title_status,
            title_error,
            body_status,
            body_error,
            image_results,
            video_status,
            video_error,
            cancelled,
        } = result;
        if attempt_id.trim().is_empty() || claim_token.len() != 64 {
            return Err("填充任务或授权令牌无效".to_string());
        }
        let valid_result = |status: &str| matches!(status, "filled" | "failed" | "skipped");
        if !valid_result(title_status) || !valid_result(body_status) || !valid_result(video_status)
        {
            return Err("填充字段结果无效".to_string());
        }
        let title_error = title_error
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect::<String>();
        let body_error = body_error
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect::<String>();
        let video_error = video_error
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect::<String>();
        let conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_capture_account(&conn, expected_account_id)
            .map_err(|error| format!("校验填充目标账号失败: {error}"))?;
        let entry = read_publish_outbox_by_id(&conn, attempt_id)
            .map_err(|error| format!("读取发布填充任务失败: {error}"))?
            .ok_or_else(|| "发布填充任务不存在".to_string())?;
        if entry.account_pool_id != expected_account_id || entry.status != "prepared" {
            return Err("发布填充任务账号无效或已提交，拒绝更新".to_string());
        }
        let stored_token: Option<String> = conn
            .query_row(
                "SELECT fill_claim_token
                 FROM publish_outbox WHERE attempt_id = ?1 AND account_pool_id = ?2",
                params![attempt_id, expected_account_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("校验填充授权失败: {error}"))?;
        if stored_token.as_deref() != Some(claim_token) {
            return Err("填充授权已失效，请重新领取任务".to_string());
        }
        let claim_expired: bool = conn
            .query_row(
                "SELECT fill_claim_expires_at IS NULL
                     OR fill_claim_expires_at <= datetime('now', 'localtime')
                 FROM publish_outbox WHERE attempt_id = ?1 AND account_pool_id = ?2",
                params![attempt_id, expected_account_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("读取填充授权期限失败: {error}"))?;
        if claim_expired {
            return Err("填充授权已过期，请重新领取任务".to_string());
        }
        let current_item_ids = note_item_ids_for_version(
            &conn,
            entry.note_id,
            expected_account_id,
            entry.content_version,
        )?;
        if current_item_ids != snapshot_item_ids(&entry)? {
            return Err("笔记素材顺序已变化，拒绝保存过期填充结果".to_string());
        }
        let mut previous = serde_json::from_str::<serde_json::Value>(&entry.fill_result_json)
            .unwrap_or_else(|_| serde_json::json!({}));
        if !previous.is_object() {
            previous = serde_json::json!({});
        }
        if cancelled {
            conn.execute(
                "UPDATE publish_outbox SET fill_status = 'cancelled',
                    fill_claim_token = NULL, fill_claim_expires_at = NULL,
                    fill_result_json = ?1, updated_at = datetime('now', 'localtime')
                 WHERE attempt_id = ?2 AND account_pool_id = ?3",
                params![
                    "{\"cancelled\":true}".to_string(),
                    attempt_id,
                    expected_account_id
                ],
            )
            .map_err(|error| format!("取消填充任务失败: {error}"))?;
        } else {
            for (field, status, error) in [
                ("title", title_status, title_error.as_str()),
                ("body", body_status, body_error.as_str()),
            ] {
                if status != "skipped" {
                    previous[field] = serde_json::json!({
                        "status": status,
                        "error": if error.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(error.to_string()) },
                    });
                }
            }
            if image_results.len() > 9 {
                return Err("图片填充回执超过单条任务上限".to_string());
            }
            let snapshot: serde_json::Value = serde_json::from_str(&entry.snapshot_json)
                .map_err(|_| "发布快照不是有效 JSON".to_string())?;
            let is_video =
                snapshot.get("noteType").and_then(serde_json::Value::as_str) == Some("video");
            let allowed_ids = if is_video {
                Vec::new()
            } else {
                snapshot_item_ids(&entry)?
            };
            let mut stored_images = previous["images"]["items"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|item| {
                    item.get("itemId")
                        .and_then(serde_json::Value::as_i64)
                        .map(|id| (id, item))
                })
                .collect::<std::collections::BTreeMap<_, _>>();
            let mut seen_results = HashSet::new();
            for result in image_results {
                let item_id = result
                    .get("itemId")
                    .and_then(serde_json::Value::as_i64)
                    .ok_or_else(|| "图片填充回执缺少素材 ID".to_string())?;
                let status = result
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                if !allowed_ids.contains(&item_id)
                    || !seen_results.insert(item_id)
                    || !valid_result(status)
                {
                    return Err("图片填充回执与当前发布快照不匹配".to_string());
                }
                if status != "skipped" {
                    let error = result
                        .get("error")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .chars()
                        .take(300)
                        .collect::<String>();
                    stored_images.insert(
                        item_id,
                        serde_json::json!({
                            "itemId": item_id,
                            "status": status,
                            "error": if error.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(error) },
                        }),
                    );
                }
            }
            let ordered_images = allowed_ids
                .iter()
                .map(|item_id| {
                    stored_images.get(item_id).cloned().unwrap_or_else(|| {
                        serde_json::json!({"itemId": item_id, "status": "pending", "error": null})
                    })
                })
                .collect::<Vec<_>>();
            let images_done = ordered_images
                .iter()
                .all(|image| image["status"] == "filled");
            let images_status = if images_done {
                "filled"
            } else if ordered_images
                .iter()
                .any(|image| image["status"] == "filled")
            {
                "partial"
            } else {
                "failed"
            };
            previous["images"] = serde_json::json!({
                "status": images_status,
                "count": ordered_images.len(),
                "items": ordered_images,
            });
            if video_status != "skipped" {
                previous["video"] = serde_json::json!({
                    "status": video_status,
                    "error": if video_error.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(video_error) },
                });
            }
            let title_done = previous["title"]["status"] == "filled";
            let body_done = previous["body"]["status"] == "filled";
            let video_done = !is_video || previous["video"]["status"] == "filled";
            let fill_status = if title_done && body_done && images_done && video_done {
                "filled"
            } else {
                "partial"
            };
            conn.execute(
                "UPDATE publish_outbox SET fill_status = ?1, fill_result_json = ?2,
                    fill_claim_token = CASE WHEN ?1 = 'filled' THEN NULL ELSE fill_claim_token END,
                    fill_claim_expires_at = CASE WHEN ?1 = 'filled' THEN NULL ELSE fill_claim_expires_at END,
                    updated_at = datetime('now', 'localtime')
                 WHERE attempt_id = ?3 AND account_pool_id = ?4",
                params![fill_status, previous.to_string(), attempt_id, expected_account_id],
            )
            .map_err(|error| format!("保存填充结果失败: {error}"))?;
        }
        read_publish_outbox_by_id(&conn, attempt_id)
            .map_err(|error| format!("读取填充结果失败: {error}"))?
            .ok_or_else(|| "填充结果保存后无法读取".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db() -> (LocalDb, std::path::PathBuf) {
        static NEXT_TEMP_DB_ID: AtomicU64 = AtomicU64::new(0);
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let sequence = NEXT_TEMP_DB_ID.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "aichihongshu-publish-fill-{}-{suffix}-{sequence}",
            std::process::id()
        ));
        let db = LocalDb::open(dir.join("app.db")).expect("open local db");
        (db, dir)
    }

    fn create_fill_task(db: &LocalDb, attempt_id: &str) -> i64 {
        let conn = db.connect().expect("connect db");
        conn.execute(
            "INSERT OR IGNORE INTO account_pool (id, alias, role, user_data_dir, status)
             VALUES (2, 'QA-B', 'operation', 'browser_profiles/QA-B', 'active')",
            [],
        )
        .expect("insert QA-B once");
        drop(conn);
        db.activate_account(2).expect("activate QA-B");
        let note = db
            .create_local_draft_for_account("待填充标题", Some(2))
            .expect("create QA-B note");
        let note = db
            .update_local_note(LocalNoteUpdate {
                note_id: note.id,
                account_pool_id: 2,
                expected_version: note.content_version,
                title: "待填充标题".to_string(),
                body: "第一段正文".to_string(),
                tags: vec!["测试话题".to_string()],
                note_type: "text".to_string(),
                item_ids: Vec::new(),
                video_path: None,
            })
            .expect("update QA-B note");
        let entry = db
            .prepare_local_publish(LocalPublishOutboxPrepare {
                attempt_id: attempt_id.to_string(),
                account_pool_id: 2,
                note_id: note.id,
                snapshot_key: format!("2:note:{}:v{}", note.id, note.content_version),
                content_version: note.content_version,
                snapshot_json: serde_json::json!({
                    "title": "待填充标题",
                    "body": "第一段正文",
                    "tags": ["测试话题"],
                    "itemIds": []
                })
                .to_string(),
            })
            .expect("prepare QA-B outbox");
        db.request_local_publish_fill(&entry.attempt_id, 2)
            .expect("queue single browser fill task");
        db.activate_account(1).expect("restore QA-A active account");
        note.id
    }

    fn create_image_fill_task(db: &LocalDb, attempt_id: &str) -> (i64, Vec<i64>, Vec<Vec<u8>>) {
        let conn = db.connect().expect("connect db");
        conn.execute(
            "INSERT OR IGNORE INTO account_pool (id, alias, role, user_data_dir, status)
             VALUES (2, 'QA-B', 'operation', 'browser_profiles/QA-B', 'active')",
            [],
        )
        .expect("insert QA-B once");
        drop(conn);
        db.activate_account(2).expect("activate QA-B");
        let png = b"\x89PNG\r\n\x1a\nsmall test image".to_vec();
        let item = db
            .import_local_image_for_account(
                2,
                LocalImageImport {
                    account_pool_id: 2,
                    file_name: "red.png".to_string(),
                    mime_type: Some("image/png".to_string()),
                    data_base64: STANDARD.encode(&png),
                    thumbnail_data_base64: None,
                },
            )
            .expect("import managed image");
        let png_second = b"\x89PNG\r\n\x1a\nsecond image".to_vec();
        let second_item = db
            .import_local_image_for_account(
                2,
                LocalImageImport {
                    account_pool_id: 2,
                    file_name: "blue.png".to_string(),
                    mime_type: Some("image/png".to_string()),
                    data_base64: STANDARD.encode(&png_second),
                    thumbnail_data_base64: None,
                },
            )
            .expect("import second managed image");
        let note = db
            .create_local_draft_for_account("图片任务标题", Some(2))
            .expect("create image draft");
        let note = db
            .update_local_note(LocalNoteUpdate {
                note_id: note.id,
                account_pool_id: 2,
                expected_version: note.content_version,
                title: "图片任务标题".to_string(),
                body: "含图片正文".to_string(),
                tags: vec![],
                note_type: "image".to_string(),
                item_ids: vec![item.id, second_item.id],
                video_path: None,
            })
            .expect("associate image to note");
        let entry = db
            .prepare_local_publish(LocalPublishOutboxPrepare {
                attempt_id: attempt_id.to_string(),
                account_pool_id: 2,
                note_id: note.id,
                snapshot_key: format!("2:note:{}:v{}", note.id, note.content_version),
                content_version: note.content_version,
                snapshot_json: serde_json::json!({
                    "title": "图片任务标题",
                    "body": "含图片正文",
                    "tags": [],
                    "itemIds": [item.id, second_item.id]
                })
                .to_string(),
            })
            .expect("prepare image outbox");
        db.request_local_publish_fill(&entry.attempt_id, 2)
            .expect("queue image fill task");
        db.activate_account(1).expect("restore QA-A active account");
        (
            note.id,
            vec![item.id, second_item.id],
            vec![png, png_second],
        )
    }

    #[test]
    fn browser_fill_task_is_single_account_scoped_and_retryable() {
        let (db, dir) = temp_db();
        let note_id = create_fill_task(&db, "fill-single-1");
        assert_eq!(db.current_active_account().expect("active account").id, 1);

        let claim = db
            .claim_browser_publish_fill_task(2)
            .expect("claim selected QA-B task")
            .expect("one queued task");
        assert_eq!(claim.task.account_pool_id, 2);
        assert_eq!(claim.task.tags, vec!["测试话题"]);
        assert_eq!(claim.task.fill_status, "claimed");
        assert!(db
            .claim_browser_publish_fill_task(2)
            .expect("second claim while leased")
            .is_none());

        assert!(
            db.finish_browser_publish_fill_task(BrowserPublishFillResult {
                attempt_id: &claim.task.attempt_id,
                expected_account_id: 1,
                claim_token: &claim.claim_token,
                title_status: "filled",
                title_error: None,
                body_status: "filled",
                body_error: None,
                image_results: &[],
                video_status: "skipped",
                video_error: None,
                cancelled: false,
            })
            .is_err(),
            "a selected task cannot be written under another account"
        );
        assert!(
            db.finish_browser_publish_fill_task(BrowserPublishFillResult {
                attempt_id: &claim.task.attempt_id,
                expected_account_id: 2,
                claim_token: "wrong-token",
                title_status: "filled",
                title_error: None,
                body_status: "filled",
                body_error: None,
                image_results: &[],
                video_status: "skipped",
                video_error: None,
                cancelled: false,
            })
            .is_err(),
            "an invalid capability token is rejected"
        );

        let partial = db
            .finish_browser_publish_fill_task(BrowserPublishFillResult {
                attempt_id: &claim.task.attempt_id,
                expected_account_id: 2,
                claim_token: &claim.claim_token,
                title_status: "filled",
                title_error: None,
                body_status: "failed",
                body_error: Some("正文编辑框未找到"),
                image_results: &[],
                video_status: "skipped",
                video_error: None,
                cancelled: false,
            })
            .expect("persist field-level partial result");
        assert_eq!(partial.fill_status, "partial");
        let result: serde_json::Value = serde_json::from_str(&partial.fill_result_json).unwrap();
        assert_eq!(result["title"]["status"], "filled");
        assert_eq!(result["body"]["status"], "failed");
        assert_eq!(result["body"]["error"], "正文编辑框未找到");

        let retried = db
            .finish_browser_publish_fill_task(BrowserPublishFillResult {
                attempt_id: &claim.task.attempt_id,
                expected_account_id: 2,
                claim_token: &claim.claim_token,
                title_status: "skipped",
                title_error: None,
                body_status: "filled",
                body_error: None,
                image_results: &[],
                video_status: "skipped",
                video_error: None,
                cancelled: false,
            })
            .expect("retry failed body field");
        assert_eq!(retried.fill_status, "filled");
        let result: serde_json::Value = serde_json::from_str(&retried.fill_result_json).unwrap();
        assert_eq!(
            result["title"]["status"], "filled",
            "retry preserves the successful title"
        );
        assert_eq!(result["body"]["status"], "filled");
        assert_eq!(
            db.current_active_account()
                .expect("active account unchanged")
                .id,
            1
        );

        let reopened = LocalDb::open(db.path.clone()).expect("reopen fill db");
        let conn = reopened.connect().expect("query reopened fill db");
        let stored: (String, String) = conn
            .query_row(
                "SELECT fill_status, fill_result_json FROM publish_outbox WHERE attempt_id = 'fill-single-1' AND note_id = ?1",
                params![note_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read persisted fill result");
        assert_eq!(stored.0, "filled");
        let result: serde_json::Value = serde_json::from_str(&stored.1).unwrap();
        assert_eq!(result["body"]["status"], "filled");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn browser_fill_task_expires_and_cancel_clears_the_lease() {
        let (db, dir) = temp_db();
        let _note_id = create_fill_task(&db, "fill-expired-1");
        let conn = db.connect().expect("connect db");
        conn.execute(
            "UPDATE publish_outbox SET fill_expires_at = datetime('now', 'localtime', '-1 minute')
             WHERE attempt_id = 'fill-expired-1'",
            [],
        )
        .expect("expire queued task");
        assert!(db
            .claim_browser_publish_fill_task(2)
            .expect("expired task query")
            .is_none());
        let status: String = conn
            .query_row(
                "SELECT fill_status FROM publish_outbox WHERE attempt_id = 'fill-expired-1'",
                [],
                |row| row.get(0),
            )
            .expect("read expired status");
        assert_eq!(status, "expired");

        create_fill_task(&db, "fill-cancel-1");
        let claim = db
            .claim_browser_publish_fill_task(2)
            .expect("claim task to cancel")
            .expect("queued task exists");
        let cancelled = db
            .finish_browser_publish_fill_task(BrowserPublishFillResult {
                attempt_id: &claim.task.attempt_id,
                expected_account_id: 2,
                claim_token: &claim.claim_token,
                title_status: "skipped",
                title_error: None,
                body_status: "skipped",
                body_error: None,
                image_results: &[],
                video_status: "skipped",
                video_error: None,
                cancelled: true,
            })
            .expect("cancel claimed task");
        assert_eq!(cancelled.fill_status, "cancelled");
        assert_eq!(
            db.current_active_account()
                .expect("active account unchanged")
                .id,
            1
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn browser_publish_fill_reads_only_ordered_account_scoped_chunks_and_retries_image_results() {
        let (db, dir) = temp_db();
        let (_note_id, item_ids, originals) = create_image_fill_task(&db, "fill-image-1");
        let item_id = item_ids[0];
        let original = &originals[0];
        let claim = db
            .claim_browser_publish_fill_task(2)
            .expect("claim image task")
            .expect("image task available");
        let images = db
            .browser_publish_fill_task_images(&claim.task.attempt_id, 2, &claim.claim_token)
            .expect("list associated image metadata");
        assert_eq!(images.len(), 2);
        assert_eq!(images[0]["itemId"], item_id);
        assert_eq!(images[0]["filename"], "image-01.png");
        assert_eq!(images[1]["itemId"], item_ids[1]);
        assert_eq!(images[1]["filename"], "image-02.png");
        assert_eq!(images[0]["totalBytes"], original.len());
        assert!(
            images[0].get("path").is_none(),
            "local paths never leave the database"
        );

        let first = db
            .read_browser_publish_fill_image_chunk(
                &claim.task.attempt_id,
                2,
                &claim.claim_token,
                item_id,
                0,
                8,
            )
            .expect("read first bounded chunk");
        assert_eq!(first["dataBase64"], STANDARD.encode(&original[..8]));
        assert!(!first["done"].as_bool().unwrap());
        let second = db
            .read_browser_publish_fill_image_chunk(
                &claim.task.attempt_id,
                2,
                &claim.claim_token,
                item_id,
                8,
                MAX_FILL_IMAGE_CHUNK_BYTES,
            )
            .expect("read final bounded chunk");
        assert_eq!(second["dataBase64"], STANDARD.encode(&original[8..]));
        assert!(second["done"].as_bool().unwrap());
        assert!(db
            .read_browser_publish_fill_image_chunk(
                &claim.task.attempt_id,
                1,
                &claim.claim_token,
                item_id,
                0,
                8,
            )
            .is_err());
        assert!(db
            .read_browser_publish_fill_image_chunk(
                &claim.task.attempt_id,
                2,
                &claim.claim_token,
                item_id + 1000,
                0,
                8,
            )
            .is_err());
        assert!(db
            .read_browser_publish_fill_image_chunk(
                &claim.task.attempt_id,
                2,
                &claim.claim_token,
                item_id,
                original.len() as u64 + 1,
                8,
            )
            .is_err());
        assert!(db
            .read_browser_publish_fill_image_chunk(
                &claim.task.attempt_id,
                2,
                &claim.claim_token,
                item_id,
                0,
                MAX_FILL_IMAGE_CHUNK_BYTES + 1,
            )
            .is_err());

        let failed = db
            .finish_browser_publish_fill_task(
                BrowserPublishFillResult {
                    attempt_id: &claim.task.attempt_id,
                    expected_account_id: 2,
                    claim_token: &claim.claim_token,
                    title_status: "filled",
                    title_error: None,
                    body_status: "filled",
                    body_error: None,
                    image_results: &[
                        serde_json::json!({"itemId": item_id, "status": "failed", "error": "文件框未接收"}),
                        serde_json::json!({"itemId": item_ids[1], "status": "failed", "error": "文件框未接收"}),
                    ],
                    video_status: "skipped",
                    video_error: None,
                    cancelled: false,
                }
            )
            .expect("persist per-image failure");
        assert_eq!(failed.fill_status, "partial");
        let retried = db
            .finish_browser_publish_fill_task(BrowserPublishFillResult {
                attempt_id: &claim.task.attempt_id,
                expected_account_id: 2,
                claim_token: &claim.claim_token,
                title_status: "skipped",
                title_error: None,
                body_status: "skipped",
                body_error: None,
                image_results: &[
                    serde_json::json!({"itemId": item_id, "status": "filled"}),
                    serde_json::json!({"itemId": item_ids[1], "status": "filled"}),
                ],
                video_status: "skipped",
                video_error: None,
                cancelled: false,
            })
            .expect("retry failed image only");
        assert_eq!(retried.fill_status, "filled");
        let persisted: serde_json::Value = serde_json::from_str(&retried.fill_result_json).unwrap();
        assert_eq!(persisted["images"]["items"][0]["status"], "filled");
        assert_eq!(persisted["images"]["items"][0]["itemId"], item_id);
        assert_eq!(persisted["images"]["items"][1]["itemId"], item_ids[1]);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn browser_publish_fill_transfers_account_scoped_video_and_requires_video_receipt() {
        let (db, dir) = temp_db();
        let conn = db.connect().expect("connect db");
        conn.execute(
            "INSERT OR IGNORE INTO account_pool (id, alias, role, user_data_dir, status)
             VALUES (2, 'QA-B', 'operation', 'browser_profiles/QA-B', 'active')",
            [],
        )
        .expect("insert QA-B once");
        drop(conn);
        db.activate_account(2).expect("activate QA-B");
        let note = db
            .create_local_draft_for_account("视频任务标题", Some(2))
            .expect("create video draft");
        let video_bytes = [
            0, 0, 0, 24, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0, 0, 0, 1,
        ];
        let imported = db
            .import_local_video_chunk(LocalVideoImportChunk {
                note_id: note.id,
                account_pool_id: 2,
                expected_version: note.content_version,
                upload_id: "00000000-0000-0000-0000-000000000001".to_string(),
                filename: "clip.mp4".to_string(),
                mime_type: "video/mp4".to_string(),
                total_bytes: video_bytes.len() as u64,
                offset: 0,
                data_base64: STANDARD.encode(video_bytes),
                done: true,
            })
            .expect("import managed video");
        let video_note = imported.note.expect("video import returns updated note");
        let video_path = video_note.video_path.expect("managed video path");
        let entry = db
            .prepare_local_publish(LocalPublishOutboxPrepare {
                attempt_id: "fill-video-1".to_string(),
                account_pool_id: 2,
                note_id: note.id,
                snapshot_key: format!("2:note:{}:v{}", note.id, video_note.content_version),
                content_version: video_note.content_version,
                snapshot_json: serde_json::json!({
                    "title": "视频任务标题",
                    "body": "视频正文",
                    "tags": [],
                    "itemIds": [],
                    "noteType": "video",
                    "videoPath": video_path,
                })
                .to_string(),
            })
            .expect("prepare video outbox");
        db.request_local_publish_fill(&entry.attempt_id, 2)
            .expect("queue video fill task");
        db.activate_account(1).expect("restore QA-A active account");

        let claim = db
            .claim_browser_publish_fill_task(2)
            .expect("claim video task")
            .expect("video task available");
        assert_eq!(claim.task.image_count, 0);
        assert!(db
            .browser_publish_fill_task_images(&claim.task.attempt_id, 2, &claim.claim_token)
            .expect("video task has no image transfer list")
            .is_empty());
        let metadata = db
            .browser_publish_fill_task_video(&claim.task.attempt_id, 2, &claim.claim_token)
            .expect("read video metadata")
            .expect("video metadata available");
        assert_eq!(metadata["totalBytes"], video_bytes.len());
        assert_eq!(
            metadata["filename"],
            format!("{}.mp4", metadata["sha256"].as_str().unwrap())
        );
        assert!(
            metadata.get("path").is_none(),
            "local path never leaves the database"
        );
        let chunk = db
            .read_browser_publish_fill_video_chunk(
                &claim.task.attempt_id,
                2,
                &claim.claim_token,
                0,
                8,
            )
            .expect("read bounded video chunk");
        assert_eq!(chunk["dataBase64"], STANDARD.encode(&video_bytes[..8]));
        assert!(!chunk["done"].as_bool().unwrap());
        assert!(db
            .read_browser_publish_fill_video_chunk(
                &claim.task.attempt_id,
                1,
                &claim.claim_token,
                0,
                8,
            )
            .is_err());

        let partial = db
            .finish_browser_publish_fill_task(BrowserPublishFillResult {
                attempt_id: &claim.task.attempt_id,
                expected_account_id: 2,
                claim_token: &claim.claim_token,
                title_status: "filled",
                title_error: None,
                body_status: "filled",
                body_error: None,
                image_results: &[],
                video_status: "failed",
                video_error: Some("视频文件框未接受"),
                cancelled: false,
            })
            .expect("persist failed video receipt");
        assert_eq!(partial.fill_status, "partial");
        let result: serde_json::Value = serde_json::from_str(&partial.fill_result_json).unwrap();
        assert_eq!(result["video"]["status"], "failed");

        let retried = db
            .finish_browser_publish_fill_task(BrowserPublishFillResult {
                attempt_id: &claim.task.attempt_id,
                expected_account_id: 2,
                claim_token: &claim.claim_token,
                title_status: "skipped",
                title_error: None,
                body_status: "skipped",
                body_error: None,
                image_results: &[],
                video_status: "filled",
                video_error: None,
                cancelled: false,
            })
            .expect("persist successful video retry");
        assert_eq!(retried.fill_status, "filled");
        let result: serde_json::Value = serde_json::from_str(&retried.fill_result_json).unwrap();
        assert_eq!(result["video"]["status"], "filled");
        assert_eq!(result["images"]["count"], 0);
        fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn browser_publish_fill_rejects_symlinked_assets_root() {
        let (db, dir) = temp_db();
        create_image_fill_task(&db, "fill-image-symlink");
        let assets = dir.join("assets");
        let renamed = dir.join("assets-store");
        fs::rename(&assets, &renamed).expect("move managed asset directory");
        std::os::unix::fs::symlink(&renamed, &assets).expect("create symlinked assets root");
        assert!(db.claim_browser_publish_fill_task(2).is_err());
        fs::remove_dir_all(dir).ok();
    }
}
