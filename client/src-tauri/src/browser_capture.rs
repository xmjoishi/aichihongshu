//! 浏览器剪藏与单篇快照回传链路（CHG-20260916-001 / N12，D4 混合路线）。
//!
//! 链路：Chrome 扩展（纯消息传输）→ 桌面应用内 Rust Native Host →
//! owner-only、按通道/工作区隔离的 Unix socket（单行 JSON）→ 本模块 →
//! 镜像再校验 + 以当前激活账号盖章 targetAccountId →
//! SQLite 持久化 / `browser-capture://message` UI 通知。
//!
//! 安全边界：
//! - socket 目录与文件 owner-only（0700 / 0600），只接受本机同用户连接；
//! - 不采纳消息里的任何账号字段，targetAccountId 一律由本进程盖章；
//! - 字段校验镜像 client/src/lib/browserCapture.ts 的 TS 契约；
//! - 浏览器收藏在 Native Messaging 返回成功前直接写入当前账号 SQLite；事件只负责通知 UI。

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const CAPTURE_EVENT: &str = "browser-capture://message";

const MAX_WIRE_BYTES: usize = 256 * 1024;
const MAX_TITLE_CHARS: usize = 200;
const MAX_URL_CHARS: usize = 2_000;
const MAX_BODY_CHARS: usize = 20_000;
const MAX_REASON_CHARS: usize = 2_000;
const MAX_OBSERVED_AT_CHARS: usize = 64;
const MAX_REQUEST_ID_CHARS: usize = 128;
const MAX_PROFILE_BIO_CHARS: usize = 2_000;
const MAX_PROFILE_TAGS: usize = 30;
const MAX_PROFILE_NOTES: usize = 30;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureEvent {
    pub title: String,
    pub source_url: String,
    pub body: String,
    pub reason: String,
    pub observed_at: String,
    pub request_id: Option<String>,
    pub target_account_id: i64,
    pub transport: &'static str,
    /// clip | note_snapshot | ref_snapshot
    pub kind: String,
    /// note_material | profile_material | web_material
    pub material_type: String,
    /// note | profile | web
    pub page_type: String,
    pub image_transfer_protocol: bool,
    pub profile_notes_requested: bool,
    pub author: String,
    pub metrics: BrowserCaptureMetrics,
    pub profile: BrowserCaptureProfile,
    pub modules: BrowserCaptureModules,
    pub capture_details: Value,
    /// Filled by the local database lookup, never copied from the extension.
    pub reference_account_id: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureMetrics {
    pub like: Option<i64>,
    pub collect: Option<i64>,
    pub comment: Option<i64>,
    pub share: Option<i64>,
    pub followers: Option<i64>,
    pub note_count: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureProfile {
    pub avatar_url: Option<String>,
    pub bio: String,
    pub follows: Option<i64>,
    pub ip_location: String,
    pub tags: Vec<String>,
}

impl BrowserCaptureProfile {
    fn has_data(&self) -> bool {
        self.avatar_url.is_some()
            || !self.bio.is_empty()
            || self.follows.is_some()
            || !self.ip_location.is_empty()
            || !self.tags.is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureModules {
    pub collect: BrowserCaptureCollectModules,
    pub data: BrowserCaptureDataModules,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureCollectModules {
    pub title_body: bool,
    pub author_source: bool,
    pub images: bool,
    pub comments: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureDataModules {
    pub metrics: bool,
    pub published_at: bool,
}

/// 与 TS 契约一致：非字符串字段按空串处理，字符串截断到上限。
fn text(value: &Value, field: &str, max_chars: usize) -> String {
    match value.get(field) {
        Some(Value::String(text)) => text.truncated(max_chars),
        _ => String::new(),
    }
}

fn optional_count(value: &Value, field: &str) -> Option<i64> {
    match value.get(field) {
        Some(Value::Number(n)) => n.as_i64().filter(|n| *n >= 0),
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                trimmed.parse::<i64>().ok().filter(|n| *n >= 0)
            }
        }
        _ => None,
    }
}

fn xhs_profile_id_from_url(source_url: &str) -> Option<&str> {
    let rest = source_url.strip_prefix("https://")?;
    let (host, path) = rest.split_once('/')?;
    if !matches!(
        host.to_ascii_lowercase().as_str(),
        "xiaohongshu.com" | "www.xiaohongshu.com"
    ) {
        return None;
    }
    let id = path.strip_prefix("user/profile/")?;
    let id = id.split(['/', '?', '#']).next()?.trim();
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return None;
    }
    Some(id)
}

fn module_flag(value: &Value, path: &[&str], default: bool) -> bool {
    let mut current = value;
    for key in path {
        let Some(next) = current.get(*key) else {
            return default;
        };
        current = next;
    }
    current.as_bool().unwrap_or(default)
}

/// 分享链接通常带有渠道、设备和跟踪参数；这些参数不应让同一条笔记
/// 被重复收藏。保留 source_url 原值用于回访，只对去重键提取稳定的笔记 ID。
fn collection_dedupe_key(account_id: i64, source_url: &str, title: &str) -> Option<String> {
    let source_url = source_url.trim();
    if source_url.is_empty() {
        return None;
    }

    let without_scheme = source_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(source_url);
    let path_start = without_scheme.find('/');
    let (host, path) = match path_start {
        Some(index) => (&without_scheme[..index], &without_scheme[index..]),
        None => (without_scheme, ""),
    };
    let host = host.to_ascii_lowercase();
    let is_xiaohongshu = host == "xiaohongshu.com" || host.ends_with(".xiaohongshu.com");

    if is_xiaohongshu {
        let path = path.split(['?', '#']).next().unwrap_or("");
        let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        let stable_id = match segments.as_slice() {
            ["explore", id] if !id.is_empty() => Some(("note", *id)),
            ["discovery", "item", id] if !id.is_empty() => Some(("note", *id)),
            ["user", "profile", id] if !id.is_empty() => Some(("profile", *id)),
            _ => None,
        };
        if let Some((kind, id)) = stable_id {
            return Some(format!(
                "{}|xiaohongshu|{}|{}",
                account_id,
                kind,
                id.to_ascii_lowercase()
            ));
        }
    }

    Some(format!(
        "{}|{}|{}",
        account_id,
        source_url.to_lowercase(),
        title.trim().to_lowercase()
    ))
}

trait Truncate {
    fn truncated(self, max_chars: usize) -> String;
}

impl Truncate for &String {
    fn truncated(self, max_chars: usize) -> String {
        self.trim().chars().take(max_chars).collect()
    }
}

/// 镜像 browserCapture.ts 的消息校验；账号字段不采纳，等待盖章。
pub fn validate_incoming(raw: &str) -> Result<BrowserCaptureEvent, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|_| "剪藏消息不是有效 JSON".to_string())?;
    if !value.is_object() {
        return Err("剪藏消息格式无效".to_string());
    }

    let title = text(&value, "title", MAX_TITLE_CHARS);
    if title.is_empty() {
        return Err("剪藏标题不能为空".to_string());
    }
    let source_url = text(&value, "sourceUrl", MAX_URL_CHARS);
    if !(source_url.is_empty()
        || source_url.starts_with("http://")
        || source_url.starts_with("https://"))
    {
        return Err("来源链接必须以 http:// 或 https:// 开头".to_string());
    }

    let request_id = text(&value, "requestId", MAX_REQUEST_ID_CHARS);
    let target_account_id = match value.get("targetAccountId") {
        Some(Value::Number(number)) => number
            .as_i64()
            .filter(|account_id| *account_id > 0)
            .ok_or_else(|| "目标账号 ID 无效".to_string())?,
        Some(Value::Null) | None => 0,
        _ => return Err("目标账号 ID 无效".to_string()),
    };

    let mut kind = match text(&value, "kind", 32).as_str() {
        "note_snapshot" | "ref_snapshot" | "clip" => text(&value, "kind", 32),
        _ => "clip".to_string(),
    };
    let material_type = match text(&value, "materialType", 32).as_str() {
        "note_material" | "profile_material" | "web_material" | "image_material" => {
            text(&value, "materialType", 32)
        }
        _ => match kind.as_str() {
            "note_snapshot" => "note_material".to_string(),
            "ref_snapshot" => "profile_material".to_string(),
            _ => "web_material".to_string(),
        },
    };
    let page_type = match text(&value, "pageType", 16).as_str() {
        "note" | "profile" | "web" => text(&value, "pageType", 16),
        _ => "web".to_string(),
    };
    let profile_notes_requested = match value.get("profileNotesRequested") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(requested)) => *requested,
        _ => return Err("主页笔记显式请求标记无效".to_string()),
    };
    if profile_notes_requested && page_type != "profile" {
        return Err("主页笔记同步只能用于主页采集".to_string());
    }
    if profile_notes_requested {
        kind = "ref_snapshot".to_string();
    }

    let modules = BrowserCaptureModules {
        collect: BrowserCaptureCollectModules {
            title_body: module_flag(&value, &["modules", "collect", "titleBody"], true),
            author_source: module_flag(&value, &["modules", "collect", "authorSource"], true),
            images: module_flag(&value, &["modules", "collect", "images"], false),
            comments: module_flag(&value, &["modules", "collect", "comments"], false),
        },
        data: BrowserCaptureDataModules {
            metrics: module_flag(
                &value,
                &["modules", "data", "metrics"],
                kind != "clip" && !profile_notes_requested,
            ),
            published_at: module_flag(&value, &["modules", "data", "publishedAt"], false),
        },
    };

    let profile = validate_profile(&value, &page_type);
    let mut capture_details = validate_capture_details(
        &value,
        &modules,
        &page_type,
        &material_type,
        profile_notes_requested,
    );
    if let Some(details) = capture_details.as_object_mut() {
        if page_type == "note" || page_type == "profile" {
            details.insert("metrics".to_string(), serde_json::json!({
                "like": optional_count(&value, "like"),
                "collect": optional_count(&value, "collect"),
                "comment": optional_count(&value, "comment"),
                "share": optional_count(&value, "share").or_else(|| optional_count(&value, "shares")),
                "followers": optional_count(&value, "followers"),
                "noteCount": optional_count(&value, "noteCount"),
                "evidence": value.get("evidence").cloned().unwrap_or(Value::Null),
            }));
        }
        if page_type == "profile" {
            details.insert(
                "profile".to_string(),
                serde_json::to_value(&profile).unwrap_or(Value::Null),
            );
        }
    }

    Ok(BrowserCaptureEvent {
        title,
        source_url,
        body: text(&value, "body", MAX_BODY_CHARS),
        reason: text(&value, "reason", MAX_REASON_CHARS),
        observed_at: text(&value, "observedAt", MAX_OBSERVED_AT_CHARS),
        request_id: if request_id.is_empty() {
            None
        } else {
            Some(request_id)
        },
        // 一律不信任扩展提供的账号；由 handle_connection 以当前激活账号盖章。
        target_account_id,
        transport: "extension",
        kind,
        material_type,
        page_type,
        image_transfer_protocol: value
            .get("imageTransferProtocol")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        profile_notes_requested,
        author: text(&value, "author", 200),
        metrics: BrowserCaptureMetrics {
            like: optional_count(&value, "like"),
            collect: optional_count(&value, "collect"),
            comment: optional_count(&value, "comment"),
            share: optional_count(&value, "share").or_else(|| optional_count(&value, "shares")),
            followers: optional_count(&value, "followers"),
            note_count: optional_count(&value, "noteCount"),
        },
        profile,
        modules,
        capture_details,
        reference_account_id: None,
    })
}

