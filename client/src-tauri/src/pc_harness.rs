//! PC Harness：用户显式开启的局域网 Companion API。
//! 仅处理手机任务有限端点，Bearer 配对令牌鉴权；不暴露 Tauri/shell/任意路径。

use crate::db::{
    CompanionTaskSummary, ExperiencePromptUpsert, LocalDb, LocalImageImport, MemoryEntryCreate,
    MemoryEntryFilter, MemoryEntryTransition, MemoryEntryUpdate,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const PROTOCOL_VERSION: &str = "1";
const DEFAULT_PORT: u16 = 18765;
const MAX_BODY_BYTES: usize = 28 * 1024 * 1024;
const MAX_PHOTOS: usize = 9;
const MAX_PHOTO_BYTES: usize = 12 * 1024 * 1024;
const ALLOWED_EXT: [&str; 3] = ["jpg", "jpeg", "png"];
const MOBILE_PRESENCE_TTL: Duration = Duration::from_secs(8);
const MOBILE_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcHarnessStatus {
    pub running: bool,
    pub bind_address: Option<String>,
    pub lan_addresses: Vec<String>,
    pub port: u16,
    pub pairing_token: Option<String>,
    pub protocol_version: &'static str,
    pub active_account_id: Option<i64>,
    pub mobile_connected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileMemoryCommandEnvelope {
    pub id: String,
    pub account_id: i64,
    pub operation: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileMemoryCommandReceipt {
    pub cache_synced: bool,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileMemoryCommandPollRequest {
    account_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileMemoryCommandResultRequest {
    account_id: i64,
    success: bool,
    cache_synced: bool,
    message: Option<String>,
}

#[derive(Debug, Clone)]
struct MobileMemoryCommandResult {
    success: bool,
    cache_synced: bool,
    message: Option<String>,
}

struct PendingMobileMemoryCommand {
    envelope: MobileMemoryCommandEnvelope,
    delivered: bool,
    result: Option<MobileMemoryCommandResult>,
}

#[derive(Default)]
struct MobileMemoryCommandState {
    last_seen: Option<Instant>,
    last_account_id: Option<i64>,
    pending: Option<PendingMobileMemoryCommand>,
}

/// In-memory, single-flight write-through broker. Commands are never persisted
/// or replayed after the phone goes offline or the Harness stops.
#[derive(Default)]
pub struct MobileMemoryCommandBroker {
    state: Mutex<MobileMemoryCommandState>,
    changed: Condvar,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTaskRequest {
    topic: Option<String>,
    account_id: Option<i64>,
    client_task_id: Option<String>,
    photos: Option<Vec<PhotoPayload>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhotoPayload {
    filename: Option<String>,
    mime_type: Option<String>,
    data_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishReceiptRequest {
    status: String,
    note_url: Option<String>,
    message: Option<String>,
}

#[derive(Clone)]
struct HarnessShared {
    db: Arc<LocalDb>,
    token: Arc<Mutex<String>>,
    running: Arc<AtomicBool>,
    bind_address: Arc<Mutex<Option<String>>>,
    port: u16,
    memory_commands: Arc<MobileMemoryCommandBroker>,
}

pub struct PcHarnessHandle {
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl Drop for PcHarnessHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.join.take() {
            let _ = handle.join();
        }
    }
}

#[derive(Default)]
pub struct PcHarnessRuntime {
    handle: Option<PcHarnessHandle>,
    token: String,
    active_token: Option<Arc<Mutex<String>>>,
    running: Arc<AtomicBool>,
    bind_address: Arc<Mutex<Option<String>>>,
    port: u16,
    memory_commands: Arc<MobileMemoryCommandBroker>,
}

impl PcHarnessRuntime {
    pub fn new() -> Self {
        Self {
            handle: None,
            token: generate_token(),
            active_token: None,
            running: Arc::new(AtomicBool::new(false)),
            bind_address: Arc::new(Mutex::new(None)),
            port: DEFAULT_PORT,
            memory_commands: Arc::new(MobileMemoryCommandBroker::default()),
        }
    }

    /// 用持久化的配对令牌恢复运行时，避免重启后手机端失配。
    pub fn restore_token(&mut self, token: &str) {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            self.token = trimmed.to_string();
        }
    }

    pub fn rotate_token(&mut self) -> String {
        self.token = generate_token();
        if let Some(active_token) = &self.active_token {
            if let Ok(mut shared_token) = active_token.lock() {
                *shared_token = self.token.clone();
            }
        }
        self.token.clone()
    }

    pub fn token(&self) -> String {
        self.token.clone()
    }

    pub fn status(&self, db: &LocalDb) -> PcHarnessStatus {
        let active_account_id = db.current_active_account().ok().map(|account| account.id);
        PcHarnessStatus {
            running: self.running.load(Ordering::SeqCst),
            bind_address: self
                .bind_address
                .lock()
                .ok()
                .and_then(|value| value.clone()),
            lan_addresses: lan_ipv4_addresses(),
            port: self.port,
            pairing_token: Some(self.token.clone()),
            protocol_version: PROTOCOL_VERSION,
            active_account_id,
            mobile_connected: self.mobile_connected_for_account(active_account_id),
        }
    }

    pub fn mobile_connected(&self, db: &LocalDb) -> bool {
        self.mobile_connected_for_account(
            db.current_active_account().ok().map(|account| account.id),
        )
    }

    fn mobile_connected_for_account(&self, account_id: Option<i64>) -> bool {
        self.running.load(Ordering::SeqCst)
            && account_id.is_some_and(|id| self.memory_commands.connected_for(id))
    }

    pub fn start(&mut self, db: Arc<LocalDb>) -> Result<PcHarnessStatus, String> {
        if self.running.load(Ordering::SeqCst) {
            return Ok(self.status(&db));
        }
        let listener = TcpListener::bind(("0.0.0.0", self.port))
            .map_err(|error| format!("PC Harness 监听失败（端口 {}）: {error}", self.port))?;
        listener
            .set_nonblocking(false)
            .map_err(|error| format!("设置监听失败: {error}"))?;
        let local = listener
            .local_addr()
            .map_err(|error| format!("读取监听地址失败: {error}"))?;
        let bind_address = format!("0.0.0.0:{}", local.port());
        if let Ok(mut slot) = self.bind_address.lock() {
            *slot = Some(bind_address);
        }
        self.port = local.port();

        let active_token = Arc::new(Mutex::new(self.token.clone()));
        let shared = HarnessShared {
            db: db.clone(),
            token: active_token.clone(),
            running: self.running.clone(),
            bind_address: self.bind_address.clone(),
            port: local.port(),
            memory_commands: self.memory_commands.clone(),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        self.running.store(true, Ordering::SeqCst);
        let join = thread::spawn(move || accept_loop(listener, shared, thread_stop));
        self.handle = Some(PcHarnessHandle {
            stop,
            join: Some(join),
        });
        self.active_token = Some(active_token);
        Ok(self.status(&db))
    }

    pub fn stop(&mut self, db: &LocalDb) -> Result<PcHarnessStatus, String> {
        self.running.store(false, Ordering::SeqCst);
        if let Some(mut handle) = self.handle.take() {
            handle.stop.store(true, Ordering::SeqCst);
            // 唤醒阻塞 accept：向本地端口发起一次连接。
            let _ = TcpStream::connect_timeout(
                &SocketAddr::from(([127, 0, 0, 1], self.port)),
                Duration::from_millis(200),
            );
            if let Some(join) = handle.join.take() {
                let _ = join.join();
            }
        }
        if let Ok(mut slot) = self.bind_address.lock() {
            *slot = None;
        }
        self.active_token = None;
        self.memory_commands.disconnect();
        Ok(self.status(db))
    }

    pub fn memory_command_broker(&self) -> Arc<MobileMemoryCommandBroker> {
        self.memory_commands.clone()
    }
}

impl MobileMemoryCommandBroker {
    pub fn connected_for(&self, account_id: i64) -> bool {
        self.state.lock().is_ok_and(|state| {
            state.last_account_id == Some(account_id)
                && state
                    .last_seen
                    .is_some_and(|last_seen| last_seen.elapsed() <= MOBILE_PRESENCE_TTL)
        })
    }

    fn disconnect(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.last_seen = None;
            state.last_account_id = None;
            if let Some(pending) = state.pending.as_mut() {
                pending.result = Some(MobileMemoryCommandResult {
                    success: false,
                    cache_synced: false,
                    message: Some("PC Harness 已停止".to_string()),
                });
            }
            self.changed.notify_all();
        }
    }

    fn poll(&self, account_id: i64) -> Option<MobileMemoryCommandEnvelope> {
        let mut state = self.state.lock().ok()?;
        state.last_seen = Some(Instant::now());
        state.last_account_id = Some(account_id);
        let pending = state.pending.as_mut()?;
        if pending.delivered || pending.envelope.account_id != account_id {
            return None;
        }
        pending.delivered = true;
        Some(pending.envelope.clone())
    }

    fn complete(
        &self,
        command_id: &str,
        request: MobileMemoryCommandResultRequest,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "手機命令狀態鎖不可用".to_string())?;
        state.last_seen = Some(Instant::now());
        state.last_account_id = Some(request.account_id);
        let Some(pending) = state.pending.as_mut() else {
            return Err("此手機記憶命令已過期".to_string());
        };
        if pending.envelope.id != command_id || pending.envelope.account_id != request.account_id {
            return Err("手機記憶命令或帳號不匹配".to_string());
        }
        pending.result = Some(MobileMemoryCommandResult {
            success: request.success,
            cache_synced: request.cache_synced,
            message: request.message,
        });
        self.changed.notify_all();
        Ok(())
    }

    pub fn execute(
        &self,
        account_id: i64,
        operation: String,
        payload: Value,
    ) -> Result<MobileMemoryCommandReceipt, String> {
        const ALLOWED_OPERATIONS: [&str; 9] = [
            "createEntry",
            "updateEntry",
            "setEntryEnabled",
            "deleteEntry",
            "createPrompt",
            "updatePrompt",
            "setPromptEnabled",
            "deletePrompt",
            "seedExamples",
        ];
        if !ALLOWED_OPERATIONS.contains(&operation.as_str()) {
            return Err("不支持的手机记忆操作".to_string());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "手机命令状态锁不可用".to_string())?;
        if state.last_account_id != Some(account_id)
            || !state
                .last_seen
                .is_some_and(|last_seen| last_seen.elapsed() <= MOBILE_PRESENCE_TTL)
        {
            return Err("手机未连接。请在手机前台打开记忆页并保持 Harness 连接".to_string());
        }
        if state.pending.is_some() {
            return Err("另一条手机记忆操作正在等待手机确认，请稍后再试".to_string());
        }
        let command_id = generate_token();
        state.pending = Some(PendingMobileMemoryCommand {
            envelope: MobileMemoryCommandEnvelope {
                id: command_id.clone(),
                account_id,
                operation,
                payload,
            },
            delivered: false,
            result: None,
        });
        self.changed.notify_all();

        let started = Instant::now();
        loop {
            if let Some(result) = state
                .pending
                .as_mut()
                .and_then(|pending| pending.result.take())
            {
                state.pending = None;
                if !result.success {
                    return Err(result
                        .message
                        .unwrap_or_else(|| "手机拒绝了该操作".to_string()));
                }
                return Ok(MobileMemoryCommandReceipt {
                    cache_synced: result.cache_synced,
                    message: result.message,
                });
            }
            let remaining = MOBILE_COMMAND_TIMEOUT.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                state.pending = None;
                return Err("等待手机确认超时。请检查手机是否仍在前台连接".to_string());
            }
            let (next_state, timeout) = self
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| "手机命令状态锁不可用".to_string())?;
            state = next_state;
            if timeout.timed_out()
                && state.pending.as_ref().is_some_and(|pending| {
                    pending.envelope.id == command_id && pending.result.is_none()
                })
            {
                state.pending = None;
                return Err("等待手机确认超时。请检查手机是否仍在前台连接".to_string());
            }
        }
    }
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("系统安全随机数生成器不可用");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn lan_ipv4_addresses() -> Vec<String> {
    let mut out = Vec::new();
    for interface in ["en0", "en1", "eth0", "wlan0"] {
        if let Ok(output) = std::process::Command::new("ipconfig")
            .arg("getifaddr")
            .arg(interface)
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !text.is_empty() && !out.contains(&text) {
                    out.push(text);
                }
            }
        }
    }
    out
}

fn accept_loop(listener: TcpListener, shared: HarnessShared, stop: Arc<AtomicBool>) {
    for stream in listener.incoming() {
        if stop.load(Ordering::SeqCst) || !shared.running.load(Ordering::SeqCst) {
            break;
        }
        match stream {
            Ok(stream) => {
                let shared = shared.clone();
                let stop = stop.clone();
                thread::spawn(move || {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let _ = handle_connection(stream, shared);
                });
            }
            Err(_) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn handle_connection(mut stream: TcpStream, shared: HarnessShared) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut buffer = Vec::with_capacity(8 * 1024);
    let mut chunk = [0u8; 8 * 1024];
    let header_end = loop {
        if buffer.len() > 64 * 1024 {
            return write_json(&mut stream, 431, &json!({ "message": "请求头过大" }));
        }
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
    };

    let header_bytes = &buffer[..header_end];
    let header_text = String::from_utf8_lossy(header_bytes);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut content_length = 0usize;
    let mut authorization: Option<String> = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            if name == "content-length" {
                content_length = value.parse().unwrap_or(0);
            } else if name == "authorization" {
                authorization = Some(value.to_string());
            }
        }
    }
    if content_length > MAX_BODY_BYTES {
        return write_json(&mut stream, 413, &json!({ "message": "请求体过大" }));
    }
    let body_start = header_end + 4;
    let mut body = buffer[body_start.min(buffer.len())..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
        if body.len() > MAX_BODY_BYTES {
            return write_json(&mut stream, 413, &json!({ "message": "请求体过大" }));
        }
    }
    body.truncate(content_length);

    let token = shared
        .token
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let authorized = authorization
        .as_deref()
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|present| present.trim() == token)
        .unwrap_or(false);
    if !authorized {
        return write_json(
            &mut stream,
            401,
            &json!({ "message": "配对令牌无效或未提供" }),
        );
    }

    let response = route(&shared, &method, &path, &body);
    write_json(&mut stream, response.0, &response.1)
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn route(shared: &HarnessShared, method: &str, path: &str, body: &[u8]) -> (u16, Value) {
    let path = path.split('?').next().unwrap_or(path);
    match (method, path) {
        ("GET", "/api/mobile/v1/health") => {
            let account_id = shared
                .db
                .current_active_account()
                .ok()
                .map(|account| account.id);
            (
                200,
                json!({
                    "ok": true,
                    "service": "pc-harness",
                    "protocolVersion": PROTOCOL_VERSION,
                    "accountId": account_id,
                }),
            )
        }
        ("POST", "/api/mobile/v1/companion/tasks") => create_task(shared, body),
        ("GET", path) if path.starts_with("/api/mobile/v1/companion/tasks/") => {
            let rest = path.trim_start_matches("/api/mobile/v1/companion/tasks/");
            if let Some(task_id) = rest.strip_suffix("/draft") {
                get_draft(shared, task_id)
            } else {
                get_task(shared, rest)
            }
        }
        ("POST", path)
            if path.starts_with("/api/mobile/v1/companion/tasks/")
                && path.ends_with("/publish-receipt") =>
        {
            let task_id = path
                .trim_start_matches("/api/mobile/v1/companion/tasks/")
                .trim_end_matches("/publish-receipt");
            publish_receipt(shared, task_id, body)
        }
        ("POST", "/api/mobile/v1/memory/reconcile") => reconcile_mobile_memory(shared, body),
        ("POST", "/api/mobile/v1/memory/commands/next") => next_mobile_memory_command(shared, body),
        ("POST", path)
            if path.starts_with("/api/mobile/v1/memory/commands/") && path.ends_with("/result") =>
        {
            let id = path
                .trim_start_matches("/api/mobile/v1/memory/commands/")
                .trim_end_matches("/result");
            complete_mobile_memory_command(shared, id, body)
        }
        ("POST", "/api/mobile/v1/memory/entries") => create_mobile_memory_entry(shared, body),
        ("PUT", path) if path.starts_with("/api/mobile/v1/memory/entries/") => {
            let id = path.trim_start_matches("/api/mobile/v1/memory/entries/");
            update_mobile_memory_entry(shared, id, body)
        }
        ("POST", "/api/mobile/v1/memory/prompts") => create_mobile_prompt(shared, body),
        ("PUT", path) if path.starts_with("/api/mobile/v1/memory/prompts/") => {
            let id = path.trim_start_matches("/api/mobile/v1/memory/prompts/");
            update_mobile_prompt(shared, id, body)
        }
        ("DELETE", path) if path.starts_with("/api/mobile/v1/memory/entries/") => {
            let id = path.trim_start_matches("/api/mobile/v1/memory/entries/");
            delete_mobile_memory_entry(shared, id)
        }
        ("DELETE", path) if path.starts_with("/api/mobile/v1/memory/prompts/") => {
            let id = path.trim_start_matches("/api/mobile/v1/memory/prompts/");
            delete_mobile_prompt(shared, id)
        }
        _ => (404, json!({ "message": "接口不存在" })),
    }
}

fn next_mobile_memory_command(shared: &HarnessShared, body: &[u8]) -> (u16, Value) {
    let request: MobileMemoryCommandPollRequest = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": format!("请求体无效: {error}") })),
    };
    let active_account_id = match shared.db.current_active_account() {
        Ok(account) => account.id,
        Err(error) => return (400, json!({ "message": error })),
    };
    if request.account_id != active_account_id {
        return (
            403,
            json!({ "message": "手机配对账号与 PC 当前账号不一致" }),
        );
    }
    let command = shared.memory_commands.poll(request.account_id);
    (200, json!({ "command": command }))
}

fn complete_mobile_memory_command(
    shared: &HarnessShared,
    command_id: &str,
    body: &[u8],
) -> (u16, Value) {
    let request: MobileMemoryCommandResultRequest = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": format!("请求体无效: {error}") })),
    };
    let active_account_id = match shared.db.current_active_account() {
        Ok(account) => account.id,
        Err(error) => return (400, json!({ "message": error })),
    };
    if request.account_id != active_account_id {
        return (
            403,
            json!({ "message": "手机配对账号与 PC 当前账号不一致" }),
        );
    }
    match shared.memory_commands.complete(command_id, request) {
        Ok(()) => (200, json!({ "accepted": true })),
        Err(error) => (404, json!({ "message": error })),
    }
}

