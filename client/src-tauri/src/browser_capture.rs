//! 浏览器剪藏与单篇快照回传链路（CHG-20260916-001 / N12，D4 混合路线）。
//!
//! 链路：Chrome 扩展（纯消息传输）→ 原生宿主 host.cjs →
//! owner-only Unix socket（单行 JSON）→ 本模块 →
//! 镜像再校验 + 以当前激活账号盖章 targetAccountId →
//! SQLite 持久化 / `browser-capture://message` UI 通知。
//!
//! 安全边界：
//! - socket 目录与文件 owner-only（0700 / 0600），只接受本机同用户连接；
//! - 不采纳消息里的任何账号字段，targetAccountId 一律由本进程盖章；
//! - 字段校验镜像 client/src/lib/browserCapture.ts 的 TS 契约；
//! - 浏览器收藏在 Native Messaging 返回成功前直接写入当前账号 SQLite；事件只负责通知 UI。

use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
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
    pub author: String,
    pub metrics: BrowserCaptureMetrics,
    pub modules: BrowserCaptureModules,
    /// Filled by the local database lookup, never copied from the extension.
    pub reference_account_id: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureMetrics {
    pub like: Option<i64>,
    pub collect: Option<i64>,
    pub comment: Option<i64>,
    pub followers: Option<i64>,
    pub note_count: Option<i64>,
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
        let path = path
            .split(|character| character == '?' || character == '#')
            .next()
            .unwrap_or("");
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
    if !source_url.is_empty()
        && !(source_url.starts_with("http://") || source_url.starts_with("https://"))
    {
        return Err("来源链接必须以 http:// 或 https:// 开头".to_string());
    }

    let request_id = text(&value, "requestId", MAX_REQUEST_ID_CHARS);

    let kind = match text(&value, "kind", 32).as_str() {
        "note_snapshot" | "ref_snapshot" | "clip" => text(&value, "kind", 32),
        _ => "clip".to_string(),
    };
    let material_type = match text(&value, "materialType", 32).as_str() {
        "note_material" | "profile_material" | "web_material" => text(&value, "materialType", 32),
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

    let modules = BrowserCaptureModules {
        collect: BrowserCaptureCollectModules {
            title_body: module_flag(&value, &["modules", "collect", "titleBody"], true),
            author_source: module_flag(&value, &["modules", "collect", "authorSource"], true),
            images: false,
            comments: false,
        },
        data: BrowserCaptureDataModules {
            metrics: module_flag(&value, &["modules", "data", "metrics"], kind != "clip"),
            published_at: false,
        },
    };

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
        target_account_id: 0,
        transport: "extension",
        kind,
        material_type,
        page_type,
        author: text(&value, "author", 200),
        metrics: BrowserCaptureMetrics {
            like: optional_count(&value, "like"),
            collect: optional_count(&value, "collect"),
            comment: optional_count(&value, "comment"),
            followers: optional_count(&value, "followers"),
            note_count: optional_count(&value, "noteCount"),
        },
        modules,
        reference_account_id: None,
    })
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
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".aichihongshu")
        .join("browser-capture.sock")
}

/// 扩展目录（开发默认 = 仓库 browser-extension/，供浏览器「加载已解压」）。
fn project_extension_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("AICHIHONGSHU_EXTENSION_DIR") {
        let trimmed = dir.trim().to_string();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../browser-extension")
}

/// 扩展目录：优先项目目录；兼容旧部署副本。
fn extension_dir() -> PathBuf {
    let project = project_extension_dir();
    if project.join("manifest.json").is_file() {
        return project.canonicalize().unwrap_or(project);
    }
    let deployed = deployed_extension_dir();
    if deployed.join("manifest.json").is_file() {
        return deployed.canonicalize().unwrap_or(deployed);
    }
    project
}

fn deployed_extension_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".aichihongshu")
        .join("browser-extension")
}

/// 原生宿主脚本：始终落在用户目录（改 shebang，不污染仓库）。
fn host_script_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".aichihongshu").join("host.cjs")
}

/// 解析 node 绝对路径（优先当前进程用的 node，其次 which）。
fn resolve_node_path() -> Result<String, String> {
    let candidates = [
        std::env::var("MIMO_NODE").ok().unwrap_or_default(),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("node").display().to_string()))
            .unwrap_or_default(),
        "/Users/wuxianhao/.local/bin/node".to_string(),
        "/Users/wuxianhao/.hermes/node/bin/node".to_string(),
        "/opt/homebrew/bin/node".to_string(),
        "/usr/local/bin/node".to_string(),
        "/usr/bin/node".to_string(),
    ];
    for candidate in candidates {
        if candidate.is_empty() {
            continue;
        }
        if std::path::Path::new(&candidate).is_file() {
            return Ok(candidate);
        }
    }
    if let Ok(output) = std::process::Command::new("which").arg("node").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(path);
            }
        }
    }
    Err("找不到 node 可执行文件，请安装 Node.js 后重试".to_string())
}