fn validate_profile(value: &Value, page_type: &str) -> BrowserCaptureProfile {
    if page_type != "profile" {
        return BrowserCaptureProfile::default();
    }
    let Some(profile) = value.get("profile").and_then(Value::as_object) else {
        return BrowserCaptureProfile::default();
    };
    let avatar_url = profile
        .get("avatarUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| safe_public_image_reference(url))
        .map(|url| url.chars().take(MAX_URL_CHARS).collect());
    let bio = profile
        .get("bio")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(MAX_PROFILE_BIO_CHARS)
        .collect();
    let follows = optional_count(&Value::Object(profile.clone()), "follows");
    let ip_location = profile
        .get("ipLocation")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(100)
        .collect();
    let mut tags = Vec::new();
    if let Some(values) = profile.get("tags").and_then(Value::as_array) {
        for value in values.iter().take(MAX_PROFILE_TAGS * 2) {
            let Some(tag) = value.as_str() else { continue };
            let tag = tag.trim().trim_start_matches('#');
            if tag.is_empty() || tag.chars().count() > 80 || tags.iter().any(|saved| saved == tag) {
                continue;
            }
            tags.push(tag.to_string());
            if tags.len() == MAX_PROFILE_TAGS {
                break;
            }
        }
    }
    BrowserCaptureProfile {
        avatar_url,
        bio,
        follows,
        ip_location,
        tags,
    }
}

fn validate_capture_details(
    value: &Value,
    modules: &BrowserCaptureModules,
    page_type: &str,
    material_type: &str,
    profile_notes_requested: bool,
) -> Value {
    const MAX_IMAGES: usize = 12;
    const MAX_COMMENTS: usize = 20;
    let images = if modules.collect.images
        && (page_type == "note" || material_type == "image_material")
    {
        value
            .get("images")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_IMAGES)
            .filter_map(|item| {
                let url = item.get("url").and_then(Value::as_str)?.trim();
                if !safe_public_image_reference(url) {
                    return None;
                }
                let width = optional_count(item, "width").filter(|n| *n <= 20_000);
                let height = optional_count(item, "height").filter(|n| *n <= 20_000);
                Some(serde_json::json!({
                    "url": url.chars().take(2_000).collect::<String>(),
                    "width": width,
                    "height": height,
                    "order": optional_count(item, "domIndex").unwrap_or_default().min(1000),
                    "source": if material_type == "image_material" { "selected-page-image" } else { "visible-note-image" },
                }))
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let comments = if modules.collect.comments && page_type == "note" {
        value
            .get("comments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_COMMENTS)
            .filter_map(|item| {
                let text = item.get("text").and_then(Value::as_str)?.trim();
                if text.is_empty() {
                    return None;
                }
                Some(serde_json::json!({
                    "author": item.get("author").and_then(Value::as_str).unwrap_or("").chars().take(80).collect::<String>(),
                    "text": text.chars().take(350).collect::<String>(),
                    "likes": optional_count(item, "likes"),
                    "truncated": item.get("truncated").and_then(Value::as_bool).unwrap_or(text.chars().count() > 350),
                    "source": "currently-loaded-comment",
                }))
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut evidence = serde_json::Map::new();
    if let Some(input) = value.get("evidence").and_then(Value::as_object) {
        for key in ["like", "collect", "comment", "followers", "noteCount"] {
            if let Some(item) = input.get(key).and_then(Value::as_object) {
                evidence.insert(key.to_string(), serde_json::json!({
                    "source": item.get("source").and_then(Value::as_str).map(|s| s.chars().take(120).collect::<String>()),
                    "missingReason": item.get("missingReason").and_then(Value::as_str).map(|s| s.chars().take(180).collect::<String>()),
                }));
            }
        }
    }
    let profile_notes_state = if profile_notes_requested {
        match value.get("profileNotesState").and_then(Value::as_str) {
            Some("complete") => "complete",
            Some("partial") => "partial",
            Some("login-required") => "login-required",
            Some("verification-required") => "verification-required",
            Some("not-profile") => "not-profile",
            _ => "unavailable",
        }
    } else {
        "not-requested"
    };
    let profile_notes = if profile_notes_requested {
        value
            .get("profileNotes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_PROFILE_NOTES)
            .filter_map(|item| {
                let note_url = canonical_profile_note_url(item.get("noteUrl").and_then(Value::as_str)?.trim())?;
                let title = item.get("title").and_then(Value::as_str)?.trim();
                if title.is_empty() {
                    return None;
                }
                let tags = item
                    .get("tags")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|tag| !tag.is_empty())
                    .take(20)
                    .map(|tag| tag.chars().take(80).collect::<String>())
                    .collect::<Vec<_>>();
                Some(serde_json::json!({
                    "noteUrl": note_url,
                    "title": title.chars().take(MAX_TITLE_CHARS).collect::<String>(),
                    "body": item.get("body").and_then(Value::as_str).unwrap_or("").chars().take(1_200).collect::<String>(),
                    "likes": optional_count(item, "likes").filter(|count| *count <= 1_000_000_000_000),
                    "comments": optional_count(item, "comments").filter(|count| *count <= 1_000_000_000_000),
                    "collects": optional_count(item, "collects").filter(|count| *count <= 1_000_000_000_000),
                    "tags": tags,
                    "publishedAt": item.get("publishedAt").and_then(Value::as_str).map(|s| s.chars().take(80).collect::<String>()),
                }))
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    serde_json::json!({
        "images": images,
        "comments": comments,
        "evidence": evidence,
        "publishedAt": value.get("publishedAt").and_then(Value::as_str).map(|s| s.chars().take(80).collect::<String>()),
        "publishedLocation": value.get("publishedLocation").and_then(Value::as_str).map(|s| s.chars().take(100).collect::<String>()),
        "profileNotesState": profile_notes_state,
        "profileNotes": profile_notes,
    })
}

fn canonical_profile_note_url(raw: &str) -> Option<String> {
    if raw.len() > MAX_URL_CHARS || raw.chars().any(char::is_control) {
        return None;
    }
    let rest = raw.strip_prefix("https://")?;
    let (authority, path_and_suffix) = rest.split_once('/')?;
    if authority.contains('@') || authority.contains(':') {
        return None;
    }
    if !matches!(
        authority.to_ascii_lowercase().as_str(),
        "xiaohongshu.com" | "www.xiaohongshu.com"
    ) {
        return None;
    }
    let path = path_and_suffix.split(['?', '#']).next().unwrap_or_default();
    let segments = path.split('/').collect::<Vec<_>>();
    let note_id = match segments.as_slice() {
        ["explore", note_id] if !note_id.is_empty() => *note_id,
        ["discovery", "item", note_id] if !note_id.is_empty() => *note_id,
        _ => return None,
    };
    if note_id.len() > 128
        || !note_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return None;
    }
    Some(format!("https://{authority}/{path}"))
}

fn safe_public_image_reference(raw: &str) -> bool {
    if raw.len() > MAX_URL_CHARS || !raw.starts_with("https://") {
        return false;
    }
    let authority = raw[8..]
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    let hostname = if authority.starts_with('[') {
        authority
            .split_once(']')
            .map(|(host, _)| &host[1..])
            .unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    }
    .trim_end_matches('.')
    .to_ascii_lowercase();
    let non_public_ip = hostname
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| match ip {
            std::net::IpAddr::V4(address) => {
                let octets = address.octets();
                address.is_private()
                    || address.is_loopback()
                    || address.is_link_local()
                    || address.is_broadcast()
                    || address.is_multicast()
                    || address.is_unspecified()
                    || octets[0] == 100 && (64..=127).contains(&octets[1])
                    || octets[0] == 192 && octets[1] == 0 && octets[2] == 0
                    || octets[0] == 192 && octets[1] == 0 && octets[2] == 2
                    || octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)
                    || octets[0] == 198 && octets[1] == 51 && octets[2] == 100
                    || octets[0] == 203 && octets[1] == 0 && octets[2] == 113
            }
            // Reject literal IPv6 references; we do not need them for XHS images and
            // this avoids accepting mapped or otherwise special-use addresses.
            std::net::IpAddr::V6(_) => true,
        });
    let literal_ipv6 = hostname.contains(':');
    if hostname.is_empty()
        || hostname == "localhost"
        || hostname.ends_with(".localhost")
        || hostname.ends_with(".local")
        || non_public_ip
        || literal_ipv6
    {
        return false;
    }
    true
}

/// socket 路径：默认 ~/.aichihongshu/browser-capture.sock；
/// AICHIHONGSHU_CAPTURE_SOCKET 可覆盖（测试/QA 用）。
pub fn socket_path() -> PathBuf {
    if let Ok(path) = std::env::var("AICHIHONGSHU_CAPTURE_SOCKET") {
        let trimmed = path.trim().to_string();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    instance_socket_path(runtime_channel(), &workspace_identity())
}

fn capture_instance_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".aichihongshu").join("instances")
}

fn capture_instance_dir(channel: &str) -> PathBuf {
    capture_instance_root().join(channel)
}

fn valid_workspace_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn instance_socket_path(channel: &str, workspace_id: &str) -> PathBuf {
    capture_instance_dir(channel).join(format!("{workspace_id}.sock"))
}

fn instance_registration_path(channel: &str, workspace_id: &str) -> PathBuf {
    capture_instance_dir(channel).join(format!("{workspace_id}.json"))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureInstanceRegistration {
    workspace_id: String,
    channel: String,
    executable_path: String,
    launch_target: String,
    #[serde(default)]
    app_version: String,
    #[serde(default)]
    protocol_version: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInstanceDescriptor {
    pub workspace_id: String,
    pub display_name: String,
    pub channel: String,
    pub app_version: String,
    pub protocol_version: u16,
    pub online: bool,
}

fn launch_target_for(executable: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        for ancestor in executable.ancestors() {
            if ancestor.extension().and_then(|ext| ext.to_str()) == Some("app") {
                return ancestor.to_path_buf();
            }
        }
    }
    executable.to_path_buf()
}

fn write_instance_registration(channel: &str, workspace_id: &str) -> Result<(), String> {
    if !valid_workspace_id(workspace_id) || !matches!(channel, "prod" | "dev") {
        return Err("桌面实例身份格式无效".to_string());
    }
    let executable =
        std::env::current_exe().map_err(|error| format!("获取桌面应用路径失败: {error}"))?;
    let registration = CaptureInstanceRegistration {
        workspace_id: workspace_id.to_string(),
        channel: channel.to_string(),
        executable_path: executable.to_string_lossy().into_owned(),
        launch_target: launch_target_for(&executable)
            .to_string_lossy()
            .into_owned(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: PROTOCOL_VERSION,
    };
    let dir = capture_instance_dir(channel);
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建实例注册目录失败: {error}"))?;
    let _ = std::fs::set_permissions(
        capture_instance_root(),
        std::fs::Permissions::from_mode(0o700),
    );
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    let path = instance_registration_path(channel, workspace_id);
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec(&registration).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| format!("创建实例注册记录失败: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("写入实例注册记录失败: {error}"))?;
    let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600));
    std::fs::rename(&temporary, &path).map_err(|error| format!("启用实例注册记录失败: {error}"))
}

fn read_instance_registration(
    channel: &str,
    workspace_id: &str,
) -> Option<CaptureInstanceRegistration> {
    if !valid_workspace_id(workspace_id) || !matches!(channel, "prod" | "dev") {
        return None;
    }
    let raw = std::fs::read(instance_registration_path(channel, workspace_id)).ok()?;
    let registration = serde_json::from_slice::<CaptureInstanceRegistration>(&raw).ok()?;
    (registration.workspace_id == workspace_id && registration.channel == channel)
        .then_some(registration)
}

/// 返回当前通道的友好实例清单；绝不将可执行文件或安装路径发给浏览器。
pub fn list_capture_instances(channel: &str) -> Vec<CaptureInstanceDescriptor> {
    if !matches!(channel, "prod" | "dev") {
        return Vec::new();
    }
    let mut registrations = Vec::new();
    if let Ok(entries) = std::fs::read_dir(capture_instance_dir(channel)) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(workspace_id) = path.file_stem().and_then(|name| name.to_str()) else {
                continue;
            };
            if let Some(registration) = read_instance_registration(channel, workspace_id) {
                registrations.push(registration);
            }
        }
    }
    let current_channel = runtime_channel();
    let current_workspace = workspace_identity();
    if current_channel == channel
        && !registrations
            .iter()
            .any(|item| item.workspace_id == current_workspace)
    {
        if let Ok(executable) = std::env::current_exe() {
            registrations.push(CaptureInstanceRegistration {
                workspace_id: current_workspace,
                channel: current_channel.to_string(),
                executable_path: executable.to_string_lossy().into_owned(),
                launch_target: launch_target_for(&executable)
                    .to_string_lossy()
                    .into_owned(),
                app_version: env!("CARGO_PKG_VERSION").to_string(),
                protocol_version: PROTOCOL_VERSION,
            });
        }
    }
    registrations
        .into_iter()
        .map(|item| {
            let socket = instance_socket_path(channel, &item.workspace_id);
            let online = UnixStream::connect(&socket).is_ok()
                || listener_lock_owner_at(&socket.with_extension("lock"))
                    .ok()
                    .flatten()
                    .is_some();
            let display_name = item.workspace_id.clone();
            CaptureInstanceDescriptor {
                workspace_id: item.workspace_id,
                display_name,
                channel: item.channel,
                app_version: if item.app_version.is_empty() {
                    env!("CARGO_PKG_VERSION").to_string()
                } else {
                    item.app_version
                },
                protocol_version: if item.protocol_version == 0 {
                    PROTOCOL_VERSION
                } else {
                    item.protocol_version
                },
                online,
            }
        })
        .collect()
}

/// Native Host 内部用于路由的 socket 解析器；workspace 必须精确匹配登记记录。
pub fn capture_instance_socket(channel: &str, workspace_id: &str) -> Result<PathBuf, String> {
    if !matches!(channel, "prod" | "dev") {
        return Err("CHANNEL_INVALID".to_string());
    }
    if !valid_workspace_id(workspace_id)
        || (read_instance_registration(channel, workspace_id).is_none()
            && !(runtime_channel() == channel && workspace_identity() == workspace_id))
    {
        return Err("INSTANCE_NOT_REGISTERED".to_string());
    }
    Ok(instance_socket_path(channel, workspace_id))
}

/// 仅响应插件明确发出的启动动作；Native Host 被动启动本身永远不打开 GUI。
pub fn launch_capture_instance(channel: &str, workspace_id: &str) -> Result<(), String> {
    let registration = read_instance_registration(channel, workspace_id)
        .or_else(|| {
            if runtime_channel() == channel && workspace_identity() == workspace_id {
                let executable = std::env::current_exe().ok()?;
                Some(CaptureInstanceRegistration {
                    workspace_id: workspace_id.to_string(),
                    channel: channel.to_string(),
                    executable_path: executable.to_string_lossy().into_owned(),
                    launch_target: launch_target_for(&executable)
                        .to_string_lossy()
                        .into_owned(),
                    app_version: env!("CARGO_PKG_VERSION").to_string(),
                    protocol_version: PROTOCOL_VERSION,
                })
            } else {
                None
            }
        })
        .ok_or_else(|| "INSTANCE_NOT_REGISTERED".to_string())?;
    let executable = PathBuf::from(&registration.executable_path);
    let target = PathBuf::from(&registration.launch_target);
    if !executable.is_file() || !target.exists() {
        return Err("INSTANCE_START_FAILED".to_string());
    }
    #[cfg(target_os = "macos")]
    let result = if target.extension().and_then(|ext| ext.to_str()) == Some("app") {
        std::process::Command::new("open")
            .args(["-n", "-a"])
            .arg(&target)
            .spawn()
    } else {
        std::process::Command::new(&executable).spawn()
    };
    #[cfg(not(target_os = "macos"))]
    let result = std::process::Command::new(&executable).spawn();
    result
        .map(|_| ())
        .map_err(|_| "INSTANCE_START_FAILED".to_string())
}

/// Debug 桌面构建走开发通道；Native Messaging 启动器显式传入通道，避免
/// 正式版和开发版因为启动环境或旧清单而连到同一个 socket。
pub fn runtime_channel() -> &'static str {
    match std::env::var("AICHIHONGSHU_CAPTURE_CHANNEL").as_deref() {
        Ok("dev") => "dev",
        Ok("prod") => "prod",
        _ if cfg!(debug_assertions) => "dev",
        _ => "prod",
    }
}

/// 仅返回工作区 basename 和稳定短摘要，不把完整本地路径传给扩展。
pub fn workspace_identity() -> String {
    use sha2::{Digest, Sha256};
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let canonical = root.canonicalize().unwrap_or(root);
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    let short = digest[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let name = canonical
        .parent()
        .and_then(Path::file_name)
        .and_then(|part| part.to_str())
        .unwrap_or("workspace");
    format!("{name}-{short}")
}

fn channel_host_name_for(channel: &str) -> &'static str {
    if channel == "dev" {
        "com.aichihongshu.host.dev"
    } else {
        "com.aichihongshu.host"
    }
}

fn channel_host_name() -> &'static str {
    channel_host_name_for(runtime_channel())
}

fn channel_manifest_filename_for(channel: &str) -> String {
    format!("{}.json", channel_host_name_for(channel))
}

fn channel_manifest_filename() -> String {
    channel_manifest_filename_for(runtime_channel())
}

fn listener_lock_path() -> PathBuf {
    instance_socket_path(runtime_channel(), &workspace_identity()).with_extension("lock")
}

fn listener_lock_owner_at(path: &Path) -> Result<Option<Value>, String> {
    let mut file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取浏览器通道锁失败: {error}")),
    };
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
        return Ok(None);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EWOULDBLOCK) || error.raw_os_error() == Some(libc::EAGAIN)
    {
        let mut raw = String::new();
        file.read_to_string(&mut raw)
            .map_err(|read_error| format!("读取浏览器通道 owner 信息失败: {read_error}"))?;
        return serde_json::from_str(&raw)
            .map(Some)
            .map_err(|_| "通道正在运行，但 owner 信息不可读；为避免抢占，安装已停止".to_string());
    }
    Err(format!("检查浏览器通道锁失败: {error}"))
}

fn acquire_listener_lock() -> Result<File, String> {
    acquire_listener_lock_at(
        &listener_lock_path(),
        runtime_channel(),
        &workspace_identity(),
    )
}

fn acquire_listener_lock_at(
    path: &Path,
    channel: &str,
    workspace_id: &str,
) -> Result<File, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建浏览器通道目录失败: {error}"))?;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("打开浏览器通道锁失败: {error}"))?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        return Err(format!(
            "当前通道已有应用实例监听，拒绝抢占 socket: {error}"
        ));
    }
    let owner = serde_json::json!({
        "pid": std::process::id(),
        "channel": channel,
        "workspaceId": workspace_id,
    });
    file.set_len(0)
        .and_then(|_| file.write_all(owner.to_string().as_bytes()))
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("写入浏览器通道 owner 信息失败: {error}"))?;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    Ok(file)
}