fn create_task(shared: &HarnessShared, body: &[u8]) -> (u16, Value) {
    let request: CreateTaskRequest = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": format!("请求体无效: {error}") })),
    };
    let topic = request
        .topic
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let photos = request.photos.unwrap_or_default();
    if topic.is_none() && photos.is_empty() {
        return (400, json!({ "message": "至少提供一张照片或一段主题文字" }));
    }
    if photos.len() > MAX_PHOTOS {
        return (400, json!({ "message": "单次最多上传 9 张照片" }));
    }

    let account_id = match resolve_account(shared, request.account_id) {
        Ok(value) => value,
        Err(message) => return (400, json!({ "message": message })),
    };

    if let Some(client_task_id) = request
        .client_task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        match shared
            .db
            .find_companion_task_by_client_id(account_id, client_task_id)
        {
            Ok(Some(existing)) => return (200, task_json(&existing)),
            Ok(None) => {}
            Err(error) => return (500, json!({ "message": error })),
        }
    }

    let task_id = format!("cmp-{}-{}", account_id, &generate_token()[..12]);
    let created = match shared.db.create_companion_task(
        &task_id,
        request
            .client_task_id
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty()),
        account_id,
        topic.as_deref(),
    ) {
        Ok(value) => value,
        Err(error) => return (500, json!({ "message": error })),
    };
    let _ = shared.db.update_companion_task_progress(
        &created.task_id,
        "processing",
        &[],
        None,
        None,
        None,
        &[],
        None,
        None,
    );

    match process_task(
        shared,
        &created.task_id,
        account_id,
        topic.as_deref(),
        &photos,
    ) {
        Ok(summary) => (200, task_json(&summary)),
        Err(error) => match shared.db.update_companion_task_progress(
            &created.task_id,
            "failed",
            &[],
            None,
            None,
            None,
            &[],
            None,
            Some(&error),
        ) {
            Ok(summary) => (200, task_json(&summary)),
            Err(update_error) => (
                500,
                json!({ "message": format!("{error}；且无法写入失败状态: {update_error}") }),
            ),
        },
    }
}