/// 从仓库/项目目录读取 host.cjs，写入用户目录并改写 shebang。
fn install_host_script() -> Result<PathBuf, String> {
    let source = project_extension_dir().join("host").join("host.cjs");
    let raw = if source.is_file() {
        std::fs::read_to_string(&source).map_err(|error| format!("读取 host.cjs 失败: {error}"))?
    } else {
        include_str!("../../../browser-extension/host/host.cjs").to_string()
    };
    let node_abs = resolve_node_path()?;
    let patched = if raw.starts_with("#!") {
        let rest = raw.find('\n').map(|idx| &raw[idx..]).unwrap_or("\n");
        format!("#!{node_abs}{rest}")
    } else {
        format!("#!{node_abs}\n{raw}")
    };
    let target = host_script_path();
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建 .aichihongshu 失败: {error}"))?;
    }
    std::fs::write(&target, patched).map_err(|error| format!("写入宿主脚本失败: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }
    Ok(target)
}

/// 读取项目扩展 manifest，校验权限并返回 extension_id。
fn read_extension_meta() -> Result<(PathBuf, String, String), String> {
    let dir = extension_dir();
    let manifest_path = dir.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("读取扩展 manifest 失败: {error}"))?;
    let manifest: Value =
        serde_json::from_str(&raw).map_err(|_| "扩展 manifest 不是有效 JSON".to_string())?;
    let allowed = ["nativeMessaging", "scripting", "activeTab"];
    if let Some(perms) = manifest.get("permissions").and_then(|v| v.as_array()) {
        for item in perms {
            let name = item.as_str().unwrap_or("");
            if !allowed.contains(&name) {
                return Err(format!("扩展权限超出最小集合：{name}"));
            }
        }
    }
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0")
        .to_string();
    let key_b64 = manifest
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("扩展 manifest 缺少 key 字段")?;
    let extension_id = extension_id_from_key(key_b64)?;
    Ok((dir, version, extension_id))
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

/// 安装到指定浏览器：写宿主 + 打开扩展页 + 打开扩展目录（项目目录）。
pub fn install_for_browser(browser: &str) -> Result<String, String> {
    if !matches!(browser, "chrome" | "edge") {
        return Err("只支持 chrome 或 edge".to_string());
    }
    let (ext_dir, version, extension_id) = read_extension_meta()?;
    let host_script = install_host_script()?;

    let host_json = serde_json::json!({
        "name": "com.aichihongshu.host",
        "description": "爱吃红薯数据抓取宿主（本地转发，无网络权限）",
        "path": host_script,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{extension_id}/")],
    });
    let target_dir = browser_host_dir(browser);
    std::fs::create_dir_all(&target_dir)
        .map_err(|error| format!("创建 NativeMessagingHosts 失败: {error}"))?;
    let host_manifest = target_dir.join("com.aichihongshu.host.json");
    std::fs::write(&host_manifest, format!("{host_json}\n"))
        .map_err(|error| format!("写入宿主清单失败: {error}"))?;

    // 自动打开扩展页 + 扩展目录，用户只需「加载已解压」。
    let _ = open_extensions_page(browser);
    let _ = open_dir(&ext_dir);

    let label = if browser == "edge" { "Edge" } else { "Chrome" };
    Ok(format!(
        "✓ 已安装到 {label}\n\
         ✓ 扩展目录（请加载此文件夹）：{ext}\n\
         ✓ 扩展 ID：{id}\n\
         ✓ 扩展版本：v{ver}\n\
         ✓ 宿主：{host}\n\n\
         请在 {label} 扩展页：开发者模式 → 加载已解压的扩展程序 → 选择上面扩展目录",
        ext = ext_dir.display(),
        id = extension_id,
        ver = version,
        host = host_manifest.display(),
    ))
}

/// 复制扩展目录到 ~/aichihongshu-extensions/vX.Y.Z/（NOOMD 式副本，可存档版本）。
pub fn copy_extension_dir() -> Result<String, String> {
    let (src, version, extension_id) = read_extension_meta()?;
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let dest = PathBuf::from(home)
        .join("aichihongshu-extensions")
        .join(format!("v{version}"));
    std::fs::create_dir_all(&dest).map_err(|error| format!("创建副本目录失败: {error}"))?;
    // 复制扩展本体（不含 host/ 子目录，宿主在 ~/.aichihongshu/host.cjs）。
    for name in [
        "manifest.json",
        "popup.html",
        "popup.css",
        "popup.js",
        "background.js",
        "extract.js",
    ] {
        let from = src.join(name);
        if from.is_file() {
            std::fs::copy(&from, dest.join(name))
                .map_err(|error| format!("复制 {name} 失败: {error}"))?;
        }
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
    let dir = extension_dir();
    if !dir.join("manifest.json").is_file() {
        return Err("扩展目录不存在".to_string());
    }
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
    let dir = extension_dir();
    if !dir.join("manifest.json").is_file() {
        return Err("扩展目录不存在".to_string());
    }
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

/// 连接自检：扩展文件 → 宿主清单 → Unix socket，逐跳报告。
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
    let host_path = host_script_path();
    let host_ok = host_path.is_file();
    let mut host_detail = if host_ok {
        host_path.display().to_string()
    } else {
        "缺少 ~/.aichihongshu/host.cjs（点「安装到 Chrome/Edge」）".to_string()
    };
    if host_ok {
        if let Ok(raw) = std::fs::read_to_string(&host_path) {
            let shebang = raw.lines().next().unwrap_or("");
            if shebang.starts_with("#!") {
                let interpreter = shebang[2..].trim();
                host_detail = format!("{host_detail}（{shebang}）");
                if interpreter.contains("env node") {
                    host_detail.push_str(" ⚠ env node 在 Chrome 下可能找不到 PATH");
                    hops.push((
                        "宿主 shebang".to_string(),
                        false,
                        "需改写为 node 绝对路径（点安装到 Chrome/Edge）".to_string(),
                    ));
                } else if !std::path::Path::new(interpreter).is_file() {
                    hops.push((
                        "宿主 shebang".to_string(),
                        false,
                        format!("{interpreter} 不存在"),
                    ));
                }
            }
        }
    }
    hops.push(("原生宿主脚本".to_string(), host_ok, host_detail));
    let chrome_host = native_host_dir("Google/Chrome").join("com.aichihongshu.host.json");
    let edge_host = native_host_dir("Microsoft Edge").join("com.aichihongshu.host.json");
    let host_manifest_ok = chrome_host.is_file() || edge_host.is_file();
    hops.push((
        "宿主清单".to_string(),
        host_manifest_ok,
        if host_manifest_ok {
            format!(
                "Chrome {} / Edge {}",
                if chrome_host.is_file() { "✓" } else { "✗" },
                if edge_host.is_file() { "✓" } else { "✗" }
            )
        } else {
            "未安装 NativeMessagingHosts".to_string()
        },
    ));
    let sock = socket_path();
    let socket_ok = sock.exists();
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
    pub extension_version: Option<String>,
    pub extension_dir: String,
    pub extension_id: Option<String>,
    pub host_manifest_path: String,
    pub host_installed: bool,
    pub host_manifest_matches: bool,
    pub host_installed_edge: bool,
    pub browsers: Vec<String>,
}

pub const PROTOCOL_VERSION: u16 = 3;

fn host_status_for(browser_rel: &str, extension_id: &Option<String>) -> (String, bool, bool) {
    let path = native_host_dir(browser_rel).join("com.aichihongshu.host.json");
    let mut installed = false;
    let mut matches = false;
    if let Ok(raw) = std::fs::read_to_string(&path) {
        installed = true;
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            matches = value
                .get("allowed_origins")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter().filter_map(|item| item.as_str()).any(|origin| {
                        extension_id
                            .as_ref()
                            .is_some_and(|id| origin.contains(id.as_str()))
                    })
                })
                .unwrap_or(false);
        }
    }
    (path.display().to_string(), installed, matches)
}