const EXTENSION_FILES: &[&str] = &[
    "manifest.json",
    "popup.html",
    "popup.css",
    "popup.js",
    "background.js",
    "capture-image-fetch.js",
    "capture-image-client.js",
    "extract.js",
    "creator-fill.js",
    "native-bridge.js",
    "capture-recovery.js",
    "connection-diagnostics.js",
    "profile-notes.js",
    "capture-preview.js",
    "preview-session.js",
    "preview.html",
    "preview.css",
    "preview-page.js",
];

/// 扩展运行文件编译进桌面应用，干净安装时无需仓库目录或 Node.js。
fn bundled_extension_file(name: &str) -> Option<&'static [u8]> {
    match name {
        "manifest.json" => Some(include_bytes!("../../../browser-extension/manifest.json")),
        "popup.html" => Some(include_bytes!("../../../browser-extension/popup.html")),
        "popup.css" => Some(include_bytes!("../../../browser-extension/popup.css")),
        "popup.js" => Some(include_bytes!("../../../browser-extension/popup.js")),
        "background.js" => Some(include_bytes!("../../../browser-extension/background.js")),
        "capture-image-fetch.js" => Some(include_bytes!(
            "../../../browser-extension/capture-image-fetch.js"
        )),
        "capture-image-client.js" => Some(include_bytes!(
            "../../../browser-extension/capture-image-client.js"
        )),
        "extract.js" => Some(include_bytes!("../../../browser-extension/extract.js")),
        "creator-fill.js" => Some(include_bytes!("../../../browser-extension/creator-fill.js")),
        "native-bridge.js" => Some(include_bytes!(
            "../../../browser-extension/native-bridge.js"
        )),
        "capture-recovery.js" => Some(include_bytes!(
            "../../../browser-extension/capture-recovery.js"
        )),
        "connection-diagnostics.js" => Some(include_bytes!(
            "../../../browser-extension/connection-diagnostics.js"
        )),
        "profile-notes.js" => Some(include_bytes!(
            "../../../browser-extension/profile-notes.js"
        )),
        "capture-preview.js" => Some(include_bytes!(
            "../../../browser-extension/capture-preview.js"
        )),
        "preview-session.js" => Some(include_bytes!(
            "../../../browser-extension/preview-session.js"
        )),
        "preview.html" => Some(include_bytes!("../../../browser-extension/preview.html")),
        "preview.css" => Some(include_bytes!("../../../browser-extension/preview.css")),
        "preview-page.js" => Some(include_bytes!("../../../browser-extension/preview-page.js")),
        _ => None,
    }
}

/// 扩展目录源码。每个通道都从这里或内嵌资源生成独立部署副本。
fn project_extension_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("AICHIHONGSHU_EXTENSION_DIR") {
        let trimmed = dir.trim().to_string();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../browser-extension")
}

/// 当前应用通道的扩展部署目录。
fn extension_dir() -> PathBuf {
    let deployed = deployed_extension_dir();
    deployed.canonicalize().unwrap_or(deployed)
}

fn deployed_extension_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let root = PathBuf::from(home).join(".aichihongshu");
    if runtime_channel() == "dev" {
        root.join("dev").join("browser-extension")
    } else {
        root.join("browser-extension")
    }
}

/// 桌面端实际二进制；由 Native Messaging shell 启动器固定传入宿主模式，
/// 浏览器清单本身不依赖 args 扩展字段。
fn native_host_binary_path() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|error| format!("获取桌面应用可执行文件路径失败: {error}"))
}

fn native_host_launcher_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let root = PathBuf::from(home).join(".aichihongshu");
    let root = if runtime_channel() == "dev" {
        root.join("dev")
    } else {
        root
    };
    root.join("native-messaging-host.sh")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn write_native_host_launcher_for(path: &Path, binary: &Path, channel: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Native Messaging 启动器缺少父目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("创建宿主目录失败: {error}"))?;
    let body = format!(
        "#!/bin/sh\nAICHIHONGSHU_CAPTURE_CHANNEL={channel}\nexport AICHIHONGSHU_CAPTURE_CHANNEL\nexec {} --native-messaging-host\n",
        shell_quote(&binary.display().to_string())
    );
    let temporary = parent.join(format!(".native-host-{}.tmp", std::process::id()));
    std::fs::write(&temporary, body.as_bytes())
        .map_err(|error| format!("写入 Native Messaging 启动器失败: {error}"))?;
    std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("设置 Native Messaging 启动器权限失败: {error}"))?;
    std::fs::rename(&temporary, path)
        .map_err(|error| format!("启用 Native Messaging 启动器失败: {error}"))
}

fn extension_manifest_meta(dir: &Path) -> Result<(String, String), String> {
    let manifest_path = dir.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("读取扩展 manifest 失败: {error}"))?;
    let manifest: Value =
        serde_json::from_str(&raw).map_err(|_| "扩展 manifest 不是有效 JSON".to_string())?;
    let allowed = ["nativeMessaging", "scripting", "activeTab", "storage"];
    if let Some(perms) = manifest.get("permissions").and_then(|v| v.as_array()) {
        for item in perms {
            let name = item.as_str().unwrap_or("");
            if !allowed.contains(&name) {
                return Err(format!("扩展权限超出最小集合：{name}"));
            }
        }
    }
    if manifest
        .get("host_permissions")
        .and_then(Value::as_array)
        .is_some_and(|permissions| !permissions.is_empty())
    {
        return Err("扩展不允许声明站点级 host_permissions".to_string());
    }
    if manifest
        .get("optional_host_permissions")
        .and_then(Value::as_array)
        .is_some_and(|permissions| {
            permissions
                .iter()
                .any(|item| item.as_str() != Some("https://*/*"))
        })
    {
        return Err("扩展可选站点权限仅允许 HTTPS，且必须由用户在剪藏时按来源主机授权".to_string());
    }
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("0")
        .to_string();
    let key_b64 = manifest
        .get("key")
        .and_then(Value::as_str)
        .ok_or("扩展 manifest 缺少 key 字段")?;
    Ok((version, extension_id_from_key(key_b64)?))
}

fn bundled_extension_manifest_meta() -> Option<(String, String)> {
    let raw = extension_file_for_channel(
        "manifest.json",
        bundled_extension_file("manifest.json")?,
        runtime_channel() == "dev",
    )
    .ok()?;
    let manifest = serde_json::from_slice::<Value>(&raw).ok()?;
    let version = manifest.get("version")?.as_str()?.to_string();
    let extension_id = extension_id_from_key(manifest.get("key")?.as_str()?).ok()?;
    Some((version, extension_id))
}

fn extension_file_for_channel(
    name: &str,
    source: &[u8],
    development: bool,
) -> Result<Vec<u8>, String> {
    if name == "manifest.json" && development {
        let mut manifest: Value = serde_json::from_slice(source)
            .map_err(|_| "扩展 manifest 不是有效 JSON".to_string())?;
        let key = include_str!("../../../browser-extension/dev-public-key.txt").trim();
        manifest["name"] = Value::String("爱吃红薯数据抓取 DEV".to_string());
        manifest["description"] =
            Value::String("开发通道 · 本地采集与创作页确认式填充（不自动发布）".to_string());
        manifest["key"] = Value::String(key.to_string());
        if let Some(action) = manifest.get_mut("action") {
            action["default_title"] = Value::String("DEV 数据抓取（当前页）".to_string());
        }
        return serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string());
    }
    Ok(source.to_vec())
}

fn write_extension_tree_for(
    source: Option<&Path>,
    destination: &Path,
    development: bool,
) -> Result<(), String> {
    std::fs::create_dir_all(destination)
        .map_err(|error| format!("创建扩展暂存目录失败: {error}"))?;
    let mut hashes = serde_json::Map::new();
    use sha2::{Digest, Sha256};
    for name in EXTENSION_FILES {
        let source_bytes = if let Some(source) = source {
            std::fs::read(source.join(name))
                .map_err(|error| format!("读取扩展文件 {name} 失败: {error}"))?
        } else {
            bundled_extension_file(name)
                .ok_or_else(|| format!("桌面包中未嵌入扩展文件 {name}"))?
                .to_vec()
        };
        let bytes = extension_file_for_channel(name, &source_bytes, development)?;
        let digest = Sha256::digest(&bytes);
        let hash = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        hashes.insert((*name).to_string(), Value::String(hash));
        std::fs::write(destination.join(name), bytes)
            .map_err(|error| format!("写入扩展文件 {name} 失败: {error}"))?;
    }
    let (version, extension_id) = extension_manifest_meta(destination)?;
    let integrity = serde_json::json!({
        "version": version,
        "extensionId": extension_id,
        "files": hashes,
    });
    std::fs::write(
        destination.join("integrity.json"),
        serde_json::to_vec_pretty(&integrity).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("写入扩展完整性清单失败: {error}"))?;
    verify_extension_tree(destination)
}

fn verify_extension_tree(dir: &Path) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let raw = std::fs::read(dir.join("integrity.json"))
        .map_err(|error| format!("读取扩展完整性清单失败: {error}"))?;
    let integrity: Value =
        serde_json::from_slice(&raw).map_err(|_| "扩展完整性清单不是有效 JSON".to_string())?;
    let (version, extension_id) = extension_manifest_meta(dir)?;
    if integrity.get("version").and_then(Value::as_str) != Some(version.as_str())
        || integrity.get("extensionId").and_then(Value::as_str) != Some(extension_id.as_str())
    {
        return Err("扩展完整性清单版本或固定 ID 不匹配".to_string());
    }
    let file_hashes = integrity
        .get("files")
        .and_then(Value::as_object)
        .ok_or_else(|| "扩展完整性清单缺少文件摘要".to_string())?;
    for name in EXTENSION_FILES {
        let bytes = std::fs::read(dir.join(name))
            .map_err(|error| format!("读取扩展文件 {name} 失败: {error}"))?;
        let actual = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if file_hashes.get(*name).and_then(Value::as_str) != Some(actual.as_str()) {
            return Err(format!("扩展文件完整性校验失败: {name}"));
        }
    }
    Ok(())
}

/// 原子替换扩展目录；失败时恢复上一版，成功后保留上一版供排障。
fn replace_extension_tree(source: Option<&Path>, destination: &Path) -> Result<(), String> {
    replace_extension_tree_for(source, destination, runtime_channel() == "dev")
}

fn replace_extension_tree_for(
    source: Option<&Path>,
    destination: &Path,
    development: bool,
) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "扩展部署目录缺少父目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("创建桌面应用目录失败: {error}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let stage = parent.join(format!(
        "browser-extension.staging-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir(&stage).map_err(|error| format!("创建扩展暂存目录失败: {error}"))?;
    if let Err(error) = write_extension_tree_for(source, &stage, development) {
        let _ = std::fs::remove_dir_all(&stage);
        return Err(error);
    }

    let backup = parent.join(format!(
        "browser-extension.previous-{}-{stamp}",
        std::process::id()
    ));
    let had_previous = destination.exists();
    if had_previous {
        std::fs::rename(destination, &backup)
            .map_err(|error| format!("保存上一版扩展失败: {error}"))?;
    }
    if let Err(error) = std::fs::rename(&stage, destination) {
        if had_previous {
            let _ = std::fs::rename(&backup, destination);
        }
        return Err(format!("启用新扩展目录失败: {error}"));
    }
    Ok(())
}

fn copy_installed_extension_tree(source: &Path, target: &Path) -> Result<(), String> {
    let entries =
        std::fs::read_dir(source).map_err(|error| format!("读取旧扩展目录失败: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取旧扩展文件失败: {error}"))?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let copy = || -> std::io::Result<()> {
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                std::os::unix::fs::symlink(std::fs::read_link(&from)?, &to)?;
            } else if kind.is_dir() {
                std::fs::create_dir(&to)?;
                copy_installed_extension_tree(&from, &to).map_err(std::io::Error::other)?;
            } else if kind.is_file() {
                std::fs::copy(&from, &to)?;
            } else {
                return Err(std::io::Error::other("不支持的扩展目录文件类型"));
            }
            Ok(())
        };
        copy().map_err(|error| {
            format!(
                "保存扩展安装回滚文件 {} 失败: {error}",
                entry.file_name().to_string_lossy()
            )
        })?;
    }
    Ok(())
}