fn resolve_account(shared: &HarnessShared, requested: Option<i64>) -> Result<i64, String> {
    let active = shared
        .db
        .current_active_account()
        .map_err(|error| format!("读取当前运营账号失败: {error}"))?;
    match requested {
        Some(id) if id == active.id => Ok(active.id),
        Some(id) => Err(format!(
            "任务账号 {id} 与当前 PC 运营账号 {} 不一致；请在桌面切换到该账号后重试",
            active.id
        )),
        None => Ok(active.id),
    }
}

fn process_task(
    shared: &HarnessShared,
    task_id: &str,
    account_id: i64,
    topic: Option<&str>,
    photos: &[PhotoPayload],
) -> Result<CompanionTaskSummary, String> {
    let mut item_ids = Vec::new();
    for (index, photo) in photos.iter().enumerate() {
        let raw = photo.data_base64.trim();
        let raw = raw
            .strip_prefix("data:")
            .and_then(|value| value.find(',').map(|i| &value[i + 1..]))
            .unwrap_or(raw);
        if raw.len() > MAX_PHOTO_BYTES * 4 / 3 {
            return Err(format!("第 {} 张照片过大", index + 1));
        }
        let bytes = BASE64
            .decode(raw)
            .map_err(|error| format!("第 {} 张照片不是有效 base64: {error}", index + 1))?;
        if bytes.len() > MAX_PHOTO_BYTES {
            return Err(format!("第 {} 张照片超过 12MB", index + 1));
        }
        let filename = photo
            .filename
            .clone()
            .unwrap_or_else(|| format!("photo-{}.jpg", index + 1));
        let extension = filename
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !ALLOWED_EXT.contains(&extension.as_str()) {
            return Err(format!("第 {} 张照片格式仅支持 jpg/jpeg/png", index + 1));
        }
        let item = shared
            .db
            .import_local_image_for_account(
                account_id,
                LocalImageImport {
                    account_pool_id: account_id,
                    file_name: filename,
                    mime_type: photo.mime_type.clone(),
                    data_base64: raw.to_string(),
                    thumbnail_data_base64: None,
                },
            )
            .map_err(|error| format!("导入第 {} 张照片失败: {error}", index + 1))?;
        if !item_ids.contains(&item.id) {
            item_ids.push(item.id);
        }
    }

    let title = topic
        .map(|value| {
            let mut chars = value.chars();
            chars.by_ref().take(40).collect::<String>()
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "手机 Companion 草稿".to_string());
    let body_text = topic
        .map(|value| format!("{value}\n\n（由手机 Companion 创建，可在 PC 端继续编辑）"))
        .unwrap_or_else(|| "（由手机 Companion 创建，请在 PC 端补充正文）".to_string());

    let note = if item_ids.is_empty() {
        shared
            .db
            .create_local_draft_for_account_id(&title, account_id)
            .map_err(|error| format!("创建主题草稿失败: {error}"))?
    } else {
        shared
            .db
            .create_local_draft_from_items_for_account(&item_ids, account_id)
            .map_err(|error| format!("创建素材草稿失败: {error}"))?
    };
    let note = shared
        .db
        .update_local_note_for_account(
            account_id, note.id, &title, &body_text, &note.tags, &item_ids,
        )
        .map_err(|error| format!("写入草稿内容失败: {error}"))?;

    shared.db.update_companion_task_progress(
        task_id,
        "ready",
        &item_ids,
        Some(note.id),
        note.title.as_deref(),
        note.body.as_deref(),
        &note.tags,
        Some(note.content_version),
        None,
    )
}

fn get_task(shared: &HarnessShared, task_id: &str) -> (u16, Value) {
    match shared.db.companion_task_by_id(task_id) {
        Ok(summary) => (200, task_json(&summary)),
        Err(error) => (404, json!({ "message": error })),
    }
}

fn get_draft(shared: &HarnessShared, task_id: &str) -> (u16, Value) {
    let summary = match shared.db.companion_task_by_id(task_id) {
        Ok(value) => value,
        Err(error) => return (404, json!({ "message": error })),
    };
    if summary.note_id.is_none() {
        return (409, json!({ "message": "任务尚未生成稿件" }));
    }
    (
        200,
        json!({
            "taskId": summary.task_id,
            "noteId": summary.note_id,
            "title": summary.title.unwrap_or_default(),
            "body": summary.body.unwrap_or_default(),
            "tags": summary.tags,
            "itemIds": summary.item_ids,
            "version": summary.content_version,
            "source": "pc-harness",
        }),
    )
}

fn publish_receipt(shared: &HarnessShared, task_id: &str, body: &[u8]) -> (u16, Value) {
    let request: PublishReceiptRequest = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": format!("请求体无效: {error}") })),
    };
    match shared.db.record_companion_publish_receipt(
        task_id,
        request.status.as_str(),
        request.note_url.as_deref(),
        request.message.as_deref(),
    ) {
        Ok(summary) => (200, task_json(&summary)),
        Err(error) => (400, json!({ "message": error })),
    }
}

