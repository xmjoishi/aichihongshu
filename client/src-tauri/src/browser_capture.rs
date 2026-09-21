//! 浏览器剪藏回传链路（CHG-20260916-001 / N12 最小原型，D4 混合路线）。
//!
//! 链路：Chrome 扩展（纯消息传输）→ 原生宿主 host.cjs →
//! owner-only Unix socket（单行 JSON）→ 本模块 →
//! 镜像再校验 + 以当前激活账号盖章 targetAccountId →
//! Tauri 事件 `browser-capture://message` → WebView 待确认队列。
//!
//! 安全边界：
//! - socket 目录与文件 owner-only（0700 / 0600），只接受本机同用户连接；
//! - 不采纳消息里的任何账号字段，targetAccountId 一律由本进程盖章；
//! - 字段校验镜像 client/src/lib/browserCapture.ts 的 TS 契约；
//! - 事件只进入 WebView 待确认队列，本模块不直接写数据库。

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
}

/// 与 TS 契约一致：非字符串字段按空串处理，字符串截断到上限。
fn text(value: &Value, field: &str, max_chars: usize) -> String {
    match value.get(field) {
        Some(Value::String(text)) => text.truncated(max_chars),
        _ => String::new(),
    }
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
        Ok(()) => "{\"ok\":true}".to_string(),
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

fn process_message(stream: &mut UnixStream, app: &AppHandle) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut line = String::new();
    let read = reader.read_line(&mut line).map_err(|e| e.to_string())?;
    if read == 0 {
        return Err("浏览器宿主未发送消息".to_string());
    }
    if line.len() > MAX_WIRE_BYTES {
        return Err("浏览器剪藏内容超过 256KB 限制".to_string());
    }
    let mut event = validate_incoming(line.trim_end())?;
    let account = app.state::<crate::AppState>().db.current_active_account()?;
    event.target_account_id = account.id;
    app.emit(CAPTURE_EVENT, &event).map_err(|e| e.to_string())?;
    Ok(())
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
}