fn snapshot_extension_dir(destination: &Path) -> Result<Option<PathBuf>, String> {
    if !destination.is_dir() {
        return Ok(None);
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "扩展部署目录缺少父目录".to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let snapshot = parent.join(format!(
        "browser-extension.install-rollback-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir(&snapshot).map_err(|error| format!("创建扩展安装回滚点失败: {error}"))?;
    // Snapshot the installed tree, which may predate files in the current bundle.
    // The new bundle is validated separately during staging.
    if let Err(error) = copy_installed_extension_tree(destination, &snapshot) {
        let _ = std::fs::remove_dir_all(&snapshot);
        return Err(error);
    }
    Ok(Some(snapshot))
}

fn restore_extension_snapshot(destination: &Path, snapshot: Option<&Path>) -> Result<(), String> {
    let Some(snapshot) = snapshot else {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        if destination.exists() {
            let failed = destination.with_file_name(format!(
                "browser-extension.failed-install-{}-{stamp}",
                std::process::id()
            ));
            std::fs::rename(destination, failed)
                .map_err(|error| format!("保留失败的扩展部署副本失败: {error}"))?;
        }
        return Ok(());
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    if destination.exists() {
        let failed = destination.with_file_name(format!(
            "browser-extension.failed-install-{}-{stamp}",
            std::process::id()
        ));
        std::fs::rename(destination, failed)
            .map_err(|error| format!("保留失败的扩展部署副本失败: {error}"))?;
    }
    std::fs::rename(snapshot, destination)
        .map_err(|error| format!("恢复上一版扩展目录失败: {error}"))
}

/// Treat extension deployment and host-manifest activation as one install transaction.
/// Any error after the old extension is snapshotted restores it and keeps the failed copy.
fn with_extension_install_rollback<T>(
    destination: &Path,
    activate: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let snapshot = snapshot_extension_dir(destination)?;
    match activate() {
        Ok(value) => {
            if let Some(snapshot) = snapshot {
                let _ = std::fs::remove_dir_all(snapshot);
            }
            Ok(value)
        }
        Err(error) => match restore_extension_snapshot(destination, snapshot.as_deref()) {
            Ok(()) => Err(error),
            Err(restore_error) => Err(format!("{error}；恢复扩展目录失败：{restore_error}")),
        },
    }
}

fn deploy_extension() -> Result<PathBuf, String> {
    let project = project_extension_dir();
    let source = project
        .join("manifest.json")
        .is_file()
        .then_some(project.as_path());
    let destination = deployed_extension_dir();
    replace_extension_tree(source, &destination)?;
    Ok(destination)
}

fn native_host_dir(browser_rel: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join(browser_rel)
        .join("NativeMessagingHosts")
}

fn browser_host_dir(browser: &str) -> PathBuf {
    match browser {
        "edge" => native_host_dir("Microsoft Edge"),
        _ => native_host_dir("Google/Chrome"),
    }
}

fn write_json_atomically(path: &Path, value: &Value) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let parent = path
        .parent()
        .ok_or_else(|| "宿主清单路径缺少父目录".to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let temporary = parent.join(format!(".host-manifest-{}-{stamp}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("创建 Native Messaging 清单暂存文件失败: {error}"))?;
    if let Err(error) = file
        .write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
    {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("写入 Native Messaging 清单失败: {error}"));
    }
    if let Err(error) = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
    {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("设置 Native Messaging 清单权限失败: {error}"));
    }
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("启用 Native Messaging 清单失败: {error}")
    })
}

fn allowed_extension_origins_for(channel: &str, extension_id: &str) -> Result<Vec<String>, String> {
    let mut ids = vec![extension_id.to_string()];
    if channel == "dev" {
        let production_key = serde_json::from_slice::<Value>(include_bytes!(
            "../../../browser-extension/manifest.json"
        ))
        .ok()
        .and_then(|value| value.get("key").and_then(Value::as_str).map(str::to_string))
        .ok_or_else(|| "读取正式插件公钥失败".to_string())?;
        let production_id = extension_id_from_key(&production_key)?;
        if !ids.contains(&production_id) {
            ids.push(production_id);
        }
    }
    Ok(ids
        .into_iter()
        .map(|id| format!("chrome-extension://{id}/"))
        .collect())
}

fn write_native_host_installation(
    manifest_path: &Path,
    launcher_path: &Path,
    binary_path: &Path,
    extension_id: &str,
    channel: &str,
) -> Result<(), String> {
    let previous_launcher = std::fs::read(launcher_path).ok();
    write_native_host_launcher_for(launcher_path, binary_path, channel)?;
    let channel_label = if channel == "dev" { "DEV" } else { "正式" };
    // Keep exact, fixed extension origins. The production extension may use DEV only
    // after the user enables its advanced development mode; the existing DEV ID stays valid.
    let allowed_origins = allowed_extension_origins_for(channel, extension_id)?;
    let manifest = serde_json::json!({
        "name": channel_host_name_for(channel),
        "description": format!("爱吃红薯数据抓取宿主（{channel_label} · Rust 本地转发）"),
        "path": launcher_path,
        "type": "stdio",
        "allowed_origins": allowed_origins,
    });
    if manifest.get("args").is_some() {
        return Err("Native Messaging manifest 不允许 args 字段".to_string());
    }
    if let Err(error) = write_json_atomically(manifest_path, &manifest) {
        let restore_result = if let Some(previous) = previous_launcher {
            let temporary =
                launcher_path.with_extension(format!("restore-{}.tmp", std::process::id()));
            std::fs::write(&temporary, previous)
                .and_then(|_| {
                    std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700))
                })
                .and_then(|_| std::fs::rename(&temporary, launcher_path))
                .map_err(|restore| format!("恢复旧 Native Messaging 启动器失败: {restore}"))
        } else {
            std::fs::remove_file(launcher_path)
                .or_else(|remove| {
                    if remove.kind() == std::io::ErrorKind::NotFound {
                        Ok(())
                    } else {
                        Err(remove)
                    }
                })
                .map_err(|restore| format!("移除未完成的 Native Messaging 启动器失败: {restore}"))
        };
        return match restore_result {
            Ok(()) => Err(error),
            Err(restore) => Err(format!("{error}；{restore}")),
        };
    }
    Ok(())
}

/// 供自动 smoke test 生成与安装流程完全相同的隔离 manifest/launcher。
#[cfg(debug_assertions)]
pub fn write_native_host_test_fixture(root: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root).map_err(|error| format!("创建宿主 fixture 目录失败: {error}"))?;
    let channel = runtime_channel();
    let extension_dir = root.join("extension");
    let source = project_extension_dir();
    write_extension_tree_for(Some(&source), &extension_dir, channel == "dev")?;
    let (_, extension_id) = extension_manifest_meta(&extension_dir)?;
    let launcher = root.join("native-host.sh");
    let manifest_path = root.join(channel_manifest_filename_for(channel));
    let binary = native_host_binary_path()?;
    write_native_host_installation(&manifest_path, &launcher, &binary, &extension_id, channel)?;
    Ok(manifest_path)
}

/// 安装到指定浏览器：写入桌面应用原生宿主与扩展副本，再打开扩展页。
pub fn install_for_browser(browser: &str) -> Result<String, String> {
    if !matches!(browser, "chrome" | "edge") {
        return Err("只支持 chrome 或 edge".to_string());
    }
    let extension_destination = deployed_extension_dir();
    with_extension_install_rollback(&extension_destination, || {
        let ext_dir = deploy_extension()?;
        let (version, extension_id) = extension_manifest_meta(&ext_dir)?;
        let host_binary = native_host_binary_path()?;
        let host_name = channel_host_name();
        let channel_label = if runtime_channel() == "dev" {
            "DEV"
        } else {
            "正式"
        };

        let target_dir = browser_host_dir(browser);
        std::fs::create_dir_all(&target_dir)
            .map_err(|error| format!("创建 NativeMessagingHosts 失败: {error}"))?;
        let host_manifest = target_dir.join(channel_manifest_filename());
        let launcher = native_host_launcher_path();
        write_native_host_installation(
            &host_manifest,
            &launcher,
            &host_binary,
            &extension_id,
            runtime_channel(),
        )?;

        // 自动打开扩展页 + 扩展目录，用户只需「加载已解压」。
        let _ = open_extensions_page(browser);
        let _ = open_dir(&ext_dir);

        let label = if browser == "edge" { "Edge" } else { "Chrome" };
        Ok(format!(
            "✓ 已安装到 {label}\n\
             ✓ 扩展目录（请加载此文件夹）：{ext}\n\
             ✓ 扩展 ID：{id}\n\
             ✓ 通道：{channel_label}\n\
             ✓ 扩展版本：v{ver}\n\
             ✓ Native Host：{host_name}\n\
             ✓ 宿主：{host}\n\n\
             请在 {label} 扩展页：开发者模式 → 加载已解压的扩展程序 → 选择上面扩展目录",
            ext = ext_dir.display(),
            id = extension_id,
            ver = version,
            channel_label = channel_label,
            host_name = host_name,
            host = host_manifest.display(),
        ))
    })
}

/// 复制完整扩展目录到 ~/aichihongshu-extensions/vX.Y.Z/（可存档版本）。
pub fn copy_extension_dir() -> Result<String, String> {
    let src = deploy_extension()?;
    let (version, extension_id) = extension_manifest_meta(&src)?;
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let dest = PathBuf::from(home)
        .join("aichihongshu-extensions")
        .join(format!("v{version}"));
    replace_extension_tree(Some(&src), &dest)
        .map_err(|error| format!("创建扩展副本失败: {error}"))?;
    let copied_meta = extension_manifest_meta(&dest)?;
    if copied_meta != (version.clone(), extension_id.clone()) {
        return Err("扩展副本版本或固定 ID 与源文件不一致".to_string());
    }
    let _ = open_dir(&dest);
    Ok(format!(
        "✓ 已复制扩展到：{dest}\n✓ 扩展 ID：{id}\n\n浏览器「加载已解压」请选择该副本目录",
        dest = dest.display(),
        id = extension_id,
    ))
}

fn open_dir(dir: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(dir)
        .status()
        .map_err(|error| format!("打开目录失败: {error}"))
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err(format!("无法打开目录：{}", dir.display()))
            }
        })
}

/// 复制扩展目录路径到剪贴板（只复制路径字符串，不打开文件夹）。
pub fn copy_extension_path() -> Result<String, String> {
    let dir = deploy_extension()?;
    let canonical_dir = dir
        .canonicalize()
        .map_err(|error| format!("解析扩展目录失败: {error}"))?;
    let path = canonical_dir.display().to_string();
    copy_text_to_clipboard(&path)?;
    Ok(path)
}

fn copy_text_to_clipboard(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| format!("调用 pbcopy 失败: {error}"))?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|error| format!("写入剪贴板失败: {error}"))?;
        }
        let status = child
            .wait()
            .map_err(|error| format!("等待 pbcopy 失败: {error}"))?;
        if !status.success() {
            return Err("复制到剪贴板失败".to_string());
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("clip")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| format!("调用 clip 失败: {error}"))?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(
                    text.encode_utf16()
                        .collect::<Vec<u16>>()
                        .iter()
                        .flat_map(|u| u.to_le_bytes())
                        .collect::<Vec<u8>>()
                        .as_slice(),
                )
                .ok();
        }
        let _ = child.wait();
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("xclip")
            .args(["-selection", "clipboard"])
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| format!("调用 xclip 失败: {error}"))?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|error| format!("写入剪贴板失败: {error}"))?;
        }
        let _ = child.wait();
        Ok(())
    }
}

/// 打开当前扩展目录（项目 browser-extension/）。
pub fn open_extension_dir() -> Result<String, String> {
    let dir = deploy_extension()?;
    open_dir(&dir)?;
    Ok(format!("已打开扩展目录：{}", dir.display()))
}

/// 从 manifest.key（SPKI DER base64）推导稳定扩展 ID（与 install-host.mjs 一致）。
fn extension_id_from_key(key_b64: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let key = base64_decode(key_b64).ok_or("manifest.key 不是有效 base64")?;
    let digest = Sha256::digest(&key);
    let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    Ok(hex
        .chars()
        .map(|c| char::from(b'a' + u8::try_from(c.to_digit(16).unwrap_or(0)).unwrap_or(0)))
        .collect())
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0u32;
    for ch in input.chars().filter(|c| !c.is_whitespace()) {
        if ch == '=' {
            break;
        }
        let val = TABLE.iter().position(|&b| b == ch as u8)? as u32;
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// 打开指定浏览器的扩展管理页（chrome:// 或 edge://）。
pub fn open_extensions_page(browser: &str) -> Result<String, String> {
    let (app_name, url) = match browser {
        "edge" => ("Microsoft Edge", "edge://extensions"),
        _ => ("Google Chrome", "chrome://extensions"),
    };
    #[cfg(target_os = "macos")]
    let ok = std::process::Command::new("open")
        .args(["-a", app_name, url])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    #[cfg(target_os = "windows")]
    let ok = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    #[cfg(all(unix, not(target_os = "macos")))]
    let ok = std::process::Command::new(if browser == "edge" {
        "microsoft-edge"
    } else {
        "google-chrome"
    })
    .arg(url)
    .status()
    .map(|s| s.success())
    .unwrap_or(false);
    if !ok {
        return Err(format!(
            "无法启动 {app_name}。请确认已安装，或手动打开 {url}"
        ));
    }
    Ok(format!("已打开 {app_name} → {url}"))
}

/// 本机检测到的浏览器列表。
pub fn detect_browsers() -> Vec<String> {
    let mut found = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let candidates = [
            ("chrome", "/Applications/Google Chrome.app"),
            ("edge", "/Applications/Microsoft Edge.app"),
        ];
        for (id, path) in candidates {
            if std::path::Path::new(path).exists() {
                found.push(id.to_string());
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        found.push("chrome".to_string());
        found.push("edge".to_string());
    }
    if found.is_empty() {
        found.push("chrome".to_string());
    }
    found
}

/// 连接自检：扩展文件 → Rust 原生宿主 → 清单 → Unix socket，逐跳报告。
pub fn test_link() -> Result<Vec<(String, bool, String)>, String> {
    let mut hops = Vec::new();
    let dir = extension_dir();
    let manifest_ok = dir.join("manifest.json").is_file();
    hops.push((
        "扩展文件".to_string(),
        manifest_ok,
        if manifest_ok {
            dir.display().to_string()
        } else {
            "未找到 manifest.json，请先安装".to_string()
        },
    ));
    let host_path = native_host_launcher_path();
    let host_ok = std::fs::metadata(&host_path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0);
    hops.push((
        "Native Messaging 无界面启动器".to_string(),
        host_ok,
        if host_ok {
            format!(
                "{}（固定进入 Rust 宿主模式；无 Node 依赖）",
                host_path.display()
            )
        } else {
            "未安装当前通道启动器；请重新安装/更新插件".to_string()
        },
    ));
    let extension_id = bundled_extension_manifest_meta().map(|(_, id)| id);
    let (_, chrome_installed, chrome_matches) = host_status_for("Google/Chrome", &extension_id);
    let (_, edge_installed, edge_matches) = host_status_for("Microsoft Edge", &extension_id);
    let host_manifest_ok = (chrome_installed || edge_installed)
        && (!chrome_installed || chrome_matches)
        && (!edge_installed || edge_matches);
    hops.push((
        "宿主注册与路径".to_string(),
        host_manifest_ok,
        if host_manifest_ok {
            format!(
                "{} · Chrome {} / Edge {} · 清单来源、精确扩展 ID 与启动器路径匹配",
                runtime_channel(),
                if chrome_matches {
                    "✓"
                } else if chrome_installed {
                    "需修复"
                } else {
                    "未安装"
                },
                if edge_matches {
                    "✓"
                } else if edge_installed {
                    "需修复"
                } else {
                    "未安装"
                }
            )
        } else {
            format!(
                "清单缺失或与当前通道/扩展 ID/启动器路径不匹配 · Chrome {} / Edge {}",
                if chrome_matches {
                    "✓"
                } else if chrome_installed {
                    "需修复"
                } else {
                    "未安装"
                },
                if edge_matches {
                    "✓"
                } else if edge_installed {
                    "需修复"
                } else {
                    "未安装"
                }
            )
        },
    ));
    let sock = socket_path();
    let socket_ok = UnixStream::connect(&sock).is_ok()
        || listener_lock_owner_at(&sock.with_extension("lock"))
            .ok()
            .flatten()
            .is_some();
    hops.push((
        "应用 socket".to_string(),
        socket_ok,
        if socket_ok {
            format!("监听中 {}", sock.display())
        } else {
            format!("未找到 {}（应用未运行或未启动监听）", sock.display())
        },
    ));
    Ok(hops)
}

/// 供设置页展示的链路状态：扩展版本、协议版本、宿主是否已安装。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureStatus {
    pub protocol_version: u16,
    pub channel: String,
    pub workspace_id: String,
    pub app_version: String,
    pub extension_version: Option<String>,
    pub extension_dir: String,
    pub extension_id: Option<String>,
    pub host_manifest_path: String,
    pub host_installed: bool,
    pub host_manifest_matches: bool,
    pub host_installed_edge: bool,
    pub host_manifest_matches_edge: bool,
    pub browsers: Vec<String>,
    pub last_reported_extension_version: Option<String>,
    pub last_reported_channel: Option<String>,
    pub last_reported_step: Option<String>,
    pub last_reported_error_code: Option<String>,
    pub last_reported_duration_ms: Option<u64>,
    pub last_reported_at_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct BrowserExtensionReport {
    version: String,
    channel: String,
    step: String,
    error_code: Option<String>,
    duration_ms: Option<u64>,
    reported_at_ms: u64,
}

static LAST_EXTENSION_REPORT: OnceLock<Mutex<Option<BrowserExtensionReport>>> = OnceLock::new();

fn record_extension_report(value: &Value) {
    let Some(version) = value.get("extensionVersion").and_then(Value::as_str) else {
        return;
    };
    let version = version.trim();
    if version.is_empty() || version.len() > 32 {
        return;
    }
    let action = value
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(
        action,
        "ping" | "list_capture_accounts" | "lookup_page_context"
    ) {
        return;
    }
    let diagnostic = value.get("diagnostic");
    let step = diagnostic
        .and_then(|item| item.get("step"))
        .and_then(Value::as_str)
        .filter(|step| step.len() <= 32)
        .unwrap_or(if action == "ping" {
            "version_handshake"
        } else {
            "account_read"
        });
    let mut error_code = diagnostic
        .and_then(|item| item.get("errorCode"))
        .and_then(Value::as_str)
        .filter(|code| code.len() <= 48)
        .map(str::to_string);
    let Ok(elapsed) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return;
    };
    let reported_at_ms =
        elapsed.as_secs().saturating_mul(1000) + u64::from(elapsed.subsec_millis());
    let started_at_ms = diagnostic
        .and_then(|item| item.get("startedAtMs"))
        .and_then(Value::as_u64);
    let duration_ms = started_at_ms
        .and_then(|started| reported_at_ms.checked_sub(started))
        .filter(|duration| *duration <= 120_000);
    let request_protocol = value
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    if request_protocol != PROTOCOL_VERSION as u64 {
        error_code = Some("PROTOCOL_INCOMPATIBLE".to_string());
    }
    let report = BrowserExtensionReport {
        version: version.to_string(),
        channel: runtime_channel().to_string(),
        step: step.to_string(),
        error_code,
        duration_ms,
        reported_at_ms,
    };
    if let Ok(mut last) = LAST_EXTENSION_REPORT
        .get_or_init(|| Mutex::new(None))
        .lock()
    {
        *last = Some(report);
    }
}

fn annotate_latest_extension_error(code: &str) {
    if code.is_empty() || code.len() > 48 {
        return;
    }
    if let Ok(mut latest) = LAST_EXTENSION_REPORT
        .get_or_init(|| Mutex::new(None))
        .lock()
    {
        if let Some(report) = latest.as_mut() {
            report.error_code = Some(code.to_string());
        }
    }
}

pub const PROTOCOL_VERSION: u16 = 12;

fn is_xhs_creator_publish_url(source_url: &str) -> bool {
    let Some(rest) = source_url.trim().strip_prefix("https://") else {
        return false;
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    if !rest[..authority_end].eq_ignore_ascii_case("creator.xiaohongshu.com") {
        return false;
    }
    let path_and_suffix = &rest[authority_end..];
    let path = path_and_suffix.split(['?', '#']).next().unwrap_or_default();
    path == "/publish" || path.starts_with("/publish/")
}

fn host_status_for(browser_rel: &str, extension_id: &Option<String>) -> (String, bool, bool) {
    let path = native_host_dir(browser_rel).join(channel_manifest_filename());
    let mut installed = false;
    let mut matches = false;
    if let Ok(raw) = std::fs::read_to_string(&path) {
        installed = true;
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            let origins_match = value
                .get("allowed_origins")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    let actual = arr
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>();
                    extension_id
                        .as_ref()
                        .and_then(|id| allowed_extension_origins_for(runtime_channel(), id).ok())
                        .is_some_and(|expected| actual == expected)
                })
                .unwrap_or(false);
            let expected_launcher = native_host_launcher_path().canonicalize().ok();
            let configured_binary = value
                .get("path")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .and_then(|binary| binary.canonicalize().ok());
            let no_unsupported_args = value.get("args").is_none();
            let name_matches =
                value.get("name").and_then(Value::as_str) == Some(channel_host_name());
            let launcher_path = native_host_launcher_path();
            let launcher_executable = std::fs::metadata(&launcher_path).is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            });
            let expected_binary = native_host_binary_path().ok();
            let launcher_matches = launcher_executable
                && std::fs::read_to_string(&launcher_path).is_ok_and(|source| {
                    let binary_matches = expected_binary.as_ref().is_some_and(|binary| {
                        source.contains(&shell_quote(&binary.display().to_string()))
                    });
                    binary_matches
                        && source.contains("--native-messaging-host")
                        && source.contains(&format!(
                            "AICHIHONGSHU_CAPTURE_CHANNEL={}",
                            runtime_channel()
                        ))
                });
            matches = origins_match
                && no_unsupported_args
                && name_matches
                && launcher_matches
                && expected_launcher == configured_binary;
        }
    }
    (path.display().to_string(), installed, matches)
}