fn task_json(summary: &CompanionTaskSummary) -> Value {
    json!({
        "taskId": summary.task_id,
        "status": summary.status,
        "accountId": summary.account_pool_id,
        "createdAt": summary.created_at,
        "updatedAt": summary.updated_at,
        "error": summary.error,
        "clientTaskId": summary.client_task_id,
        "topic": summary.topic,
        "noteId": summary.note_id,
        "itemIds": summary.item_ids,
        "publishStatus": summary.publish_status,
        "publishNoteUrl": summary.publish_note_url,
        "publishMessage": summary.publish_message,
    })
}

// ── 手机记忆池（origin=mobile）有限端点 ──────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileMemoryEntryBody {
    kind: String,
    content: String,
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    source_type: Option<String>,
    #[serde(default)]
    occurred_at: Option<String>,
    #[serde(default)]
    confirm_status: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobilePromptBody {
    title: String,
    content: String,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    apply_scope: Option<String>,
    #[serde(default)]
    apply_target: Option<String>,
    #[serde(default)]
    sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileMemorySnapshotBody {
    #[serde(default)]
    entry_ids: Vec<i64>,
    #[serde(default)]
    prompt_ids: Vec<i64>,
}

/// Reconcile a full phone snapshot without sending any cached PC data back to the phone.
fn reconcile_mobile_memory(shared: &HarnessShared, body: &[u8]) -> (u16, Value) {
    let request: MobileMemorySnapshotBody = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": format!("请求体无效: {error}") })),
    };
    let account_id = match shared.db.current_active_account() {
        Ok(account) => account.id,
        Err(error) => return (400, json!({ "message": error })),
    };
    let keep_entry_ids: HashSet<i64> = request.entry_ids.into_iter().collect();
    let keep_prompt_ids: HashSet<i64> = request.prompt_ids.into_iter().collect();

    let entries = match shared.db.list_memory_entries(MemoryEntryFilter {
        account_pool_id: Some(account_id),
        origin: Some("mobile".to_string()),
        kind: None,
        confirm_status: None,
        enabled: None,
    }) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": error })),
    };
    let mut deleted_entries = 0;
    for entry in entries {
        if keep_entry_ids.contains(&entry.id) {
            continue;
        }
        if let Err(error) = shared.db.delete_mobile_memory_cache_entry(entry.id) {
            return (400, json!({ "message": error }));
        }
        deleted_entries += 1;
    }

    let prompts = match shared
        .db
        .list_experience_prompts(Some(account_id), Some("mobile".to_string()))
    {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": error })),
    };
    let mut deleted_prompts = 0;
    for prompt in prompts {
        if keep_prompt_ids.contains(&prompt.id) {
            continue;
        }
        if let Err(error) =
            shared
                .db
                .delete_experience_prompt(prompt.id, account_id, "mobile".to_string())
        {
            return (400, json!({ "message": error }));
        }
        deleted_prompts += 1;
    }

    (
        200,
        json!({
            "deletedEntries": deleted_entries,
            "deletedPrompts": deleted_prompts,
        }),
    )
}