pub fn status() -> BrowserCaptureStatus {
    let dir = extension_dir();
    let manifest_path = dir.join("manifest.json");
    let mut extension_version = None;
    let mut extension_id = None;
    if let Ok(raw) = std::fs::read_to_string(&manifest_path) {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            extension_version = value
                .get("version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Some(key) = value.get("key").and_then(|v| v.as_str()) {
                extension_id = extension_id_from_key(key).ok();
            }
        }
    }
    let (host_manifest_path, host_installed, host_manifest_matches) =
        host_status_for("Google/Chrome", &extension_id);
    let (_, host_installed_edge, _) = host_status_for("Microsoft Edge", &extension_id);
    BrowserCaptureStatus {
        protocol_version: PROTOCOL_VERSION,
        extension_version,
        extension_dir: dir.display().to_string(),
        extension_id,
        host_manifest_path,
        host_installed,
        host_manifest_matches,
        host_installed_edge,
        browsers: detect_browsers(),
    }
}

/// 启动回传监听线程。绑定失败（如已有实例占用）只记录 stderr，不影响应用。
pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let path = socket_path();
        if let Some(parent) = path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                eprintln!("浏览器剪藏 socket 目录创建失败: {error}");
                return;
            }
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
        let _ = std::fs::remove_file(&path);
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
    let reply = match process_message(&mut stream, app) {
        Ok(value) => serde_json::to_string(&value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"响应序列化失败\"}".to_string()),
        Err(message) => {
            let encoded =
                serde_json::to_string(&message).unwrap_or_else(|_| "\"处理剪藏失败\"".to_string());
            format!("{{\"ok\":false,\"error\":{encoded}}}")
        }
    };
    let _ = stream.write_all(reply.as_bytes());
    let _ = stream.write_all(b"\n");
    let _ = stream.flush();
}