pub fn status() -> BrowserCaptureStatus {
    let dir = extension_dir();
    let manifest_path = dir.join("manifest.json");
    let disk_meta = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|manifest| {
            Some((
                manifest.get("version")?.as_str()?.to_string(),
                extension_id_from_key(manifest.get("key")?.as_str()?).ok()?,
            ))
        });
    let (extension_version, extension_id) = bundled_extension_manifest_meta()
        .or(disk_meta)
        .map(|(version, id)| (Some(version), Some(id)))
        .unwrap_or((None, None));
    let (host_manifest_path, host_installed, host_manifest_matches) =
        host_status_for("Google/Chrome", &extension_id);
    let (_, host_installed_edge, host_manifest_matches_edge) =
        host_status_for("Microsoft Edge", &extension_id);
    let last_report = LAST_EXTENSION_REPORT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|report| report.clone());
    BrowserCaptureStatus {
        protocol_version: PROTOCOL_VERSION,
        channel: runtime_channel().to_string(),
        workspace_id: workspace_identity(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        extension_version,
        extension_dir: dir.display().to_string(),
        extension_id,
        host_manifest_path,
        host_installed,
        host_manifest_matches,
        host_installed_edge,
        host_manifest_matches_edge,
        browsers: detect_browsers(),
        last_reported_extension_version: last_report.as_ref().map(|report| report.version.clone()),
        last_reported_channel: last_report.as_ref().map(|report| report.channel.clone()),
        last_reported_step: last_report.as_ref().map(|report| report.step.clone()),
        last_reported_error_code: last_report
            .as_ref()
            .and_then(|report| report.error_code.clone()),
        last_reported_duration_ms: last_report.as_ref().and_then(|report| report.duration_ms),
        last_reported_at_ms: last_report.map(|report| report.reported_at_ms),
    }
}

/// 启动回传监听线程。绑定失败（如已有实例占用）只记录 stderr，不影响应用。
pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let _owner_lock = match acquire_listener_lock() {
            Ok(lock) => lock,
            Err(error) => {
                eprintln!("浏览器剪藏监听器未启动（{}）: {error}", runtime_channel());
                return;
            }
        };
        if let Err(error) = write_instance_registration(runtime_channel(), &workspace_identity()) {
            eprintln!("浏览器剪藏实例注册失败（{}）: {error}", runtime_channel());
            return;
        }
        let path = socket_path();
        if let Some(parent) = path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                eprintln!("浏览器剪藏 socket 目录创建失败: {error}");
                return;
            }
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            if !metadata.file_type().is_socket() {
                eprintln!(
                    "浏览器剪藏 socket 路径被非 socket 文件占用，保留原文件: {}",
                    path.display()
                );
                return;
            }
            if UnixStream::connect(&path).is_ok() {
                eprintln!(
                    "发现旧版浏览器剪藏监听器仍在线，保留其 socket: {}",
                    path.display()
                );
                return;
            }
            if let Err(error) = std::fs::remove_file(&path) {
                eprintln!("清理已确认失效的浏览器剪藏 socket 失败: {error}");
                return;
            }
        }
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!(
                    "浏览器剪藏 socket 绑定失败（已有实例在运行？）: {} ({error})",
                    path.display()
                );
                return;
            }
        };
        // owner-only：其他本机用户不可连接。
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => handle_connection(stream, &app),
                Err(error) => eprintln!("浏览器剪藏 socket accept 失败: {error}"),
            }
        }
    });
}

fn handle_connection(mut stream: UnixStream, app: &AppHandle) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut response = match process_message(&mut stream, app) {
        Ok(value) => value,
        Err(message) => {
            let error_code = if message.contains("协议版本") || message.contains("协议，请更新")
            {
                "PROTOCOL_INCOMPATIBLE"
            } else if message.contains("读取本地账号") || message.contains("账号失败") {
                "ACCOUNT_READ_FAILED"
            } else if message.contains("工作区已变化") {
                "INSTANCE_MISMATCH"
            } else if message.contains("通道已变化") {
                "CHANNEL_MISMATCH"
            } else {
                "REQUEST_REJECTED"
            };
            serde_json::json!({"ok": false, "errorCode": error_code, "error": message})
        }
    };
    if response.get("ok").and_then(Value::as_bool) == Some(false) {
        if let Some(code) = response.get("errorCode").and_then(Value::as_str) {
            annotate_latest_extension_error(code);
        }
    }
    stamp_response_identity(&mut response);
    let reply = serde_json::to_string(&response).unwrap_or_default();
    let _ = stream.write_all(reply.as_bytes());
    let _ = stream.write_all(b"\n");
    let _ = stream.flush();
}

fn stamp_response_identity(response: &mut Value) {
    response["channel"] = serde_json::json!(runtime_channel());
    response["workspaceId"] = serde_json::json!(workspace_identity());
    response["appVersion"] = serde_json::json!(env!("CARGO_PKG_VERSION"));
    response["protocolVersion"] = serde_json::json!(PROTOCOL_VERSION);
}

fn validate_connection_identity(value: &Value) -> Result<(), String> {
    if let Some(channel) = value.get("expectedChannel").and_then(Value::as_str) {
        if channel != runtime_channel() {
            return Err("目标通道已变化，拒绝访问此桌面实例".to_string());
        }
    }
    if let Some(workspace) = value.get("expectedWorkspaceId").and_then(Value::as_str) {
        if !workspace.is_empty() && workspace != workspace_identity() {
            return Err("目标工作区已变化，拒绝访问此桌面实例".to_string());
        }
    }
    Ok(())
}

fn validate_capture_transfer_identity(value: &Value) -> Result<(), String> {
    if value.get("expectedChannel").and_then(Value::as_str) != Some(runtime_channel()) {
        return Err("剪藏图片传输缺少匹配的目标通道，已拒绝".to_string());
    }
    if value.get("expectedWorkspaceId").and_then(Value::as_str)
        != Some(workspace_identity().as_str())
    {
        return Err("剪藏图片传输缺少匹配的目标工作区，已拒绝".to_string());
    }
    if value.get("imageTransferProtocol").and_then(Value::as_bool) != Some(true) {
        return Err("剪藏图片传输协议标记缺失".to_string());
    }
    if value.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION as u64) {
        return Err("剪藏图片传输协议版本不兼容".to_string());
    }
    Ok(())
}

fn validate_explicit_capture_instance_identity(value: &Value) -> Result<(), String> {
    if value.get("expectedChannel").and_then(Value::as_str) != Some(runtime_channel()) {
        return Err("核实 requestId 缺少匹配的目标通道，已拒绝".to_string());
    }
    if value.get("expectedWorkspaceId").and_then(Value::as_str)
        != Some(workspace_identity().as_str())
    {
        return Err("核实 requestId 缺少匹配的目标工作区，已拒绝".to_string());
    }
    Ok(())
}