fn create_mobile_memory_entry(shared: &HarnessShared, body: &[u8]) -> (u16, Value) {
    let request: MobileMemoryEntryBody = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": format!("请求体无效: {error}") })),
    };
    let account_id = match shared.db.current_active_account() {
        Ok(account) => account.id,
        Err(error) => return (400, json!({ "message": error })),
    };
    let requested_status = match request.confirm_status.as_deref().unwrap_or("candidate") {
        "candidate" => "candidate",
        "confirmed" => "confirmed",
        "rejected" => "candidate",
        // 缓存允许重建最终态；经合法状态机补齐确认步骤。
        "outdated" => "confirmed",
        _ => return (400, json!({ "message": "确认状态无效" })),
    };
    let entry = match shared.db.create_memory_entry(MemoryEntryCreate {
        account_pool_id: account_id,
        origin: "mobile".to_string(),
        kind: request.kind,
        content: request.content,
        subject: request.subject,
        scope: Some("account".to_string()),
        source: request.source,
        source_type: request.source_type,
        occurred_at: request.occurred_at,
        confirm_status: Some(requested_status.to_string()),
        enabled: request.enabled,
    }) {
        Ok(entry) => entry,
        Err(error) => return (400, json!({ "message": error })),
    };
    if let Some(final_status) = request.confirm_status.as_deref() {
        let transitions: &[&str] = match final_status {
            "rejected" => &["rejected"],
            "outdated" => &["outdated"],
            _ => &[],
        };
        for next_status in transitions {
            if let Err(error) = shared
                .db
                .transition_memory_entry_status(MemoryEntryTransition {
                    id: entry.id,
                    account_pool_id: account_id,
                    next_status: (*next_status).to_string(),
                    replaced_by: None,
                })
            {
                return (400, json!({ "message": error }));
            }
        }
    }
    (200, json!({ "id": entry.id }))
}

