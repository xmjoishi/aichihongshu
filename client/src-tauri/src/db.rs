use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Rust 本地数据层使用传入的 SQLite 数据库路径。
///
/// 开发态可以复用项目已有的 `data/app.db`，让桌面端直接看到历史数据；
/// 发布态由宿主传入应用数据目录中的数据库。该层不会复制浏览器目录、Cookie 或登录态。
pub struct LocalDb {
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAccount {
    pub id: i64,
    pub alias: String,
    pub role: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolAccount {
    pub id: i64,
    pub alias: String,
    pub role: String,
    pub display_name: Option<String>,
    pub is_active: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub id: i64,
    pub account_pool_id: i64,
    pub account_id: Option<String>,
    pub display_name: Option<String>,
    pub niche: Option<String>,
    pub target_audience: Option<String>,
    pub content_pillars: Vec<String>,
    pub persona_name: Option<String>,
    pub persona_bio: Option<String>,
    pub persona_tone: Option<String>,
    pub persona_taboos: Vec<String>,
    pub followers: i64,
    pub total_notes: i64,
    pub total_likes: i64,
    pub total_collects: i64,
    pub avg_likes: f64,
    pub avg_comments: f64,
    pub avg_collects: f64,
    pub preferred_styles: Vec<String>,
    pub preferred_scenes: Vec<String>,
    pub hashtag_pool: Vec<String>,
    pub posting_rhythm: Option<String>,
    pub avatar_url: Option<String>,
    pub xhs_bio: Option<String>,
    pub xhs_follows: i64,
    pub ip_location: Option<String>,
    pub xhs_tags: Vec<String>,
    pub crawled_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    pub id: i64,
    pub title: String,
    pub image_path: String,
    pub thumbnail_path: Option<String>,
    pub tags: Vec<String>,
    pub style: Option<String>,
    pub material: Option<String>,
    pub scene: Option<String>,
    pub color: Option<String>,
    pub analysis_raw: Option<String>,
    pub note_count: i64,
    pub created_at: Option<String>,
    pub image_version: i64,
    pub content_hash: Option<String>,
    pub metadata_version: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: i64,
    pub item_id: Option<i64>,
    pub item_ids: Vec<i64>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub tags: Vec<String>,
    pub status: String,
    pub note_type: String,
    pub likes: i64,
    pub comments: i64,
    pub collects: i64,
    pub published_at: Option<String>,
    pub note_url: Option<String>,
    pub account_ref: Option<String>,
    pub cover_desc: Option<String>,
    pub prompt_used: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub content_version: i64,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionTaskSummary {
    pub task_id: String,
    pub client_task_id: Option<String>,
    pub account_pool_id: i64,
    pub status: String,
    pub topic: Option<String>,
    pub item_ids: Vec<i64>,
    pub note_id: Option<i64>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub tags: Vec<String>,
    pub content_version: Option<i64>,
    pub publish_status: Option<String>,
    pub publish_note_url: Option<String>,
    pub publish_message: Option<String>,
    pub error: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeItemsResult {
    pub purged_ids: Vec<i64>,
    pub cleanup_warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNoteUpdate {
    pub note_id: i64,
    pub account_pool_id: i64,
    pub expected_version: i64,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub note_type: String,
    pub item_ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNoteStatusUpdate {
    pub note_id: i64,
    pub account_pool_id: i64,
    pub expected_version: i64,
    pub status: String,
    pub note_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishOutboxSummary {
    pub attempt_id: String,
    pub account_pool_id: i64,
    pub note_id: i64,
    pub snapshot_key: String,
    pub content_version: i64,
    pub snapshot_json: String,
    pub status: String,
    pub platform_url: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalPublishOutboxPrepare {
    pub attempt_id: String,
    pub account_pool_id: i64,
    pub note_id: i64,
    pub snapshot_key: String,
    pub content_version: i64,
    pub snapshot_json: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalPublishOutboxUpdate {
    pub attempt_id: String,
    pub account_pool_id: i64,
    pub status: String,
    pub platform_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedImageFile {
    pub index: i64,
    pub filename: String,
    pub item_id: i64,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedImagesSummary {
    pub note_id: i64,
    pub stage_dir: String,
    pub files: Vec<StagedImageFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNoteItemsUpdate {
    pub note_id: i64,
    pub account_pool_id: i64,
    pub expected_version: i64,
    pub item_ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAccountCreate {
    pub alias: String,
    pub role: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAccountUpdate {
    pub account_id: i64,
    pub alias: String,
    pub role: String,
    pub display_name: Option<String>,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProfileUpdate {
    pub account_pool_id: i64,
    pub account_id: Option<String>,
    pub display_name: Option<String>,
    pub niche: Option<String>,
    pub target_audience: Option<String>,
    pub content_pillars: Vec<String>,
    pub persona_name: Option<String>,
    pub persona_bio: Option<String>,
    pub persona_tone: Option<String>,
    pub persona_taboos: Vec<String>,
    pub preferred_styles: Vec<String>,
    pub preferred_scenes: Vec<String>,
    pub hashtag_pool: Vec<String>,
    pub posting_rhythm: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalInspirationCreate {
    pub id: String,
    pub account_pool_id: i64,
    pub title: String,
    pub source_url: String,
    pub body: String,
    pub observed_at: String,
    pub reason: String,
    pub dedupe_key: Option<String>,
    /// note_material | profile_material | web_material
    pub material_type: Option<String>,
    pub author: Option<String>,
    pub capture_modules: Option<Vec<String>>,
}

/// 页面快照指标。缺失为 None，入库为 NULL，禁止用 0 冒充未采集。
#[derive(Debug, Default, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PageSnapshotMetrics {
    pub like: Option<i64>,
    pub collect: Option<i64>,
    pub comment: Option<i64>,
    pub followers: Option<i64>,
    pub note_count: Option<i64>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PageSnapshotCreate {
    pub account_pool_id: i64,
    /// note_snapshot | ref_snapshot | clip
    pub kind: String,
    pub source_url: String,
    pub title: String,
    pub author: String,
    pub body_excerpt: String,
    pub metrics: PageSnapshotMetrics,
    pub reference_account_id: Option<i64>,
    pub request_id: Option<String>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSnapshotSummary {
    pub id: i64,
    pub account_pool_id: i64,
    pub kind: String,
    pub source_url: String,
    pub title: String,
    pub author: String,
    pub body_excerpt: String,
    pub like_count: Option<i64>,
    pub collect_count: Option<i64>,
    pub comment_count: Option<i64>,
    pub metrics_json: String,
    pub note_id: Option<i64>,
    pub reference_account_id: Option<i64>,
    pub request_id: Option<String>,
    pub observed_at: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalKnowledgePreferences {
    pub account_pool_id: i64,
    pub disabled_rule_keys: Vec<String>,
    pub use_my_samples: bool,
    pub use_reference_samples: bool,
    pub use_inspirations: bool,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalKnowledgePreferencesUpdate {
    pub account_pool_id: i64,
    pub disabled_rule_keys: Vec<String>,
    pub use_my_samples: bool,
    pub use_reference_samples: bool,
    pub use_inspirations: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptConfig {
    pub key: String,
    pub label: String,
    pub prompt: String,
    pub sort_order: i64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptConfigUpsert {
    pub account_pool_id: i64,
    pub key: String,
    pub label: String,
    pub prompt: String,
    pub sort_order: i64,
    pub enabled: bool,
}

/// L3 事实记忆条目（定位/表达偏好/事实/事件/内容历史）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: i64,
    pub account_pool_id: i64,
    pub origin: String,
    pub kind: String,
    pub content: String,
    pub subject: String,
    pub scope: String,
    pub source: String,
    pub source_type: String,
    pub occurred_at: Option<String>,
    pub confirm_status: String,
    pub valid_status: String,
    pub enabled: bool,
    pub replaced_by: Option<i64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntryCreate {
    pub account_pool_id: i64,
    pub origin: String,
    pub kind: String,
    pub content: String,
    pub subject: Option<String>,
    pub scope: Option<String>,
    pub source: Option<String>,
    pub source_type: Option<String>,
    pub occurred_at: Option<String>,
    /// 默认 candidate；仅允许 candidate 或 confirmed（手工录入的确定事实）。
    pub confirm_status: Option<String>,
    /// 是否启用注入；默认 true。AI 来源建议 false，由用户开启。
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntryUpdate {
    pub id: i64,
    pub account_pool_id: i64,
    pub kind: String,
    pub content: String,
    pub subject: Option<String>,
    pub scope: Option<String>,
    pub source: Option<String>,
    pub source_type: Option<String>,
    pub occurred_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntryTransition {
    pub id: i64,
    pub account_pool_id: i64,
    pub next_status: String,
    pub replaced_by: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntryFilter {
    pub account_pool_id: Option<i64>,
    pub origin: Option<String>,
    pub kind: Option<String>,
    pub confirm_status: Option<String>,
    /// true=仅启用 / false=仅停用 / 缺省=全部
    pub enabled: Option<bool>,
}

/// L2 用户经验提示词条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperiencePrompt {
    pub id: i64,
    pub account_pool_id: i64,
    pub origin: String,
    pub title: String,
    pub content: String,
    pub enabled: bool,
    pub apply_scope: String,
    pub apply_target: String,
    pub source: String,
    pub sort_order: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperiencePromptUpsert {
    pub account_pool_id: i64,
    pub origin: String,
    /// 空串表示新建；非空表示更新该 id。
    pub id: Option<i64>,
    pub title: String,
    pub content: String,
    pub enabled: bool,
    pub apply_scope: Option<String>,
    pub apply_target: Option<String>,
    pub source: Option<String>,
    pub sort_order: Option<i64>,
}

/// L0/L1 系统经验规则（只读展示；L1 允许覆盖并可恢复默认）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySystemRules {
    pub l0: String,
    pub l1_default: String,
    pub l1_active: String,
    pub l1_is_override: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNoteStatsUpdate {
    pub note_id: i64,
    pub account_pool_id: i64,
    pub expected_version: i64,
    pub field: String,
    pub value: i64,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalReferenceAccountCreate {
    pub account_pool_id: i64,
    pub account_id: String,
    pub name: Option<String>,
    pub followers: i64,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalReferenceAccountUpdate {
    pub id: i64,
    pub account_pool_id: i64,
    pub account_id: String,
    pub name: Option<String>,
    pub followers: i64,
    pub content_style: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalAIRunUpsert {
    pub run_id: String,
    pub account_pool_id: Option<i64>,
    pub note_id: Option<i64>,
    pub item_id: Option<i64>,
    pub provider: String,
    pub started_at: String,
    pub status: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalAIRunUpdate {
    pub run_id: String,
    pub account_pool_id: Option<i64>,
    pub status: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalAIRunArtifactCreate {
    pub run_id: String,
    pub account_pool_id: Option<i64>,
    pub note_id: Option<i64>,
    pub item_id: Option<i64>,
    pub kind: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspirationSummary {
    pub id: String,
    pub account_pool_id: i64,
    pub title: String,
    pub source_url: String,
    pub body: String,
    pub observed_at: String,
    pub reason: String,
    pub status: String,
    pub note_id: Option<i64>,
    pub dedupe_key: Option<String>,
    pub material_type: String,
    pub author: String,
    pub capture_modules: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AIRunSummary {
    pub run_id: String,
    pub account_pool_id: Option<i64>,
    pub note_id: Option<i64>,
    pub item_id: Option<i64>,
    pub provider: String,
    pub started_at: String,
    pub status: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AIRunArtifactSummary {
    pub id: i64,
    pub run_id: String,
    pub account_pool_id: Option<i64>,
    pub note_id: Option<i64>,
    pub item_id: Option<i64>,
    pub kind: String,
    pub content: String,
    pub created_at: Option<String>,
}

/// Extension popup lookup result. The active account is resolved locally and
/// never accepted from the browser extension.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageContext {
    pub match_type: String,
    pub default_action: String,
    pub page_type: String,
    pub snapshot_kind: Option<String>,
    pub reference_account_id: Option<i64>,
    pub matched_title: Option<String>,
    pub last_snapshot_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImageImport {
    pub account_pool_id: i64,
    pub file_name: String,
    pub mime_type: Option<String>,
    pub data_base64: String,
    pub thumbnail_data_base64: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImageRepair {
    pub item_id: i64,
    pub account_pool_id: i64,
    pub expected_image_version: i64,
    pub file_name: String,
    pub mime_type: Option<String>,
    pub data_base64: String,
    pub thumbnail_data_base64: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalItemMetadataUpdate {
    pub item_id: i64,
    pub account_pool_id: i64,
    pub expected_metadata_version: i64,
    pub title: String,
    pub tags: Vec<String>,
    pub style: Option<String>,
    pub material: Option<String>,
    pub scene: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceAccountSummary {
    pub id: i64,
    pub account_id: String,
    pub name: Option<String>,
    pub followers: i64,
    pub total_likes: i64,
    pub note_count: i64,
    pub avg_likes: f64,
    pub avg_comments: f64,
    pub avg_collects: f64,
    pub content_style: Option<String>,
    pub top_notes: Vec<ReferenceNote>,
    pub raw_data: Option<String>,
    pub crawled_at: Option<String>,
    pub analyzed_at: Option<String>,
    pub insights: Option<String>,
    pub insights_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct ReferenceNote {
    pub title: String,
    pub likes: i64,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub database_path: String,
    pub active_account: ActiveAccount,
    pub profile: Option<ProfileSummary>,
    pub item_count: i64,
    pub items: Vec<ItemSummary>,
    pub trash_items: Vec<ItemSummary>,
    /// Item ids whose managed image path is currently missing on disk.
    /// This is computed from the account-scoped snapshot so the UI can offer
    /// repair without attempting to read arbitrary paths from the frontend.
    pub missing_image_ids: Vec<i64>,
    pub note_count: i64,
    pub note_status_counts: BTreeMap<String, i64>,
    pub notes: Vec<NoteSummary>,
    pub trash_notes: Vec<NoteSummary>,
    pub reference_accounts: Vec<ReferenceAccountSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountPoolSnapshot {
    pub items: Vec<PoolAccount>,
}

impl LocalDb {
    pub fn open(path: PathBuf) -> SqlResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| rusqlite::Error::InvalidPath(parent.to_path_buf()))?;
        }

        let db = Self { path };
        let mut conn = db.connect()?;
        migrate(&mut conn)?;
        let active = ensure_active_account(&mut conn, &db.path)?;
        import_legacy_inspirations(&mut conn, active.id)?;
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读取当前激活运营账号，供浏览器剪藏回传等宿主侧链路盖章使用。
    /// 语义与其他读取一致：无激活账号时确保默认账号存在。
    pub fn current_active_account(&self) -> Result<ActiveAccount, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))
    }

    /// 读取当前运营账号可见物品的本地图片，返回 data URL 供桌面 WebView 展示。
    /// 图片路径来自受账号隔离约束的 items 记录，不接受前端任意文件路径。
    pub fn image_data_url(&self, item_id: i64) -> Result<Option<String>, String> {
        self.image_data_url_for_account(item_id, None, "original")
    }

    pub fn image_data_url_for_account(
        &self,
        item_id: i64,
        expected_account_id: Option<i64>,
        variant: &str,
    ) -> Result<Option<String>, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let stored_paths: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT image_path, thumbnail_path FROM items
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![item_id, active.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("读取图片记录失败: {error}"))?;

        let Some((original_path, thumbnail_path)) = stored_paths else {
            return Ok(None);
        };
        let image_path = if variant == "thumbnail" {
            thumbnail_path
                .as_deref()
                .map(|path| self.resolve_image_path(path))
                .filter(|path| path.is_file())
                .unwrap_or_else(|| self.resolve_image_path(&original_path))
        } else {
            self.resolve_image_path(&original_path)
        };
        let bytes = fs::read(&image_path)
            .map_err(|error| format!("读取图片失败（{}）: {error}", image_path.display()))?;
        let extension = image_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime = match extension.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "svg" => "image/svg+xml",
            _ => "application/octet-stream",
        };
        Ok(Some(format!(
            "data:{mime};base64,{}",
            STANDARD.encode(bytes)
        )))
    }

    fn resolve_image_path(&self, stored_path: &str) -> PathBuf {
        let path = PathBuf::from(stored_path);
        if path.is_absolute() {
            return path;
        }

        let db_dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        let project_root = db_dir.parent().unwrap_or(db_dir);
        let candidates = [
            db_dir.join(&path),
            project_root.join(&path),
            project_root.join("assets").join(&path),
            db_dir.join("assets").join(&path),
        ];
        candidates
            .iter()
            .find(|candidate| candidate.is_file())
            .cloned()
            .unwrap_or_else(|| project_root.join("assets").join(path))
    }

    fn connect(&self) -> SqlResult<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             PRAGMA busy_timeout=5000;
             PRAGMA synchronous=NORMAL;
             PRAGMA journal_mode=WAL;",
        )?;
        Ok(conn)
    }

    pub fn snapshot(&self) -> SqlResult<WorkspaceSnapshot> {
        self.snapshot_for_account(None)
    }

    pub fn snapshot_for_account(
        &self,
        expected_account_id: Option<i64>,
    ) -> SqlResult<WorkspaceSnapshot> {
        self.snapshot_section_for_account(expected_account_id, "all")
    }

    /// Read only the data needed by a UI resource. Existing callers keep the full snapshot.
    pub fn snapshot_section_for_account(
        &self,
        expected_account_id: Option<i64>,
        section: &str,
    ) -> SqlResult<WorkspaceSnapshot> {
        let with_items = matches!(section, "all" | "workspace" | "library" | "notes");
        let with_notes = matches!(section, "all" | "workspace" | "notes");
        let with_references = matches!(section, "all" | "workspace" | "references");
        let mut conn = self.connect()?;
        let active = ensure_active_account(&mut conn, &self.path)?;
        ensure_expected_account(&active, expected_account_id)?;

        let profile = conn
            .query_row(
                "SELECT id, account_pool_id, account_id, display_name, niche, target_audience,
                        content_pillars, persona_name, persona_bio, persona_tone, persona_taboos,
                        followers, total_notes, total_likes, total_collects,
                        avg_likes, avg_comments, avg_collects,
                        preferred_styles, preferred_scenes, hashtag_pool, posting_rhythm,
                        avatar_url, xhs_bio, xhs_follows, ip_location, xhs_tags, crawled_at, updated_at
                 FROM my_profile
                 WHERE account_pool_id = ?1
                 ORDER BY id
                 LIMIT 1",
                params![active.id],
                |row| {
                    Ok(ProfileSummary {
                        id: row.get(0)?,
                        account_pool_id: row.get(1)?,
                        account_id: row.get(2)?,
                        display_name: row.get(3)?,
                        niche: row.get(4)?,
                        target_audience: row.get(5)?,
                        content_pillars: parse_json_vec(row.get(6)?),
                        persona_name: row.get(7)?,
                        persona_bio: row.get(8)?,
                        persona_tone: row.get(9)?,
                        persona_taboos: parse_json_vec(row.get(10)?),
                        followers: row.get(11)?,
                        total_notes: row.get(12)?,
                        total_likes: row.get(13)?,
                        total_collects: row.get(14)?,
                        avg_likes: row.get(15)?,
                        avg_comments: row.get(16)?,
                        avg_collects: row.get(17)?,
                        preferred_styles: parse_json_vec(row.get(18)?),
                        preferred_scenes: parse_json_vec(row.get(19)?),
                        hashtag_pool: parse_json_vec(row.get(20)?),
                        posting_rhythm: row.get(21)?,
                        avatar_url: row.get(22)?,
                        xhs_bio: row.get(23)?,
                        xhs_follows: row.get(24)?,
                        ip_location: row.get(25)?,
                        xhs_tags: parse_json_vec(row.get(26)?),
                        crawled_at: row.get(27)?,
                        updated_at: row.get(28)?,
                    })
                },
            )
            .optional()?;

        let item_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM items
             WHERE account_pool_id = ?1 AND deleted_at IS NULL",
            params![active.id],
            |row| row.get(0),
        )?;
        let note_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE account_pool_id = ?1 AND deleted_at IS NULL",
            params![active.id],
            |row| row.get(0),
        )?;
        let note_status_counts = {
            let mut status_stmt = conn.prepare(
                "SELECT status, COUNT(*) FROM notes
                 WHERE account_pool_id = ?1 AND deleted_at IS NULL
                 GROUP BY status
                 ORDER BY status",
            )?;
            let status_rows = status_stmt.query_map(params![active.id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            let mut counts = BTreeMap::new();
            for row in status_rows {
                let (status, count) = row?;
                counts.insert(status, count);
            }
            counts
        };

        let items = if with_items {
            read_item_summaries(&conn, active.id, false)?
        } else {
            Vec::new()
        };
        let trash_items = if matches!(section, "all" | "library") {
            read_item_summaries(&conn, active.id, true)?
        } else {
            Vec::new()
        };
        let missing_image_ids = if matches!(section, "all" | "library") {
            items
                .iter()
                .chain(trash_items.iter())
                .filter(|item| !self.resolve_image_path(&item.image_path).is_file())
                .map(|item| item.id)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        let notes = if with_notes {
            read_note_summaries(&conn, active.id, false)?
        } else {
            Vec::new()
        };
        let trash_notes = if matches!(section, "all" | "notes") {
            read_note_summaries(&conn, active.id, true)?
        } else {
            Vec::new()
        };

        let mut ref_stmt = conn.prepare(
            "SELECT id, account_id, name, followers, total_likes, note_count,
                    avg_likes, avg_comments, avg_collects, content_style, top_notes,
                    raw_data, crawled_at, analyzed_at, insights, insights_at
             FROM reference_accounts
             WHERE account_pool_id = ?1
             ORDER BY id DESC",
        )?;
        let reference_accounts = if with_references {
            ref_stmt
                .query_map(params![active.id], |row| {
                    Ok(ReferenceAccountSummary {
                        id: row.get(0)?,
                        account_id: row.get(1)?,
                        name: row.get(2)?,
                        followers: row.get(3)?,
                        total_likes: row.get(4)?,
                        note_count: row.get(5)?,
                        avg_likes: row.get(6)?,
                        avg_comments: row.get(7)?,
                        avg_collects: row.get(8)?,
                        content_style: row.get(9)?,
                        top_notes: parse_json_vec(row.get(10)?),
                        raw_data: row.get(11)?,
                        crawled_at: row.get(12)?,
                        analyzed_at: row.get(13)?,
                        insights: row.get(14)?,
                        insights_at: row.get(15)?,
                    })
                })?
                .collect::<SqlResult<Vec<_>>>()?
        } else {
            Vec::new()
        };

        Ok(WorkspaceSnapshot {
            database_path: self.path.display().to_string(),
            active_account: active,
            profile,
            item_count,
            items,
            trash_items,
            missing_image_ids,
            note_count,
            note_status_counts,
            notes,
            trash_notes,
            reference_accounts,
        })
    }

    pub fn create_local_draft(&self, title: &str) -> SqlResult<NoteSummary> {
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

        let mut conn = self.connect()?;
        let active = ensure_active_account(&mut conn, &self.path)?;
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
                    cover_desc, prompt_used, created_at, updated_at, content_version, deleted_at
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

    /// 将前端已读取的图片安全写入当前账号素材目录，并在数据库提交失败时清理文件。
    /// 前端不传任意路径；文件名只用于推断类型和标题，落位路径由内容摘要生成。
    pub fn import_local_image(&self, import: LocalImageImport) -> Result<ItemSummary, String> {
        let account_pool_id = import.account_pool_id;
        self.import_local_image_for_account(account_pool_id, import)
    }

    /// 按显式账号导入素材（PC Harness 等宿主侧链路）。不依赖 UI 激活账号，
    /// 但要求目标账号存在，保证任务创建时冻结的账号归属不被切换干扰。
    pub fn import_local_image_for_account(
        &self,
        account_pool_id: i64,
        import: LocalImageImport,
    ) -> Result<ItemSummary, String> {
        let file_name = import.file_name.trim();
        let path = Path::new(file_name);
        let validated = validate_local_image(&import)?;
        let thumbnail_bytes = validate_thumbnail(import.thumbnail_data_base64.as_deref())?;
        let extension = validated.extension.as_str();
        let bytes = validated.bytes.as_slice();
        let hash = validated.hash.as_str();

        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let account_exists: Option<i64> = conn
            .query_row(
                "SELECT id FROM account_pool WHERE id = ?1",
                params![account_pool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("校验导入账号失败: {error}"))?;
        if account_exists.is_none() {
            return Err("导入账号不存在".to_string());
        }

        if let Some(existing) = read_item_by_hash(&conn, account_pool_id, &hash)
            .map_err(|error| format!("检查重复素材失败: {error}"))?
        {
            return Ok(existing);
        }

        let db_dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        let relative_path = format!("assets/{}/{hash}.{extension}", account_pool_id);
        let target_path = db_dir.join(&relative_path);
        let thumbnail_relative_path = thumbnail_bytes
            .as_ref()
            .map(|_| format!("assets/{}/thumbnails/{hash}.jpg", account_pool_id));
        let thumbnail_target_path = thumbnail_relative_path
            .as_deref()
            .map(|relative| db_dir.join(relative));
        let parent = target_path
            .parent()
            .ok_or_else(|| "无法定位素材目录".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("创建素材目录失败: {error}"))?;

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let staging_path = parent.join(format!(".import-{}-{stamp}.staging", std::process::id()));
        {
            let mut staging = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging_path)
                .map_err(|error| format!("创建素材暂存文件失败: {error}"))?;
            if let Err(error) = staging.write_all(&bytes) {
                fs::remove_file(&staging_path).ok();
                return Err(format!("写入素材暂存文件失败: {error}"));
            }
            if let Err(error) = staging.sync_all() {
                fs::remove_file(&staging_path).ok();
                return Err(format!("刷新素材暂存文件失败: {error}"));
            }
        }

        if let Err(error) = fs::rename(&staging_path, &target_path) {
            fs::remove_file(&staging_path).ok();
            return Err(format!("素材落位失败: {error}"));
        }

        if let (Some(thumbnail_bytes), Some(thumbnail_target_path)) =
            (thumbnail_bytes.as_ref(), thumbnail_target_path.as_ref())
        {
            let thumbnail_parent = thumbnail_target_path
                .parent()
                .ok_or_else(|| "无法定位缩略图目录".to_string())?;
            if let Err(error) = fs::create_dir_all(thumbnail_parent) {
                fs::remove_file(&target_path).ok();
                return Err(format!("创建缩略图目录失败: {error}"));
            }
            let thumbnail_staging_path = thumbnail_parent.join(format!(
                ".import-thumbnail-{}-{stamp}.staging",
                std::process::id()
            ));
            let mut staging = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&thumbnail_staging_path)
            {
                Ok(staging) => staging,
                Err(error) => {
                    fs::remove_file(&target_path).ok();
                    return Err(format!("创建缩略图暂存文件失败: {error}"));
                }
            };
            if let Err(error) = staging.write_all(thumbnail_bytes) {
                fs::remove_file(&thumbnail_staging_path).ok();
                fs::remove_file(&target_path).ok();
                return Err(format!("写入缩略图暂存文件失败: {error}"));
            }
            if let Err(error) = staging.sync_all() {
                fs::remove_file(&thumbnail_staging_path).ok();
                fs::remove_file(&target_path).ok();
                return Err(format!("刷新缩略图暂存文件失败: {error}"));
            }
            if let Err(error) = fs::rename(&thumbnail_staging_path, thumbnail_target_path) {
                fs::remove_file(&thumbnail_staging_path).ok();
                fs::remove_file(&target_path).ok();
                return Err(format!("缩略图落位失败: {error}"));
            }
        }

        let title = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("未命名素材")
            .trim();
        let title = if title.is_empty() {
            "未命名素材"
        } else {
            title
        };
        let tx = match conn.transaction() {
            Ok(tx) => tx,
            Err(error) => {
                fs::remove_file(&target_path).ok();
                if let Some(path) = thumbnail_target_path.as_ref() {
                    fs::remove_file(path).ok();
                }
                return Err(format!("开始素材保存事务失败: {error}"));
            }
        };
        let insert_result = tx.execute(
            "INSERT INTO items (title, image_path, thumbnail_path, tags, account_pool_id, image_version, content_hash, metadata_version)
             VALUES (?1, ?2, ?3, '[]', ?4, 1, ?5, 1)",
            params![
                title,
                relative_path,
                thumbnail_relative_path,
                account_pool_id,
                hash
            ],
        );
        if let Err(error) = insert_result {
            fs::remove_file(&target_path).ok();
            if let Some(path) = thumbnail_target_path.as_ref() {
                fs::remove_file(path).ok();
            }
            return Err(format!("保存素材记录失败: {error}"));
        }
        let item_id = tx.last_insert_rowid();
        let item = match read_item_summary(&tx, item_id, account_pool_id) {
            Ok(item) => item,
            Err(error) => {
                fs::remove_file(&target_path).ok();
                if let Some(path) = thumbnail_target_path.as_ref() {
                    fs::remove_file(path).ok();
                }
                return Err(format!("读取已保存素材失败: {error}"));
            }
        };
        if let Err(error) = tx.commit() {
            fs::remove_file(&target_path).ok();
            if let Some(path) = thumbnail_target_path.as_ref() {
                fs::remove_file(path).ok();
            }
            return Err(format!("提交素材记录失败: {error}"));
        }
        Ok(item)
    }

    /// 用用户明确选择的新文件修复/替换当前账号素材；旧文件保留，避免误删仍被其他记录引用的路径。
    /// 图片内容版本递增并清空旧分析结果，缓存会因新版本键自然失效。
    pub fn repair_local_image(&self, repair: LocalImageRepair) -> Result<ItemSummary, String> {
        let validated = validate_local_image(&LocalImageImport {
            account_pool_id: repair.account_pool_id,
            file_name: repair.file_name.clone(),
            mime_type: repair.mime_type.clone(),
            data_base64: repair.data_base64,
            thumbnail_data_base64: None,
        })?;
        let thumbnail_bytes = validate_thumbnail(repair.thumbnail_data_base64.as_deref())?;
        let extension = validated.extension.as_str();
        let bytes = validated.bytes.as_slice();
        let hash = validated.hash.as_str();

        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(repair.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let current: Option<(String, i64, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT image_path, image_version, content_hash, thumbnail_path FROM items
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![repair.item_id, active.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| format!("读取待修复素材失败: {error}"))?;
        let Some((current_path, current_version, current_hash, current_thumbnail_path)) = current
        else {
            return Err("素材不存在或不属于当前账号".to_string());
        };
        if current_version != repair.expected_image_version {
            return Err(format!(
                "素材图片版本冲突：当前为 {current_version}，修复请求为 {}，请刷新后重试",
                repair.expected_image_version
            ));
        }
        if current_hash.as_deref() == Some(hash) {
            let thumbnail_ready = thumbnail_bytes
                .as_ref()
                .map(|_| {
                    current_thumbnail_path
                        .as_deref()
                        .map(|path| self.resolve_image_path(path).is_file())
                        .unwrap_or(false)
                })
                .unwrap_or(true);
            if self.resolve_image_path(&current_path).is_file() && thumbnail_ready {
                return read_item_summary(&conn, repair.item_id, active.id)
                    .map_err(|error| format!("读取已存在素材失败: {error}"));
            }
        }
        let duplicate_id: Option<i64> = conn
            .query_row(
                "SELECT id FROM items
                 WHERE account_pool_id = ?1 AND content_hash = ?2 AND id <> ?3 AND deleted_at IS NULL
                 ORDER BY id LIMIT 1",
                params![active.id, hash, repair.item_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("检查重复修复素材失败: {error}"))?;
        if let Some(existing_id) = duplicate_id {
            return Err(format!(
                "该图片内容已存在于素材 {existing_id}，未覆盖当前素材"
            ));
        }

        let db_dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        let relative_path = format!("assets/{}/{hash}.{extension}", active.id);
        let target_path = db_dir.join(&relative_path);
        let thumbnail_relative_path = thumbnail_bytes
            .as_ref()
            .map(|_| format!("assets/{}/thumbnails/{hash}.jpg", active.id));
        let thumbnail_target_path = thumbnail_relative_path
            .as_deref()
            .map(|relative| db_dir.join(relative));
        let parent = target_path
            .parent()
            .ok_or_else(|| "无法定位素材目录".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("创建素材目录失败: {error}"))?;
        let target_exists = target_path.is_file();
        if target_exists {
            let existing_bytes = fs::read(&target_path)
                .map_err(|error| format!("读取已有素材目标文件失败: {error}"))?;
            if existing_bytes.as_slice() != bytes {
                return Err("素材目标文件已存在但内容摘要不匹配，未覆盖".to_string());
            }
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let staging_path = parent.join(format!(".repair-{}-{stamp}.staging", std::process::id()));
        let mut thumbnail_target_created = false;
        if !target_exists {
            let mut staging = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging_path)
                .map_err(|error| format!("创建素材修复暂存文件失败: {error}"))?;
            if let Err(error) = staging.write_all(bytes) {
                fs::remove_file(&staging_path).ok();
                return Err(format!("写入素材修复暂存文件失败: {error}"));
            }
            if let Err(error) = staging.sync_all() {
                fs::remove_file(&staging_path).ok();
                return Err(format!("刷新素材修复暂存文件失败: {error}"));
            }
            if let Err(error) = fs::rename(&staging_path, &target_path) {
                fs::remove_file(&staging_path).ok();
                return Err(format!("素材修复落位失败: {error}"));
            }
        }

        if let (Some(thumbnail_bytes), Some(thumbnail_target_path)) =
            (thumbnail_bytes.as_ref(), thumbnail_target_path.as_ref())
        {
            let thumbnail_parent = thumbnail_target_path
                .parent()
                .ok_or_else(|| "无法定位缩略图目录".to_string())?;
            fs::create_dir_all(thumbnail_parent)
                .map_err(|error| format!("创建缩略图目录失败: {error}"))?;
            let thumbnail_exists = thumbnail_target_path.is_file();
            if thumbnail_exists {
                let existing_bytes = fs::read(thumbnail_target_path)
                    .map_err(|error| format!("读取已有缩略图失败: {error}"))?;
                if existing_bytes.as_slice() != thumbnail_bytes {
                    return Err("缩略图目标文件已存在但内容不匹配，未覆盖".to_string());
                }
            } else {
                let thumbnail_staging_path = thumbnail_parent.join(format!(
                    ".repair-thumbnail-{}-{stamp}.staging",
                    std::process::id()
                ));
                let mut staging = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&thumbnail_staging_path)
                    .map_err(|error| format!("创建缩略图修复暂存文件失败: {error}"))?;
                if let Err(error) = staging.write_all(thumbnail_bytes) {
                    fs::remove_file(&thumbnail_staging_path).ok();
                    if !target_exists {
                        fs::remove_file(&target_path).ok();
                    }
                    return Err(format!("写入缩略图修复暂存文件失败: {error}"));
                }
                if let Err(error) = staging.sync_all() {
                    fs::remove_file(&thumbnail_staging_path).ok();
                    if !target_exists {
                        fs::remove_file(&target_path).ok();
                    }
                    return Err(format!("刷新缩略图修复暂存文件失败: {error}"));
                }
                if let Err(error) = fs::rename(&thumbnail_staging_path, thumbnail_target_path) {
                    fs::remove_file(&thumbnail_staging_path).ok();
                    if !target_exists {
                        fs::remove_file(&target_path).ok();
                    }
                    return Err(format!("缩略图修复落位失败: {error}"));
                }
                thumbnail_target_created = true;
            }
        }

        let tx = match conn.transaction() {
            Ok(tx) => tx,
            Err(error) => {
                if !target_exists {
                    fs::remove_file(&target_path).ok();
                }
                if thumbnail_target_created {
                    if let Some(path) = thumbnail_target_path.as_ref() {
                        fs::remove_file(path).ok();
                    }
                }
                return Err(format!("开始素材修复事务失败: {error}"));
            }
        };
        let changed = tx
            .execute(
                "UPDATE items SET image_path = ?1, thumbnail_path = ?2,
                        image_version = image_version + 1, content_hash = ?3, analysis_raw = NULL
                 WHERE id = ?4 AND account_pool_id = ?5 AND deleted_at IS NULL
                   AND image_version = ?6",
                params![
                    relative_path,
                    thumbnail_relative_path,
                    hash,
                    repair.item_id,
                    active.id,
                    repair.expected_image_version,
                ],
            )
            .map_err(|error| format!("保存修复素材记录失败: {error}"))?;
        if changed != 1 {
            if !target_exists {
                fs::remove_file(&target_path).ok();
            }
            if thumbnail_target_created {
                if let Some(path) = thumbnail_target_path.as_ref() {
                    fs::remove_file(path).ok();
                }
            }
            return Err("素材不存在、账号已切换或图片版本冲突，修复未写入".to_string());
        }
        let item = match read_item_summary(&tx, repair.item_id, active.id) {
            Ok(item) => item,
            Err(error) => {
                if !target_exists {
                    fs::remove_file(&target_path).ok();
                }
                if thumbnail_target_created {
                    if let Some(path) = thumbnail_target_path.as_ref() {
                        fs::remove_file(path).ok();
                    }
                }
                return Err(format!("读取已修复素材失败: {error}"));
            }
        };
        if let Err(error) = tx.commit() {
            if !target_exists {
                fs::remove_file(&target_path).ok();
            }
            if thumbnail_target_created {
                if let Some(path) = thumbnail_target_path.as_ref() {
                    fs::remove_file(path).ok();
                }
            }
            return Err(format!("提交素材修复失败: {error}"));
        }
        Ok(item)
    }

    /// 软删除当前账号素材；数据库记录和磁盘文件保留，供回收站恢复或后续清理。
    pub fn delete_local_item(&self, item_id: i64, account_pool_id: i64) -> Result<(), String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let changed = conn
            .execute(
                "UPDATE items SET deleted_at = datetime('now', 'localtime')
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
                params![item_id, active.id],
            )
            .map_err(|error| format!("删除本地素材失败: {error}"))?;
        if changed != 1 {
            return Err("素材不存在、已删除或不属于当前账号".to_string());
        }
        Ok(())
    }

    /// 从当前账号回收站恢复素材；若相同内容已有活动素材则拒绝恢复以免重复。
    pub fn restore_local_item(
        &self,
        item_id: i64,
        account_pool_id: i64,
    ) -> Result<ItemSummary, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let hash: Option<String> = conn
            .query_row(
                "SELECT content_hash FROM items
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NOT NULL",
                params![item_id, active.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取回收站素材失败: {error}"))?;
        if let Some(hash) = hash {
            if let Some(existing_id) = conn
                .query_row(
                    "SELECT id FROM items
                     WHERE account_pool_id = ?1 AND content_hash = ?2 AND deleted_at IS NULL
                       AND id <> ?3 LIMIT 1",
                    params![active.id, hash, item_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|error| format!("检查恢复重复素材失败: {error}"))?
            {
                return Err(format!("相同内容的活动素材 {existing_id} 已存在，未恢复"));
            }
        }
        let changed = conn
            .execute(
                "UPDATE items SET deleted_at = NULL
                 WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NOT NULL",
                params![item_id, active.id],
            )
            .map_err(|error| format!("恢复本地素材失败: {error}"))?;
        if changed != 1 {
            return Err("素材已被其他操作恢复或删除，未写入".to_string());
        }
        read_item_summary(&conn, item_id, active.id)
            .map_err(|error| format!("读取已恢复素材失败: {error}"))
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
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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

    /// 永久清理当前账号回收站素材。仍被任何本地笔记引用的素材必须先解除引用，
    /// 且只删除由本地图库管理的 assets 路径；数据库失败会恢复已暂存文件。
    pub fn purge_local_items(
        &self,
        item_ids: &[i64],
        account_pool_id: i64,
    ) -> Result<PurgeItemsResult, String> {
        let mut unique_ids = Vec::new();
        let mut seen = HashSet::new();
        for id in item_ids {
            if *id > 0 && seen.insert(*id) {
                unique_ids.push(*id);
            }
        }
        if unique_ids.is_empty() {
            return Err("至少选择一项回收站素材".to_string());
        }
        if unique_ids.len() > 100 {
            return Err("单次最多永久清理 100 项素材".to_string());
        }

        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始素材永久清理事务失败: {error}"))?;

        let mut records = Vec::with_capacity(unique_ids.len());
        for item_id in &unique_ids {
            let record: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT image_path, thumbnail_path FROM items
                     WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NOT NULL",
                    params![item_id, active.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| format!("读取回收站素材失败: {error}"))?;
            let Some(record) = record else {
                return Err(format!("素材 {item_id} 不在当前账号回收站，未清理"));
            };
            records.push((*item_id, record.0, record.1));
        }

        let selected: HashSet<i64> = unique_ids.iter().copied().collect();
        let mut referenced = HashSet::new();
        let mut note_stmt = tx
            .prepare("SELECT item_id, item_ids FROM notes WHERE account_pool_id = ?1")
            .map_err(|error| format!("读取笔记素材关联失败: {error}"))?;
        let note_rows = note_stmt
            .query_map(params![active.id], |row| {
                let primary: Option<i64> = row.get(0)?;
                let item_ids_json: Option<String> = row.get(1)?;
                Ok((primary, parse_json_vec::<i64>(item_ids_json)))
            })
            .map_err(|error| format!("扫描笔记素材关联失败: {error}"))?;
        for row in note_rows {
            let (primary, item_ids) =
                row.map_err(|error| format!("读取笔记素材关联失败: {error}"))?;
            if let Some(item_id) = primary {
                if selected.contains(&item_id) {
                    referenced.insert(item_id);
                }
            }
            for item_id in item_ids {
                if selected.contains(&item_id) {
                    referenced.insert(item_id);
                }
            }
        }
        drop(note_stmt);
        if !referenced.is_empty() {
            let mut ids = referenced.into_iter().collect::<Vec<_>>();
            ids.sort_unstable();
            return Err(format!(
                "素材仍被笔记引用（{}），请先删除笔记或解除素材关联后再永久清理",
                ids.iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }

        let selected_paths: HashSet<String> = records
            .iter()
            .flat_map(|(_, image_path, thumbnail_path)| {
                std::iter::once(image_path.clone()).chain(thumbnail_path.clone())
            })
            .collect();
        let mut staged = Vec::<(PathBuf, PathBuf)>::new();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        for (item_id, image_path, thumbnail_path) in &records {
            for stored_path in std::iter::once(image_path).chain(thumbnail_path.as_ref()) {
                if !self.is_managed_asset_path(&self.resolve_image_path(stored_path)) {
                    return Err(format!(
                        "素材 {item_id} 的文件路径不在本地 assets 管理范围，未清理"
                    ));
                }
                let resolved = self.resolve_image_path(stored_path);
                if !resolved.is_file() {
                    continue;
                }
                if staged.iter().any(|(source, _)| source == &resolved) {
                    continue;
                }
                let mut shared = false;
                let mut ref_stmt = tx
                    .prepare(
                        "SELECT id, image_path, thumbnail_path FROM items
                         WHERE image_path = ?1 OR thumbnail_path = ?1",
                    )
                    .map_err(|error| format!("检查素材文件引用失败: {error}"))?;
                let refs = ref_stmt
                    .query_map(params![stored_path], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    })
                    .map_err(|error| format!("检查素材文件引用失败: {error}"))?;
                for reference in refs {
                    let (reference_id, reference_image, reference_thumbnail) =
                        reference.map_err(|error| format!("读取素材文件引用失败: {error}"))?;
                    if !selected.contains(&reference_id)
                        || !selected_paths.contains(&reference_image)
                        || reference_thumbnail
                            .as_deref()
                            .is_some_and(|path| !selected_paths.contains(path))
                    {
                        shared = true;
                        break;
                    }
                }
                drop(ref_stmt);
                if shared {
                    continue;
                }
                let parent = resolved
                    .parent()
                    .ok_or_else(|| format!("素材 {item_id} 文件目录无效"))?;
                let staged_path =
                    parent.join(format!(".purge-{item_id}-{}-{stamp}.staging", staged.len()));
                if staged_path.exists() {
                    return Err("素材永久清理暂存文件已存在，未清理".to_string());
                }
                if let Err(error) = fs::rename(&resolved, &staged_path) {
                    for (source, staging) in staged.iter().rev() {
                        fs::rename(staging, source).ok();
                    }
                    return Err(format!("暂存待清理素材失败: {error}"));
                }
                staged.push((resolved, staged_path));
            }
        }

        for item_id in &unique_ids {
            let changed = tx
                .execute(
                    "DELETE FROM items
                     WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NOT NULL",
                    params![item_id, active.id],
                )
                .map_err(|error| format!("删除素材记录失败: {error}"))?;
            if changed != 1 {
                for (source, staging) in staged.iter().rev() {
                    fs::rename(staging, source).ok();
                }
                return Err(format!("素材 {item_id} 已被其他操作改变，未清理"));
            }
        }
        if let Err(error) = tx.commit() {
            for (source, staging) in staged.iter().rev() {
                fs::rename(staging, source).ok();
            }
            return Err(format!("提交素材永久清理失败: {error}"));
        }

        let mut cleanup_warnings = Vec::new();
        for (source, staging) in staged {
            if let Err(error) = fs::remove_file(&staging) {
                cleanup_warnings.push(format!(
                    "{}（原路径 {}）: {error}",
                    staging.display(),
                    source.display()
                ));
            }
        }
        Ok(PurgeItemsResult {
            purged_ids: unique_ids,
            cleanup_warnings,
        })
    }

    fn is_managed_asset_path(&self, path: &Path) -> bool {
        let db_dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        let project_root = db_dir.parent().unwrap_or(db_dir);
        path.starts_with(db_dir.join("assets")) || path.starts_with(project_root.join("assets"))
    }

    /// 更新当前账号素材元数据；图片内容版本保持不变，独立 metadata_version 防止旧回执覆盖。
    pub fn update_local_item_metadata(
        &self,
        update: LocalItemMetadataUpdate,
    ) -> Result<ItemSummary, String> {
        let title = update.title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return Err("素材标题必须是 1 到 200 个字符".to_string());
        }
        if update.tags.len() > 30 || update.tags.iter().any(|tag| tag.chars().count() > 40) {
            return Err("素材标签数量或长度超出限制".to_string());
        }
        let tags = serde_json::to_string(&update.tags)
            .map_err(|error| format!("序列化素材标签失败: {error}"))?;
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, Some(update.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开始素材元数据保存失败: {error}"))?;
        let changed = tx
            .execute(
                "UPDATE items SET title = ?1, tags = ?2, style = ?3, material = ?4,
                        scene = ?5, color = ?6, metadata_version = metadata_version + 1
                 WHERE id = ?7 AND account_pool_id = ?8 AND deleted_at IS NULL
                   AND metadata_version = ?9",
                params![
                    title,
                    tags,
                    update.style,
                    update.material,
                    update.scene,
                    update.color,
                    update.item_id,
                    active.id,
                    update.expected_metadata_version,
                ],
            )
            .map_err(|error| format!("保存素材元数据失败: {error}"))?;
        if changed != 1 {
            return Err("素材不存在、账号已切换或元数据版本冲突，保存未写入".to_string());
        }
        let item = read_item_summary(&tx, update.item_id, active.id)
            .map_err(|error| format!("读取已保存素材元数据失败: {error}"))?;
        tx.commit()
            .map_err(|error| format!("提交素材元数据失败: {error}"))?;
        Ok(item)
    }

    /// 从当前账号素材原子创建草稿，避免前端先写空笔记再异步补关联。
    pub fn create_local_draft_from_items(
        &self,
        item_ids: &[i64],
        expected_account_id: Option<i64>,
    ) -> Result<NoteSummary, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        if item_ids.is_empty() || item_ids.len() > 9 {
            return Err("草稿需要关联 1 到 9 张素材".to_string());
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
            "INSERT INTO notes (item_id, item_ids, title, tags, status, account_pool_id)
             VALUES (?1, ?2, ?3, '[]', 'draft', ?4)",
            params![item_ids[0], item_ids_json, first_title, account_pool_id],
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
        let mut conn = self
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
        let mut conn = self
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let primary_item_id = update.item_ids.first().copied();
        let changed = tx
            .execute(
                "UPDATE notes SET title = ?1, body = ?2, tags = ?3,
                    note_type = ?4, item_id = ?5, item_ids = ?6,
                    content_version = content_version + 1,
                    updated_at = datetime('now', 'localtime')
                 WHERE id = ?7 AND account_pool_id = ?8 AND deleted_at IS NULL
                   AND content_version = ?9",
                params![
                    title,
                    update.body,
                    tags,
                    update.note_type,
                    primary_item_id,
                    item_ids,
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
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
                        created_at, updated_at
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let mut statement = conn
            .prepare(
                "SELECT attempt_id, account_pool_id, note_id, snapshot_key,
                        content_version, snapshot_json, status, platform_url, error,
                        created_at, updated_at
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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

    /// 把笔记关联素材按上传顺序复制到本地暂存目录，文件名带序号前缀，
    /// 供用户按编号手动拖拽上传；不访问平台、不修改素材库。
    pub fn stage_local_note_images(
        &self,
        note_id: i64,
        expected_account_id: Option<i64>,
    ) -> Result<StagedImagesSummary, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let active = ensure_active_account(&mut conn, &self.path)
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

    pub fn account_pool(&self) -> SqlResult<AccountPoolSnapshot> {
        let mut conn = self.connect()?;
        let active = ensure_active_account(&mut conn, &self.path)?;
        let mut stmt = conn.prepare(
            "SELECT id, alias, role, display_name, status
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
                    display_name: row.get(3)?,
                    is_active: id == active.id,
                    status: row.get(4)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(AccountPoolSnapshot { items })
    }

    /// 创建本地账号池记录。只创建空的受管目录，不复制或读取浏览器登录态。
    pub fn create_local_account(&self, input: LocalAccountCreate) -> Result<(), String> {
        let alias = input.alias.trim();
        if alias.is_empty() || alias.chars().count() > 80 {
            return Err("账号别名不能为空且不能超过 80 个字符".to_string());
        }
        if !matches!(input.role.as_str(), "operation" | "assistant") {
            return Err("账号角色只能是 operation 或 assistant".to_string());
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
        let result = conn.execute(
            "INSERT INTO account_pool (alias, role, user_data_dir, status)
             VALUES (?1, ?2, ?3, 'active')",
            params![alias, input.role, user_data_dir.display().to_string()],
        );
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&user_data_dir);
            return Err(format!("创建本地账号失败: {error}"));
        }
        Ok(())
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
             SET alias = ?1, role = ?2, display_name = ?3, status = ?4
             WHERE id = ?5",
            params![
                alias,
                input.role,
                input.display_name,
                input.status,
                input.account_id
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

    /// 保存当前运营账号的人设/内容策略字段，不触碰平台统计字段或浏览器登录态。
    pub fn update_local_profile(&self, input: LocalProfileUpdate) -> Result<(), String> {
        validate_profile_list(&input.content_pillars)?;
        validate_profile_list(&input.persona_taboos)?;
        validate_profile_list(&input.preferred_styles)?;
        validate_profile_list(&input.preferred_scenes)?;
        validate_profile_list(&input.hashtag_pool)?;
        for value in [
            input.account_id.as_deref(),
            input.display_name.as_deref(),
            input.niche.as_deref(),
            input.target_audience.as_deref(),
            input.persona_name.as_deref(),
            input.persona_bio.as_deref(),
            input.persona_tone.as_deref(),
            input.posting_rhythm.as_deref(),
        ] {
            if value.is_some_and(|text| text.chars().count() > 2000) {
                return Err("人设字段不能超过 2000 个字符".to_string());
            }
        }
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
                   persona_name = ?6,
                   persona_bio = ?7,
                   persona_tone = ?8,
                   persona_taboos = ?9,
                   preferred_styles = ?10,
                   preferred_scenes = ?11,
                   hashtag_pool = ?12,
                   posting_rhythm = ?13,
                   updated_at = datetime('now', 'localtime')
                 WHERE id = ?14",
                params![
                    input.account_id,
                    input.display_name,
                    input.niche,
                    input.target_audience,
                    content_pillars,
                    input.persona_name,
                    input.persona_bio,
                    input.persona_tone,
                    persona_taboos,
                    preferred_styles,
                    preferred_scenes,
                    hashtag_pool,
                    input.posting_rhythm,
                    profile_id,
                ],
            )
        } else {
            conn.execute(
                "INSERT INTO my_profile (
                   account_pool_id, account_id, display_name, niche, target_audience,
                   content_pillars, persona_name, persona_bio, persona_tone, persona_taboos,
                   preferred_styles, preferred_scenes, hashtag_pool, posting_rhythm, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, datetime('now', 'localtime'))",
                params![
                    input.account_pool_id,
                    input.account_id,
                    input.display_name,
                    input.niche,
                    input.target_audience,
                    content_pillars,
                    input.persona_name,
                    input.persona_bio,
                    input.persona_tone,
                    persona_taboos,
                    preferred_styles,
                    preferred_scenes,
                    hashtag_pool,
                    input.posting_rhythm,
                ],
            )
        }
        .map_err(|error| format!("保存本地人设失败: {error}"))?;
        Ok(())
    }

    /// 读取当前运营账号的经验库开关。缺少记录时使用安全默认值：所有经验来源启用。
    pub fn local_knowledge_preferences(
        &self,
        expected_account_id: Option<i64>,
    ) -> Result<LocalKnowledgePreferences, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        Ok(default_local_knowledge_preferences(active.id, None))
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
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
        let mut conn = self
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
                    Ok(experience_prompt_from_row(row)?)
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
                .query_map(params![active.id], |row| {
                    Ok(experience_prompt_from_row(row)?)
                })
                .map_err(|error| format!("读取经验提示词失败: {error}"))?;
            mapped.collect::<SqlResult<Vec<_>>>()
        };
        rows.map_err(|error| format!("读取经验提示词失败: {error}"))
    }

    /// 新增或更新经验提示词。启用条目每池 ≤10 条，单条 ≤300 字。
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let _ = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let _ = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let _ = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        conn.execute(
            "DELETE FROM app_settings WHERE key = ?1",
            params![MEMORY_L1_OVERRIDE_KEY],
        )
        .map_err(|error| format!("清除系统规则覆盖失败: {error}"))?;
        self.read_memory_system_rules()
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
        let active = ensure_active_account(&mut conn, &self.path)
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

    /// 读取当前运营账号的本地灵感/剪藏，不依赖 WebView localStorage。
    pub fn local_inspirations(
        &self,
        expected_account_id: Option<i64>,
    ) -> Result<Vec<InspirationSummary>, String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, expected_account_id)
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let mut statement = conn
            .prepare(
                "SELECT id, account_pool_id, title, source_url, body, observed_at,
                        reason, status, note_id, dedupe_key, material_type, author, capture_modules
                 FROM inspirations
                 WHERE account_pool_id = ?1
                 ORDER BY observed_at DESC, id DESC",
            )
            .map_err(|error| format!("读取本地灵感失败: {error}"))?;
        let inspirations = statement
            .query_map(params![active.id], inspiration_from_row)
            .map_err(|error| format!("读取本地灵感失败: {error}"))?
            .collect::<SqlResult<Vec<_>>>()
            .map_err(|error| format!("解析本地灵感失败: {error}"))?;
        Ok(inspirations)
    }

    /// 保存一条当前账号的灵感/剪藏。相同 dedupe key 会替换旧的未采用记录，
    /// 防止浏览器重复发送造成列表膨胀；已转草稿的记录仍保留其转换状态。
    pub fn save_local_inspiration(&self, input: LocalInspirationCreate) -> Result<(), String> {
        validate_local_inspiration(&input)?;
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let tx = conn
            .transaction()
            .map_err(|error| format!("开启本地灵感事务失败: {error}"))?;
        let existing_account: Option<i64> = tx
            .query_row(
                "SELECT account_pool_id FROM inspirations WHERE id = ?1",
                params![input.id.trim()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("校验本地灵感归属失败: {error}"))?;
        if existing_account.is_some_and(|account_id| account_id != input.account_pool_id) {
            return Err("灵感 ID 已属于其他账号，拒绝覆盖".to_string());
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
                       AND status = 'saved'",
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
        let active = ensure_active_account(&mut conn, &self.path)
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
                 WHERE id = ?2 AND account_pool_id = ?3 AND status = 'saved'",
                params![note_id, id.trim(), account_pool_id],
            )
            .map_err(|error| format!("转换本地灵感失败: {error}"))?;
        if changed != 1 {
            return Err("灵感不存在、已转为草稿或不属于当前账号".to_string());
        }
        let converted = tx
            .query_row(
                "SELECT id, account_pool_id, title, source_url, body, observed_at,
                        reason, status, note_id, dedupe_key, material_type, author, capture_modules
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

    /// 根据当前激活账号的本地记录识别扩展当前页，供弹窗选择默认操作。
    pub fn lookup_browser_page_context(
        &self,
        source_url: &str,
        requested_page_type: &str,
    ) -> Result<BrowserPageContext, String> {
        let normalized_url = normalize_browser_lookup_url(source_url)
            .ok_or_else(|| "当前页链接无效，必须是 http(s) 链接".to_string())?;
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;

        let own_note = {
            let mut statement = conn
                .prepare(
                    "SELECT title, note_url FROM notes
                     WHERE account_pool_id = ?1 AND deleted_at IS NULL AND note_url IS NOT NULL",
                )
                .map_err(|error| format!("查询当前账号笔记失败: {error}"))?;
            let rows = statement
                .query_map(params![active.id], |row| {
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
                .query_map(params![active.id], |row| {
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

        let prior_snapshot = {
            let mut statement = conn
                .prepare(
                    "SELECT kind, title, observed_at, source_url, reference_account_id FROM page_snapshots
                     WHERE account_pool_id = ?1
                     ORDER BY observed_at DESC, id DESC LIMIT 2000",
                )
                .map_err(|error| format!("查询页面快照历史失败: {error}"))?;
            let rows = statement
                .query_map(params![active.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                    ))
                })
                .map_err(|error| format!("读取页面快照历史失败: {error}"))?;
            let mut found = None;
            for row in rows {
                let snapshot = row.map_err(|error| format!("解析页面快照历史失败: {error}"))?;
                if normalize_browser_lookup_url(&snapshot.3).as_deref()
                    == Some(normalized_url.as_str())
                {
                    found = Some(snapshot);
                    break;
                }
            }
            found
        };

        let saved_material = {
            let mut statement = conn
                .prepare(
                    "SELECT title, source_url, material_type FROM inspirations
                     WHERE account_pool_id = ?1 AND source_url != ''
                     ORDER BY updated_at DESC, id DESC",
                )
                .map_err(|error| format!("查询已收藏材料失败: {error}"))?;
            let rows = statement
                .query_map(params![active.id], |row| {
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
            let last_snapshot_at = prior_snapshot
                .as_ref()
                .filter(|snapshot| snapshot.0 == "note_snapshot")
                .map(|snapshot| snapshot.2.clone());
            return Ok(browser_page_context(
                "own_note",
                "note",
                Some("note_snapshot"),
                None,
                title,
                last_snapshot_at,
            ));
        }
        if let Some((reference_account_id, name, note_title)) = reference_note {
            let last_snapshot_at = prior_snapshot
                .as_ref()
                .filter(|snapshot| snapshot.0 == "ref_snapshot")
                .map(|snapshot| snapshot.2.clone());
            return Ok(browser_page_context(
                "reference_note",
                "note",
                Some("ref_snapshot"),
                Some(reference_account_id),
                prior_snapshot
                    .as_ref()
                    .map(|snapshot| snapshot.1.clone())
                    .or(note_title)
                    .or(name),
                last_snapshot_at,
            ));
        }
        if let Some((reference_account_id, name)) = reference_profile {
            let last_snapshot_at = prior_snapshot
                .as_ref()
                .filter(|snapshot| snapshot.0 == "ref_snapshot")
                .map(|snapshot| snapshot.2.clone());
            return Ok(browser_page_context(
                "reference_profile",
                "profile",
                Some("ref_snapshot"),
                Some(reference_account_id),
                prior_snapshot
                    .as_ref()
                    .map(|snapshot| snapshot.1.clone())
                    .or(name),
                last_snapshot_at,
            ));
        }
        if let Some((kind, title, observed_at, _, reference_account_id)) = prior_snapshot {
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
                ));
            }
        }
        if let Some((title, _, Some(material_type))) = saved_material {
            let (match_type, page_type) = match material_type.as_str() {
                "note_material" => ("saved_note_material", "note"),
                "profile_material" => ("saved_profile_material", "profile"),
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
        })
    }

    /// 保存一条页面快照（单篇刷新 / 扩展解析当前页）。
    /// 快照是数据记录，不走灵感待确认队列；指标缺失保持 NULL，不编造数字。
    pub fn save_page_snapshot(
        &self,
        input: PageSnapshotCreate,
    ) -> Result<PageSnapshotSummary, String> {
        validate_page_snapshot(&input)?;
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
            .map_err(|error| format!("读取激活账号失败: {error}"))?;
        ensure_expected_account(&active, Some(input.account_pool_id))
            .map_err(|error| format!("账号上下文已变化: {error}"))?;
        let reference_account_id = if let Some(reference_account_id) = input.reference_account_id {
            let belongs_to_active: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM reference_accounts
                     WHERE id = ?1 AND account_pool_id = ?2)",
                    params![reference_account_id, active.id],
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
                        params![active.id, request_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| format!("校验快照幂等失败: {error}"))?;
                if let Some(id) = existing {
                    return self.page_snapshot_by_id(id);
                }
            }
        }
        let note_id = if input.kind == "note_snapshot" {
            resolve_note_id_by_url(&conn, active.id, &input.source_url)
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
                active.id,
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
                    active.id
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
                    active.id,
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        if let Some(id) = existing_id {
            conn.execute(
                "UPDATE reference_accounts
                 SET name = ?1, followers = ?2
                 WHERE id = ?3 AND account_pool_id = ?4",
                params![
                    input.name.as_deref().map(str::trim),
                    input.followers,
                    id,
                    input.account_pool_id
                ],
            )
            .map_err(|error| format!("更新榜样账号失败: {error}"))?;
        } else {
            conn.execute(
                "INSERT INTO reference_accounts (account_pool_id, account_id, name, followers)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    input.account_pool_id,
                    input.account_id.trim(),
                    input.name.as_deref().map(str::trim),
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let changed = conn
            .execute(
                "UPDATE reference_accounts
                 SET name = ?1, followers = ?2,
                     content_style = COALESCE(?3, content_style)
                 WHERE id = ?4 AND account_pool_id = ?5",
                params![
                    input.name.as_deref().map(str::trim),
                    input.followers,
                    input.content_style,
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

    /// 删除当前账号下的榜样账号记录，不影响笔记、素材或浏览器登录态。
    pub fn delete_local_reference_account(
        &self,
        id: i64,
        account_pool_id: i64,
    ) -> Result<(), String> {
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
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
        task_id: &str,
        status: &str,
        item_ids: &[i64],
        note_id: Option<i64>,
        title: Option<&str>,
        body: Option<&str>,
        tags: &[String],
        content_version: Option<i64>,
        error: Option<&str>,
    ) -> Result<CompanionTaskSummary, String> {
        if !matches!(
            status,
            "queued" | "processing" | "ready" | "failed" | "cancelled"
        ) {
            return Err("Companion 任务状态无效".to_string());
        }
        let mut conn = self
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
        let mut conn = self
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

    /// Persist a bounded generated artifact separately from run metadata.
    /// The artifact is scoped to the same account/object as its run and is
    /// replaced idempotently for the same run and kind.
    pub fn save_local_ai_artifact(
        &self,
        input: LocalAIRunArtifactCreate,
    ) -> Result<AIRunArtifactSummary, String> {
        validate_local_ai_artifact(&input)?;
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        let mut conn = self
            .connect()
            .map_err(|error| format!("打开本地数据库失败: {error}"))?;
        let active = ensure_active_account(&mut conn, &self.path)
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
        Ok(account)
    }
}

fn parse_json_vec<T: DeserializeOwned>(raw: Option<String>) -> Vec<T> {
    raw.and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn knowledge_preferences_key(account_pool_id: i64) -> String {
    format!("knowledge_preferences:{account_pool_id}")
}

fn prompt_configs_key(account_pool_id: i64) -> String {
    format!("prompt_configs:{account_pool_id}")
}

const MEMORY_L1_OVERRIDE_KEY: &str = "memory_l1_override";

const DEFAULT_MEMORY_L0: &str = "\
你是「爱吃红薯」小红书家居内容助手，帮助当前运营账号做选题、写稿、改稿与复盘。
Ask 模式只回答和分析，不执行命令、不修改文件、不访问网络、不写入页面。
Agent 模式先给出行动计划；涉及发布、删除、修改或外部操作时必须先明确列出待确认动作，不要擅自执行。";

const DEFAULT_MEMORY_L1: &str = "\
出稿硬性格式（小红书编辑器不识别 Markdown，必须纯文本）：
1. 禁止任何 Markdown 标记：加粗、标题、列表、代码、引用、表格、链接、分隔线
2. 禁止会话/元信息与过场开场白；不要在正文里重复标题
3. 标题一行 ≤20 字，可带数字或痛点；正文分段清晰、口语短句，结尾 5-8 个话题标签，200-500 字
4. 格式固定为两行块：第一行标题本身，空一行后直接写正文要点/体验/避坑
方法论：先痛点后解法；真实接地气；参考经验与样本时学习思路，不要照抄，不编造数据与来源。";

fn validate_origin(origin: Option<&str>) -> Result<(), String> {
    match origin {
        None | Some("") => Ok(()),
        Some("pc") | Some("mobile") => Ok(()),
        Some(_) => Err("端归属只能是 pc 或 mobile".to_string()),
    }
}

fn validate_memory_kind(kind: &str) -> Result<(), String> {
    match kind {
        "positioning" | "expression" | "fact" | "event" | "content_history" => Ok(()),
        _ => Err(
            "记忆类型只能是 positioning / expression / fact / event / content_history".to_string(),
        ),
    }
}

fn validate_confirm_status(status: &str) -> Result<(), String> {
    match status {
        "candidate" | "confirmed" | "rejected" | "outdated" => Ok(()),
        _ => Err("确认状态只能是 candidate / confirmed / rejected / outdated".to_string()),
    }
}

fn validate_source_type(source_type: Option<&str>) -> Result<(), String> {
    match source_type {
        None | Some("") | Some("user") | Some("ai_draft") | Some("import") | Some("sync") => Ok(()),
        Some(_) => Err("来源类型只能是 user / ai_draft / import / sync".to_string()),
    }
}

fn validate_memory_content(content: &str) -> Result<(), String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("记忆内容不能为空".to_string());
    }
    if trimmed.chars().count() > 1000 {
        return Err("记忆内容最多 1000 字".to_string());
    }
    Ok(())
}

fn validate_status_transition(current: &str, next: &str) -> Result<(), String> {
    let allowed = matches!(
        (current, next),
        ("candidate", "confirmed") | ("candidate", "rejected") | ("confirmed", "outdated")
    );
    if allowed {
        Ok(())
    } else {
        Err(format!(
            "不允许从 {current} 迁移到 {next}；候选只能确认/否定，确认只能标记过时，否定与过时不可逆"
        ))
    }
}

fn validate_experience_prompt_fields(title: &str, content: &str) -> Result<(), String> {
    let title = title.trim();
    let content = content.trim();
    if title.is_empty() {
        return Err("经验提示词标题不能为空".to_string());
    }
    if title.chars().count() > 40 {
        return Err("经验提示词标题最多 40 字".to_string());
    }
    if content.is_empty() {
        return Err("经验提示词内容不能为空".to_string());
    }
    if content.chars().count() > 300 {
        return Err("经验提示词内容最多 300 字".to_string());
    }
    Ok(())
}

fn experience_prompt_from_row(row: &rusqlite::Row<'_>) -> SqlResult<ExperiencePrompt> {
    Ok(ExperiencePrompt {
        id: row.get(0)?,
        account_pool_id: row.get(1)?,
        origin: row.get(2)?,
        title: row.get(3)?,
        content: row.get(4)?,
        enabled: row.get::<_, i64>(5)? != 0,
        apply_scope: row.get(6)?,
        apply_target: row.get(7)?,
        source: row.get(8)?,
        sort_order: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn default_prompt_configs() -> Vec<PromptConfig> {
    vec![
        PromptConfig {
            key: "quick_title".to_string(),
            label: "生成标题".to_string(),
            prompt: "请为这篇笔记生成 5 个吸引人的标题，每行一个，格式：\n1. 标题一\n2. 标题二\n…\n不超过 20 字，带情绪词或反问，避免营销腔。".to_string(),
            sort_order: 0,
            enabled: true,
        },
        PromptConfig {
            key: "quick_body".to_string(),
            label: "优化正文".to_string(),
            prompt: "请帮我优化这篇笔记的正文，保持口语化，短句换行，突出卖点，控制在 300 字以内。".to_string(),
            sort_order: 1,
            enabled: true,
        },
        PromptConfig {
            key: "quick_tags".to_string(),
            label: "生成标签".to_string(),
            prompt: "请为这篇笔记生成 8 个小红书话题标签，格式：\n#标签1 #标签2 …\n贴合内容垂类，覆盖主话题/场景/风格/情绪四类。".to_string(),
            sort_order: 2,
            enabled: true,
        },
        PromptConfig {
            key: "quick_cover".to_string(),
            label: "写封面文案".to_string(),
            prompt: "请为这篇笔记写一段封面图文字，不超过 15 字，大字报风格，有视觉冲击力。".to_string(),
            sort_order: 3,
            enabled: true,
        },
    ]
}

fn validate_prompt_config_fields(
    key: &str,
    label: &str,
    prompt: &str,
    sort_order: i64,
) -> Result<(), String> {
    if key.trim().is_empty() || key.chars().count() > 120 {
        return Err("提示词标识无效".to_string());
    }
    if label.trim().is_empty() || label.chars().count() > 120 {
        return Err("提示词名称不能为空且不能超过 120 个字符".to_string());
    }
    if prompt.trim().is_empty() || prompt.chars().count() > 16_000 {
        return Err("提示词内容不能为空且不能超过 16000 个字符".to_string());
    }
    if !(0..=100_000).contains(&sort_order) {
        return Err("提示词排序值无效".to_string());
    }
    Ok(())
}

fn validate_prompt_configs(prompts: &[PromptConfig]) -> Result<(), String> {
    if prompts.len() > 128 {
        return Err("提示词数量不能超过 128 条".to_string());
    }
    let mut seen = HashSet::new();
    for prompt in prompts {
        validate_prompt_config_fields(
            &prompt.key,
            &prompt.label,
            &prompt.prompt,
            prompt.sort_order,
        )?;
        if !seen.insert(prompt.key.clone()) {
            return Err("提示词标识不能重复".to_string());
        }
    }
    Ok(())
}

/// Read the old global prompt_configs table once when a database is upgraded.
/// The table was created by the Python backend and may be absent in fresh
/// databases, so all discovery/row errors deliberately fall back to defaults.
fn legacy_prompt_configs(conn: &Connection) -> Option<Vec<PromptConfig>> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'prompt_configs'
             )",
            [],
            |row| row.get(0),
        )
        .ok()?;
    if !exists {
        return None;
    }

    let mut statement = conn
        .prepare(
            "SELECT key, label, prompt, sort_order, enabled
             FROM prompt_configs
             ORDER BY sort_order, key",
        )
        .ok()?;
    let rows = statement
        .query_map([], |row| {
            let enabled = row.get::<_, Option<i64>>(4)?.unwrap_or(1) != 0;
            Ok(PromptConfig {
                key: row.get(0)?,
                label: row.get(1)?,
                prompt: row.get(2)?,
                sort_order: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                enabled,
            })
        })
        .ok()?;
    let mut prompts = Vec::new();
    for row in rows {
        prompts.push(row.ok()?);
    }
    if prompts.is_empty() {
        None
    } else {
        Some(prompts)
    }
}

fn read_prompt_configs_value(
    conn: &Connection,
    key: &str,
) -> Result<Option<Vec<PromptConfig>>, String> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取本地提示词失败: {error}"))?;
    stored
        .map(|raw| {
            serde_json::from_str::<Vec<PromptConfig>>(&raw)
                .map_err(|error| format!("本地提示词格式损坏: {error}"))
        })
        .transpose()
}

fn write_prompt_configs_value(
    conn: &Connection,
    key: &str,
    prompts: &[PromptConfig],
) -> Result<(), String> {
    let value =
        serde_json::to_string(prompts).map_err(|error| format!("序列化本地提示词失败: {error}"))?;
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES (?1, ?2, datetime('now', 'localtime'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at",
        params![key, value],
    )
    .map_err(|error| format!("保存本地提示词失败: {error}"))?;
    Ok(())
}

fn default_local_knowledge_preferences(
    account_pool_id: i64,
    updated_at: Option<String>,
) -> LocalKnowledgePreferences {
    LocalKnowledgePreferences {
        account_pool_id,
        disabled_rule_keys: Vec::new(),
        use_my_samples: true,
        use_reference_samples: true,
        use_inspirations: true,
        updated_at,
    }
}

fn validate_local_knowledge_preferences(disabled_rule_keys: &[String]) -> Result<(), String> {
    if disabled_rule_keys.len() > 32 {
        return Err("经验规律开关最多保存 32 项".to_string());
    }
    let mut seen = HashSet::new();
    for key in disabled_rule_keys {
        let trimmed = key.trim();
        if trimmed.is_empty() || trimmed.chars().count() > 80 {
            return Err("经验规律标识无效".to_string());
        }
        if !seen.insert(trimmed.to_string()) {
            return Err("经验规律开关不能重复".to_string());
        }
    }
    Ok(())
}

struct ValidatedLocalImage {
    extension: String,
    bytes: Vec<u8>,
    hash: String,
}

fn validate_local_image(import: &LocalImageImport) -> Result<ValidatedLocalImage, String> {
    let file_name = import.file_name.trim();
    let path = Path::new(file_name);
    if file_name.is_empty() || path.file_name().and_then(|name| name.to_str()) != Some(file_name) {
        return Err("图片文件名不合法".to_string());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif"
    ) {
        return Err("仅支持 JPG、PNG、GIF、WEBP 或 AVIF 图片".to_string());
    }
    let bytes = STANDARD
        .decode(import.data_base64.as_bytes())
        .map_err(|_| "图片数据不是有效的 base64".to_string())?;
    const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片大小必须在 1B 到 25MB 之间".to_string());
    }
    if !image_signature_matches(&extension, &bytes) {
        return Err("图片内容与文件类型不匹配".to_string());
    }
    if let Some(mime) = import
        .mime_type
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let expected = image_mime_for_extension(&extension);
        if mime != expected && !(extension == "jpg" && mime == "image/jpeg") {
            return Err("图片 MIME 类型与扩展名不匹配".to_string());
        }
    }
    let digest = Sha256::digest(&bytes);
    let hash = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(ValidatedLocalImage {
        extension,
        bytes,
        hash,
    })
}

fn validate_thumbnail(data_base64: Option<&str>) -> Result<Option<Vec<u8>>, String> {
    let Some(data_base64) = data_base64.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let validated = validate_local_image(&LocalImageImport {
        account_pool_id: 0,
        file_name: "thumbnail.jpg".to_string(),
        mime_type: Some("image/jpeg".to_string()),
        data_base64: data_base64.to_string(),
        thumbnail_data_base64: None,
    })?;
    if validated.bytes.len() > 4 * 1024 * 1024 {
        return Err("缩略图不能超过 4MB".to_string());
    }
    Ok(Some(validated.bytes))
}

fn image_mime_for_extension(extension: &str) -> &'static str {
    match extension {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn image_signature_matches(extension: &str, bytes: &[u8]) -> bool {
    match extension {
        "jpg" | "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "avif" => {
            bytes.len() >= 12
                && &bytes[4..8] == b"ftyp"
                && matches!(
                    &bytes[8..12],
                    b"avif" | b"avis" | b"mif1" | b"msf1" | b"heic" | b"heix"
                )
        }
        _ => false,
    }
}

fn read_item_summary(conn: &Connection, item_id: i64, account_id: i64) -> SqlResult<ItemSummary> {
    conn.query_row(
        "SELECT id, title, image_path, thumbnail_path, tags, style, material, scene, color,
                analysis_raw, note_count, created_at, image_version, content_hash, metadata_version
         FROM items WHERE id = ?1 AND account_pool_id = ?2 AND deleted_at IS NULL",
        params![item_id, account_id],
        |row| {
            Ok(ItemSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                image_path: row.get(2)?,
                thumbnail_path: row.get(3)?,
                tags: parse_json_vec(row.get(4)?),
                style: row.get(5)?,
                material: row.get(6)?,
                scene: row.get(7)?,
                color: row.get(8)?,
                analysis_raw: row.get(9)?,
                note_count: row.get(10)?,
                created_at: row.get(11)?,
                image_version: row.get(12)?,
                content_hash: row.get(13)?,
                metadata_version: row.get(14)?,
            })
        },
    )
}

fn read_item_by_hash(
    conn: &Connection,
    account_id: i64,
    content_hash: &str,
) -> SqlResult<Option<ItemSummary>> {
    conn.query_row(
        "SELECT id, title, image_path, thumbnail_path, tags, style, material, scene, color,
                analysis_raw, note_count, created_at, image_version, content_hash, metadata_version
         FROM items
         WHERE account_pool_id = ?1 AND content_hash = ?2 AND deleted_at IS NULL
         ORDER BY id LIMIT 1",
        params![account_id, content_hash],
        |row| {
            Ok(ItemSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                image_path: row.get(2)?,
                thumbnail_path: row.get(3)?,
                tags: parse_json_vec(row.get(4)?),
                style: row.get(5)?,
                material: row.get(6)?,
                scene: row.get(7)?,
                color: row.get(8)?,
                analysis_raw: row.get(9)?,
                note_count: row.get(10)?,
                created_at: row.get(11)?,
                image_version: row.get(12)?,
                content_hash: row.get(13)?,
                metadata_version: row.get(14)?,
            })
        },
    )
    .optional()
}

fn read_item_summaries(
    conn: &Connection,
    account_id: i64,
    deleted: bool,
) -> SqlResult<Vec<ItemSummary>> {
    let deleted_clause = if deleted { "IS NOT NULL" } else { "IS NULL" };
    let sql = format!(
        "SELECT id, title, image_path, thumbnail_path, tags, style, material, scene, color,
                analysis_raw, note_count, created_at, image_version, content_hash, metadata_version
         FROM items
         WHERE account_pool_id = ?1 AND deleted_at {deleted_clause}
         ORDER BY id DESC
         LIMIT 5000"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![account_id], |row| {
            Ok(ItemSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                image_path: row.get(2)?,
                thumbnail_path: row.get(3)?,
                tags: parse_json_vec(row.get(4)?),
                style: row.get(5)?,
                material: row.get(6)?,
                scene: row.get(7)?,
                color: row.get(8)?,
                analysis_raw: row.get(9)?,
                note_count: row.get(10)?,
                created_at: row.get(11)?,
                image_version: row.get(12)?,
                content_hash: row.get(13)?,
                metadata_version: row.get(14)?,
            })
        })?
        .collect::<SqlResult<Vec<_>>>();
    rows
}

fn read_note_summary(conn: &Connection, note_id: i64, account_id: i64) -> SqlResult<NoteSummary> {
    conn.query_row(
        "SELECT id, item_id, item_ids, title, body, tags, status, note_type,
                likes, comments, collects, published_at, note_url, account_ref,
                cover_desc, prompt_used, created_at, updated_at, content_version, deleted_at
         FROM notes WHERE id = ?1 AND account_pool_id = ?2",
        params![note_id, account_id],
        |row| {
            let item_id: Option<i64> = row.get(1)?;
            let mut item_ids = parse_json_vec(row.get(2)?);
            if item_ids.is_empty() {
                if let Some(id) = item_id {
                    item_ids.push(id);
                }
            }
            Ok(NoteSummary {
                id: row.get(0)?,
                item_id,
                item_ids,
                title: row.get(3)?,
                body: row.get(4)?,
                tags: parse_json_vec(row.get(5)?),
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
            })
        },
    )
}

fn read_note_summaries(
    conn: &Connection,
    account_id: i64,
    deleted: bool,
) -> SqlResult<Vec<NoteSummary>> {
    let deleted_clause = if deleted { "IS NOT NULL" } else { "IS NULL" };
    let sql = format!(
        "SELECT id, item_id, item_ids, title, body, tags, status, note_type,
                likes, comments, collects, published_at, note_url, account_ref,
                cover_desc, prompt_used, created_at, updated_at, content_version, deleted_at
         FROM notes
         WHERE account_pool_id = ?1 AND deleted_at {deleted_clause}
         ORDER BY id DESC
         LIMIT 5000"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![account_id], |row| {
        let item_id: Option<i64> = row.get(1)?;
        let mut item_ids = parse_json_vec(row.get(2)?);
        if item_ids.is_empty() {
            if let Some(id) = item_id {
                item_ids.push(id);
            }
        }
        Ok(NoteSummary {
            id: row.get(0)?,
            item_id,
            item_ids,
            title: row.get(3)?,
            body: row.get(4)?,
            tags: parse_json_vec(row.get(5)?),
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
        })
    })?;
    rows.collect()
}

fn stage_legacy_inspirations(conn: &Connection) -> SqlResult<()> {
    let mut statement = conn.prepare("PRAGMA table_info(\"inspirations\")")?;
    let mut rows = statement.query([])?;
    let mut id_type = None;
    let mut has_account_scope = false;
    let mut has_body = false;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        let column_type: String = row.get(2)?;
        match name.as_str() {
            "id" => id_type = Some(column_type),
            "account_pool_id" => has_account_scope = true,
            "body" => has_body = true,
            _ => {}
        }
    }
    drop(rows);
    drop(statement);

    let is_current_schema = id_type
        .as_deref()
        .is_some_and(|column_type| column_type.eq_ignore_ascii_case("TEXT"))
        && has_account_scope
        && has_body;
    if id_type.is_none() || is_current_schema {
        return Ok(());
    }

    let legacy_exists: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'inspirations_legacy_v1'
         )",
        [],
        |row| row.get(0),
    )?;
    if legacy_exists {
        return Err(rusqlite::Error::InvalidParameterName(
            "检测到未完成的 inspirations 迁移：inspirations_legacy_v1 已存在".to_string(),
        ));
    }

    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_inspirations_pool;
         DROP INDEX IF EXISTS idx_inspirations_dedupe;
         ALTER TABLE inspirations RENAME TO inspirations_legacy_v1;",
    )
}

fn import_legacy_inspirations(conn: &mut Connection, account_pool_id: i64) -> SqlResult<()> {
    let legacy_exists: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'inspirations_legacy_v1'
         )",
        [],
        |row| row.get(0),
    )?;
    if !legacy_exists {
        return Ok(());
    }

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO inspirations (
             id, account_pool_id, title, source_url, body, observed_at, reason,
             status, note_id, dedupe_key, created_at, updated_at
         )
         SELECT
             'legacy-' || CAST(id AS TEXT),
             ?1,
             COALESCE(title, ''),
             CASE
                 WHEN source LIKE 'http://%' OR source LIKE 'https://%' THEN source
                 ELSE ''
             END,
             COALESCE(keyword, ''),
             COALESCE(created_at, datetime('now', 'localtime')),
             COALESCE(source, ''),
             'saved',
             NULL,
             NULL,
             COALESCE(created_at, datetime('now', 'localtime')),
             COALESCE(created_at, datetime('now', 'localtime'))
         FROM inspirations_legacy_v1",
        params![account_pool_id],
    )?;
    tx.execute_batch("DROP TABLE inspirations_legacy_v1;")?;
    tx.commit()
}

fn migrate(conn: &mut Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );",
    )?;

    let tx = conn.transaction()?;
    // Python 旧版已经创建过一个同名的 inspirations 表，但其主键是
    // INTEGER 且字段语义不同。先把它移到待导入表名，让下面的完整表
    // 定义真正落地；数据会在 active account 建立后再导入。
    stage_legacy_inspirations(&tx)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS account_pool (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             alias TEXT UNIQUE NOT NULL,
             role TEXT NOT NULL DEFAULT 'operation'
                 CHECK(role IN ('operation', 'assistant')),
             user_data_dir TEXT UNIQUE NOT NULL,
             display_name TEXT,
             status TEXT NOT NULL DEFAULT 'active'
                 CHECK(status IN ('active', 'banned', 'suspended', 'retired')),
             created_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS app_settings (
             key TEXT PRIMARY KEY,
             value TEXT,
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS items (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             title TEXT NOT NULL,
             image_path TEXT NOT NULL,
             thumbnail_path TEXT,
             style TEXT,
             material TEXT,
             scene TEXT,
             color TEXT,
             tags TEXT DEFAULT '[]',
             analysis_raw TEXT,
             note_count INTEGER DEFAULT 0,
             account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE SET NULL,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             deleted_at TEXT,
             image_version INTEGER NOT NULL DEFAULT 1,
             content_hash TEXT,
             metadata_version INTEGER NOT NULL DEFAULT 1
         );
         CREATE TABLE IF NOT EXISTS notes (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             item_id INTEGER REFERENCES items(id),
             item_ids TEXT DEFAULT '[]',
             title TEXT,
             body TEXT,
             tags TEXT DEFAULT '[]',
             status TEXT NOT NULL DEFAULT 'draft',
             note_type TEXT DEFAULT 'text',
             likes INTEGER DEFAULT 0,
             comments INTEGER DEFAULT 0,
             collects INTEGER DEFAULT 0,
             published_at TEXT,
             note_url TEXT,
             account_ref TEXT,
             cover_desc TEXT,
             prompt_used TEXT,
             content_version INTEGER NOT NULL DEFAULT 1,
             account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE SET NULL,
             deleted_at TEXT,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS my_profile (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             account_pool_id INTEGER UNIQUE REFERENCES account_pool(id) ON DELETE CASCADE,
             account_id TEXT,
             display_name TEXT,
             niche TEXT,
             followers INTEGER DEFAULT 0,
             total_notes INTEGER DEFAULT 0,
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS reference_accounts (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE CASCADE,
             account_id TEXT NOT NULL,
             name TEXT,
             followers INTEGER DEFAULT 0,
             total_likes INTEGER DEFAULT 0,
             note_count INTEGER DEFAULT 0,
             avg_likes REAL DEFAULT 0,
             avg_comments REAL DEFAULT 0,
             avg_collects REAL DEFAULT 0,
             content_style TEXT,
             top_notes TEXT DEFAULT '[]',
             raw_data TEXT,
             crawled_at TEXT,
             analyzed_at TEXT,
             insights TEXT,
             insights_at TEXT,
             UNIQUE(account_pool_id, account_id)
         );
         CREATE TABLE IF NOT EXISTS inspirations (
             id TEXT PRIMARY KEY,
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             title TEXT NOT NULL,
             source_url TEXT NOT NULL DEFAULT '',
             body TEXT NOT NULL DEFAULT '',
             observed_at TEXT NOT NULL,
             reason TEXT NOT NULL DEFAULT '',
             status TEXT NOT NULL DEFAULT 'saved'
                 CHECK(status IN ('saved', 'converted')),
             note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
             dedupe_key TEXT,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS ai_runs (
             run_id TEXT PRIMARY KEY,
             account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE CASCADE,
             note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
             item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
             provider TEXT NOT NULL,
             started_at TEXT NOT NULL,
             status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
             finished_at TEXT,
             error TEXT,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS ai_run_artifacts (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             run_id TEXT NOT NULL REFERENCES ai_runs(run_id) ON DELETE CASCADE,
             account_pool_id INTEGER REFERENCES account_pool(id) ON DELETE CASCADE,
             note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
             item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
             kind TEXT NOT NULL,
             content TEXT NOT NULL,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             UNIQUE(run_id, kind)
         );
         CREATE TABLE IF NOT EXISTS publish_outbox (
             attempt_id TEXT PRIMARY KEY,
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
             snapshot_key TEXT NOT NULL,
             content_version INTEGER NOT NULL,
             snapshot_json TEXT NOT NULL,
             status TEXT NOT NULL CHECK(status IN ('prepared', 'submitted', 'confirmed', 'failed', 'unknown')),
             platform_url TEXT,
             error TEXT,
             created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
             updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE TABLE IF NOT EXISTS memory_entries (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             origin TEXT NOT NULL DEFAULT 'pc' CHECK(origin IN ('pc', 'mobile')),
             kind TEXT NOT NULL DEFAULT 'fact'
                 CHECK(kind IN ('positioning', 'expression', 'fact', 'event', 'content_history')),
             content TEXT NOT NULL,
             subject TEXT NOT NULL DEFAULT '',
             scope TEXT NOT NULL DEFAULT 'account',
             source TEXT NOT NULL DEFAULT '',
             source_type TEXT NOT NULL DEFAULT 'user'
                 CHECK(source_type IN ('user', 'ai_draft', 'import', 'sync')),
             occurred_at TEXT,
             confirm_status TEXT NOT NULL DEFAULT 'candidate'
                 CHECK(confirm_status IN ('candidate', 'confirmed', 'rejected', 'outdated')),
             valid_status TEXT NOT NULL DEFAULT 'valid'
                 CHECK(valid_status IN ('valid', 'invalid')),
             replaced_by INTEGER REFERENCES memory_entries(id) ON DELETE SET NULL,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_memory_entries_pool_origin
             ON memory_entries(account_pool_id, origin, confirm_status, valid_status);
         CREATE TABLE IF NOT EXISTS experience_prompts (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             origin TEXT NOT NULL DEFAULT 'pc' CHECK(origin IN ('pc', 'mobile')),
             title TEXT NOT NULL,
             content TEXT NOT NULL,
             enabled INTEGER NOT NULL DEFAULT 1,
             apply_scope TEXT NOT NULL DEFAULT 'account'
                 CHECK(apply_scope IN ('global', 'account')),
             apply_target TEXT NOT NULL DEFAULT 'all'
                 CHECK(apply_target IN ('all', 'compose', 'chat')),
             source TEXT NOT NULL DEFAULT 'user'
                 CHECK(source IN ('user', 'from_memory')),
             sort_order INTEGER NOT NULL DEFAULT 0,
             created_at TEXT DEFAULT (datetime('now', 'localtime')),
             updated_at TEXT DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_experience_prompts_pool_origin
             ON experience_prompts(account_pool_id, origin, enabled);
         CREATE TABLE IF NOT EXISTS page_snapshots (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             account_pool_id INTEGER NOT NULL REFERENCES account_pool(id) ON DELETE CASCADE,
             kind TEXT NOT NULL CHECK(kind IN ('note_snapshot', 'ref_snapshot', 'clip')),
             source_url TEXT NOT NULL DEFAULT '',
             title TEXT NOT NULL DEFAULT '',
             author TEXT NOT NULL DEFAULT '',
             body_excerpt TEXT NOT NULL DEFAULT '',
             like_count INTEGER,
             collect_count INTEGER,
             comment_count INTEGER,
             metrics_json TEXT NOT NULL DEFAULT '{}',
             note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
             reference_account_id INTEGER REFERENCES reference_accounts(id) ON DELETE SET NULL,
             request_id TEXT,
             observed_at TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_page_snapshots_pool_kind
             ON page_snapshots(account_pool_id, kind, observed_at);
         CREATE INDEX IF NOT EXISTS idx_page_snapshots_url
             ON page_snapshots(account_pool_id, source_url);",
    )?;

    // 旧数据库可能由 Python 先创建过部分表。只增加缺失列，不重建表、不覆盖字段。
    for (table, column, definition) in [
        ("account_pool", "role", "TEXT NOT NULL DEFAULT 'operation'"),
        ("account_pool", "user_data_dir", "TEXT NOT NULL DEFAULT ''"),
        ("account_pool", "display_name", "TEXT"),
        ("account_pool", "status", "TEXT NOT NULL DEFAULT 'active'"),
        ("items", "title", "TEXT NOT NULL DEFAULT ''"),
        ("items", "image_path", "TEXT NOT NULL DEFAULT ''"),
        ("items", "thumbnail_path", "TEXT"),
        ("items", "style", "TEXT"),
        ("items", "material", "TEXT"),
        ("items", "scene", "TEXT"),
        ("items", "color", "TEXT"),
        ("items", "tags", "TEXT DEFAULT '[]'"),
        ("items", "analysis_raw", "TEXT"),
        ("items", "note_count", "INTEGER DEFAULT 0"),
        ("items", "account_pool_id", "INTEGER"),
        ("items", "created_at", "TEXT"),
        ("items", "deleted_at", "TEXT"),
        ("items", "image_version", "INTEGER NOT NULL DEFAULT 1"),
        ("items", "content_hash", "TEXT"),
        ("items", "metadata_version", "INTEGER NOT NULL DEFAULT 1"),
        ("notes", "item_id", "INTEGER"),
        ("notes", "item_ids", "TEXT DEFAULT '[]'"),
        ("notes", "title", "TEXT"),
        ("notes", "body", "TEXT"),
        ("notes", "status", "TEXT NOT NULL DEFAULT 'draft'"),
        ("notes", "note_type", "TEXT DEFAULT 'text'"),
        ("notes", "likes", "INTEGER DEFAULT 0"),
        ("notes", "comments", "INTEGER DEFAULT 0"),
        ("notes", "collects", "INTEGER DEFAULT 0"),
        ("notes", "published_at", "TEXT"),
        ("notes", "note_url", "TEXT"),
        ("notes", "account_ref", "TEXT"),
        ("notes", "cover_desc", "TEXT"),
        ("notes", "prompt_used", "TEXT"),
        ("notes", "content_version", "INTEGER NOT NULL DEFAULT 1"),
        ("notes", "account_pool_id", "INTEGER"),
        ("notes", "deleted_at", "TEXT"),
        ("notes", "created_at", "TEXT"),
        ("notes", "updated_at", "TEXT"),
        ("my_profile", "account_pool_id", "INTEGER"),
        ("my_profile", "account_id", "TEXT"),
        ("my_profile", "display_name", "TEXT"),
        ("my_profile", "niche", "TEXT"),
        ("my_profile", "followers", "INTEGER DEFAULT 0"),
        ("my_profile", "total_notes", "INTEGER DEFAULT 0"),
        ("my_profile", "target_audience", "TEXT"),
        ("my_profile", "content_pillars", "TEXT DEFAULT '[]'"),
        ("my_profile", "persona_name", "TEXT"),
        ("my_profile", "persona_bio", "TEXT"),
        ("my_profile", "persona_tone", "TEXT"),
        ("my_profile", "persona_taboos", "TEXT DEFAULT '[]'"),
        ("my_profile", "total_likes", "INTEGER DEFAULT 0"),
        ("my_profile", "total_collects", "INTEGER DEFAULT 0"),
        ("my_profile", "avg_likes", "REAL DEFAULT 0"),
        ("my_profile", "avg_comments", "REAL DEFAULT 0"),
        ("my_profile", "avg_collects", "REAL DEFAULT 0"),
        ("my_profile", "preferred_styles", "TEXT DEFAULT '[]'"),
        ("my_profile", "preferred_scenes", "TEXT DEFAULT '[]'"),
        ("my_profile", "hashtag_pool", "TEXT DEFAULT '[]'"),
        ("my_profile", "posting_rhythm", "TEXT"),
        ("my_profile", "avatar_url", "TEXT"),
        ("my_profile", "xhs_bio", "TEXT"),
        ("my_profile", "xhs_follows", "INTEGER DEFAULT 0"),
        ("my_profile", "ip_location", "TEXT"),
        ("my_profile", "xhs_tags", "TEXT DEFAULT '[]'"),
        ("my_profile", "crawled_at", "TEXT"),
        ("my_profile", "updated_at", "TEXT"),
        ("reference_accounts", "account_pool_id", "INTEGER"),
        (
            "reference_accounts",
            "account_id",
            "TEXT NOT NULL DEFAULT ''",
        ),
        ("reference_accounts", "name", "TEXT"),
        ("reference_accounts", "followers", "INTEGER DEFAULT 0"),
        ("reference_accounts", "total_likes", "INTEGER DEFAULT 0"),
        ("reference_accounts", "note_count", "INTEGER DEFAULT 0"),
        ("reference_accounts", "avg_likes", "REAL DEFAULT 0"),
        ("reference_accounts", "avg_comments", "REAL DEFAULT 0"),
        ("reference_accounts", "avg_collects", "REAL DEFAULT 0"),
        ("reference_accounts", "content_style", "TEXT"),
        ("reference_accounts", "top_notes", "TEXT DEFAULT '[]'"),
        ("reference_accounts", "raw_data", "TEXT"),
        ("reference_accounts", "crawled_at", "TEXT"),
        ("reference_accounts", "analyzed_at", "TEXT"),
        ("reference_accounts", "insights", "TEXT"),
        ("reference_accounts", "insights_at", "TEXT"),
        ("inspirations", "account_pool_id", "INTEGER"),
        ("inspirations", "source_url", "TEXT NOT NULL DEFAULT ''"),
        ("inspirations", "body", "TEXT NOT NULL DEFAULT ''"),
        ("inspirations", "observed_at", "TEXT NOT NULL DEFAULT ''"),
        ("inspirations", "reason", "TEXT NOT NULL DEFAULT ''"),
        ("inspirations", "status", "TEXT NOT NULL DEFAULT 'saved'"),
        ("inspirations", "note_id", "INTEGER"),
        ("inspirations", "dedupe_key", "TEXT"),
        ("inspirations", "created_at", "TEXT"),
        ("inspirations", "updated_at", "TEXT"),
        (
            "inspirations",
            "material_type",
            "TEXT NOT NULL DEFAULT 'web_material'",
        ),
        (
            "inspirations",
            "capture_modules",
            "TEXT NOT NULL DEFAULT '[]'",
        ),
        ("inspirations", "author", "TEXT NOT NULL DEFAULT ''"),
        ("ai_runs", "run_id", "TEXT"),
        ("ai_runs", "account_pool_id", "INTEGER"),
        ("ai_runs", "note_id", "INTEGER"),
        ("ai_runs", "item_id", "INTEGER"),
        ("ai_runs", "provider", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("ai_runs", "started_at", "TEXT NOT NULL DEFAULT ''"),
        ("ai_runs", "status", "TEXT NOT NULL DEFAULT 'interrupted'"),
        ("ai_runs", "finished_at", "TEXT"),
        ("ai_runs", "error", "TEXT"),
        ("ai_runs", "created_at", "TEXT"),
        ("ai_runs", "updated_at", "TEXT"),
        ("ai_run_artifacts", "run_id", "TEXT"),
        ("ai_run_artifacts", "account_pool_id", "INTEGER"),
        ("ai_run_artifacts", "note_id", "INTEGER"),
        ("ai_run_artifacts", "item_id", "INTEGER"),
        (
            "ai_run_artifacts",
            "kind",
            "TEXT NOT NULL DEFAULT 'unknown'",
        ),
        ("ai_run_artifacts", "content", "TEXT NOT NULL DEFAULT ''"),
        ("ai_run_artifacts", "created_at", "TEXT"),
        ("publish_outbox", "attempt_id", "TEXT"),
        ("publish_outbox", "account_pool_id", "INTEGER"),
        ("publish_outbox", "note_id", "INTEGER"),
        ("publish_outbox", "snapshot_key", "TEXT"),
        (
            "publish_outbox",
            "content_version",
            "INTEGER NOT NULL DEFAULT 1",
        ),
        (
            "publish_outbox",
            "snapshot_json",
            "TEXT NOT NULL DEFAULT '{}'",
        ),
        (
            "publish_outbox",
            "status",
            "TEXT NOT NULL DEFAULT 'prepared'",
        ),
        ("publish_outbox", "platform_url", "TEXT"),
        ("publish_outbox", "error", "TEXT"),
        ("publish_outbox", "created_at", "TEXT"),
        ("publish_outbox", "updated_at", "TEXT"),
        ("memory_entries", "enabled", "INTEGER NOT NULL DEFAULT 1"),
    ] {
        ensure_column(&tx, table, column, definition)?;
    }

    // 记忆启用位一次性回填：原「已确认且有效」为启用，候选/否定/过时为停用。
    let memory_enabled_migrated: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = 2",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if memory_enabled_migrated == 0 {
        tx.execute_batch(
            "UPDATE memory_entries SET enabled = 1
             WHERE confirm_status = 'confirmed' AND valid_status = 'valid';
             UPDATE memory_entries SET enabled = 0
             WHERE NOT (confirm_status = 'confirmed' AND valid_status = 'valid');",
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, name)
             VALUES (2, 'memory_entries_enabled')",
            [],
        )?;
    }

    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_items_pool_active
             ON items(account_pool_id, deleted_at, id);
         CREATE INDEX IF NOT EXISTS idx_notes_pool_id
             ON notes(account_pool_id, id);
         CREATE INDEX IF NOT EXISTS idx_profile_pool_id
             ON my_profile(account_pool_id);
         CREATE INDEX IF NOT EXISTS idx_reference_accounts_pool
             ON reference_accounts(account_pool_id, id);
         CREATE INDEX IF NOT EXISTS idx_inspirations_pool
             ON inspirations(account_pool_id, observed_at DESC, id);
         CREATE INDEX IF NOT EXISTS idx_inspirations_dedupe
             ON inspirations(account_pool_id, dedupe_key);
         CREATE INDEX IF NOT EXISTS idx_ai_runs_scope
             ON ai_runs(account_pool_id, note_id, item_id, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_ai_run_artifacts_scope
             ON ai_run_artifacts(account_pool_id, note_id, item_id, id DESC);
         CREATE INDEX IF NOT EXISTS idx_publish_outbox_scope
             ON publish_outbox(account_pool_id, note_id, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_publish_outbox_snapshot
             ON publish_outbox(account_pool_id, snapshot_key, updated_at DESC);",
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, name)
         VALUES (1, 'rust_local_core')",
        [],
    )?;
    tx.commit()?;
    migrate_companion_tasks(conn)
}

fn migrate_companion_tasks(conn: &mut Connection) -> SqlResult<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS companion_tasks (
             task_id TEXT PRIMARY KEY,
             client_task_id TEXT,
             account_pool_id INTEGER NOT NULL,
             status TEXT NOT NULL,
             topic TEXT,
             item_ids TEXT NOT NULL DEFAULT '[]',
             note_id INTEGER,
             title TEXT,
             body TEXT,
             tags TEXT NOT NULL DEFAULT '[]',
             content_version INTEGER,
             publish_status TEXT,
             publish_note_url TEXT,
             publish_message TEXT,
             error TEXT,
             created_at TEXT,
             updated_at TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_companion_tasks_client
             ON companion_tasks(account_pool_id, client_task_id);
         CREATE INDEX IF NOT EXISTS idx_companion_tasks_account
             ON companion_tasks(account_pool_id, updated_at DESC);",
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, name)
         VALUES (2, 'companion_tasks_v1')",
        [],
    )?;
    tx.commit()
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> SqlResult<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let mut rows = stmt.query([])?;
    let mut found = false;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            found = true;
            break;
        }
    }
    drop(rows);
    drop(stmt);
    if !found {
        conn.execute(
            &format!("ALTER TABLE \"{table}\" ADD COLUMN \"{column}\" {definition}"),
            [],
        )?;
    }
    Ok(())
}

fn local_timestamp() -> String {
    chrono_local_now()
}

fn chrono_local_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or_default();
    // sqlite-compatible localtime stamp without extra chrono dependency
    format_unix_local(secs)
}

fn format_unix_local(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{y:04}-{m:02}-{d:02} {hh:02}:{mm:02}:{ss:02}")
}

/// Howard Hinnant civil_from_days (UTC approximation is enough for local QA stamps).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn read_companion_task(conn: &Connection, task_id: &str) -> Result<CompanionTaskSummary, String> {
    conn.query_row(
        "SELECT task_id, client_task_id, account_pool_id, status, topic, item_ids,
                note_id, title, body, tags, content_version,
                publish_status, publish_note_url, publish_message, error,
                created_at, updated_at
         FROM companion_tasks WHERE task_id = ?1",
        params![task_id],
        |row| {
            Ok(CompanionTaskSummary {
                task_id: row.get(0)?,
                client_task_id: row.get(1)?,
                account_pool_id: row.get(2)?,
                status: row.get(3)?,
                topic: row.get(4)?,
                item_ids: parse_json_vec(row.get(5)?),
                note_id: row.get(6)?,
                title: row.get(7)?,
                body: row.get(8)?,
                tags: parse_json_vec(row.get(9)?),
                content_version: row.get(10)?,
                publish_status: row.get(11)?,
                publish_note_url: row.get(12)?,
                publish_message: row.get(13)?,
                error: row.get(14)?,
                created_at: row.get(15)?,
                updated_at: row.get(16)?,
            })
        },
    )
    .map_err(|error| format!("读取 Companion 任务失败: {error}"))
}

fn ensure_active_account(conn: &mut Connection, db_path: &Path) -> SqlResult<ActiveAccount> {
    let configured_id = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'active_account_id'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .and_then(|value| value.parse::<i64>().ok());

    if let Some(id) = configured_id {
        let configured = conn
            .query_row(
                "SELECT id, alias, role, status FROM account_pool WHERE id = ?1",
                params![id],
                |row| {
                    Ok(ActiveAccount {
                        id: row.get(0)?,
                        alias: row.get(1)?,
                        role: row.get(2)?,
                        status: row.get(3)?,
                    })
                },
            )
            .optional()?;
        let account = configured.ok_or_else(|| {
            rusqlite::Error::InvalidParameterName(
                "active_account_id points to missing account".into(),
            )
        })?;
        if account.status != "active" || !is_operation_role(&account.role) {
            return Err(rusqlite::Error::InvalidParameterName(
                "active account must be an active operation account".into(),
            ));
        }
        return Ok(account);
    }

    let existing = conn
        .query_row(
            "SELECT id, alias, role, status
             FROM account_pool
             WHERE status = 'active' AND role IN ('operation', 'main', 'sub_publish')
             ORDER BY id
             LIMIT 1",
            [],
            |row| {
                Ok(ActiveAccount {
                    id: row.get(0)?,
                    alias: row.get(1)?,
                    role: row.get(2)?,
                    status: row.get(3)?,
                })
            },
        )
        .optional()?;

    let account = match existing {
        Some(account) => account,
        None => {
            let browser_dir = db_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("browser_profiles")
                .join("main");
            fs::create_dir_all(&browser_dir)
                .map_err(|_| rusqlite::Error::InvalidPath(browser_dir.clone()))?;
            conn.execute(
                "INSERT INTO account_pool (alias, role, user_data_dir, status)
                 VALUES ('主号', 'operation', ?1, 'active')",
                params![browser_dir.display().to_string()],
            )?;
            ActiveAccount {
                id: conn.last_insert_rowid(),
                alias: "主号".to_string(),
                role: "operation".to_string(),
                status: "active".to_string(),
            }
        }
    };

    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES ('active_account_id', ?1, datetime('now', 'localtime'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at",
        params![account.id.to_string()],
    )?;
    Ok(account)
}

fn is_operation_role(role: &str) -> bool {
    matches!(role, "operation" | "main" | "sub_publish")
}

fn active_account_id(conn: &Connection) -> SqlResult<Option<i64>> {
    let value = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'active_account_id'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?;
    Ok(value.flatten().and_then(|value| value.parse::<i64>().ok()))
}

fn validate_profile_list(values: &[String]) -> Result<(), String> {
    if values.len() > 100 {
        return Err("单个内容列表最多保存 100 项".to_string());
    }
    if values.iter().any(|value| value.chars().count() > 120) {
        return Err("单个内容标签不能超过 120 个字符".to_string());
    }
    Ok(())
}

fn validate_local_inspiration(input: &LocalInspirationCreate) -> Result<(), String> {
    let field_limits = [
        ("灵感 ID", input.id.trim(), 120),
        ("灵感标题", input.title.trim(), 200),
        ("来源链接", input.source_url.trim(), 2_000),
        ("灵感正文", input.body.trim(), 20_000),
        ("收藏理由", input.reason.trim(), 2_000),
        ("观察时间", input.observed_at.trim(), 64),
    ];
    for (label, value, limit) in field_limits {
        if value.chars().count() > limit {
            return Err(format!("{label}不能超过 {limit} 个字符"));
        }
    }
    if input.id.trim().is_empty() || input.title.trim().is_empty() {
        return Err("灵感 ID 和标题不能为空".to_string());
    }
    let source_url = input.source_url.trim().to_ascii_lowercase();
    if !source_url.is_empty()
        && !source_url.starts_with("http://")
        && !source_url.starts_with("https://")
    {
        return Err("来源链接必须以 http:// 或 https:// 开头".to_string());
    }
    if input.observed_at.trim().is_empty() {
        return Err("观察时间不能为空".to_string());
    }
    if input
        .dedupe_key
        .as_deref()
        .is_some_and(|value| value.chars().count() > 2_400)
    {
        return Err("灵感去重键不能超过 2400 个字符".to_string());
    }
    Ok(())
}

fn validate_page_snapshot(input: &PageSnapshotCreate) -> Result<(), String> {
    if !matches!(
        input.kind.as_str(),
        "note_snapshot" | "ref_snapshot" | "clip"
    ) {
        return Err("快照类型无效".to_string());
    }
    if input.title.trim().is_empty() {
        return Err("快照标题不能为空".to_string());
    }
    if input.title.trim().chars().count() > 200
        || input.author.trim().chars().count() > 200
        || input.body_excerpt.trim().chars().count() > 4_000
        || input.source_url.trim().chars().count() > 2_000
    {
        return Err("快照字段超长".to_string());
    }
    let source_url = input.source_url.trim();
    if !source_url.is_empty()
        && !source_url.starts_with("http://")
        && !source_url.starts_with("https://")
    {
        return Err("来源链接必须以 http:// 或 https:// 开头".to_string());
    }
    if input.observed_at.trim().is_empty() {
        return Err("快照观察时间不能为空".to_string());
    }
    for (label, value) in [
        ("点赞", input.metrics.like),
        ("收藏", input.metrics.collect),
        ("评论", input.metrics.comment),
        ("粉丝", input.metrics.followers),
        ("笔记", input.metrics.note_count),
    ] {
        if value.is_some_and(|n| n < 0) {
            return Err(format!("{label}数不能为负"));
        }
    }
    if input
        .request_id
        .as_deref()
        .is_some_and(|value| value.chars().count() > 128)
    {
        return Err("请求 ID 不能超过 128 个字符".to_string());
    }
    Ok(())
}

fn resolve_note_id_by_url(
    conn: &rusqlite::Connection,
    account_pool_id: i64,
    source_url: &str,
) -> SqlResult<Option<i64>> {
    let Some(normalized_url) = normalize_browser_lookup_url(source_url) else {
        return Ok(None);
    };
    let mut statement = conn.prepare(
        "SELECT id, note_url FROM notes
         WHERE account_pool_id = ?1 AND note_url IS NOT NULL AND deleted_at IS NULL
         ORDER BY updated_at DESC",
    )?;
    let rows = statement.query_map(params![account_pool_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (id, note_url) = row?;
        if normalize_browser_lookup_url(&note_url).as_deref() == Some(normalized_url.as_str()) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn normalize_browser_lookup_url(source_url: &str) -> Option<String> {
    let source_url = source_url.trim();
    if source_url.chars().count() > 2_000
        || !(source_url.starts_with("http://") || source_url.starts_with("https://"))
    {
        return None;
    }
    let without_fragment = source_url.split('#').next().unwrap_or_default();
    let without_query = without_fragment.split('?').next().unwrap_or_default();
    let normalized = without_query.trim_end_matches('/');
    (!normalized.is_empty()).then(|| normalized.to_ascii_lowercase())
}

fn url_has_path_segment(source_url: &str, candidate: &str) -> bool {
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return false;
    }
    let without_fragment = source_url.split('#').next().unwrap_or_default();
    let without_query = without_fragment.split('?').next().unwrap_or_default();
    without_query
        .split('/')
        .any(|segment| segment.eq_ignore_ascii_case(candidate))
}

fn browser_page_context(
    match_type: &str,
    page_type: &str,
    snapshot_kind: Option<&str>,
    reference_account_id: Option<i64>,
    matched_title: Option<String>,
    last_snapshot_at: Option<String>,
) -> BrowserPageContext {
    BrowserPageContext {
        match_type: match_type.to_string(),
        default_action: if snapshot_kind.is_some() {
            "update_data".to_string()
        } else {
            "collect_material".to_string()
        },
        page_type: page_type.to_string(),
        snapshot_kind: snapshot_kind.map(str::to_string),
        reference_account_id,
        matched_title,
        last_snapshot_at,
    }
}

fn validate_local_reference_account(
    account_id: &str,
    name: Option<&str>,
    followers: i64,
) -> Result<(), String> {
    if account_id.trim().is_empty() || account_id.chars().count() > 200 {
        return Err("榜样账号 ID 不能为空且不能超过 200 个字符".to_string());
    }
    if name.is_some_and(|value| value.chars().count() > 200) {
        return Err("榜样账号名称不能超过 200 个字符".to_string());
    }
    if !(0..=1_000_000_000_000).contains(&followers) {
        return Err("粉丝数必须在 0 到 1 万亿之间".to_string());
    }
    Ok(())
}

fn validate_local_ai_run(
    run_id: &str,
    provider: &str,
    started_at: &str,
    status: &str,
    finished_at: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    if run_id.trim().is_empty() || run_id.chars().count() > 120 {
        return Err("AI 运行 ID 无效".to_string());
    }
    if provider.trim().is_empty() || provider.chars().count() > 64 {
        return Err("AI Provider 无效".to_string());
    }
    if started_at.trim().is_empty() || started_at.chars().count() > 64 {
        return Err("AI 运行开始时间无效".to_string());
    }
    validate_local_ai_run_status(status)?;
    if finished_at.is_some_and(|value| value.chars().count() > 64) {
        return Err("AI 运行完成时间无效".to_string());
    }
    if error.is_some_and(|value| value.chars().count() > 240) {
        return Err("AI 运行错误信息过长".to_string());
    }
    Ok(())
}

fn validate_local_ai_run_status(status: &str) -> Result<(), String> {
    if matches!(
        status.trim(),
        "running" | "completed" | "failed" | "cancelled" | "interrupted"
    ) {
        Ok(())
    } else {
        Err("AI 运行状态无效".to_string())
    }
}

fn validate_local_ai_artifact(input: &LocalAIRunArtifactCreate) -> Result<(), String> {
    if input.run_id.trim().is_empty() || input.run_id.chars().count() > 120 {
        return Err("AI 产物运行 ID 无效".to_string());
    }
    if input.kind.trim() != "assistant_text" {
        return Err("AI 产物类型暂只支持 assistant_text".to_string());
    }
    if input.content.trim().is_empty() {
        return Err("AI 产物内容不能为空".to_string());
    }
    if input.content.chars().count() > 64_000 {
        return Err("AI 产物内容不能超过 64000 个字符".to_string());
    }
    Ok(())
}

fn validate_ai_object_scope(
    conn: &Connection,
    account_pool_id: Option<i64>,
    note_id: Option<i64>,
    item_id: Option<i64>,
) -> Result<(), String> {
    if (note_id.is_some() || item_id.is_some()) && account_pool_id.is_none() {
        return Err("带笔记或素材的 AI 运行必须带账号上下文".to_string());
    }
    if let (Some(account_id), Some(note_id)) = (account_pool_id, note_id) {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM notes WHERE id = ?1 AND account_pool_id = ?2
                )",
                params![note_id, account_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("校验 AI 笔记归属失败: {error}"))?;
        if !exists {
            return Err("AI 运行笔记不属于当前账号".to_string());
        }
    }
    if let (Some(account_id), Some(item_id)) = (account_pool_id, item_id) {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM items WHERE id = ?1 AND account_pool_id = ?2
                )",
                params![item_id, account_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("校验 AI 素材归属失败: {error}"))?;
        if !exists {
            return Err("AI 运行素材不属于当前账号".to_string());
        }
    }
    Ok(())
}

fn inspiration_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InspirationSummary> {
    let material_type: Option<String> = row.get(10)?;
    let author: Option<String> = row.get(11)?;
    let capture_modules: Option<String> = row.get(12)?;
    Ok(InspirationSummary {
        id: row.get(0)?,
        account_pool_id: row.get(1)?,
        title: row.get(2)?,
        source_url: row.get(3)?,
        body: row.get(4)?,
        observed_at: row.get(5)?,
        reason: row.get(6)?,
        status: row.get(7)?,
        note_id: row.get(8)?,
        dedupe_key: row.get(9)?,
        material_type: material_type.unwrap_or_else(|| "web_material".to_string()),
        author: author.unwrap_or_default(),
        capture_modules: capture_modules
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default(),
    })
}

fn page_snapshot_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PageSnapshotSummary> {
    let request_id: Option<String> = row.get(13)?;
    Ok(PageSnapshotSummary {
        id: row.get(0)?,
        account_pool_id: row.get(1)?,
        kind: row.get(2)?,
        source_url: row.get(3)?,
        title: row.get(4)?,
        author: row.get(5)?,
        body_excerpt: row.get(6)?,
        like_count: row.get(7)?,
        collect_count: row.get(8)?,
        comment_count: row.get(9)?,
        metrics_json: row.get(10)?,
        note_id: row.get(11)?,
        reference_account_id: row.get(12)?,
        request_id: request_id.filter(|value| !value.is_empty()),
        observed_at: row.get(14)?,
        created_at: row.get(15)?,
    })
}

fn ai_run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AIRunSummary> {
    Ok(AIRunSummary {
        run_id: row.get(0)?,
        account_pool_id: row.get(1)?,
        note_id: row.get(2)?,
        item_id: row.get(3)?,
        provider: row.get(4)?,
        started_at: row.get(5)?,
        status: row.get(6)?,
        finished_at: row.get(7)?,
        error: row.get(8)?,
    })
}

fn ai_run_artifact_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AIRunArtifactSummary> {
    Ok(AIRunArtifactSummary {
        id: row.get(0)?,
        run_id: row.get(1)?,
        account_pool_id: row.get(2)?,
        note_id: row.get(3)?,
        item_id: row.get(4)?,
        kind: row.get(5)?,
        content: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn publish_outbox_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PublishOutboxSummary> {
    Ok(PublishOutboxSummary {
        attempt_id: row.get(0)?,
        account_pool_id: row.get(1)?,
        note_id: row.get(2)?,
        snapshot_key: row.get(3)?,
        content_version: row.get(4)?,
        snapshot_json: row.get(5)?,
        status: row.get(6)?,
        platform_url: row.get(7)?,
        error: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn read_publish_outbox_by_id(
    conn: &Connection,
    attempt_id: &str,
) -> SqlResult<Option<PublishOutboxSummary>> {
    conn.query_row(
        "SELECT attempt_id, account_pool_id, note_id, snapshot_key,
                content_version, snapshot_json, status, platform_url, error,
                created_at, updated_at
         FROM publish_outbox WHERE attempt_id = ?1",
        params![attempt_id],
        publish_outbox_from_row,
    )
    .optional()
}

fn validate_publish_outbox_prepare(input: &LocalPublishOutboxPrepare) -> Result<(), String> {
    if input.attempt_id.trim().is_empty() || input.attempt_id.chars().count() > 160 {
        return Err("发布尝试 ID 无效".to_string());
    }
    if input.note_id <= 0 || input.account_pool_id <= 0 || input.content_version <= 0 {
        return Err("发布准备的账号、笔记或版本无效".to_string());
    }
    if input.snapshot_key.trim().is_empty() || input.snapshot_key.chars().count() > 300 {
        return Err("发布快照键无效".to_string());
    }
    if input.snapshot_json.trim().is_empty() || input.snapshot_json.chars().count() > 100_000 {
        return Err("发布快照内容无效或过大".to_string());
    }
    Ok(())
}

fn validate_publish_outbox_update(input: &LocalPublishOutboxUpdate) -> Result<(), String> {
    if input.attempt_id.trim().is_empty() || input.attempt_id.chars().count() > 160 {
        return Err("发布尝试 ID 无效".to_string());
    }
    if input.account_pool_id <= 0 {
        return Err("发布账号无效".to_string());
    }
    if !matches!(
        input.status.as_str(),
        "prepared" | "submitted" | "confirmed" | "failed" | "unknown"
    ) {
        return Err("发布状态无效".to_string());
    }
    if input
        .platform_url
        .as_deref()
        .is_some_and(|value| value.chars().count() > 2_000)
    {
        return Err("平台链接不能超过 2000 个字符".to_string());
    }
    if input
        .error
        .as_deref()
        .is_some_and(|value| value.chars().count() > 1_000)
    {
        return Err("发布错误信息不能超过 1000 个字符".to_string());
    }
    Ok(())
}

fn valid_publish_transition(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("prepared", "submitted")
            | ("prepared", "failed")
            | ("prepared", "unknown")
            | ("submitted", "confirmed")
            | ("submitted", "failed")
            | ("submitted", "unknown")
            | ("unknown", "confirmed")
            | ("unknown", "failed")
            | ("failed", "prepared")
    ) || from == to
}

fn ensure_expected_account(
    active: &ActiveAccount,
    expected_account_id: Option<i64>,
) -> SqlResult<()> {
    if let Some(expected) = expected_account_id {
        if active.id != expected {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "expected account {expected}, active account {}",
                active.id
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db() -> (LocalDb, PathBuf) {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "aichihongshu-local-db-{}-{suffix}",
            std::process::id()
        ));
        let db = LocalDb::open(dir.join("app.db")).expect("open local db");
        (db, dir)
    }

    #[test]
    fn creates_schema_and_keeps_drafts_in_active_pool() {
        let (db, dir) = temp_db();
        let db_path = db.path.clone();
        let before = db.snapshot().expect("initial snapshot");
        assert!(before.items.is_empty());
        assert!(before.notes.is_empty());
        assert_eq!(before.item_count, 0);
        assert_eq!(before.note_count, 0);

        let note = db
            .create_local_draft("本地 Rust 草稿")
            .expect("create draft");
        assert_eq!(note.status, "draft");
        assert_eq!(note.content_version, 1);

        let updated = db
            .update_local_note(LocalNoteUpdate {
                note_id: note.id,
                account_pool_id: 1,
                expected_version: note.content_version,
                title: "可靠保存标题".to_string(),
                body: "纯文本正文\n第二行".to_string(),
                tags: vec!["家居".to_string(), "改造".to_string()],
                note_type: "text".to_string(),
                item_ids: Vec::new(),
            })
            .expect("update local note");
        assert_eq!(updated.title.as_deref(), Some("可靠保存标题"));
        assert_eq!(updated.body.as_deref(), Some("纯文本正文\n第二行"));
        assert_eq!(updated.tags, vec!["家居".to_string(), "改造".to_string()]);
        assert_eq!(updated.content_version, 2);

        let stale = db.update_local_note(LocalNoteUpdate {
            note_id: note.id,
            account_pool_id: 1,
            expected_version: 1,
            title: "旧回执不应覆盖".to_string(),
            body: "旧正文".to_string(),
            tags: vec!["旧标签".to_string()],
            note_type: "text".to_string(),
            item_ids: Vec::new(),
        });
        assert!(stale.is_err());

        let ready = db
            .update_local_note_status(LocalNoteStatusUpdate {
                note_id: note.id,
                account_pool_id: 1,
                expected_version: 2,
                status: "ready".to_string(),
                note_url: None,
            })
            .expect("update local note status");
        assert_eq!(ready.status, "ready");
        assert_eq!(ready.content_version, 3);

        let after = db.snapshot().expect("snapshot after write");
        assert_eq!(after.notes.len(), 1);
        assert_eq!(after.note_count, 1);
        assert_eq!(after.note_status_counts.get("ready"), Some(&1));
        assert_eq!(after.notes[0].title.as_deref(), Some("可靠保存标题"));
        assert_eq!(after.notes[0].body.as_deref(), Some("纯文本正文\n第二行"));
        assert_eq!(
            after.notes[0].tags,
            vec!["家居".to_string(), "改造".to_string()]
        );
        assert_eq!(after.notes[0].content_version, 3);
        assert_eq!(after.notes[0].item_ids, Vec::<i64>::new());

        drop(db);
        let reopened = LocalDb::open(db_path).expect("reopen local db");
        let restored = reopened.snapshot().expect("snapshot after reopen");
        assert_eq!(restored.note_count, 1);
        assert_eq!(restored.notes[0].title.as_deref(), Some("可靠保存标题"));
        assert_eq!(restored.notes[0].status, "ready");
        assert_eq!(restored.notes[0].content_version, 3);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn updates_note_item_order_and_rejects_cross_account_item() {
        let (db, dir) = temp_db();
        let note = db.create_local_draft("素材关联测试").expect("create draft");
        let conn = db.connect().expect("connect test db");
        conn.execute(
            "INSERT INTO items (id, title, image_path, account_pool_id) VALUES
             (1001, 'A-1', 'fixtures/a-1.png', 1),
             (1002, 'A-2', 'fixtures/a-2.png', 1)",
            [],
        )
        .expect("insert active account items");
        conn.execute(
            "INSERT INTO account_pool (id, alias, role, user_data_dir, status)
             VALUES (2, 'B', 'operation', 'browser_profiles/B', 'active')",
            [],
        )
        .expect("insert second account");
        conn.execute(
            "INSERT INTO items (id, title, image_path, account_pool_id)
             VALUES (2001, 'B-1', 'fixtures/b-1.png', 2)",
            [],
        )
        .expect("insert other account item");
        drop(conn);

        let ordered = db
            .update_local_note_items(LocalNoteItemsUpdate {
                note_id: note.id,
                account_pool_id: 1,
                expected_version: 1,
                item_ids: vec![1002, 1001],
            })
            .expect("save item order");
        assert_eq!(ordered.item_ids, vec![1002, 1001]);
        assert_eq!(ordered.item_id, Some(1002));
        assert_eq!(ordered.content_version, 2);

        let cross_account = db.update_local_note_items(LocalNoteItemsUpdate {
            note_id: note.id,
            account_pool_id: 1,
            expected_version: 2,
            item_ids: vec![1002, 2001],
        });
        assert!(cross_account.is_err());
        let snapshot = db.snapshot().expect("read unchanged association");
        assert_eq!(snapshot.notes[0].item_ids, vec![1002, 1001]);
        assert_eq!(snapshot.notes[0].content_version, 2);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reads_active_item_image_as_data_url() {
        let (db, dir) = temp_db();
        let assets = dir.join("assets");
        fs::create_dir_all(&assets).expect("create assets dir");
        fs::write(assets.join("sample.png"), b"png-bytes").expect("write image");
        fs::create_dir_all(assets.join("thumbnails")).expect("create thumbnails dir");
        fs::write(assets.join("thumbnails/sample.jpg"), b"thumb-bytes").expect("write thumbnail");

        let conn = db.connect().expect("connect test db");
        conn.execute(
            "INSERT INTO items (title, image_path, thumbnail_path, account_pool_id) VALUES (?1, ?2, ?3, 1)",
            params!["测试图片", "sample.png", "thumbnails/sample.jpg"],
        )
        .expect("insert image item");
        let item_id = conn.last_insert_rowid();
        drop(conn);

        let data_url = db
            .image_data_url(item_id)
            .expect("read image data")
            .expect("image should exist");
        assert!(data_url.starts_with("data:image/png;base64,"));
        assert!(data_url.ends_with("cG5nLWJ5dGVz"));
        let thumbnail_url = db
            .image_data_url_for_account(item_id, Some(1), "thumbnail")
            .expect("read thumbnail")
            .expect("thumbnail should exist");
        assert!(thumbnail_url.starts_with("data:image/jpeg;base64,"));
        assert!(thumbnail_url.ends_with("dGh1bWItYnl0ZXM="));
        fs::remove_file(assets.join("thumbnails/sample.jpg")).expect("remove thumbnail");
        let fallback_url = db
            .image_data_url_for_account(item_id, Some(1), "thumbnail")
            .expect("fallback to original")
            .expect("original should still exist");
        assert!(fallback_url.ends_with("cG5nLWJ5dGVz"));
        assert!(db
            .image_data_url_for_account(item_id, Some(999), "original")
            .is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn creates_updates_and_retires_local_accounts_without_crossing_active_boundary() {
        let (db, dir) = temp_db();
        db.create_local_account(LocalAccountCreate {
            alias: "辅助采集号".to_string(),
            role: "assistant".to_string(),
        })
        .expect("create local account");
        let pool = db.account_pool().expect("read account pool");
        let assistant = pool
            .items
            .iter()
            .find(|account| account.alias == "辅助采集号")
            .expect("created assistant");
        assert_eq!(assistant.role, "assistant");
        assert!(!assistant.is_active);

        db.update_local_account(LocalAccountUpdate {
            account_id: assistant.id,
            alias: "辅助采集号-改名".to_string(),
            role: "operation".to_string(),
            display_name: Some("采集辅助".to_string()),
            status: "active".to_string(),
        })
        .expect("update local account");
        db.retire_local_account(assistant.id)
            .expect("retire non-active account");
        assert!(db.retire_local_account(1).is_err());

        db.update_local_profile(LocalProfileUpdate {
            account_pool_id: 1,
            account_id: Some("local-main".to_string()),
            display_name: Some("本地主号".to_string()),
            niche: Some("家居".to_string()),
            target_audience: Some("租房人群".to_string()),
            content_pillars: vec!["改造".to_string()],
            persona_name: Some("红薯主理人".to_string()),
            persona_bio: Some("本地人设".to_string()),
            persona_tone: Some("直接".to_string()),
            persona_taboos: vec!["高级感".to_string()],
            preferred_styles: vec!["实用".to_string()],
            preferred_scenes: vec!["客厅".to_string()],
            hashtag_pool: vec!["家居好物".to_string()],
            posting_rhythm: Some("每周三篇".to_string()),
        })
        .expect("update local profile");
        let profile = db
            .snapshot()
            .expect("read profile")
            .profile
            .expect("profile");
        assert_eq!(profile.display_name.as_deref(), Some("本地主号"));
        assert_eq!(profile.content_pillars, vec!["改造".to_string()]);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn persists_local_inspirations_with_dedupe_and_explicit_conversion() {
        let (db, dir) = temp_db();
        db.save_local_inspiration(LocalInspirationCreate {
            id: "inspiration-a".to_string(),
            account_pool_id: 1,
            title: "租房客厅收纳".to_string(),
            source_url: "https://example.com/a".to_string(),
            body: "观察到收纳筐与墙面颜色形成对比".to_string(),
            observed_at: "2026-09-17T10:00:00.000Z".to_string(),
            reason: "可借鉴配色".to_string(),
            material_type: Some("web_material".to_string()),
            author: Some(String::new()),
            capture_modules: Some(vec![]),
            dedupe_key: Some("1|https://example.com/a|租房客厅收纳".to_string()),
        })
        .expect("save local inspiration");
        assert_eq!(
            db.local_inspirations(Some(1))
                .expect("list inspirations")
                .len(),
            1
        );

        db.save_local_inspiration(LocalInspirationCreate {
            id: "inspiration-a-retry".to_string(),
            account_pool_id: 1,
            title: "租房客厅收纳（更新）".to_string(),
            source_url: "https://example.com/a".to_string(),
            body: "补充了材质观察".to_string(),
            observed_at: "2026-09-17T10:01:00.000Z".to_string(),
            reason: "更适合当前选题".to_string(),
            material_type: Some("web_material".to_string()),
            author: Some(String::new()),
            capture_modules: Some(vec![]),
            dedupe_key: Some("1|https://example.com/a|租房客厅收纳".to_string()),
        })
        .expect("replace duplicate inspiration");
        let deduped = db
            .local_inspirations(Some(1))
            .expect("list deduped inspirations");
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].id, "inspiration-a-retry");

        let draft = db.create_local_draft("灵感草稿").expect("create draft");
        let converted = db
            .convert_local_inspiration("inspiration-a-retry", 1, draft.id)
            .expect("convert inspiration");
        assert_eq!(converted.status, "converted");
        assert_eq!(converted.note_id, Some(draft.id));
        db.save_local_inspiration(LocalInspirationCreate {
            id: "inspiration-after-convert".to_string(),
            account_pool_id: 1,
            title: "租房客厅收纳（再次补充）".to_string(),
            source_url: "https://example.com/a".to_string(),
            body: "不应丢失已关联草稿".to_string(),
            observed_at: "2026-09-17T10:02:00.000Z".to_string(),
            reason: "补充观察".to_string(),
            material_type: Some("web_material".to_string()),
            author: Some(String::new()),
            capture_modules: Some(vec![]),
            dedupe_key: Some("1|https://example.com/a|租房客厅收纳".to_string()),
        })
        .expect("update converted inspiration without duplicating it");
        let preserved = db
            .local_inspirations(Some(1))
            .expect("read converted inspiration");
        assert_eq!(preserved.len(), 1);
        assert_eq!(preserved[0].status, "converted");
        assert_eq!(preserved[0].note_id, Some(draft.id));
        assert!(db
            .convert_local_inspiration("inspiration-a-retry", 1, draft.id)
            .is_err());
        assert!(db
            .save_local_inspiration(LocalInspirationCreate {
                id: "bad-url".to_string(),
                account_pool_id: 1,
                title: "非法来源".to_string(),
                source_url: "file:///tmp/a".to_string(),
                body: String::new(),
                observed_at: "2026-09-17T10:00:00.000Z".to_string(),
                reason: String::new(),
                material_type: Some("web_material".to_string()),
                author: Some(String::new()),
                capture_modules: Some(vec![]),
                dedupe_key: None,
            })
            .is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn persists_local_reference_accounts_with_account_boundary() {
        let (db, dir) = temp_db();
        db.create_local_reference_account(LocalReferenceAccountCreate {
            account_pool_id: 1,
            account_id: "reference-001".to_string(),
            name: Some("收纳榜样".to_string()),
            followers: 1200,
        })
        .expect("create local reference account");
        let first = db.snapshot().expect("read reference accounts");
        assert_eq!(first.reference_accounts.len(), 1);
        assert_eq!(first.reference_accounts[0].followers, 1200);

        db.update_local_reference_account(LocalReferenceAccountUpdate {
            id: first.reference_accounts[0].id,
            account_pool_id: 1,
            account_id: "reference-001".to_string(),
            name: Some("收纳榜样-更新".to_string()),
            followers: 1500,
            content_style: Some("{\"keywords\":[\"实用\"]}".to_string()),
        })
        .expect("update local reference account");
        let updated = db.snapshot().expect("read updated reference account");
        assert_eq!(
            updated.reference_accounts[0].name.as_deref(),
            Some("收纳榜样-更新")
        );
        assert_eq!(
            updated.reference_accounts[0].content_style.as_deref(),
            Some("{\"keywords\":[\"实用\"]}")
        );

        db.create_local_reference_account(LocalReferenceAccountCreate {
            account_pool_id: 1,
            account_id: "reference-001".to_string(),
            name: Some("幂等更新".to_string()),
            followers: 1600,
        })
        .expect("upsert local reference account");
        assert_eq!(
            db.snapshot()
                .expect("read idempotent account")
                .reference_accounts
                .len(),
            1
        );

        db.delete_local_reference_account(updated.reference_accounts[0].id, 1)
            .expect("delete local reference account");
        assert!(db
            .snapshot()
            .expect("read after delete")
            .reference_accounts
            .is_empty());
        assert!(db
            .create_local_reference_account(LocalReferenceAccountCreate {
                account_pool_id: 1,
                account_id: "".to_string(),
                name: None,
                followers: 0,
            })
            .is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn imports_scoped_image_with_hash_and_compensation() {
        let (db, dir) = temp_db();
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let tiny_jpeg = "/9j/";
        let imported = db
            .import_local_image(LocalImageImport {
                account_pool_id: 1,
                file_name: "客厅.png".to_string(),
                mime_type: Some("image/png".to_string()),
                data_base64: png.to_string(),
                thumbnail_data_base64: Some(tiny_jpeg.to_string()),
            })
            .expect("import image");
        assert_eq!(imported.title, "客厅");
        assert_eq!(imported.image_version, 1);
        assert_eq!(imported.content_hash.as_deref().map(str::len), Some(64));
        assert!(imported.image_path.starts_with("assets/1/"));
        assert!(dir.join(&imported.image_path).is_file());
        assert!(imported
            .thumbnail_path
            .as_deref()
            .map(|path| dir.join(path).is_file())
            .unwrap_or(false));

        let duplicate = db
            .import_local_image(LocalImageImport {
                account_pool_id: 1,
                file_name: "同一内容.png".to_string(),
                mime_type: Some("image/png".to_string()),
                data_base64: png.to_string(),
                thumbnail_data_base64: None,
            })
            .expect("deduplicate image");
        assert_eq!(duplicate.id, imported.id);
        assert_eq!(db.snapshot().expect("snapshot").item_count, 1);

        let draft = db
            .create_local_draft_from_items(&[imported.id], Some(1))
            .expect("create material draft");
        assert_eq!(draft.item_ids, vec![imported.id]);
        assert_eq!(draft.item_id, Some(imported.id));

        let edited = db
            .update_local_item_metadata(LocalItemMetadataUpdate {
                item_id: imported.id,
                account_pool_id: 1,
                expected_metadata_version: 1,
                title: "更新后的客厅".to_string(),
                tags: vec!["家居".to_string(), "客厅".to_string()],
                style: Some("原木".to_string()),
                material: None,
                scene: Some("室内".to_string()),
                color: Some("暖白".to_string()),
            })
            .expect("update metadata");
        assert_eq!(edited.title, "更新后的客厅");
        assert_eq!(edited.tags, vec!["家居".to_string(), "客厅".to_string()]);
        assert_eq!(edited.metadata_version, 2);
        assert!(db
            .update_local_item_metadata(LocalItemMetadataUpdate {
                item_id: imported.id,
                account_pool_id: 1,
                expected_metadata_version: 1,
                title: "旧回执".to_string(),
                tags: Vec::new(),
                style: None,
                material: None,
                scene: None,
                color: None,
            })
            .is_err());

        // Removing the managed file simulates a broken reference. Re-importing
        // the same content restores it and bumps only the image version.
        fs::remove_file(dir.join(&imported.image_path)).expect("remove broken image");
        let missing = db.snapshot().expect("snapshot with missing image");
        assert_eq!(missing.missing_image_ids, vec![imported.id]);
        let repaired = db
            .repair_local_image(LocalImageRepair {
                item_id: imported.id,
                account_pool_id: 1,
                expected_image_version: 1,
                file_name: "恢复.png".to_string(),
                mime_type: Some("image/png".to_string()),
                data_base64: png.to_string(),
                thumbnail_data_base64: None,
            })
            .expect("repair image");
        assert_eq!(repaired.id, imported.id);
        assert_eq!(repaired.image_version, 2);
        assert!(dir.join(&repaired.image_path).is_file());
        assert!(db
            .snapshot()
            .expect("snapshot after repair")
            .missing_image_ids
            .is_empty());
        assert!(db
            .repair_local_image(LocalImageRepair {
                item_id: imported.id,
                account_pool_id: 1,
                expected_image_version: 1,
                file_name: "过期.png".to_string(),
                mime_type: Some("image/png".to_string()),
                data_base64: png.to_string(),
                thumbnail_data_base64: None,
            })
            .is_err());

        db.delete_local_item(imported.id, 1)
            .expect("soft delete image");
        let trashed = db.snapshot().expect("snapshot with trash");
        assert_eq!(trashed.item_count, 0);
        assert_eq!(trashed.items.len(), 0);
        assert_eq!(trashed.trash_items.len(), 1);
        let restored = db
            .restore_local_item(imported.id, 1)
            .expect("restore image");
        assert_eq!(restored.id, imported.id);
        assert_eq!(db.snapshot().expect("snapshot after restore").item_count, 1);

        let invalid_name = db.import_local_image(LocalImageImport {
            account_pool_id: 1,
            file_name: "../escape.png".to_string(),
            mime_type: Some("image/png".to_string()),
            data_base64: png.to_string(),
            thumbnail_data_base64: None,
        });
        assert!(invalid_name.is_err());
        let invalid_bytes = db.import_local_image(LocalImageImport {
            account_pool_id: 1,
            file_name: "bad.png".to_string(),
            mime_type: Some("image/png".to_string()),
            data_base64: STANDARD.encode(b"not an image"),
            thumbnail_data_base64: None,
        });
        assert!(invalid_bytes.is_err());
        let wrong_account = db.import_local_image(LocalImageImport {
            account_pool_id: 999,
            file_name: "wrong.png".to_string(),
            mime_type: Some("image/png".to_string()),
            data_base64: png.to_string(),
            thumbnail_data_base64: None,
        });
        assert!(wrong_account.is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn preserves_existing_note_with_legacy_over_limit_items_when_editing_text() {
        let (db, dir) = temp_db();
        let item_ids: Vec<i64> = (1..=10).collect();
        let item_ids_json = serde_json::to_string(&item_ids).expect("serialize legacy item ids");
        let conn = db.connect().expect("open local db");
        for item_id in &item_ids {
            conn.execute(
                "INSERT INTO items (id, title, image_path, account_pool_id)
                 VALUES (?1, ?2, ?3, 1)",
                params![
                    item_id,
                    format!("素材 {item_id}"),
                    format!("assets/{item_id}.jpg")
                ],
            )
            .expect("seed legacy item");
        }
        conn.execute(
            "INSERT INTO notes (item_id, item_ids, title, body, status, account_pool_id)
             VALUES (?1, ?2, '历史十图笔记', '旧正文', 'draft', 1)",
            params![item_ids[0], item_ids_json],
        )
        .expect("seed legacy note");
        let note_id = conn.last_insert_rowid();
        drop(conn);

        let updated = db
            .update_local_note(LocalNoteUpdate {
                note_id,
                account_pool_id: 1,
                expected_version: 1,
                title: "历史十图笔记".to_string(),
                body: "只改正文也应能保存".to_string(),
                tags: Vec::new(),
                note_type: "text".to_string(),
                item_ids,
            })
            .expect("preserve existing over-limit association");
        assert_eq!(updated.body.as_deref(), Some("只改正文也应能保存"));
        assert_eq!(updated.content_version, 2);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rejects_stale_account_context_before_local_write() {
        let (db, dir) = temp_db();
        assert!(db.snapshot_for_account(Some(999)).is_err());
        assert!(db
            .create_local_draft_for_account("不应写入", Some(999))
            .is_err());
        let snapshot = db.snapshot().expect("read unchanged snapshot");
        assert_eq!(snapshot.note_count, 0);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn persists_local_knowledge_preferences_with_account_boundary() {
        let (db, dir) = temp_db();
        let defaults = db
            .local_knowledge_preferences(Some(1))
            .expect("read default knowledge preferences");
        assert!(defaults.use_my_samples);
        assert!(defaults.use_reference_samples);
        assert!(defaults.use_inspirations);

        let saved = db
            .save_local_knowledge_preferences(LocalKnowledgePreferencesUpdate {
                account_pool_id: 1,
                disabled_rule_keys: vec!["top_tag".to_string()],
                use_my_samples: false,
                use_reference_samples: true,
                use_inspirations: false,
            })
            .expect("save knowledge preferences");
        assert_eq!(saved.disabled_rule_keys, vec!["top_tag".to_string()]);
        assert!(!saved.use_my_samples);
        assert!(!saved.use_inspirations);
        assert!(db
            .save_local_knowledge_preferences(LocalKnowledgePreferencesUpdate {
                account_pool_id: 1,
                disabled_rule_keys: vec!["top_tag".to_string(), " top_tag ".to_string()],
                use_my_samples: true,
                use_reference_samples: true,
                use_inspirations: true,
            })
            .is_err());

        drop(db);
        let reopened = LocalDb::open(dir.join("app.db")).expect("reopen local db");
        let restored = reopened
            .local_knowledge_preferences(Some(1))
            .expect("restore knowledge preferences");
        assert_eq!(restored.disabled_rule_keys, vec!["top_tag".to_string()]);
        assert!(!restored.use_my_samples);
        assert!(reopened
            .save_local_knowledge_preferences(LocalKnowledgePreferencesUpdate {
                account_pool_id: 999,
                disabled_rule_keys: Vec::new(),
                use_my_samples: true,
                use_reference_samples: true,
                use_inspirations: true,
            })
            .is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn moves_local_note_to_trash_and_restores_with_account_boundary() {
        let (db, dir) = temp_db();
        let note = db
            .create_local_draft("可恢复的本地笔记")
            .expect("create note");
        let deleted = db
            .delete_local_note(note.id, 1)
            .expect("move note to trash");
        assert!(deleted.deleted_at.is_some());
        let trashed = db.snapshot().expect("snapshot with note trash");
        assert!(trashed.notes.is_empty());
        assert_eq!(trashed.trash_notes.len(), 1);
        assert!(db.delete_local_note(note.id, 1).is_err());
        assert!(db.restore_local_note(note.id, 999).is_err());
        let restored = db.restore_local_note(note.id, 1).expect("restore note");
        assert!(restored.deleted_at.is_none());
        let after = db.snapshot().expect("snapshot after note restore");
        assert_eq!(after.notes.len(), 1);
        assert!(after.trash_notes.is_empty());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn permanently_purges_only_unreferenced_trashed_items() {
        let (db, dir) = temp_db();
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let imported = db
            .import_local_image(LocalImageImport {
                account_pool_id: 1,
                file_name: "需保护.png".to_string(),
                mime_type: Some("image/png".to_string()),
                data_base64: png.to_string(),
                thumbnail_data_base64: None,
            })
            .expect("import item");
        let note = db
            .create_local_draft_from_items(&[imported.id], Some(1))
            .expect("create associated note");
        db.delete_local_item(imported.id, 1)
            .expect("move item to trash");
        let blocked = db.purge_local_items(&[imported.id], 1);
        assert!(blocked.is_err());
        assert!(dir.join(&imported.image_path).is_file());

        // A trashed note still protects its referenced material.
        db.delete_local_note(note.id, 1)
            .expect("move associated note to trash");
        assert!(db.purge_local_items(&[imported.id], 1).is_err());

        let conn = db.connect().expect("connect to clear test association");
        conn.execute(
            "UPDATE notes SET item_id = NULL, item_ids = '[]' WHERE id = ?1",
            params![note.id],
        )
        .expect("clear test association");
        drop(conn);
        let purged = db
            .purge_local_items(&[imported.id], 1)
            .expect("purge unreferenced item");
        assert_eq!(purged.purged_ids, vec![imported.id]);
        assert!(!dir.join(&imported.image_path).exists());
        let count: i64 = db
            .connect()
            .expect("reopen after purge")
            .query_row(
                "SELECT COUNT(*) FROM items WHERE id = ?1",
                params![imported.id],
                |row| row.get(0),
            )
            .expect("read purged item count");
        assert_eq!(count, 0);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn persists_local_ai_runs_with_scope_and_status() {
        let (db, dir) = temp_db();
        let note = db
            .create_local_draft_for_account("AI 测试", Some(1))
            .expect("create note");
        let started = db
            .upsert_local_ai_run(LocalAIRunUpsert {
                run_id: "run-local-1".to_string(),
                account_pool_id: Some(1),
                note_id: Some(note.id),
                item_id: None,
                provider: "local-cli".to_string(),
                started_at: "2026-09-17T10:00:00Z".to_string(),
                status: "running".to_string(),
                finished_at: None,
                error: None,
            })
            .expect("save running metadata");
        assert_eq!(started.status, "running");
        let latest = db
            .latest_local_ai_run(Some(1), Some(note.id), None)
            .expect("read latest run")
            .expect("run exists");
        assert_eq!(latest.run_id, "run-local-1");
        let completed = db
            .update_local_ai_run(LocalAIRunUpdate {
                run_id: "run-local-1".to_string(),
                account_pool_id: Some(1),
                status: "completed".to_string(),
                finished_at: Some("2026-09-17T10:00:01Z".to_string()),
                error: None,
            })
            .expect("finish run");
        assert_eq!(completed.status, "completed");
        let preserved = db
            .upsert_local_ai_run(LocalAIRunUpsert {
                run_id: "run-local-1".to_string(),
                account_pool_id: Some(1),
                note_id: Some(note.id),
                item_id: None,
                provider: "local-cli".to_string(),
                started_at: "2026-09-17T10:00:00Z".to_string(),
                status: "running".to_string(),
                finished_at: None,
                error: None,
            })
            .expect("late start write is idempotent");
        assert_eq!(preserved.status, "completed");
        let artifact = db
            .save_local_ai_artifact(LocalAIRunArtifactCreate {
                run_id: "run-local-1".to_string(),
                account_pool_id: Some(1),
                note_id: Some(note.id),
                item_id: None,
                kind: "assistant_text".to_string(),
                content: "第一版输出".to_string(),
            })
            .expect("save artifact");
        assert_eq!(artifact.content, "第一版输出");
        let replaced = db
            .save_local_ai_artifact(LocalAIRunArtifactCreate {
                run_id: "run-local-1".to_string(),
                account_pool_id: Some(1),
                note_id: Some(note.id),
                item_id: None,
                kind: "assistant_text".to_string(),
                content: "最终输出".to_string(),
            })
            .expect("replace artifact idempotently");
        assert_eq!(replaced.id, artifact.id);
        let artifacts = db
            .local_ai_artifacts(Some(1), Some(note.id), None)
            .expect("read artifacts");
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].content, "最终输出");
        assert!(db
            .save_local_ai_artifact(LocalAIRunArtifactCreate {
                run_id: "run-local-1".to_string(),
                account_pool_id: Some(2),
                note_id: Some(note.id),
                item_id: None,
                kind: "assistant_text".to_string(),
                content: "越权输出".to_string(),
            })
            .is_err());
        assert!(db
            .latest_local_ai_run(Some(2), Some(note.id), None)
            .is_err());
        assert!(db
            .upsert_local_ai_run(LocalAIRunUpsert {
                run_id: "run-local-2".to_string(),
                account_pool_id: None,
                note_id: Some(note.id),
                item_id: None,
                provider: "local-cli".to_string(),
                started_at: "2026-09-17T10:00:00Z".to_string(),
                status: "running".to_string(),
                finished_at: None,
                error: None,
            })
            .is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn persists_publish_outbox_and_blocks_duplicate_snapshot_submission() {
        let (db, dir) = temp_db();
        let note = db
            .create_local_draft_for_account("发布 outbox 测试", Some(1))
            .expect("create note");
        let snapshot = LocalPublishOutboxPrepare {
            attempt_id: "publish-test-attempt-1".to_string(),
            account_pool_id: 1,
            note_id: note.id,
            snapshot_key: format!("1:note:{}:v{}", note.id, note.content_version),
            content_version: note.content_version,
            snapshot_json: r#"{"title":"发布 outbox 测试","body":"正文","tags":[],"itemIds":[]}"#
                .to_string(),
        };
        let prepared = db
            .prepare_local_publish(snapshot.clone())
            .expect("prepare local publish");
        assert_eq!(prepared.status, "prepared");
        let submitted = db
            .update_local_publish(LocalPublishOutboxUpdate {
                attempt_id: prepared.attempt_id.clone(),
                account_pool_id: 1,
                status: "submitted".to_string(),
                platform_url: None,
                error: None,
            })
            .expect("record submitted");
        assert_eq!(submitted.status, "submitted");
        let duplicate = db
            .prepare_local_publish(LocalPublishOutboxPrepare {
                attempt_id: "publish-test-attempt-2".to_string(),
                ..snapshot
            })
            .expect("reuse submitted snapshot without creating duplicate");
        assert_eq!(duplicate.attempt_id, prepared.attempt_id);
        let history = db
            .local_publish_outbox(Some(1), Some(note.id))
            .expect("read publish history");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, "submitted");
        assert!(db
            .update_local_publish(LocalPublishOutboxUpdate {
                attempt_id: prepared.attempt_id,
                account_pool_id: 2,
                status: "confirmed".to_string(),
                platform_url: None,
                error: None,
            })
            .is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reads_existing_workspace_history_without_recreating_it() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "aichihongshu-legacy-db-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("app.db");
        let legacy = Connection::open(&path).expect("open legacy db");
        legacy
            .execute_batch(
                "CREATE TABLE account_pool (
                     id INTEGER PRIMARY KEY, alias TEXT NOT NULL, role TEXT NOT NULL,
                     user_data_dir TEXT NOT NULL, display_name TEXT, status TEXT NOT NULL
                 );
                 CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
                 CREATE TABLE items (
                     id INTEGER PRIMARY KEY, title TEXT NOT NULL, image_path TEXT NOT NULL,
                     tags TEXT, note_count INTEGER, account_pool_id INTEGER, deleted_at TEXT
                 );
                 CREATE TABLE notes (
                     id INTEGER PRIMARY KEY, item_id INTEGER, item_ids TEXT, title TEXT,
                     tags TEXT, status TEXT, account_pool_id INTEGER
                 );
                 CREATE TABLE my_profile (
                     id INTEGER PRIMARY KEY, account_pool_id INTEGER, account_id TEXT,
                     display_name TEXT, niche TEXT, followers INTEGER, total_notes INTEGER
                 );
                 CREATE TABLE reference_accounts (
                     id INTEGER PRIMARY KEY, account_pool_id INTEGER, account_id TEXT,
                     name TEXT, followers INTEGER, total_likes INTEGER, note_count INTEGER,
                     avg_likes REAL, avg_comments REAL, avg_collects REAL, content_style TEXT,
                     top_notes TEXT, raw_data TEXT, crawled_at TEXT, analyzed_at TEXT,
                     insights TEXT, insights_at TEXT
                 );
                 INSERT INTO account_pool VALUES (1, '主号', 'operation', '/tmp/profile', '历史主号', 'active');
                 INSERT INTO app_settings VALUES ('active_account_id', '1', NULL);
                 INSERT INTO items VALUES (7, '历史图库', 'history.jpg', '[\"家居\"]', 2, 1, NULL);
                 INSERT INTO notes VALUES (9, 7, '[7]', '历史笔记', '[\"装修\"]', 'published', 1);
                 INSERT INTO my_profile VALUES (1, 1, 'history-user', '历史账号', '家居', 88, 9);
                 INSERT INTO reference_accounts VALUES (3, 1, 'reference-user', '历史榜样', 100, 200, 4,
                   50, 5, 10, NULL, '[{\"title\":\"参考笔记\",\"likes\":12}]', NULL, NULL, NULL, NULL, NULL);",
            )
            .expect("seed legacy history");
        drop(legacy);

        let db = LocalDb::open(path).expect("migrate legacy db");
        let snapshot = db.snapshot().expect("read legacy snapshot");
        assert_eq!(snapshot.active_account.id, 1);
        assert_eq!(snapshot.item_count, 1);
        assert_eq!(snapshot.items[0].title, "历史图库");
        assert_eq!(snapshot.notes[0].title.as_deref(), Some("历史笔记"));
        assert_eq!(
            snapshot.reference_accounts[0].name.as_deref(),
            Some("历史榜样")
        );
        assert_eq!(
            snapshot.reference_accounts[0].top_notes[0].title,
            "参考笔记"
        );
        assert_eq!(
            snapshot.profile.unwrap().display_name.as_deref(),
            Some("历史账号")
        );
        db.update_local_profile(LocalProfileUpdate {
            account_pool_id: 1,
            account_id: Some("history-user-updated".to_string()),
            display_name: Some("迁移后人设".to_string()),
            niche: Some("家居改造".to_string()),
            target_audience: Some("租房人群".to_string()),
            content_pillars: vec!["收纳".to_string()],
            persona_name: Some("历史主号人设".to_string()),
            persona_bio: Some("兼容旧表结构".to_string()),
            persona_tone: Some("清晰".to_string()),
            persona_taboos: vec![],
            preferred_styles: vec!["实用".to_string()],
            preferred_scenes: vec!["客厅".to_string()],
            hashtag_pool: vec!["家居改造".to_string()],
            posting_rhythm: Some("每周三篇".to_string()),
        })
        .expect("update profile on legacy table without unique constraint");
        let updated = db.snapshot().expect("read updated legacy profile");
        assert_eq!(
            updated.profile.unwrap().display_name.as_deref(),
            Some("迁移后人设")
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn migrates_legacy_inspirations_before_creating_scope_indexes() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "aichihongshu-legacy-inspiration-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("app.db");
        let legacy = Connection::open(&path).expect("open legacy db");
        legacy
            .execute_batch(
                "CREATE TABLE account_pool (
                     id INTEGER PRIMARY KEY, alias TEXT NOT NULL, role TEXT NOT NULL,
                     user_data_dir TEXT NOT NULL, status TEXT NOT NULL
                 );
                 CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
                 CREATE TABLE inspirations (
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     title TEXT NOT NULL,
                     keyword TEXT,
                     source TEXT DEFAULT 'ai',
                     likes_ref INTEGER DEFAULT 0,
                     note_ref TEXT,
                     saved INTEGER DEFAULT 1,
                     created_at TEXT
                 );
                 INSERT INTO account_pool VALUES (1, '主号', 'operation', '/tmp/profile', 'active');
                 INSERT INTO app_settings VALUES ('active_account_id', '1', NULL);
                 INSERT INTO inspirations
                   (id, title, keyword, source, saved, created_at)
                 VALUES (7, '旧灵感', '旧观察', 'ai', 1, '2026-09-18 10:00:00');",
            )
            .expect("seed legacy inspirations");
        drop(legacy);

        let db = LocalDb::open(path.clone()).expect("migrate legacy inspirations");
        let migrated = db
            .local_inspirations(Some(1))
            .expect("read migrated inspirations");
        assert_eq!(migrated.len(), 1);
        assert_eq!(migrated[0].id, "legacy-7");
        assert_eq!(migrated[0].title, "旧灵感");
        assert_eq!(migrated[0].body, "旧观察");
        assert_eq!(migrated[0].reason, "ai");
        assert_eq!(migrated[0].source_url, "");

        db.save_local_inspiration(LocalInspirationCreate {
            id: "new-inspiration".to_string(),
            account_pool_id: 1,
            title: "新灵感".to_string(),
            source_url: "https://example.com/note".to_string(),
            body: "新观察".to_string(),
            observed_at: "2026-09-18T11:00:00Z".to_string(),
            reason: "手工".to_string(),
            material_type: Some("web_material".to_string()),
            author: Some(String::new()),
            capture_modules: Some(vec![]),
            dedupe_key: None,
        })
        .expect("write UUID-like inspiration id after migration");
        drop(db);

        let reopened = LocalDb::open(path.clone()).expect("reopen migrated inspirations");
        let restored = reopened
            .local_inspirations(Some(1))
            .expect("read restored inspirations");
        assert_eq!(restored.len(), 2);
        let conn = reopened.connect().expect("open migrated database");
        let legacy_table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'inspirations_legacy_v1'",
                [],
                |row| row.get(0),
            )
            .expect("check legacy table cleanup");
        assert_eq!(legacy_table_count, 0);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn persists_local_prompt_configs_and_note_stats_with_account_and_version_guards() {
        let (db, dir) = temp_db();
        let defaults = db
            .list_prompt_configs(Some(1))
            .expect("list default prompts");
        assert_eq!(defaults.len(), 4);
        db.upsert_prompt_config(PromptConfigUpsert {
            account_pool_id: 1,
            key: "custom_test".to_string(),
            label: "测试动作".to_string(),
            prompt: "请检查这篇笔记".to_string(),
            sort_order: 10,
            enabled: true,
        })
        .expect("save local prompt");
        let prompts = db.list_prompt_configs(Some(1)).expect("read local prompts");
        assert_eq!(
            prompts.last().map(|prompt| prompt.key.as_str()),
            Some("custom_test")
        );
        db.delete_prompt_config("custom_test", 1)
            .expect("delete local prompt");
        assert!(db
            .list_prompt_configs(Some(1))
            .expect("read prompts after delete")
            .iter()
            .all(|prompt| prompt.key != "custom_test"));

        let draft = db
            .create_local_draft("互动数据测试")
            .expect("create stats note");
        let updated = db
            .update_local_note_stats(LocalNoteStatsUpdate {
                note_id: draft.id,
                account_pool_id: 1,
                expected_version: draft.content_version,
                field: "likes".to_string(),
                value: 42,
            })
            .expect("update local stats");
        assert_eq!(updated.likes, 42);
        assert!(db
            .update_local_note_stats(LocalNoteStatsUpdate {
                note_id: draft.id,
                account_pool_id: 1,
                expected_version: draft.content_version,
                field: "likes".to_string(),
                value: 99,
            })
            .is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn imports_legacy_prompt_configs_into_account_scoped_settings() {
        let (db, dir) = temp_db();
        let conn = db.connect().expect("open local db");
        conn.execute_batch(
            "CREATE TABLE prompt_configs (
                 key TEXT PRIMARY KEY,
                 label TEXT NOT NULL,
                 prompt TEXT NOT NULL,
                 sort_order INTEGER NOT NULL DEFAULT 0,
                 enabled INTEGER NOT NULL DEFAULT 1
             );
             INSERT INTO prompt_configs (key, label, prompt, sort_order, enabled)
             VALUES ('legacy_prompt', '旧提示词', '保留历史配置', 7, 0);",
        )
        .expect("seed legacy prompt configs");
        drop(conn);

        let prompts = db
            .list_prompt_configs(Some(1))
            .expect("import legacy prompt configs");
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].key, "legacy_prompt");
        assert!(!prompts[0].enabled);

        let conn = db.connect().expect("reopen local db");
        let stored: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'prompt_configs:1'",
                [],
                |row| row.get(0),
            )
            .expect("read account scoped prompt config");
        assert!(stored.contains("legacy_prompt"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn stages_note_images_in_upload_order_and_clears_after_confirm() {
        let (db, dir) = temp_db();
        let assets_dir = dir.join("assets").join("fixtures");
        fs::create_dir_all(&assets_dir).expect("create fixture assets");
        fs::write(assets_dir.join("a.png"), b"image-a").expect("write fixture a");
        fs::write(assets_dir.join("b.png"), b"image-b").expect("write fixture b");

        let conn = db.connect().expect("connect test db");
        conn.execute(
            "INSERT INTO items (id, title, image_path, account_pool_id) VALUES
             (2001, '第一张', 'fixtures/a.png', 1),
             (2002, '第二张', 'fixtures/b.png', 1)",
            [],
        )
        .expect("insert items");
        let note = db.create_local_draft("暂存顺序测试").expect("create draft");
        // 关联顺序与素材 id 顺序相反，验证暂存序号跟随笔记关联顺序。
        conn.execute(
            "UPDATE notes SET item_ids = '[2002, 2001]' WHERE id = ?1",
            params![note.id],
        )
        .expect("set note item order");

        let stage_dir = dir.join("publish_staging").join(note.id.to_string());
        // 模拟上一次暂存遗留的旧文件，重新准备时必须清理。
        fs::create_dir_all(&stage_dir).expect("create stale stage dir");
        fs::write(stage_dir.join("99_stale.png"), b"stale").expect("write stale file");
        drop(conn);

        let staged = db
            .stage_local_note_images(note.id, None)
            .expect("stage note images");
        assert_eq!(staged.note_id, note.id);
        assert_eq!(staged.stage_dir, stage_dir.display().to_string());
        assert_eq!(staged.files.len(), 2);
        assert_eq!(staged.files[0].index, 1);
        assert_eq!(staged.files[0].item_id, 2002);
        assert_eq!(staged.files[0].filename, "01_b.png");
        assert_eq!(staged.files[0].title, "第二张");
        assert_eq!(staged.files[1].index, 2);
        assert_eq!(staged.files[1].item_id, 2001);
        assert_eq!(staged.files[1].filename, "02_a.png");
        assert!(stage_dir.join("01_b.png").is_file());
        assert!(stage_dir.join("02_a.png").is_file());
        assert!(
            !stage_dir.join("99_stale.png").exists(),
            "重新准备必须清掉上次遗留文件"
        );

        // 账号不匹配时既不能暂存，也不能解析暂存目录。
        assert!(db.stage_local_note_images(note.id, Some(999)).is_err());
        assert!(db.local_note_stage_dir(note.id, Some(999)).is_err());
        // 不存在的笔记不能解析暂存目录。
        assert!(db.local_note_stage_dir(987654, None).is_err());

        db.clear_local_note_stage(note.id, None)
            .expect("clear stage after confirm");
        assert!(!stage_dir.exists());
        // 重复清理幂等。
        db.clear_local_note_stage(note.id, None)
            .expect("clear stage again");

        fs::remove_dir_all(dir).ok();
    }

    fn sample_memory_create(content: &str) -> MemoryEntryCreate {
        MemoryEntryCreate {
            account_pool_id: 1,
            origin: "pc".to_string(),
            kind: "fact".to_string(),
            content: content.to_string(),
            subject: Some("门后置物架".to_string()),
            scope: Some("租房".to_string()),
            source: Some("用户口述".to_string()),
            source_type: Some("user".to_string()),
            occurred_at: Some("2026-03".to_string()),
            confirm_status: Some("candidate".to_string()),
            enabled: None,
        }
    }

    #[test]
    fn creates_filters_and_deletes_memory_entries() {
        let (db, dir) = temp_db();
        let created = db
            .create_memory_entry(sample_memory_create("旧塑料架踢脚线卡住"))
            .expect("create memory");
        assert_eq!(created.confirm_status, "candidate");
        assert_eq!(created.origin, "pc");
        assert_eq!(created.kind, "fact");
        assert_eq!(created.occurred_at.as_deref(), Some("2026-03"));

        let mobile = db
            .create_memory_entry(MemoryEntryCreate {
                origin: "mobile".to_string(),
                confirm_status: Some("confirmed".to_string()),
                ..sample_memory_create("手机随手记：阳台推拉门尺寸 1.8m")
            })
            .expect("create mobile memory");
        assert_eq!(mobile.origin, "mobile");

        let pc_only = db
            .list_memory_entries(MemoryEntryFilter {
                account_pool_id: Some(1),
                origin: Some("pc".to_string()),
                kind: None,
                confirm_status: None,
                enabled: None,
            })
            .expect("list pc");
        assert_eq!(pc_only.len(), 1);
        assert_eq!(pc_only[0].id, created.id);

        let candidates = db
            .list_memory_entries(MemoryEntryFilter {
                account_pool_id: Some(1),
                origin: None,
                kind: Some("fact".to_string()),
                confirm_status: Some("candidate".to_string()),
                enabled: None,
            })
            .expect("list candidates");
        assert_eq!(candidates.len(), 1);

        let updated = db
            .update_memory_entry(MemoryEntryUpdate {
                id: created.id,
                account_pool_id: 1,
                kind: "event".to_string(),
                content: "旧塑料架踢脚线卡住，已更换金属架".to_string(),
                subject: Some("门后置物架".to_string()),
                scope: Some("租房".to_string()),
                source: Some("用户口述".to_string()),
                source_type: Some("user".to_string()),
                occurred_at: Some("2026-03".to_string()),
            })
            .expect("update memory");
        assert_eq!(updated.kind, "event");

        db.delete_memory_entry(created.id, 1).expect("delete");
        let after = db
            .list_memory_entries(MemoryEntryFilter {
                account_pool_id: Some(1),
                origin: None,
                kind: None,
                confirm_status: None,
                enabled: None,
            })
            .expect("list after delete");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, mobile.id);
        assert!(db.delete_memory_entry(created.id, 1).is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn enforces_memory_status_machine_and_replacement() {
        let (db, dir) = temp_db();
        let candidate = db
            .create_memory_entry(sample_memory_create("油烟机漏烟（AI 稿推断）"))
            .expect("create");
        // 候选 → 过时 非法
        assert!(db
            .transition_memory_entry_status(MemoryEntryTransition {
                id: candidate.id,
                account_pool_id: 1,
                next_status: "outdated".to_string(),
                replaced_by: None,
            })
            .is_err());

        let confirmed = db
            .transition_memory_entry_status(MemoryEntryTransition {
                id: candidate.id,
                account_pool_id: 1,
                next_status: "confirmed".to_string(),
                replaced_by: None,
            })
            .expect("confirm");
        assert_eq!(confirmed.confirm_status, "confirmed");
        assert_eq!(confirmed.valid_status, "valid");

        // 确认 → 候选 不可逆
        assert!(db
            .transition_memory_entry_status(MemoryEntryTransition {
                id: candidate.id,
                account_pool_id: 1,
                next_status: "candidate".to_string(),
                replaced_by: None,
            })
            .is_err());

        let successor = db
            .create_memory_entry(MemoryEntryCreate {
                confirm_status: Some("confirmed".to_string()),
                ..sample_memory_create("油烟机已换新，漏烟问题解决")
            })
            .expect("create successor");

        // 替代条目必须已确认；候选不能当替代目标
        let pending = db
            .create_memory_entry(sample_memory_create("临时候选"))
            .expect("create pending");
        assert!(db
            .transition_memory_entry_status(MemoryEntryTransition {
                id: candidate.id,
                account_pool_id: 1,
                next_status: "outdated".to_string(),
                replaced_by: Some(pending.id),
            })
            .is_err());

        let outdated = db
            .transition_memory_entry_status(MemoryEntryTransition {
                id: candidate.id,
                account_pool_id: 1,
                next_status: "outdated".to_string(),
                replaced_by: Some(successor.id),
            })
            .expect("outdate");
        assert_eq!(outdated.confirm_status, "outdated");
        assert_eq!(outdated.valid_status, "invalid");
        assert_eq!(outdated.replaced_by, Some(successor.id));

        // 被替代引用的条目不可删
        assert!(db.delete_memory_entry(successor.id, 1).is_err());

        let rejected = db
            .create_memory_entry(sample_memory_create("未确认推断"))
            .expect("create reject");
        let rejected = db
            .transition_memory_entry_status(MemoryEntryTransition {
                id: rejected.id,
                account_pool_id: 1,
                next_status: "rejected".to_string(),
                replaced_by: None,
            })
            .expect("reject");
        assert_eq!(rejected.valid_status, "invalid");
        assert!(db
            .transition_memory_entry_status(MemoryEntryTransition {
                id: rejected.id,
                account_pool_id: 1,
                next_status: "confirmed".to_string(),
                replaced_by: None,
            })
            .is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn isolates_memory_and_prompts_by_account() {
        let (db, dir) = temp_db();
        let entry = db
            .create_memory_entry(sample_memory_create("账号一的私有事实"))
            .expect("create a");
        db.upsert_experience_prompt(ExperiencePromptUpsert {
            account_pool_id: 1,
            origin: "pc".to_string(),
            id: None,
            title: "账号一经验".to_string(),
            content: "仅账号一可见".to_string(),
            enabled: true,
            apply_scope: None,
            apply_target: None,
            source: None,
            sort_order: None,
        })
        .expect("create prompt");

        // 账号不匹配时拒绝读写
        assert!(db
            .update_memory_entry(MemoryEntryUpdate {
                id: entry.id,
                account_pool_id: 999,
                kind: "fact".to_string(),
                content: "越权改写".to_string(),
                subject: None,
                scope: None,
                source: None,
                source_type: None,
                occurred_at: None,
            })
            .is_err());
        assert!(db.delete_memory_entry(entry.id, 999).is_err());
        assert!(db.list_experience_prompts(Some(999), None).is_err());

        // 切到第二个账号后看不到账号一记忆与经验提示词
        db.create_local_account(LocalAccountCreate {
            alias: "记忆隔离测试号".to_string(),
            role: "operation".to_string(),
        })
        .expect("create second account");
        db.set_app_setting("active_account_id", "2")
            .expect("switch active account");
        let second_memories = db
            .list_memory_entries(MemoryEntryFilter {
                account_pool_id: Some(2),
                origin: None,
                kind: None,
                confirm_status: None,
                enabled: None,
            })
            .expect("list second account");
        assert!(second_memories.is_empty());
        let second_prompts = db
            .list_experience_prompts(Some(2), None)
            .expect("list second prompts");
        assert!(second_prompts.is_empty());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn caps_enabled_experience_prompts_and_validates_fields() {
        let (db, dir) = temp_db();
        for index in 0..10 {
            db.upsert_experience_prompt(ExperiencePromptUpsert {
                account_pool_id: 1,
                origin: "pc".to_string(),
                id: None,
                title: format!("经验{index}"),
                content: format!("内容{index}"),
                enabled: true,
                apply_scope: Some("account".to_string()),
                apply_target: Some("compose".to_string()),
                source: Some("user".to_string()),
                sort_order: Some(index),
            })
            .expect("fill enabled prompts");
        }
        let overflow = db.upsert_experience_prompt(ExperiencePromptUpsert {
            account_pool_id: 1,
            origin: "pc".to_string(),
            id: None,
            title: "第11条".to_string(),
            content: "应被拒绝".to_string(),
            enabled: true,
            apply_scope: None,
            apply_target: None,
            source: None,
            sort_order: None,
        });
        assert!(overflow.is_err());

        // 停用一条后可再启用新的
        let list = db
            .list_experience_prompts(Some(1), Some("pc".to_string()))
            .expect("list");
        db.upsert_experience_prompt(ExperiencePromptUpsert {
            account_pool_id: 1,
            origin: "pc".to_string(),
            id: Some(list[0].id),
            title: list[0].title.clone(),
            content: list[0].content.clone(),
            enabled: false,
            apply_scope: Some(list[0].apply_scope.clone()),
            apply_target: Some(list[0].apply_target.clone()),
            source: Some(list[0].source.clone()),
            sort_order: Some(list[0].sort_order),
        })
        .expect("disable one");
        db.upsert_experience_prompt(ExperiencePromptUpsert {
            account_pool_id: 1,
            origin: "pc".to_string(),
            id: None,
            title: "第11条".to_string(),
            content: "应被接受".to_string(),
            enabled: true,
            apply_scope: None,
            apply_target: None,
            source: None,
            sort_order: None,
        })
        .expect("accept after disable");

        assert!(db
            .upsert_experience_prompt(ExperiencePromptUpsert {
                account_pool_id: 1,
                origin: "pc".to_string(),
                id: None,
                title: "".to_string(),
                content: "无标题".to_string(),
                enabled: true,
                apply_scope: None,
                apply_target: None,
                source: None,
                sort_order: None,
            })
            .is_err());
        let long = "字".repeat(301);
        assert!(db
            .upsert_experience_prompt(ExperiencePromptUpsert {
                account_pool_id: 1,
                origin: "pc".to_string(),
                id: None,
                title: "超长".to_string(),
                content: long,
                enabled: true,
                apply_scope: None,
                apply_target: None,
                source: None,
                sort_order: None,
            })
            .is_err());

        // mobile 池独立计数
        db.upsert_experience_prompt(ExperiencePromptUpsert {
            account_pool_id: 1,
            origin: "mobile".to_string(),
            id: None,
            title: "手机经验".to_string(),
            content: "手机侧经验提示词".to_string(),
            enabled: true,
            apply_scope: None,
            apply_target: None,
            source: None,
            sort_order: None,
        })
        .expect("mobile pool has own quota");
        let mobile_list = db
            .list_experience_prompts(Some(1), Some("mobile".to_string()))
            .expect("list mobile");
        assert_eq!(mobile_list.len(), 1);
        db.delete_experience_prompt(mobile_list[0].id, 1, "mobile".to_string())
            .expect("delete mobile prompt");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn stores_and_resets_memory_l1_override() {
        let (db, dir) = temp_db();
        let rules = db.read_memory_system_rules().expect("read defaults");
        assert!(!rules.l1_is_override);
        assert_eq!(rules.l1_active, rules.l1_default);
        assert!(!rules.l0.is_empty());

        let overridden = db
            .save_memory_l1_override("自定义方法论：先列三条避坑点。")
            .expect("save override");
        assert!(overridden.l1_is_override);
        assert_eq!(overridden.l1_active, "自定义方法论：先列三条避坑点。");
        assert_eq!(overridden.l1_default, rules.l1_default);

        assert!(db.save_memory_l1_override("   ").is_err());
        assert!(db.save_memory_l1_override(&"字".repeat(2001)).is_err());

        let reset = db.reset_memory_l1_override().expect("reset");
        assert!(!reset.l1_is_override);
        assert_eq!(reset.l1_active, reset.l1_default);
        fs::remove_dir_all(dir).ok();
    }
}