pub(crate) fn process_message<R: tauri::Runtime>(
    stream: &mut UnixStream,
    app: &AppHandle<R>,
) -> Result<Value, String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut line = String::new();
    let read = reader.read_line(&mut line).map_err(|e| e.to_string())?;
    if read == 0 {
        return Err("浏览器宿主未发送消息".to_string());
    }
    if line.len() > MAX_WIRE_BYTES {
        return Err("浏览器剪藏内容超过 256KB 限制".to_string());
    }
    let value: Value =
        serde_json::from_str(line.trim_end()).map_err(|_| "剪藏消息不是有效 JSON".to_string())?;
    validate_connection_identity(&value)?;
    record_extension_report(&value);
    let action = value.get("action").and_then(Value::as_str);
    if matches!(
        action,
        Some("begin_capture_image_upload")
            | Some("write_capture_image_chunk")
            | Some("finish_capture_image_upload")
            | Some("fail_capture_image_upload")
    ) {
        validate_capture_transfer_identity(&value)?;
        let target_account_id = value
            .get("targetAccountId")
            .and_then(Value::as_i64)
            .filter(|account_id| *account_id > 0)
            .ok_or_else(|| "剪藏图片传输需要有效的目标账号".to_string())?;
        let inspiration_id = text(&value, "inspirationId", 120);
        let request_id = text(&value, "requestId", MAX_REQUEST_ID_CHARS);
        if inspiration_id.is_empty() || request_id.is_empty() {
            return Err("剪藏图片传输缺少剪藏 ID 或原 requestId".to_string());
        }
        let state = app.state::<crate::AppState>();
        let pool = state
            .db
            .account_pool()
            .map_err(|error| format!("校验剪藏目标账号失败: {error}"))?;
        if !pool
            .items
            .iter()
            .any(|account| account.id == target_account_id && account.status == "active")
        {
            return Err("所选剪藏账号不存在或已停用，拒绝跨账号写入".to_string());
        }
        if action == Some("begin_capture_image_upload") {
            let position = value
                .get("position")
                .and_then(Value::as_i64)
                .ok_or_else(|| "剪藏图片序号无效".to_string())?;
            let total_bytes = value
                .get("totalBytes")
                .and_then(Value::as_u64)
                .and_then(|size| usize::try_from(size).ok())
                .ok_or_else(|| "剪藏图片长度无效".to_string())?;
            let sha256 = text(&value, "sha256", 64);
            let mime_type = text(&value, "mimeType", 64);
            let progress = state.db.begin_browser_capture_image_upload(
                crate::db::BrowserCaptureImageUploadStart {
                    id: &inspiration_id,
                    account_pool_id: target_account_id,
                    position,
                    request_id: &request_id,
                    total_bytes,
                    sha256: &sha256,
                    mime_type: &mime_type,
                },
            )?;
            return Ok(serde_json::json!({
                "ok": true, "upload": progress, "protocolVersion": PROTOCOL_VERSION,
                "capabilities": ["capture_image_byte_upload", "capture_image_resume"],
            }));
        }
        if action == Some("write_capture_image_chunk") {
            let position = value
                .get("position")
                .and_then(Value::as_i64)
                .ok_or_else(|| "剪藏图片序号无效".to_string())?;
            let offset = value
                .get("offset")
                .and_then(Value::as_u64)
                .and_then(|offset| usize::try_from(offset).ok())
                .ok_or_else(|| "剪藏图片偏移无效".to_string())?;
            let encoded = value
                .get("dataBase64")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if encoded.len() > 88 * 1024 {
                return Err("剪藏图片分块超过 Native Host 限制".to_string());
            }
            let bytes = BASE64_STANDARD
                .decode(encoded)
                .map_err(|_| "剪藏图片分块不是有效 base64".to_string())?;
            let progress = state.db.append_browser_capture_image_upload_chunk(
                &inspiration_id,
                target_account_id,
                position,
                &request_id,
                offset,
                &bytes,
            )?;
            return Ok(serde_json::json!({
                "ok": true, "upload": progress, "protocolVersion": PROTOCOL_VERSION,
                "capabilities": ["capture_image_byte_upload", "capture_image_resume"],
            }));
        }
        let position = value
            .get("position")
            .and_then(Value::as_i64)
            .ok_or_else(|| "剪藏图片序号无效".to_string())?;
        if action == Some("fail_capture_image_upload") {
            let message = text(&value, "error", 500);
            state.db.fail_browser_capture_image_upload(
                &inspiration_id,
                target_account_id,
                position,
                &request_id,
                if message.is_empty() {
                    "图片未能从来源读取"
                } else {
                    &message
                },
            )?;
            let _ = app.emit(
                "aichihongshu-collection-images-updated",
                serde_json::json!({
                    "accountPoolId": target_account_id, "inspirationId": inspiration_id,
                    "requestId": request_id, "position": position, "status": "failed"
                }),
            );
            return Ok(
                serde_json::json!({"ok": true, "status": "failed", "protocolVersion": PROTOCOL_VERSION}),
            );
        }
        let upload = state.db.complete_browser_capture_image_upload(
            &inspiration_id,
            target_account_id,
            position,
            &request_id,
        )?;
        match crate::collection_images::persist_extension_capture_image(&state.db, &upload) {
            Ok(()) => {
                state.db.finish_browser_capture_image_upload(
                    &inspiration_id,
                    target_account_id,
                    position,
                    &request_id,
                )?;
                let _ = app.emit(
                    "aichihongshu-collection-images-updated",
                    serde_json::json!({
                        "accountPoolId": target_account_id, "inspirationId": inspiration_id,
                        "requestId": request_id, "position": position, "status": "ready"
                    }),
                );
                return Ok(serde_json::json!({
                    "ok": true, "status": "ready", "position": position,
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": ["capture_image_byte_upload", "capture_image_resume"],
                }));
            }
            Err(error) => {
                let _ = state.db.fail_browser_capture_image_upload(
                    &inspiration_id,
                    target_account_id,
                    position,
                    &request_id,
                    &error,
                );
                return Err(error);
            }
        }
    }
    if action == Some("lookup_capture_request") {
        validate_explicit_capture_instance_identity(&value)?;
        let protocol_version = value
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        if protocol_version < PROTOCOL_VERSION as u64 {
            return Err("扩展协议版本过旧，无法核实采集结果；请修复并重载当前通道插件".to_string());
        }
        let target_account_id = value
            .get("targetAccountId")
            .and_then(Value::as_i64)
            .filter(|account_id| *account_id > 0)
            .ok_or_else(|| "核实结果需要有效的本地账号 ID".to_string())?;
        let request_id = text(&value, "requestId", MAX_REQUEST_ID_CHARS);
        let status = app
            .state::<crate::AppState>()
            .db
            .lookup_browser_capture_request(target_account_id, &request_id)?;
        return Ok(serde_json::json!({
            "ok": true,
            "captureStatus": status,
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": ["persisted_outcomes", "capture_request_verification"],
        }));
    }
    if action == Some("ping") {
        let protocol_version = value
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        if protocol_version != PROTOCOL_VERSION as u64 {
            return Ok(serde_json::json!({
                "ok": false,
                "status": "protocol_incompatible",
                "errorCode": "PROTOCOL_INCOMPATIBLE",
                "error": "插件与桌面端协议版本不兼容，请更新并重载同一通道",
                "protocolVersion": PROTOCOL_VERSION,
            }));
        }
        return Ok(serde_json::json!({
            "ok": true,
            "status": "ready",
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": ["persisted_outcomes", "capture_accounts", "capture_request_verification", "profile_notes_sync", "creator_text_fill", "creator_image_chunks"],
        }));
    }
    if action == Some("lookup_page_context") {
        let protocol_version = value
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        if protocol_version < 3 {
            return Err("扩展协议版本过旧，请在设置中重新安装/更新扩展".to_string());
        }
        let source_url = text(&value, "sourceUrl", MAX_URL_CHARS);
        let state = app.state::<crate::AppState>();
        let account_id = value
            .get("targetAccountId")
            .and_then(Value::as_i64)
            .filter(|account_id| *account_id > 0)
            .unwrap_or(state.db.current_active_account()?.id);
        let page_type = match text(&value, "pageType", 16).as_str() {
            "note" | "profile" | "web" => text(&value, "pageType", 16),
            _ => "web".to_string(),
        };
        let context = state.db.lookup_browser_page_context_for_account(
            &source_url,
            &page_type,
            account_id,
        )?;
        return Ok(serde_json::json!({
            "ok": true,
            "context": context,
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": ["persisted_outcomes", "capture_accounts", "creator_text_fill", "creator_image_chunks"],
        }));
    }

    if action == Some("list_capture_accounts") {
        let protocol_version = value
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        if protocol_version != PROTOCOL_VERSION as u64 {
            return Ok(serde_json::json!({
                "ok": false,
                "errorCode": "PROTOCOL_INCOMPATIBLE",
                "error": "插件与桌面端协议版本不兼容，请更新并重载同一通道",
                "protocolVersion": PROTOCOL_VERSION,
            }));
        }
        let state = app.state::<crate::AppState>();
        let pool = state
            .db
            .account_pool()
            .map_err(|error| format!("读取本地账号失败: {error}"))?;
        let active_account_id = state
            .db
            .current_active_account()
            .map_err(|error| format!("读取本地账号失败: {error}"))?
            .id;
        let accounts = pool
            .items
            .into_iter()
            .filter(|account| account.status == "active")
            .collect::<Vec<_>>();
        return Ok(serde_json::json!({
            "ok": true,
            "accounts": accounts,
            "activeAccountId": active_account_id,
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": ["persisted_outcomes", "capture_accounts"],
        }));
    }

    if matches!(
        action,
        Some("claim_publish_fill_task")
            | Some("read_publish_fill_image_chunk")
            | Some("read_publish_fill_video_chunk")
            | Some("finish_publish_fill_task")
    ) {
        let protocol_version = value
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        if protocol_version < PROTOCOL_VERSION as u64 {
            return Err("发布填充需要当前浏览器插件与桌面端协议，请更新两端后重试".to_string());
        }
        let source_url = text(&value, "sourceUrl", MAX_URL_CHARS);
        if !is_xhs_creator_publish_url(&source_url) {
            return Err("仅允许在小红书创作发布页领取或更新发布填充任务".to_string());
        }
        let target_account_id = value
            .get("targetAccountId")
            .and_then(Value::as_i64)
            .filter(|account_id| *account_id > 0)
            .ok_or_else(|| "请选择一个有效的本地运营账号".to_string())?;
        let state = app.state::<crate::AppState>();
        let pool = state
            .db
            .account_pool()
            .map_err(|error| format!("校验填充目标账号失败: {error}"))?;
        if !pool
            .items
            .iter()
            .any(|item| item.id == target_account_id && item.status == "active")
        {
            return Err("选择的本地账号不存在或已停用，请重新选择".to_string());
        }
        if action == Some("claim_publish_fill_task") {
            let claim = state
                .db
                .claim_browser_publish_fill_task(target_account_id)?;
            let claim = claim
                .map(|claim| {
                    let images = state.db.browser_publish_fill_task_images(
                        &claim.task.attempt_id,
                        target_account_id,
                        &claim.claim_token,
                    )?;
                    let video = state.db.browser_publish_fill_task_video(
                        &claim.task.attempt_id,
                        target_account_id,
                        &claim.claim_token,
                    )?;
                    let mut value = serde_json::to_value(claim)
                        .map_err(|error| format!("序列化填充任务失败: {error}"))?;
                    value["images"] = serde_json::json!(images);
                    value["video"] = video.unwrap_or(Value::Null);
                    Ok::<Value, String>(value)
                })
                .transpose()?;
            return Ok(serde_json::json!({
                "ok": true,
                "claim": claim,
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": ["creator_text_fill", "creator_image_chunks", "creator_video_chunks"],
            }));
        }
        let attempt_id = text(&value, "attemptId", 160);
        let claim_token = text(&value, "claimToken", 64);
        if action == Some("read_publish_fill_image_chunk") {
            let item_id = value
                .get("itemId")
                .and_then(Value::as_i64)
                .filter(|id| *id > 0)
                .ok_or_else(|| "素材 ID 无效".to_string())?;
            let offset = value
                .get("offset")
                .and_then(Value::as_u64)
                .ok_or_else(|| "图片分块偏移无效".to_string())?;
            let chunk_bytes = value
                .get("chunkBytes")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(32 * 1024);
            let chunk = state.db.read_browser_publish_fill_image_chunk(
                &attempt_id,
                target_account_id,
                &claim_token,
                item_id,
                offset,
                chunk_bytes,
            )?;
            return Ok(serde_json::json!({
                "ok": true,
                "chunk": chunk,
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": ["creator_image_chunks"],
            }));
        }
        if action == Some("read_publish_fill_video_chunk") {
            let offset = value
                .get("offset")
                .and_then(Value::as_u64)
                .ok_or_else(|| "视频分块偏移无效".to_string())?;
            let chunk_bytes = value
                .get("chunkBytes")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(96 * 1024);
            let chunk = state.db.read_browser_publish_fill_video_chunk(
                &attempt_id,
                target_account_id,
                &claim_token,
                offset,
                chunk_bytes,
            )?;
            return Ok(serde_json::json!({
                "ok": true,
                "chunk": chunk,
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": ["creator_video_chunks"],
            }));
        }
        let title_status = text(&value, "titleStatus", 16);
        let body_status = text(&value, "bodyStatus", 16);
        let video_status = text(&value, "videoStatus", 16);
        let image_results = value
            .get("imageResults")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let result =
            state
                .db
                .finish_browser_publish_fill_task(crate::db::BrowserPublishFillResult {
                    attempt_id: &attempt_id,
                    expected_account_id: target_account_id,
                    claim_token: &claim_token,
                    title_status: &title_status,
                    title_error: value.get("titleError").and_then(Value::as_str),
                    body_status: &body_status,
                    body_error: value.get("bodyError").and_then(Value::as_str),
                    image_results: &image_results,
                    video_status: &video_status,
                    video_error: value.get("videoError").and_then(Value::as_str),
                    cancelled: value
                        .get("cancelled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                })?;
        return Ok(serde_json::json!({
            "ok": true,
            "fillStatus": result.fill_status,
            "fillResult": serde_json::from_str::<Value>(&result.fill_result_json).unwrap_or_else(|_| serde_json::json!({})),
            "updatedAt": result.updated_at,
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": ["creator_text_fill", "creator_image_chunks", "creator_video_chunks"],
        }));
    }

    let mut event = validate_incoming(&value.to_string())?;
    let state = app.state::<crate::AppState>();
    let requested_account_id = event.target_account_id;
    let account = if requested_account_id > 0 {
        let pool = state
            .db
            .account_pool()
            .map_err(|error| format!("校验浏览器目标账号失败: {error}"))?;
        pool.items
            .into_iter()
            .find(|item| item.id == requested_account_id && item.status == "active")
            .ok_or_else(|| "选择的本地账号不存在或已停用，请重新选择".to_string())?
    } else {
        let active = state.db.current_active_account()?;
        crate::db::PoolAccount {
            id: active.id,
            alias: active.alias,
            role: active.role,
            user_data_dir: String::new(),
            xhs_user_id: None,
            display_name: None,
            followers: 0,
            is_active: true,
            status: active.status,
            ban_count: 0,
            notes: None,
            created_at: None,
            last_used_at: None,
        }
    };
    event.target_account_id = account.id;
    if !event.source_url.is_empty() {
        let context = state.db.lookup_browser_page_context_for_account(
            &event.source_url,
            &event.page_type,
            account.id,
        )?;
        if event.kind != "clip" && (event.modules.data.metrics || event.profile_notes_requested) {
            if let Some(kind) = context.snapshot_kind {
                event.kind = kind;
                event.reference_account_id = context.reference_account_id;
            }
        }
    }

    // 收藏和快照都在 Native Messaging ACK 前持久化。各模块独立报告结果，
    // 这样一项失败时用户可以只重试失败项，避免把“已送达”误报为“已保存”。
    let mut collection_error = None;
    let mut capture_details_error = None;
    let collection_id = event
        .request_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|value| {
            format!(
                "bc:{}:{}",
                account.id,
                value.chars().take(96).collect::<String>()
            )
        });
    let collection_id = collection_id.unwrap_or_else(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        format!("bc:{}:{}", account.id, nanos)
    });
    let wants_collection = event.modules.collect.title_body
        || event.modules.collect.author_source
        || event.modules.collect.images
        || event.modules.collect.comments;
    let collection_saved = if wants_collection {
        let mut capture_modules = Vec::new();
        if event.modules.collect.title_body {
            capture_modules.push("titleBody".to_string());
        }
        if event.modules.collect.author_source {
            capture_modules.push("authorSource".to_string());
        }
        if event.modules.data.metrics {
            capture_modules.push("metrics".to_string());
        }
        if event.modules.collect.images {
            capture_modules.push("images".to_string());
        }
        if event.modules.collect.comments {
            capture_modules.push("comments".to_string());
        }
        let dedupe_key = collection_dedupe_key(account.id, &event.source_url, &event.title);
        match state
            .db
            .save_browser_capture_inspiration(crate::db::LocalInspirationCreate {
                id: collection_id.clone(),
                account_pool_id: account.id,
                title: event.title.clone(),
                source_url: event.source_url.clone(),
                body: if event.modules.collect.title_body {
                    event.body.clone()
                } else {
                    String::new()
                },
                observed_at: event.observed_at.clone(),
                reason: event.reason.clone(),
                dedupe_key,
                material_type: Some(event.material_type.clone()),
                author: Some(if event.modules.collect.author_source {
                    event.author.clone()
                } else {
                    String::new()
                }),
                capture_modules: Some(capture_modules),
            }) {
            Ok(()) => true,
            Err(error) => {
                capture_details_error = Some(error);
                false
            }
        }
    } else {
        false
    };

    let capture_details_saved = if collection_saved
        && (event.modules.collect.images || event.modules.collect.comments || event.kind == "clip")
    {
        let payload = serde_json::to_string(&event.capture_details)
            .map_err(|error| format!("序列化图片与评论摘录失败: {error}"))?;
        match state
            .db
            .save_browser_capture_payload(&collection_id, account.id, &payload)
        {
            Ok(()) => true,
            Err(error) => {
                collection_error = Some(error);
                false
            }
        }
    } else {
        false
    };

    if let Some(request_id) = event.request_id.as_deref() {
        if collection_saved {
            state.db.register_browser_capture_request(
                account.id,
                request_id,
                &collection_id,
                capture_details_saved,
            )?;
        }
    }

    // The collection and selected image URLs are durable before the Native
    // Messaging acknowledgement. Start bounded downloads in the background so
    // network/CDN failures never turn a saved text collection into a failed save.
    if capture_details_saved && event.modules.collect.images {
        match state
            .db
            .browser_collection_image_positions(&collection_id, account.id)
        {
            Ok(_positions) if event.image_transfer_protocol => {}
            Ok(positions) => crate::collection_images::spawn_capture_downloads(
                app.clone(),
                std::sync::Arc::clone(&state.db),
                collection_id.clone(),
                account.id,
                positions,
            ),
            Err(error) => {
                eprintln!("[browser-capture] failed to queue selected collection images: {error}")
            }
        }
    }

    let mut snapshot_error = None;
    let wants_snapshot = ((event.modules.data.metrics || event.modules.data.published_at)
        && event.kind != "clip")
        || event.profile_notes_requested;
    let snapshot = if wants_snapshot {
        match state
            .db
            .save_browser_page_snapshot(crate::db::PageSnapshotCreate {
                account_pool_id: account.id,
                kind: event.kind.clone(),
                source_url: event.source_url.clone(),
                title: event.title.clone(),
                author: event.author.clone(),
                body_excerpt: event.body.chars().take(4_000).collect(),
                metrics: crate::db::PageSnapshotMetrics {
                    like: event.metrics.like,
                    collect: event.metrics.collect,
                    comment: event.metrics.comment,
                    share: event.metrics.share,
                    followers: event.metrics.followers,
                    note_count: event.metrics.note_count,
                    capture_details: event.capture_details.clone(),
                },
                reference_account_id: event.reference_account_id,
                request_id: event.request_id.clone(),
                observed_at: event.observed_at.clone(),
            }) {
            Ok(saved) => Some(saved),
            Err(error) => {
                snapshot_error = Some(error);
                None
            }
        }
    } else {
        None
    };

    let mut profile_refreshed = false;
    let mut profile_refresh_error = None;
    let mut reference_profile_updated = false;
    if event.page_type == "profile"
        && event.modules.data.metrics
        && snapshot.is_some()
        && (!event.author.is_empty()
            || event.metrics.followers.is_some()
            || event.metrics.note_count.is_some()
            || event.profile.has_data())
    {
        if let Some(profile_id) = xhs_profile_id_from_url(&event.source_url) {
            match state
                .db
                .update_profile_from_browser_snapshot(crate::db::BrowserProfileSnapshot {
                    account_pool_id: account.id,
                    profile_account_id: profile_id,
                    display_name: Some(&event.author),
                    followers: event.metrics.followers,
                    total_notes: event.metrics.note_count,
                    avatar_url: event.profile.avatar_url.as_deref(),
                    xhs_bio: (!event.profile.bio.is_empty()).then_some(event.profile.bio.as_str()),
                    xhs_follows: event.profile.follows,
                    ip_location: (!event.profile.ip_location.is_empty())
                        .then_some(event.profile.ip_location.as_str()),
                    xhs_tags: (!event.profile.tags.is_empty())
                        .then_some(event.profile.tags.as_slice()),
                }) {
                Ok(updated) => profile_refreshed = updated,
                Err(error) => profile_refresh_error = Some(error),
            }
        }
        if let (Some(profile_id), Some(reference_account_id)) = (
            xhs_profile_id_from_url(&event.source_url),
            event.reference_account_id,
        ) {
            match state.db.update_reference_account_from_browser_snapshot(
                account.id,
                reference_account_id,
                profile_id,
                Some(&event.author),
                event.metrics.followers,
                event.metrics.note_count,
            ) {
                Ok(updated) => reference_profile_updated = updated,
                Err(error) => {
                    if profile_refresh_error.is_none() {
                        profile_refresh_error = Some(error);
                    }
                }
            }
        }
    }

    let mut profile_notes_result = serde_json::json!({
        "saved": false,
        "state": event.capture_details.get("profileNotesState").and_then(Value::as_str).unwrap_or("not-requested"),
        "imported": 0,
        "updated": 0,
        "skipped": false,
        "error": null,
    });
    let profile_notes_requested = event.profile_notes_requested;
    if profile_notes_requested {
        let state_name = event
            .capture_details
            .get("profileNotesState")
            .and_then(Value::as_str)
            .unwrap_or("unavailable");
        if !matches!(state_name, "complete" | "partial") {
            profile_notes_result["error"] = Value::String(match state_name {
                "login-required" => "请先在当前浏览器登录，再重试主页笔记同步".to_string(),
                "verification-required" => {
                    "主页触发安全验证；完成验证后再重试主页笔记同步".to_string()
                }
                "not-profile" => "当前标签已离开小红书主页，请重新打开主页后重试".to_string(),
                _ => "主页笔记采集未能启动，请重试".to_string(),
            });
        } else if snapshot.is_none() {
            profile_notes_result["error"] =
                Value::String("主页数据快照未保存，笔记未导入".to_string());
        } else if let Some(profile_id) = xhs_profile_id_from_url(&event.source_url) {
            let parsed_notes = event
                .capture_details
                .get("profileNotes")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            match serde_json::from_value::<Vec<crate::db::BrowserProfileNote>>(parsed_notes) {
                Ok(notes) => match state.db.sync_profile_notes_from_browser_snapshot(
                    account.id,
                    profile_id,
                    event.reference_account_id,
                    state_name == "complete",
                    &notes,
                ) {
                    Ok(sync) if !sync.matched_profile && !sync.matched_reference => {
                        profile_notes_result["saved"] = Value::Bool(true);
                        profile_notes_result["skipped"] = Value::Bool(true);
                        profile_notes_result["error"] = Value::String(
                            "该主页未登记为本人或榜样账号；为避免跨账号写入，未导入主页笔记"
                                .to_string(),
                        );
                    }
                    Ok(sync) => {
                        profile_notes_result["saved"] = Value::Bool(true);
                        profile_notes_result["imported"] = serde_json::json!(sync.imported);
                        profile_notes_result["updated"] = serde_json::json!(sync.updated);
                    }
                    Err(error) => profile_notes_result["error"] = Value::String(error),
                },
                Err(error) => {
                    profile_notes_result["error"] =
                        Value::String(format!("主页笔记格式无效: {error}"));
                }
            }
        } else {
            profile_notes_result["error"] = Value::String("主页链接中的账号 ID 无效".to_string());
        }
        if let Some(snapshot) = snapshot.as_ref() {
            if let Some(details) = event.capture_details.as_object_mut() {
                details.insert("profileNotesSync".to_string(), profile_notes_result.clone());
            }
            if profile_notes_result["saved"] == Value::Bool(true) {
                if let Err(error) = state.db.save_browser_profile_notes_outcome(
                    snapshot.id,
                    account.id,
                    &profile_notes_result,
                ) {
                    profile_notes_result["saved"] = Value::Bool(false);
                    profile_notes_result["error"] = Value::String(error);
                }
            }
        }
    }

    let outcomes = serde_json::json!({
        "collectionSaved": collection_saved,
        "collectionError": collection_error,
        "captureDetailsSaved": capture_details_saved,
        "captureDetailsError": capture_details_error,
        "snapshotSaved": snapshot.is_some(),
        "snapshotError": snapshot_error,
        "snapshotId": snapshot.as_ref().map(|value| value.id),
        "profileRefreshed": profile_refreshed,
        "profileRefreshError": profile_refresh_error,
        "referenceProfileUpdated": reference_profile_updated,
        "profileNotesSaved": profile_notes_result["saved"],
        "profileNotesImported": profile_notes_result["imported"],
        "profileNotesUpdated": profile_notes_result["updated"],
        "profileNotesSkipped": profile_notes_result["skipped"],
        "profileNotesState": profile_notes_result["state"],
        "profileNotesError": profile_notes_result["error"],
        "targetAccountId": account.id,
        "collectionId": collection_id,
        "requestId": event.request_id,
    });
    // UI 通知失败不能反转数据库提交结果；Native Messaging 回执仍以实际持久化结果为准。
    let _ = app.emit(
        CAPTURE_EVENT,
        serde_json::json!({ "capture": event, "outcomes": outcomes.clone() }),
    );
    Ok(serde_json::json!({
        "ok": true,
        "outcomes": outcomes,
        "collectionSaved": collection_saved,
        "collectionId": collection_id,
        "snapshotSaved": snapshot.is_some(),
        "snapshotId": snapshot.map(|value| value.id),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_rebound_workspace_before_accessing_data() {
        assert!(super::validate_connection_identity(&serde_json::json!({
            "expectedWorkspaceId": "another-workspace"
        }))
        .is_err());
        assert!(super::validate_connection_identity(&serde_json::json!({
            "expectedChannel": "another-channel"
        }))
        .is_err());
        assert!(super::validate_connection_identity(&serde_json::json!({
            "expectedWorkspaceId": super::workspace_identity(),
            "expectedChannel": super::runtime_channel()
        }))
        .is_ok());
    }

    #[test]
    fn request_recovery_requires_an_explicit_matching_instance_identity() {
        let valid = serde_json::json!({
            "expectedWorkspaceId": super::workspace_identity(),
            "expectedChannel": super::runtime_channel()
        });
        assert!(super::validate_explicit_capture_instance_identity(&valid).is_ok());
        assert!(
            super::validate_explicit_capture_instance_identity(&serde_json::json!({
                "expectedWorkspaceId": super::workspace_identity()
            }))
            .is_err()
        );
        assert!(
            super::validate_explicit_capture_instance_identity(&serde_json::json!({
                "expectedWorkspaceId": "another-workspace",
                "expectedChannel": super::runtime_channel()
            }))
            .is_err()
        );
    }

    #[test]
    fn bundled_extension_contains_the_complete_checked_runtime_file_set() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "aichihongshu-extension-package-{}-{stamp}",
            std::process::id()
        ));
        write_extension_tree_for(None, &dir, false).expect("embedded extension should deploy");
        verify_extension_tree(&dir).expect("deployed extension should pass integrity check");
        let (version, extension_id) = extension_manifest_meta(&dir).unwrap();
        let bundled_manifest: Value =
            serde_json::from_slice(bundled_extension_file("manifest.json").unwrap()).unwrap();
        assert_eq!(version, bundled_manifest["version"]);
        assert_eq!(extension_id, "nafpjfbdjkcodifhhhkfnnciaonegbgk");
        assert!(dir.join("creator-fill.js").is_file());
        assert!(!dir.join("host/host.cjs").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn extension_integrity_check_rejects_tampered_runtime_file() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "aichihongshu-extension-integrity-{}-{stamp}",
            std::process::id()
        ));
        write_extension_tree_for(None, &dir, false).expect("embedded extension should deploy");
        std::fs::write(dir.join("creator-fill.js"), b"tampered")
            .expect("test file should be writable");
        let error = verify_extension_tree(&dir).expect_err("changed payload must be detected");
        assert!(error.contains("creator-fill.js"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn extension_replacement_keeps_previous_copy_when_staging_fails_and_backs_it_up_on_success() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aichihongshu-extension-update-{}-{stamp}",
            std::process::id()
        ));
        let destination = root.join("browser-extension");
        let invalid_source = root.join("incomplete-source");
        std::fs::create_dir_all(&destination).expect("old extension folder should exist");
        std::fs::create_dir_all(&invalid_source).expect("invalid source folder should exist");
        std::fs::write(destination.join("keep.txt"), "previous copy")
            .expect("old extension sentinel should be written");

        assert!(replace_extension_tree(Some(&invalid_source), &destination).is_err());
        assert_eq!(
            std::fs::read_to_string(destination.join("keep.txt")).unwrap(),
            "previous copy"
        );

        replace_extension_tree_for(None, &destination, false)
            .expect("embedded extension should replace old folder");
        verify_extension_tree(&destination).expect("new folder should pass integrity validation");
        let backup = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("browser-extension.previous-"))
            })
            .expect("previous extension directory should be retained");
        assert_eq!(
            std::fs::read_to_string(backup.join("keep.txt")).unwrap(),
            "previous copy"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn production_and_dev_extension_manifests_have_distinct_native_host_identity() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aichihongshu-extension-channels-{}-{stamp}",
            std::process::id()
        ));
        let prod = root.join("prod");
        let dev = root.join("dev");
        write_extension_tree_for(None, &prod, false).expect("production extension should deploy");
        write_extension_tree_for(None, &dev, true).expect("dev extension should deploy");
        let (prod_version, prod_id) = extension_manifest_meta(&prod).unwrap();
        let (dev_version, dev_id) = extension_manifest_meta(&dev).unwrap();
        let dev_manifest: Value =
            serde_json::from_slice(&std::fs::read(dev.join("manifest.json")).unwrap()).unwrap();
        let dev_popup = std::fs::read_to_string(dev.join("popup.js")).unwrap();
        assert_eq!(prod_version, dev_version);
        assert_ne!(prod_id, dev_id);
        assert_eq!(dev_manifest["name"], "爱吃红薯数据抓取 DEV");
        assert!(dev_popup.contains("const NATIVE_HOSTS"));
        assert!(dev_popup.contains("com.aichihongshu.host.dev"));
        assert!(verify_extension_tree(&prod).is_ok());
        assert!(verify_extension_tree(&dev).is_ok());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn native_host_manifest_has_no_browser_unsupported_args_and_launcher_owns_mode() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aichihongshu-host-manifest-{}-{stamp}",
            std::process::id()
        ));
        let manifest_path = root.join("com.aichihongshu.host.dev.json");
        let launcher_path = root.join("native-host.sh");
        let binary = native_host_binary_path().unwrap();
        write_native_host_installation(
            &manifest_path,
            &launcher_path,
            &binary,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "dev",
        )
        .unwrap();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        let launcher = std::fs::read_to_string(&launcher_path).unwrap();
        assert!(manifest.get("args").is_none());
        assert_eq!(manifest["path"], launcher_path.display().to_string());
        assert_eq!(manifest["name"], "com.aichihongshu.host.dev");
        assert!(launcher.contains("AICHIHONGSHU_CAPTURE_CHANNEL=dev"));
        assert!(launcher.contains("--native-messaging-host"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn native_host_install_rolls_back_launcher_when_manifest_activation_fails() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aichihongshu-host-install-rollback-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let manifest_path = root.join("host.json");
        let launcher_path = root.join("native-host.sh");
        std::fs::create_dir(&manifest_path).unwrap();
        std::fs::write(manifest_path.join("sentinel"), "old manifest").unwrap();
        std::fs::write(&launcher_path, "#!/bin/sh\nexec old-host\n").unwrap();

        let error = write_native_host_installation(
            &manifest_path,
            &launcher_path,
            &native_host_binary_path().unwrap(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "dev",
        )
        .expect_err("manifest directory must make atomic activation fail");

        assert!(error.contains("启用 Native Messaging 清单失败"));
        assert_eq!(
            std::fs::read_to_string(&launcher_path).unwrap(),
            "#!/bin/sh\nexec old-host\n"
        );
        assert_eq!(
            std::fs::read_to_string(manifest_path.join("sentinel")).unwrap(),
            "old manifest"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn extension_install_transaction_restores_previous_copy_after_late_failure() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aichihongshu-install-transaction-{}-{stamp}",
            std::process::id()
        ));
        let destination = root.join("browser-extension");
        std::fs::create_dir_all(&root).unwrap();
        write_extension_tree_for(None, &destination, false).unwrap();
        let (_, previous_id) = extension_manifest_meta(&destination).unwrap();

        let result = with_extension_install_rollback(&destination, || {
            replace_extension_tree_for(None, &destination, true)?;
            Err::<(), _>("injected host activation failure".to_string())
        });

        assert_eq!(
            result.expect_err("activation failure should roll back extension"),
            "injected host activation failure"
        );
        let (_, restored_id) = extension_manifest_meta(&destination).unwrap();
        assert_eq!(restored_id, previous_id);
        let failed_copy = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("browser-extension.failed-install-"))
            })
            .expect("failed extension copy should be preserved for diagnosis");
        let (_, failed_id) = extension_manifest_meta(&failed_copy).unwrap();
        assert_ne!(failed_id, previous_id);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn all_desktop_receipts_include_protocol_and_identity() {
        for mut response in [
            serde_json::json!({"ok":true,"collectionSaved":true}),
            serde_json::json!({"ok":false,"error":"rejected"}),
        ] {
            stamp_response_identity(&mut response);
            assert_eq!(response["protocolVersion"], PROTOCOL_VERSION);
            assert_eq!(response["channel"], runtime_channel());
            assert_eq!(response["workspaceId"], workspace_identity());
        }
    }

    #[test]
    fn legacy_extension_missing_new_files_can_upgrade_and_roll_back() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aichi-legacy-upgrade-{}-{stamp}",
            std::process::id()
        ));
        let destination = root.join("extension");
        std::fs::create_dir_all(destination.join("old-assets")).unwrap();
        std::fs::write(destination.join("manifest.json"), "legacy manifest").unwrap();
        std::fs::write(destination.join("old-assets/icon.txt"), "legacy asset").unwrap();
        let failed = with_extension_install_rollback(&destination, || {
            replace_extension_tree_for(None, &destination, true)?;
            Err::<(), _>("host registration failed".into())
        });
        assert_eq!(failed.unwrap_err(), "host registration failed");
        assert_eq!(
            std::fs::read_to_string(destination.join("manifest.json")).unwrap(),
            "legacy manifest"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("old-assets/icon.txt")).unwrap(),
            "legacy asset"
        );
        assert!(!destination.join("connection-diagnostics.js").exists());
        assert!(!destination.join("integrity.json").exists());
        with_extension_install_rollback(&destination, || {
            replace_extension_tree_for(None, &destination, true)
        })
        .unwrap();
        verify_extension_tree(&destination).unwrap();
        assert!(destination.join("connection-diagnostics.js").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn channel_lock_prevents_a_second_listener_from_replacing_the_owner() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aichihongshu-listener-lock-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("browser-capture.lock");
        let owner = acquire_listener_lock_at(&path, "dev", "worktree-a").unwrap();
        let owner_metadata = listener_lock_owner_at(&path).unwrap().unwrap();
        assert_eq!(owner_metadata["workspaceId"], "worktree-a");
        assert!(acquire_listener_lock_at(&path, "dev", "worktree-b").is_err());
        drop(owner);
        assert!(listener_lock_owner_at(&path).unwrap().is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_valid_message_and_preserves_requested_account() {
        let event = validate_incoming(
            r#"{"title":"书桌角","sourceUrl":"https://example.com/post","body":"正文",
                "reason":"","observedAt":"2026-09-21T10:00:00.000Z",
                "requestId":"capture-1","targetAccountId":999,"transport":"manual"}"#,
        )
        .expect("valid capture should pass");
        assert_eq!(event.title, "书桌角");
        assert_eq!(event.source_url, "https://example.com/post");
        assert_eq!(event.request_id.as_deref(), Some("capture-1"));
        // 显式账号由后续数据库查询/写入校验其可用状态；transport 固定为 extension。
        assert_eq!(event.target_account_id, 999);
        assert_eq!(event.transport, "extension");
    }

    #[test]
    fn rejects_empty_title_and_non_object() {
        let empty = validate_incoming(r#"{"title":"   ","sourceUrl":""}"#)
            .expect_err("empty title must be rejected");
        assert!(empty.contains("标题"));
        let non_object =
            validate_incoming(r#"["not","an","object"]"#).expect_err("array must be rejected");
        assert!(non_object.contains("格式无效"));
        let bad_json = validate_incoming("not-json").expect_err("invalid JSON must be rejected");
        assert!(bad_json.contains("JSON"));
    }

    #[test]
    fn rejects_non_http_url() {
        let error = validate_incoming(r#"{"title":"标题","sourceUrl":"ftp://example.com/x"}"#)
            .expect_err("non-http URL must be rejected");
        assert!(error.contains("http"));
    }

    #[test]
    fn truncates_long_fields_and_treats_non_strings_as_empty() {
        let long_title = "标".repeat(500);
        let long_body = "文".repeat(30_000);
        let event = validate_incoming(&format!(
            r#"{{"title":"{long_title}","sourceUrl":"https://example.com/a","body":"{long_body}","reason":12345}}"#
        ))
        .expect("oversized but valid-shaped fields are truncated, not rejected");
        assert_eq!(event.title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(event.body.chars().count(), MAX_BODY_CHARS);
        // 数字 reason 与 TS 契约一致按空串处理。
        assert_eq!(event.reason, "");
        // observedAt 缺省为空，由 WebView 侧补当前时间。
        assert_eq!(event.observed_at, "");
        assert_eq!(event.request_id, None);
    }

    #[test]
    fn accepts_snapshot_kind_and_optional_metrics() {
        let event = validate_incoming(
            r#"{"title":"笔记","sourceUrl":"https://www.xiaohongshu.com/explore/abc",
                "kind":"note_snapshot","pageType":"note","author":"博主","like":"1.2万","collect":30,"share":7,
                "observedAt":"2026-09-26T10:00:00.000Z"}"#,
        )
        .expect("snapshot message should pass");
        assert_eq!(event.kind, "note_snapshot");
        assert_eq!(event.author, "博主");
        assert_eq!(event.metrics.like, None); // “1.2万”不是纯数字，保持 None，不编造
        assert_eq!(event.metrics.collect, Some(30));
        assert_eq!(event.metrics.comment, None);
        assert_eq!(event.metrics.share, Some(7));
        assert_eq!(event.capture_details["metrics"]["share"], 7);
        assert!(event.modules.data.metrics);
        assert!(event.modules.collect.title_body);
    }

    #[test]
    fn validates_profile_fields_and_drops_unsafe_or_unbounded_values() {
        let event = validate_incoming(
            &serde_json::json!({
                "title": "创作者主页",
                "sourceUrl": "https://www.xiaohongshu.com/user/profile/creator-1",
                "pageType": "profile",
                "profile": {
                    "avatarUrl": "https://cdn.example.com/avatar.jpg",
                    "bio": "简介".repeat(2_100),
                    "follows": "321",
                    "ipLocation": "上海".repeat(80),
                    "tags": ["#家居", "家居", "生活方式", 7]
                }
            })
            .to_string(),
        )
        .expect("profile capture should validate");
        assert_eq!(
            event.profile.avatar_url.as_deref(),
            Some("https://cdn.example.com/avatar.jpg")
        );
        assert_eq!(event.profile.bio.chars().count(), MAX_PROFILE_BIO_CHARS);
        assert_eq!(event.profile.follows, Some(321));
        assert_eq!(event.profile.ip_location.chars().count(), 100);
        assert_eq!(event.profile.tags, vec!["家居", "生活方式"]);

        let unsafe_avatar = validate_incoming(
            &serde_json::json!({
                "title": "创作者主页",
                "pageType": "profile",
                "profile": { "avatarUrl": "https://127.0.0.1/private.jpg" }
            })
            .to_string(),
        )
        .expect("unsafe avatar should be dropped, not fail capture");
        assert_eq!(unsafe_avatar.profile.avatar_url, None);
        assert!(!unsafe_avatar.profile.has_data());
    }

    #[test]
    fn preserves_explicit_capture_module_selection() {
        let event = validate_incoming(
            r#"{"title":"笔记","kind":"note_snapshot","modules":{"collect":{"titleBody":false,"authorSource":false},"data":{"metrics":true}}}"#,
        )
        .expect("module selection should pass validation");
        assert!(!event.modules.collect.title_body);
        assert!(!event.modules.collect.author_source);
        assert!(event.modules.data.metrics);
    }

    #[test]
    fn captures_only_selected_bounded_page_details() {
        let comment = "评价".repeat(210);
        let event = validate_incoming(&serde_json::json!({
            "title": "笔记",
            "sourceUrl": "https://www.xiaohongshu.com/explore/abc",
            "pageType": "note",
            "modules": {"collect": {"titleBody": false, "authorSource": false, "images": true, "comments": true}, "data": {"publishedAt": true}},
            "images": [
                {"url":"https://cdn.example.com/a.jpg", "width":800, "height":900, "domIndex":0},
                {"url":"https://127.0.0.1:443/private.jpg", "width":800, "height":900, "domIndex":1}
            ],
            "comments": [{"author":"读者", "text":comment, "truncated":true}],
            "publishedAt": "09-15",
            "publishedLocation": "四川"
        }).to_string()).expect("selected media detail message should pass");
        assert!(event.modules.collect.images);
        assert!(event.modules.collect.comments);
        assert_eq!(event.capture_details["images"].as_array().unwrap().len(), 1);
        assert_eq!(
            event.capture_details["comments"][0]["text"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            350
        );
        assert_eq!(event.capture_details["comments"][0]["truncated"], true);
        assert_eq!(event.capture_details["publishedAt"], "09-15");
        assert_eq!(event.capture_details["publishedLocation"], "四川");
    }

    #[test]
    fn captures_profile_note_cards_only_when_explicitly_requested() {
        let notes = (0..35)
            .map(|index| {
                serde_json::json!({
                    "noteUrl": format!("https://www.xiaohongshu.com/explore/note-{index}{}", if index == 0 { "?xsec_token=private" } else { "" }),
                    "title": format!("主页笔记 {index}"),
                    "body": "正".repeat(1_500),
                    "likes": 12_345,
                    "comments": 123,
                    "collects": 456,
                    "tags": ["家居", "收纳"],
                    "publishedAt": "2026-09-28T10:00:00Z"
                })
            })
            .chain([
                serde_json::json!({
                    "noteUrl": "https://attacker.example/explore/unsafe",
                    "title": "恶意外链"
                }),
                serde_json::json!({
                    "noteUrl": "https://www.xiaohongshu.com:443/explore/port",
                    "title": "带端口链接"
                }),
            ])
            .collect::<Vec<_>>();
        let event = validate_incoming(
            &serde_json::json!({
                "title": "本人主页",
                "sourceUrl": "https://www.xiaohongshu.com/user/profile/profile-1",
                "pageType": "profile",
                "profileNotesRequested": true,
                "modules": {"data": {"metrics": false}},
                "profileNotesState": "complete",
                "profileNotes": notes,
            })
            .to_string(),
        )
        .expect("profile notes should validate");
        assert_eq!(event.kind, "ref_snapshot");
        assert!(event.profile_notes_requested);
        assert!(!event.modules.data.metrics);
        assert_eq!(event.capture_details["profileNotesState"], "complete");
        let saved_notes = event.capture_details["profileNotes"].as_array().unwrap();
        assert_eq!(saved_notes.len(), MAX_PROFILE_NOTES);
        assert_eq!(saved_notes[0]["title"], "主页笔记 0");
        assert_eq!(
            saved_notes[0]["noteUrl"],
            "https://www.xiaohongshu.com/explore/note-0"
        );
        assert_eq!(
            saved_notes[0]["body"].as_str().unwrap().chars().count(),
            1_200
        );
        assert_eq!(saved_notes[0]["likes"], 12_345);
        assert!(canonical_profile_note_url(
            "https://xiaohongshu.com/discovery/item/note-1?xsec_token=opaque"
        )
        .is_some());
        assert!(
            canonical_profile_note_url("https://xiaohongshu.com.evil.example/explore/note-1")
                .is_none()
        );
    }

    #[test]
    fn profile_metrics_do_not_implicitly_request_profile_note_sync() {
        let event = validate_incoming(
            &serde_json::json!({
                "title": "创作者主页",
                "sourceUrl": "https://www.xiaohongshu.com/user/profile/creator-2",
                "pageType": "profile",
                "modules": {"data": {"metrics": true}},
                "profileNotesState": "complete",
                "profileNotes": [{"noteUrl": "https://www.xiaohongshu.com/explore/a", "title": "不应隐式同步"}],
            })
            .to_string(),
        )
        .expect("profile metrics should remain independent from profile-note sync");
        assert!(!event.profile_notes_requested);
        assert_eq!(event.capture_details["profileNotesState"], "not-requested");
        assert!(event.capture_details["profileNotes"]
            .as_array()
            .unwrap()
            .is_empty());

        let invalid =
            validate_incoming(r#"{"title":"笔记","pageType":"note","profileNotesRequested":true}"#)
                .expect_err("explicit profile-note sync is only valid on a profile page");
        assert!(invalid.contains("主页"));
    }

    #[test]
    fn rejects_private_and_ipv6_literal_image_references_even_with_ports() {
        assert!(!safe_public_image_reference(
            "https://127.0.0.1:443/image.jpg"
        ));
        assert!(!safe_public_image_reference("https://[::1]:443/image.jpg"));
        assert!(safe_public_image_reference(
            "https://cdn.example.com:443/image.jpg"
        ));
    }

    #[test]
    fn unknown_kind_falls_back_to_clip_and_rejects_negative_metrics() {
        let event = validate_incoming(r#"{"title":"x","kind":"batch_refresh"}"#)
            .expect("unknown kind falls back");
        assert_eq!(event.kind, "clip");
        let event = validate_incoming(r#"{"title":"x","kind":"note_snapshot","like":-5}"#)
            .expect("negative metrics are dropped, not fatal");
        assert_eq!(event.metrics.like, None);
    }

    #[test]
    fn extracts_only_https_xhs_profile_ids_for_own_profile_updates() {
        assert_eq!(
            xhs_profile_id_from_url(
                "https://www.xiaohongshu.com/user/profile/profile-123?xsec_token=secret"
            ),
            Some("profile-123")
        );
        assert_eq!(
            xhs_profile_id_from_url("https://xiaohongshu.com/user/profile/abc_123/"),
            Some("abc_123")
        );
        assert_eq!(
            xhs_profile_id_from_url("http://www.xiaohongshu.com/user/profile/abc"),
            None
        );
        assert_eq!(
            xhs_profile_id_from_url("https://evil.example/user/profile/abc"),
            None
        );
        assert_eq!(
            xhs_profile_id_from_url("https://www.xiaohongshu.com/user/profile/../other"),
            None
        );
    }
}