fn update_mobile_memory_entry(shared: &HarnessShared, id: &str, body: &[u8]) -> (u16, Value) {
    let id: i64 = match id.parse() {
        Ok(value) => value,
        Err(_) => return (400, json!({ "message": "条目 id 无效" })),
    };
    let request: MobileMemoryEntryBody = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": format!("请求体无效: {error}") })),
    };
    let account_id = match shared.db.current_active_account() {
        Ok(account) => account.id,
        Err(error) => return (400, json!({ "message": error })),
    };
    let entry = match shared.db.update_memory_entry(MemoryEntryUpdate {
        id,
        account_pool_id: account_id,
        kind: request.kind,
        content: request.content,
        subject: request.subject,
        scope: Some("account".to_string()),
        source: request.source,
        source_type: request.source_type,
        occurred_at: request.occurred_at,
    }) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": error })),
    };
    if let Some(next) = request.confirm_status.as_deref() {
        let next = match next {
            "confirmed" => "confirmed",
            "rejected" => "rejected",
            "outdated" => "outdated",
            "candidate" => "candidate",
            _ => return (400, json!({ "message": "确认状态无效" })),
        };
        if next != entry.confirm_status && next != "candidate" {
            if next == "outdated" && entry.confirm_status == "candidate" {
                if let Err(error) =
                    shared
                        .db
                        .transition_memory_entry_status(MemoryEntryTransition {
                            id,
                            account_pool_id: account_id,
                            next_status: "confirmed".to_string(),
                            replaced_by: None,
                        })
                {
                    return (400, json!({ "message": error }));
                }
            }
            if let Err(error) = shared
                .db
                .transition_memory_entry_status(MemoryEntryTransition {
                    id,
                    account_pool_id: account_id,
                    next_status: next.to_string(),
                    replaced_by: None,
                })
            {
                return (400, json!({ "message": error }));
            }
        }
    }
    if let Some(enabled) = request.enabled {
        if let Err(error) = shared.db.set_memory_entry_enabled(id, account_id, enabled) {
            return (400, json!({ "message": error }));
        }
    }
    (200, json!({ "id": id }))
}