fn process_message(stream: &mut UnixStream, app: &AppHandle) -> Result<Value, String> {
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
    let action = value.get("action").and_then(Value::as_str);
    if action == Some("ping") {
        let protocol_version = value
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        if protocol_version < 3 {
            return Err("扩展协议版本过旧，请在设置中重新安装/更新扩展".to_string());
        }
        return Ok(serde_json::json!({ "ok": true, "status": "ready" }));
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
        let page_type = match text(&value, "pageType", 16).as_str() {
            "note" | "profile" | "web" => text(&value, "pageType", 16),
            _ => "web".to_string(),
        };
        let context = app
            .state::<crate::AppState>()
            .db
            .lookup_browser_page_context(&source_url, &page_type)?;
        return Ok(serde_json::json!({ "ok": true, "context": context }));
    }

    let mut event = validate_incoming(&value.to_string())?;
    let state = app.state::<crate::AppState>();
    let account = state.db.current_active_account()?;
    event.target_account_id = account.id;
    if !event.source_url.is_empty() {
        let context = state
            .db
            .lookup_browser_page_context(&event.source_url, &event.page_type)?;
        if event.modules.data.metrics {
            if let Some(kind) = context.snapshot_kind {
                event.kind = kind;
                event.reference_account_id = context.reference_account_id;
            }
        }
    }

    // 收藏直接落 SQLite 后才应向 Native Messaging 返回成功。这样扩展的
    // 成功状态代表已入库，前端事件只负责 toast 与刷新当前收藏列表。
    if event.modules.collect.title_body || event.modules.collect.author_source {
        let request_suffix = event
            .request_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(96).collect::<String>())
            .unwrap_or_else(|| {
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_nanos())
                    .unwrap_or_default();
                nanos.to_string()
            });
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
        let dedupe_key = collection_dedupe_key(account.id, &event.source_url, &event.title);
        state
            .db
            .save_local_inspiration(crate::db::LocalInspirationCreate {
                id: format!("bc:{}:{}", account.id, request_suffix),
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
            })?;
    }
    app.emit(CAPTURE_EVENT, &event).map_err(|e| e.to_string())?;
    Ok(
        serde_json::json!({ "ok": true, "collectionSaved": event.modules.collect.title_body || event.modules.collect.author_source }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_message_and_ignores_account_fields() {
        let event = validate_incoming(
            r#"{"title":"书桌角","sourceUrl":"https://example.com/post","body":"正文",
                "reason":"","observedAt":"2026-09-21T10:00:00.000Z",
                "requestId":"capture-1","targetAccountId":999,"transport":"manual"}"#,
        )
        .expect("valid capture should pass");
        assert_eq!(event.title, "书桌角");
        assert_eq!(event.source_url, "https://example.com/post");
        assert_eq!(event.request_id.as_deref(), Some("capture-1"));
        // 账号字段不采纳，等待盖章；transport 固定为 extension。
        assert_eq!(event.target_account_id, 0);
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
                "kind":"note_snapshot","author":"博主","like":"1.2万","collect":30,
                "observedAt":"2026-09-26T10:00:00.000Z"}"#,
        )
        .expect("snapshot message should pass");
        assert_eq!(event.kind, "note_snapshot");
        assert_eq!(event.author, "博主");
        assert_eq!(event.metrics.like, None); // “1.2万”不是纯数字，保持 None，不编造
        assert_eq!(event.metrics.collect, Some(30));
        assert_eq!(event.metrics.comment, None);
        assert!(event.modules.data.metrics);
        assert!(event.modules.collect.title_body);
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
    fn unknown_kind_falls_back_to_clip_and_rejects_negative_metrics() {
        let event = validate_incoming(r#"{"title":"x","kind":"batch_refresh"}"#)
            .expect("unknown kind falls back");
        assert_eq!(event.kind, "clip");
        let event = validate_incoming(r#"{"title":"x","kind":"note_snapshot","like":-5}"#)
            .expect("negative metrics are dropped, not fatal");
        assert_eq!(event.metrics.like, None);
    }
}
