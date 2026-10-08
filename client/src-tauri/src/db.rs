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

#[path = "db/accounts.rs"]
mod accounts;
#[path = "db/ai.rs"]
mod ai;
#[path = "db/analytics.rs"]
mod analytics;
pub use analytics::*;
#[path = "db/assets.rs"]
mod assets;
#[path = "db/browser.rs"]
mod browser;
#[path = "db/collection.rs"]
mod collection;
#[path = "db/companion.rs"]
mod companion;
#[path = "db/crawls.rs"]
mod crawls;
#[path = "db/knowledge.rs"]
mod knowledge;
#[path = "db/memory.rs"]
mod memory;
#[path = "db/mobile_prompt_snapshot.rs"]
mod mobile_prompt_snapshot;
pub use mobile_prompt_snapshot::{MobilePromptSnapshot, MobilePromptSnapshotResult};
#[path = "db/migrations.rs"]
mod migrations;
#[path = "db/notes.rs"]
mod notes;
#[path = "db/publish_fill.rs"]
mod publish_fill;
#[path = "db/workspace.rs"]
mod workspace;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAccount {
    pub id: i64,
    pub alias: String,
    pub role: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CrawlLogSummary {
    pub id: i64,
    pub keywords: String,
    pub count: i64,
    pub source_file: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolAccount {
    pub id: i64,
    pub alias: String,
    pub role: String,
    pub user_data_dir: String,
    pub xhs_user_id: Option<String>,
    pub display_name: Option<String>,
    pub followers: i64,
    pub is_active: bool,
    pub status: String,
    pub ban_count: i64,
    pub notes: Option<String>,
    pub created_at: Option<String>,
    pub last_used_at: Option<String>,
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
    pub risk_warning_ack: i64,
    pub risk_warning_ack_at: Option<String>,
    pub crawled_at: Option<String>,
    pub created_at: Option<String>,
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

/// MCP-facing item shape retained from the retired Python `Item` model.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct McpItemSummary {
    pub id: i64,
    pub title: String,
    pub image_path: String,
    pub style: Option<String>,
    pub material: Option<String>,
    pub scene: Option<String>,
    pub color: Option<String>,
    pub tags: Vec<String>,
    pub analysis_raw: Option<String>,
    pub note_count: i64,
    pub account_pool_id: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
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
    pub video_path: Option<String>,
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

#[derive(Debug, Clone, Copy)]
pub struct CompanionTaskProgress<'a> {
    pub task_id: &'a str,
    pub status: &'a str,
    pub item_ids: &'a [i64],
    pub note_id: Option<i64>,
    pub title: Option<&'a str>,
    pub body: Option<&'a str>,
    pub tags: &'a [String],
    pub content_version: Option<i64>,
    pub error: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeItemsResult {
    pub purged_ids: Vec<i64>,
    pub cleanup_warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNoteCreate {
    pub account_pool_id: i64,
    pub item_ids: Vec<i64>,
    pub account_ref: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub tags: Vec<String>,
    pub cover_desc: Option<String>,
    pub prompt_used: Option<String>,
    pub note_type: String,
    #[serde(default)]
    pub video_path: Option<String>,
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
    #[serde(default)]
    pub video_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVideoImportChunk {
    pub note_id: i64,
    pub account_pool_id: i64,
    pub expected_version: i64,
    pub upload_id: String,
    pub filename: String,
    pub mime_type: String,
    pub total_bytes: u64,
    pub offset: u64,
    pub data_base64: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVideoImportResult {
    pub completed: bool,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub note: Option<NoteSummary>,
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
    pub fill_status: String,
    pub fill_expires_at: Option<String>,
    pub fill_result_json: String,
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
pub struct BrowserPublishFillTask {
    pub attempt_id: String,
    pub account_pool_id: i64,
    pub note_id: i64,
    pub content_version: i64,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub image_count: usize,
    pub fill_status: String,
    pub fill_expires_at: Option<String>,
    pub fill_result: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPublishFillClaim {
    pub task: BrowserPublishFillTask,
    pub claim_token: String,
    pub claim_expires_at: String,
}

#[derive(Debug, Clone, Copy)]
pub struct BrowserPublishFillResult<'a> {
    pub attempt_id: &'a str,
    pub expected_account_id: i64,
    pub claim_token: &'a str,
    pub title_status: &'a str,
    pub title_error: Option<&'a str>,
    pub body_status: &'a str,
    pub body_error: Option<&'a str>,
    pub image_results: &'a [serde_json::Value],
    pub video_status: &'a str,
    pub video_error: Option<&'a str>,
    pub cancelled: bool,
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
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAccountUpdate {
    pub account_id: i64,
    pub alias: String,
    pub role: String,
    #[serde(default)]
    pub xhs_user_id: Option<String>,
    pub display_name: Option<String>,
    pub status: String,
    #[serde(default)]
    pub followers: Option<i64>,
    #[serde(default)]
    pub notes: Option<String>,
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
    #[serde(default)]
    pub followers: Option<i64>,
    pub persona_name: Option<String>,
    pub persona_bio: Option<String>,
    pub persona_tone: Option<String>,
    pub persona_taboos: Vec<String>,
    pub preferred_styles: Vec<String>,
    pub preferred_scenes: Vec<String>,
    pub hashtag_pool: Vec<String>,
    pub posting_rhythm: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub xhs_bio: Option<String>,
    #[serde(default)]
    pub xhs_follows: Option<i64>,
    #[serde(default)]
    pub ip_location: Option<String>,
    #[serde(default)]
    pub xhs_tags: Option<Vec<String>>,
    #[serde(default)]
    pub risk_warning_ack: Option<i64>,
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
    pub share: Option<i64>,
    pub followers: Option<i64>,
    pub note_count: Option<i64>,
    #[serde(default)]
    pub capture_details: serde_json::Value,
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

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfileNote {
    pub note_url: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub likes: Option<i64>,
    pub comments: Option<i64>,
    pub collects: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct BrowserProfileSnapshot<'a> {
    pub account_pool_id: i64,
    pub profile_account_id: &'a str,
    pub display_name: Option<&'a str>,
    pub followers: Option<i64>,
    pub total_notes: Option<i64>,
    pub avatar_url: Option<&'a str>,
    pub xhs_bio: Option<&'a str>,
    pub xhs_follows: Option<i64>,
    pub ip_location: Option<&'a str>,
    pub xhs_tags: Option<&'a [String]>,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfileNoteSync {
    pub matched_profile: bool,
    pub matched_reference: bool,
    pub imported: usize,
    pub updated: usize,
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
    #[serde(default)]
    pub note_count: Option<i64>,
    #[serde(default)]
    pub avg_likes: Option<f64>,
    #[serde(default)]
    pub avg_comments: Option<f64>,
    #[serde(default)]
    pub avg_collects: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct LocalReferenceAccountApiUpsert {
    pub account_pool_id: i64,
    pub account_id: String,
    pub name: Option<String>,
    pub followers: i64,
    pub note_count: i64,
    pub avg_likes: f64,
    pub avg_comments: f64,
    pub avg_collects: f64,
    pub content_style: Option<String>,
    pub top_notes: Vec<ReferenceNote>,
}

/// Full manual reference-account payload used by the legacy CLI contract.
#[derive(Debug, Clone)]
pub struct LocalReferenceAccountManualUpsert {
    pub account_pool_id: i64,
    pub account_id: String,
    pub name: String,
    pub followers: i64,
    pub note_count: i64,
    pub avg_likes: f64,
    pub avg_comments: f64,
    pub avg_collects: f64,
    pub content_style: Option<String>,
    pub top_notes: Vec<ReferenceNote>,
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
    pub clip_kind: String,
    pub author: String,
    pub capture_modules: Vec<String>,
    pub capture_payload: String,
    pub collection_tags: Vec<String>,
    pub collection_images: Vec<BrowserCollectionImageSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInspirationDraftResult {
    pub inspiration: InspirationSummary,
    pub note: NoteSummary,
}

/// A non-owning link from a saved clipping to another account-scoped object.
/// Removing this row never deletes either object or its media files.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInspirationReferenceSummary {
    pub inspiration_id: String,
    pub account_pool_id: i64,
    pub target_kind: String,
    pub target_id: String,
    pub target_exists: bool,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInspirationReferenceAccountResult {
    pub inspiration_id: String,
    pub account_pool_id: i64,
    pub reference_account_id: i64,
    pub platform_account_id: String,
    pub name: Option<String>,
    pub link_created: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCollectionImageSummary {
    pub position: i64,
    pub source_url: String,
    pub source_kind: String,
    pub status: String,
    pub byte_size: Option<i64>,
    pub mime_type: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub error: Option<String>,
    pub original_available: bool,
    pub thumbnail_available: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct BrowserCollectionImageSave<'a> {
    pub id: &'a str,
    pub account_pool_id: i64,
    pub position: i64,
    pub expected_source_url: &'a str,
    pub expected_request_id: Option<&'a str>,
    pub bytes: &'a [u8],
    pub mime_type: &'a str,
    pub thumbnail_bytes: &'a [u8],
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone)]
pub struct BrowserCollectionImageUpload {
    pub inspiration_id: String,
    pub account_pool_id: i64,
    pub position: i64,
    pub request_id: String,
    pub source_url: String,
    pub total_bytes: usize,
    pub sha256: String,
    pub mime_type: String,
    pub temp_name: String,
    pub next_offset: usize,
    pub already_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureImageUploadProgress {
    pub next_offset: usize,
    pub total_bytes: usize,
    pub already_ready: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct BrowserCaptureImageUploadStart<'a> {
    pub id: &'a str,
    pub account_pool_id: i64,
    pub position: i64,
    pub request_id: &'a str,
    pub total_bytes: usize,
    pub sha256: &'a str,
    pub mime_type: &'a str,
}

#[derive(Debug, Clone)]
pub struct BrowserCaptureImageUploadCompleted {
    pub inspiration_id: String,
    pub account_pool_id: i64,
    pub position: i64,
    pub request_id: String,
    pub source_url: String,
    pub total_bytes: usize,
    pub sha256: String,
    pub mime_type: String,
    pub temp_path: PathBuf,
}

/// Legacy `/api/knowledge/inspirations` row shape retained for the Rust Web adapter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyKnowledgeInspiration {
    pub id: i64,
    pub title: String,
    pub keyword: Option<String>,
    pub source: String,
    pub likes_ref: i64,
    pub note_ref: Option<String>,
    pub saved: bool,
    pub created_at: Option<String>,
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
    pub last_snapshot_metrics: Option<BrowserPageSnapshotMetrics>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageSnapshotMetrics {
    pub like: Option<i64>,
    pub collect: Option<i64>,
    pub comment: Option<i64>,
    pub share: Option<i64>,
    pub followers: Option<i64>,
    pub note_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureRequestStatus {
    pub request_id: String,
    pub target_account_id: i64,
    pub collection_saved: bool,
    pub capture_details_saved: bool,
    pub images_total: usize,
    pub images_ready: usize,
    pub images_failed: usize,
    pub snapshot_saved: bool,
    pub snapshot_id: Option<i64>,
    pub profile_notes_saved: bool,
    pub profile_notes_imported: usize,
    pub profile_notes_updated: usize,
    pub profile_notes_skipped: bool,
    pub profile_notes_state: Option<String>,
    pub profile_notes_error: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalItemAnalysisTitlePolicy {
    /// A new CLI/MCP import uses the model title unless the user supplied a title.
    Force,
    /// Re-analysis replaces only a title that still looks like an imported filename.
    IfDefault,
    /// Preserve a title explicitly provided by the user.
    Preserve,
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

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalContentKnowledgeContext {
    pub rules: Vec<String>,
    #[serde(skip)]
    pub rule_summaries: Vec<LocalKnowledgeRule>,
    pub my_samples: Vec<LocalKnowledgeSample>,
    pub reference_samples: Vec<LocalKnowledgeSample>,
    pub inspirations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalKnowledgeRule {
    pub key: String,
    pub label: String,
    pub desc: String,
    pub value: serde_json::Value,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalKnowledgeSample {
    pub title: String,
    pub body_preview: String,
    pub likes: i64,
    pub account: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeMySample {
    pub id: i64,
    pub title: Option<String>,
    pub body: Option<String>,
    pub tags: Vec<String>,
    pub likes: i64,
    pub comments: i64,
    pub collects: i64,
    pub published_at: Option<String>,
    pub note_url: Option<String>,
    pub body_preview: String,
    pub use_as_reference: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeReferenceSample {
    pub title: String,
    pub body: String,
    pub likes: i64,
    pub note_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeReferenceGroup {
    pub account_id: String,
    pub name: String,
    pub notes: Vec<KnowledgeReferenceSample>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeReferenceSampleSaveResult {
    pub duplicate: bool,
    pub count: usize,
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
        migrations::migrate(&mut conn)?;
        let active = ensure_active_account(&conn, &db.path)?;
        migrations::import_legacy_inspirations(&mut conn, active.id)?;
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Return SQLite's local calendar date for legacy analytics that use local timestamps.
    pub fn local_calendar_day(&self) -> SqlResult<String> {
        let conn = self.connect()?;
        conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
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
    if content.chars().count() > 5000 {
        return Err("经验提示词内容最多 5000 字".to_string());
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
             WHERE substr(key, 1, 5) != 'rule_'
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

/// Python stored knowledge-rule switches beside quick prompts using empty
/// `prompt` values. Move the disabled keys into the account-scoped preference
/// record instead of treating them as invalid quick-prompt entries.
fn legacy_disabled_rule_keys(conn: &Connection) -> Vec<String> {
    let exists = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'prompt_configs'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if !exists {
        return Vec::new();
    }
    let Ok(mut statement) = conn.prepare(
        "SELECT key FROM prompt_configs
         WHERE substr(key, 1, 5) = 'rule_' AND COALESCE(enabled, 1) = 0
         ORDER BY key",
    ) else {
        return Vec::new();
    };
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .ok()
        .map(|rows| rows.filter_map(SqlResult::ok).collect())
        .unwrap_or_default()
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
        item_summary_from_row,
    )
}

fn item_summary_from_row(row: &rusqlite::Row<'_>) -> SqlResult<ItemSummary> {
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
        item_summary_from_row,
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
        .query_map(params![account_id], item_summary_from_row)?
        .collect::<SqlResult<Vec<_>>>();
    rows
}

fn read_note_summary(conn: &Connection, note_id: i64, account_id: i64) -> SqlResult<NoteSummary> {
    conn.query_row(
        "SELECT id, item_id, item_ids, title, body, tags, status, note_type,
                likes, comments, collects, published_at, note_url, account_ref,
                cover_desc, prompt_used, created_at, updated_at, content_version, deleted_at,
                video_path
         FROM notes WHERE id = ?1 AND account_pool_id = ?2",
        params![note_id, account_id],
        note_summary_from_row,
    )
}

fn note_summary_from_row(row: &rusqlite::Row<'_>) -> SqlResult<NoteSummary> {
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
                cover_desc, prompt_used, created_at, updated_at, content_version, deleted_at,
                video_path
         FROM notes
         WHERE account_pool_id = ?1 AND deleted_at {deleted_clause}
         ORDER BY id DESC
         LIMIT 5000"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![account_id], note_summary_from_row)?;
    rows.collect()
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

fn ensure_active_account(conn: &Connection, db_path: &Path) -> SqlResult<ActiveAccount> {
    let configured_setting = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'active_account_id'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?;
    let configured_id = match configured_setting {
        None => None,
        Some(None) => {
            return Err(rusqlite::Error::InvalidParameterName(
                "active_account_id has no account ID".into(),
            ));
        }
        Some(Some(value)) => Some(value.parse::<i64>().map_err(|_| {
            rusqlite::Error::InvalidParameterName(
                "active_account_id is not a valid account ID".into(),
            )
        })?),
    };

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
    last_snapshot_metrics: Option<BrowserPageSnapshotMetrics>,
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
        last_snapshot_metrics,
    }
}

fn browser_page_snapshot_metrics(raw: &str) -> Option<BrowserPageSnapshotMetrics> {
    let metrics = serde_json::from_str::<PageSnapshotMetrics>(raw).ok()?;
    Some(BrowserPageSnapshotMetrics {
        like: metrics.like,
        collect: metrics.collect,
        comment: metrics.comment,
        share: metrics.share,
        followers: metrics.followers,
        note_count: metrics.note_count,
    })
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
    let material_type = material_type.unwrap_or_else(|| "web_material".to_string());
    let author: Option<String> = row.get(11)?;
    let capture_modules: Option<String> = row.get(12)?;
    let capture_payload: Option<String> = row.get(13)?;
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
        material_type: material_type.clone(),
        clip_kind: match material_type.as_str() {
            "profile_material" => "account",
            "image_material" => "material",
            _ => "note",
        }
        .to_string(),
        author: author.unwrap_or_default(),
        capture_modules: capture_modules
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default(),
        capture_payload: capture_payload.unwrap_or_else(|| "{}".to_string()),
        collection_tags: Vec::new(),
        collection_images: Vec::new(),
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
        fill_status: row.get(9)?,
        fill_expires_at: row.get(10)?,
        fill_result_json: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn read_publish_outbox_by_id(
    conn: &Connection,
    attempt_id: &str,
) -> SqlResult<Option<PublishOutboxSummary>> {
    conn.query_row(
        "SELECT attempt_id, account_pool_id, note_id, snapshot_key,
                content_version, snapshot_json, status, platform_url, error,
                fill_status, fill_expires_at, fill_result_json, created_at, updated_at
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

fn ensure_capture_account(conn: &Connection, account_id: i64) -> SqlResult<()> {
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM account_pool WHERE id = ?1",
            params![account_id],
            |row| row.get(0),
        )
        .optional()?;
    match status.as_deref() {
        Some("active") => Ok(()),
        Some(_) => Err(rusqlite::Error::InvalidParameterName(format!(
            "account {account_id} is not active"
        ))),
        None => Err(rusqlite::Error::InvalidParameterName(format!(
            "account {account_id} does not exist"
        ))),
    }
}

#[cfg(test)]
#[path = "db/tests.rs"]
mod tests;