fn create_mobile_prompt(shared: &HarnessShared, body: &[u8]) -> (u16, Value) {
    let request: MobilePromptBody = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": format!("请求体无效: {error}") })),
    };
    let account_id = match shared.db.current_active_account() {
        Ok(account) => account.id,
        Err(error) => return (400, json!({ "message": error })),
    };
    match shared
        .db
        .upsert_experience_prompt_with_id(ExperiencePromptUpsert {
            account_pool_id: account_id,
            origin: "mobile".to_string(),
            id: None,
            title: request.title,
            content: request.content,
            enabled: request.enabled.unwrap_or(true),
            apply_scope: request.apply_scope,
            apply_target: request.apply_target,
            source: Some("user".to_string()),
            sort_order: request.sort_order,
        }) {
        Ok((id, _)) => (200, json!({ "id": id })),
        Err(error) => (400, json!({ "message": error })),
    }
}

fn update_mobile_prompt(shared: &HarnessShared, id: &str, body: &[u8]) -> (u16, Value) {
    let id: i64 = match id.parse() {
        Ok(value) => value,
        Err(_) => return (400, json!({ "message": "条目 id 无效" })),
    };
    let request: MobilePromptBody = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": format!("请求体无效: {error}") })),
    };
    let account_id = match shared.db.current_active_account() {
        Ok(account) => account.id,
        Err(error) => return (400, json!({ "message": error })),
    };
    match shared.db.upsert_experience_prompt(ExperiencePromptUpsert {
        account_pool_id: account_id,
        origin: "mobile".to_string(),
        id: Some(id),
        title: request.title,
        content: request.content,
        enabled: request.enabled.unwrap_or(true),
        apply_scope: request.apply_scope,
        apply_target: request.apply_target,
        source: Some("user".to_string()),
        sort_order: request.sort_order,
    }) {
        Ok(_) => (200, json!({ "id": id })),
        Err(error) => (400, json!({ "message": error })),
    }
}

fn delete_mobile_memory_entry(shared: &HarnessShared, id: &str) -> (u16, Value) {
    let id: i64 = match id.parse() {
        Ok(value) => value,
        Err(_) => return (400, json!({ "message": "条目 id 无效" })),
    };
    match shared.db.delete_mobile_memory_cache_entry(id) {
        Ok(()) => (200, json!({ "deleted": true })),
        Err(error) => (400, json!({ "message": error })),
    }
}

fn delete_mobile_prompt(shared: &HarnessShared, id: &str) -> (u16, Value) {
    let id: i64 = match id.parse() {
        Ok(value) => value,
        Err(_) => return (400, json!({ "message": "条目 id 无效" })),
    };
    let account_id = match shared.db.current_active_account() {
        Ok(account) => account.id,
        Err(error) => return (400, json!({ "message": error })),
    };
    let prompts = match shared
        .db
        .list_experience_prompts(Some(account_id), Some("mobile".to_string()))
    {
        Ok(value) => value,
        Err(error) => return (400, json!({ "message": error })),
    };
    if prompts.iter().any(|prompt| prompt.id == id) {
        match shared
            .db
            .delete_experience_prompt(id, account_id, "mobile".to_string())
        {
            Ok(_) => (200, json!({ "deleted": true })),
            Err(error) => (400, json!({ "message": error })),
        }
    } else {
        // 目标可能已经清理；删除端点按缓存语义幂等。
        (200, json!({ "deleted": true }))
    }
}

fn write_json(stream: &mut TcpStream, status: u16, value: &Value) -> std::io::Result<()> {
    let body = value.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_end_is_detected() {
        let raw = b"GET / HTTP/1.1\r\nHost: x\r\n\r\n";
        assert_eq!(find_header_end(raw), Some(raw.len() - 4));
    }

    #[test]
    fn token_is_long_enough() {
        assert!(generate_token().len() >= 32);
    }
}
