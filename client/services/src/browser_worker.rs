//! Process supervisor shared by Tauri and the Rust HTTP adapter.
//!
//! The worker is a separate app-owned profile store. This module never reads
//! account_pool.user_data_dir, MediaCrawler data, or the user's Chrome profile.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: u64 = 1;
const MAX_WORKER_REQUEST_BYTES: usize = 64 * 1024;
// The largest legal search envelope is 717,223 UTF-8 bytes including its line
// terminator: 50 rows at every field limit, with JSON-escaped control chars
// and a 128-code-unit request ID. Profile results are capped at 60 KiB, while
// errors and other response variants are smaller. Keep this separate from the
// 64 KiB request limit and leave bounded headroom for response evolution.
const MAX_WORKER_RESPONSE_BYTES: usize = 768 * 1024;
const WORKER_START_TIMEOUT: Duration = Duration::from_secs(7);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(65);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);
const POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Clone)]
pub struct BrowserWorkerManager {
    inner: Arc<ManagerInner>,
}

struct ManagerInner {
    node: WorkerCommand,
    worker_dir: PathBuf,
    worker_script: PathBuf,
    data_root: PathBuf,
    sender: Mutex<Option<Sender<ActorCommand>>>,
    shutting_down: AtomicBool,
    next_id: AtomicU64,
}

#[derive(Clone)]
pub enum WorkerCommand {
    SearchPath(String),
    ExactPath(PathBuf),
}

pub struct BrowserWorkerConfig {
    pub node: WorkerCommand,
    pub worker_dir: PathBuf,
    pub data_root: PathBuf,
}

enum ActorCommand {
    Request {
        request: Value,
        timeout: Duration,
        reply: SyncSender<Result<Value, String>>,
    },
    Shutdown {
        reply: SyncSender<()>,
    },
}

struct PendingRequest {
    reply: Option<SyncSender<Result<Value, String>>>,
    shutdown_reply: Option<SyncSender<()>>,
    deadline: Instant,
    action: String,
    account_id: Option<i64>,
}

enum ReaderEvent {
    Line(String),
    Error(String),
    Eof,
}

impl BrowserWorkerManager {
    pub fn new(config: BrowserWorkerConfig) -> Result<Self, String> {
        let worker_script = config.worker_dir.join("worker.mjs");
        Ok(Self {
            inner: Arc::new(ManagerInner {
                node: config.node,
                worker_dir: config.worker_dir,
                worker_script,
                data_root: config.data_root,
                sender: Mutex::new(None),
                shutting_down: AtomicBool::new(false),
                next_id: AtomicU64::new(1),
            }),
        })
    }

    pub fn for_runtime(database_path: &Path) -> Result<Self, String> {
        let worker_dir = std::env::var_os("AICHIHONGSHU_BROWSER_WORKER_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::current_exe()
                    .ok()
                    .and_then(|path| path.parent().map(|parent| parent.join("browser-worker")))
                    .filter(|path| path.join("worker.mjs").is_file())
            })
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../browser-worker"));
        let node = std::env::var_os("AICHIHONGSHU_NODE")
            .map(PathBuf::from)
            .map(WorkerCommand::ExactPath)
            .unwrap_or_else(|| {
                #[cfg(windows)]
                let bundled_node = worker_dir.join("runtime").join("node.exe");
                #[cfg(not(windows))]
                let bundled_node = worker_dir.join("runtime").join("node");
                if bundled_node.is_file() {
                    WorkerCommand::ExactPath(bundled_node)
                } else {
                    WorkerCommand::SearchPath("node".into())
                }
            });
        let data_root = database_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("browser-worker")
            .join("sessions");
        Self::new(BrowserWorkerConfig {
            node,
            worker_dir,
            data_root,
        })
    }

    pub fn status(&self, account_id: i64) -> Result<Value, String> {
        self.request("status", account_id, None, None)
    }

    pub fn open_session(&self, account_id: i64) -> Result<Value, String> {
        self.request("open-session", account_id, None, None)
    }

    pub fn open_url(&self, account_id: i64, url: String) -> Result<Value, String> {
        self.request("open-url", account_id, Some(url), None)
    }

    pub fn collect_profile(&self, account_id: i64, url: String) -> Result<Value, String> {
        self.open_session(account_id)?;
        self.request("collect-profile", account_id, Some(url), None)
    }

    pub fn search_notes(
        &self,
        account_id: i64,
        keyword: &str,
        count: usize,
    ) -> Result<Value, String> {
        let keyword = keyword.trim();
        if keyword.is_empty() || keyword.chars().count() > 80 || count == 0 || count > 50 {
            return Err("搜索关键词长度或搜索数量无效（数量限制为 1 到 50）".into());
        }
        let encoded_keyword = keyword
            .as_bytes()
            .iter()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
                    (*byte as char).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect::<String>();
        let url = format!(
            "https://www.xiaohongshu.com/search_result?keyword={encoded_keyword}&max_count={count}"
        );
        self.open_session(account_id)?;
        self.request("search-notes", account_id, Some(url), None)
    }

    pub fn collect_profile_with_request_id(
        &self,
        account_id: i64,
        url: String,
        request_id: String,
    ) -> Result<Value, String> {
        self.collect_profile_with_request_id_cancellable(
            account_id,
            url,
            request_id,
            &AtomicBool::new(false),
        )
    }

    pub fn collect_profile_with_request_id_cancellable(
        &self,
        account_id: i64,
        url: String,
        request_id: String,
        cancelled: &AtomicBool,
    ) -> Result<Value, String> {
        if request_id.trim().is_empty() || request_id.len() > 128 {
            return Err("worker requestId 无效".into());
        }
        if cancelled.load(Ordering::Acquire) {
            return Err("浏览器主页采集已取消".into());
        }
        self.open_session(account_id)?;
        if cancelled.load(Ordering::Acquire) {
            return Err("浏览器主页采集已取消".into());
        }
        self.request_with_id_guarded(
            "collect-profile",
            account_id,
            Some(url),
            None,
            request_id,
            Some(cancelled),
        )
    }

    pub fn close_session(&self, account_id: i64) -> Result<Value, String> {
        self.request("close-session", account_id, None, None)
    }

    pub fn clear_session(&self, account_id: i64) -> Result<Value, String> {
        self.request("clear-session", account_id, None, None)
    }

    pub fn cancel_task(&self, account_id: i64, target_request_id: String) -> Result<Value, String> {
        self.request("cancel", account_id, None, Some(target_request_id))
    }

    fn request(
        &self,
        action: &str,
        account_id: i64,
        url: Option<String>,
        target_request_id: Option<String>,
    ) -> Result<Value, String> {
        if account_id < 1 {
            return Err("账号 ID 必须是正整数".into());
        }
        let request_id = format!(
            "browser-worker-{}-{}",
            std::process::id(),
            self.inner.next_id.fetch_add(1, Ordering::Relaxed)
        );
        self.request_with_id(action, account_id, url, target_request_id, request_id)
    }

    fn request_with_id(
        &self,
        action: &str,
        account_id: i64,
        url: Option<String>,
        target_request_id: Option<String>,
        request_id: String,
    ) -> Result<Value, String> {
        self.request_with_id_guarded(action, account_id, url, target_request_id, request_id, None)
    }

    fn request_with_id_guarded(
        &self,
        action: &str,
        account_id: i64,
        url: Option<String>,
        target_request_id: Option<String>,
        request_id: String,
        cancelled: Option<&AtomicBool>,
    ) -> Result<Value, String> {
        if account_id < 1 {
            return Err("账号 ID 必须是正整数".into());
        }
        let mut request = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "action": action,
            "accountId": account_id,
        });
        if let Some(url) = url {
            request["url"] = Value::String(url);
        }
        if let Some(target_request_id) = target_request_id {
            request["targetRequestId"] = Value::String(target_request_id);
        }
        let timeout = if action == "cancel" {
            Duration::from_secs(5)
        } else {
            REQUEST_TIMEOUT
        };
        for attempt in 0..2 {
            if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                return Err("浏览器主页采集已取消".into());
            }
            let sender = self.ensure_actor()?;
            let (reply, response) = mpsc::sync_channel(1);
            if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                return Err("浏览器主页采集已取消".into());
            }
            if sender
                .send(ActorCommand::Request {
                    request: request.clone(),
                    timeout,
                    reply,
                })
                .is_err()
            {
                if let Ok(mut stored) = self.inner.sender.lock() {
                    *stored = None;
                }
                if attempt == 0 {
                    continue;
                }
                return Err("浏览器 worker 进程已退出，请重试".into());
            }
            return response
                .recv_timeout(timeout + Duration::from_secs(2))
                .map_err(|error| match error {
                    RecvTimeoutError::Timeout => "浏览器 worker 响应超时".to_string(),
                    RecvTimeoutError::Disconnected => "浏览器 worker 进程已退出".to_string(),
                })?;
        }
        Err("浏览器 worker 进程已退出，请重试".into())
    }

    fn ensure_actor(&self) -> Result<Sender<ActorCommand>, String> {
        if self.inner.shutting_down.load(Ordering::Acquire) {
            return Err("浏览器 worker 已随应用关闭".into());
        }
        let mut stored = self
            .inner
            .sender
            .lock()
            .map_err(|_| "浏览器 worker 状态锁不可用".to_string())?;
        if let Some(sender) = stored.as_ref() {
            return Ok(sender.clone());
        }
        let (sender, receiver) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let inner = Arc::clone(&self.inner);
        thread::Builder::new()
            .name("aichihongshu-browser-worker".into())
            .spawn(move || run_actor(inner, receiver, ready_tx))
            .map_err(|error| format!("创建浏览器 worker supervisor 失败: {error}"))?;
        match ready_rx.recv_timeout(WORKER_START_TIMEOUT) {
            Ok(Ok(())) => {
                *stored = Some(sender.clone());
                Ok(sender)
            }
            Ok(Err(error)) => Err(error),
            Err(RecvTimeoutError::Timeout) => Err("浏览器 worker 启动握手超时".into()),
            Err(RecvTimeoutError::Disconnected) => Err("浏览器 worker 启动失败".into()),
        }
    }

    pub fn shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::Release);
        let sender = self
            .inner
            .sender
            .lock()
            .ok()
            .and_then(|mut sender| sender.take());
        if let Some(sender) = sender {
            let (reply, response) = mpsc::sync_channel(1);
            if sender.send(ActorCommand::Shutdown { reply }).is_ok() {
                let _ = response.recv_timeout(SHUTDOWN_TIMEOUT);
            }
        }
    }
}

impl ManagerInner {
    fn spawn_command(&self) -> Command {
        let mut command = match &self.node {
            WorkerCommand::SearchPath(name) => Command::new(name),
            WorkerCommand::ExactPath(path) => Command::new(path),
        };
        command
            .arg(&self.worker_script)
            .current_dir(&self.worker_dir)
            .env("AICHIHONGSHU_BROWSER_DATA_DIR", &self.data_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if self.worker_dir.join(".local-browsers").is_dir() {
            command.env(
                "PLAYWRIGHT_BROWSERS_PATH",
                self.worker_dir.join(".local-browsers"),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
    }

    fn next_supervisor_id(&self) -> String {
        format!(
            "supervisor-{}-{}",
            std::process::id(),
            self.next_id.fetch_add(1, Ordering::Relaxed)
        )
    }
}

fn run_actor(
    inner: Arc<ManagerInner>,
    commands: Receiver<ActorCommand>,
    ready: SyncSender<Result<(), String>>,
) {
    let launched = launch_worker(&inner);
    let (mut child, mut stdin, worker_events) = match launched {
        Ok(value) => value,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let mut pending: HashMap<String, PendingRequest> = HashMap::new();
    let mut shutdown_requested = false;
    let mut shutdown_done: Option<SyncSender<()>> = None;

    loop {
        match commands.recv_timeout(POLL_INTERVAL) {
            Ok(ActorCommand::Request {
                request,
                timeout,
                reply,
            }) => {
                if shutdown_requested {
                    let _ = reply.send(Err("浏览器 worker 正在关闭".into()));
                    continue;
                }
                let request_id = request
                    .get("requestId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if let Err(error) = send_request(&mut stdin, &request) {
                    let _ = reply.send(Err(error));
                    terminate_worker_tree(&mut child);
                    fail_pending(&mut pending, "浏览器 worker 写入管道失败");
                    return;
                }
                pending.insert(
                    request_id,
                    PendingRequest {
                        reply: Some(reply),
                        shutdown_reply: None,
                        deadline: Instant::now() + timeout,
                        action: request
                            .get("action")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        account_id: request.get("accountId").and_then(Value::as_i64),
                    },
                );
            }
            Ok(ActorCommand::Shutdown { reply }) => {
                if shutdown_requested {
                    let _ = reply.send(());
                    continue;
                }
                shutdown_requested = true;
                let request_id = inner.next_supervisor_id();
                let request = json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "action": "shutdown",
                });
                if send_request(&mut stdin, &request).is_err() {
                    terminate_worker_tree(&mut child);
                    fail_pending(&mut pending, "浏览器 worker 关闭失败");
                    let _ = reply.send(());
                    return;
                }
                pending.insert(
                    request_id,
                    PendingRequest {
                        reply: None,
                        shutdown_reply: Some(reply),
                        deadline: Instant::now() + SHUTDOWN_TIMEOUT,
                        action: "shutdown".into(),
                        account_id: None,
                    },
                );
            }
            Err(RecvTimeoutError::Disconnected) => {
                if !shutdown_requested {
                    let request_id = inner.next_supervisor_id();
                    let request = json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": request_id,
                        "action": "shutdown",
                    });
                    if send_request(&mut stdin, &request).is_ok() {
                        shutdown_requested = true;
                        pending.insert(
                            request_id,
                            PendingRequest {
                                reply: None,
                                shutdown_reply: None,
                                deadline: Instant::now() + SHUTDOWN_TIMEOUT,
                                action: "shutdown".into(),
                                account_id: None,
                            },
                        );
                    } else {
                        terminate_worker_tree(&mut child);
                        fail_pending(&mut pending, "浏览器 worker 关闭失败");
                        return;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        loop {
            match worker_events.try_recv() {
                Ok(ReaderEvent::Line(line)) => {
                    if let Err(error) = handle_worker_line(
                        &mut pending,
                        line,
                        &mut shutdown_requested,
                        &mut shutdown_done,
                    ) {
                        eprintln!("[aichihongshu] browser worker stopped: {error}");
                        terminate_worker_tree(&mut child);
                        return;
                    }
                    if shutdown_requested && pending.values().all(|item| item.action != "shutdown")
                    {
                        graceful_worker_exit(&mut child, stdin);
                        fail_pending(&mut pending, "浏览器 worker 已关闭");
                        if let Some(reply) = shutdown_done.take() {
                            let _ = reply.send(());
                        }
                        return;
                    }
                }
                Ok(ReaderEvent::Error(error)) => {
                    fail_pending(&mut pending, &error);
                    terminate_worker_tree(&mut child);
                    return;
                }
                Ok(ReaderEvent::Eof) => {
                    fail_pending(&mut pending, "浏览器 worker 输出已关闭");
                    terminate_worker_tree(&mut child);
                    return;
                }
                Err(_) => break,
            }
        }

        if let Err(error) = expire_pending(&inner, &mut stdin, &mut pending) {
            fail_pending(&mut pending, &error);
            terminate_worker_tree(&mut child);
            return;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let message = format!("浏览器 worker 已退出 ({status})");
                fail_pending(&mut pending, &message);
                terminate_worker_tree(&mut child);
                return;
            }
            Ok(None) => {}
            Err(error) => {
                fail_pending(
                    &mut pending,
                    &format!("检查浏览器 worker 进程失败: {error}"),
                );
                terminate_worker_tree(&mut child);
                return;
            }
        }
    }
}

fn launch_worker(
    inner: &ManagerInner,
) -> Result<(Child, ChildStdin, Receiver<ReaderEvent>), String> {
    verify_node_runtime(inner)?;
    let mut child = inner
        .spawn_command()
        .spawn()
        .map_err(|error| format!("启动浏览器 worker 失败: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "浏览器 worker stdin 不可用".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "浏览器 worker stdout 不可用".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        let _ = thread::Builder::new()
            .name("browser-worker-stderr".into())
            .spawn(move || {
                let mut reader = BufReader::new(stderr);
                let _ = std::io::copy(&mut reader, &mut std::io::sink());
            });
    }
    let (event_tx, event_rx) = mpsc::channel();
    let _ = thread::Builder::new()
        .name("browser-worker-stdout".into())
        .spawn(move || read_worker_output(BufReader::new(stdout), event_tx));
    match event_rx.recv_timeout(WORKER_START_TIMEOUT) {
        Ok(ReaderEvent::Line(line)) => {
            let ready: Value = serde_json::from_str(&line)
                .map_err(|_| "浏览器 worker 握手不是有效 JSON".to_string())?;
            if ready.get("type").and_then(Value::as_str) != Some("ready")
                || ready.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
            {
                terminate_worker_tree(&mut child);
                return Err("浏览器 worker 协议握手不匹配".into());
            }
            Ok((child, stdin, event_rx))
        }
        Ok(ReaderEvent::Error(error)) => {
            terminate_worker_tree(&mut child);
            Err(format!("读取浏览器 worker 握手失败: {error}"))
        }
        Ok(ReaderEvent::Eof) => {
            terminate_worker_tree(&mut child);
            Err("浏览器 worker 在握手前退出".into())
        }
        Err(RecvTimeoutError::Timeout) => {
            terminate_worker_tree(&mut child);
            Err("浏览器 worker 启动握手超时".into())
        }
        Err(RecvTimeoutError::Disconnected) => {
            terminate_worker_tree(&mut child);
            Err("浏览器 worker 输出管道已断开".into())
        }
    }
}

fn verify_node_runtime(inner: &ManagerInner) -> Result<(), String> {
    let mut command = match &inner.node {
        WorkerCommand::SearchPath(name) => Command::new(name),
        WorkerCommand::ExactPath(path) => Command::new(path),
    };
    let output = command
        .arg("--version")
        .output()
        .map_err(|error| format!("找不到随应用交付的 Node runtime: {error}"))?;
    if !output.status.success() {
        return Err("Node runtime 版本探测失败".into());
    }
    let version = String::from_utf8_lossy(&output.stdout);
    let major = node_version_major(version.as_bytes());
    if major.is_none_or(|value| value < 22) {
        return Err(format!(
            "浏览器 worker 需要 Node.js 22 或以上版本，当前为 {}",
            version.trim()
        ));
    }
    Ok(())
}

fn node_version_major(version: &[u8]) -> Option<u32> {
    std::str::from_utf8(version)
        .ok()?
        .trim()
        .strip_prefix('v')?
        .split('.')
        .next()?
        .parse::<u32>()
        .ok()
}

fn read_worker_output<R: Read>(mut stdout: R, events: Sender<ReaderEvent>) {
    let mut line = Vec::with_capacity(1_024);
    let mut byte = [0_u8; 1];
    loop {
        match stdout.read(&mut byte) {
            Ok(0) => {
                if !line.is_empty() {
                    let _ = events.send(ReaderEvent::Error("worker 输出最后一行缺少换行符".into()));
                } else {
                    let _ = events.send(ReaderEvent::Eof);
                }
                return;
            }
            Ok(_) if byte[0] == b'\n' => {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                let value = match String::from_utf8(std::mem::take(&mut line)) {
                    Ok(value) => value,
                    Err(_) => {
                        let _ = events.send(ReaderEvent::Error("worker 输出不是 UTF-8".into()));
                        return;
                    }
                };
                if events.send(ReaderEvent::Line(value)).is_err() {
                    return;
                }
            }
            Ok(_) => {
                if line.len() >= MAX_WORKER_RESPONSE_BYTES {
                    let _ = events.send(ReaderEvent::Error("worker 输出超过 768KB 上限".into()));
                    return;
                }
                line.push(byte[0]);
            }
            Err(error) => {
                let _ = events.send(ReaderEvent::Error(format!("读取 worker 输出失败: {error}")));
                return;
            }
        }
    }
}

fn send_request(stdin: &mut ChildStdin, request: &Value) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(request).map_err(|error| format!("编码 worker 请求失败: {error}"))?;
    if bytes.len() > MAX_WORKER_REQUEST_BYTES {
        return Err("worker 请求超过 64KB 上限".into());
    }
    stdin
        .write_all(&bytes)
        .and_then(|()| stdin.write_all(b"\n"))
        .and_then(|()| stdin.flush())
        .map_err(|error| format!("发送 worker 请求失败: {error}"))
}

fn handle_worker_line(
    pending: &mut HashMap<String, PendingRequest>,
    line: String,
    shutdown_requested: &mut bool,
    shutdown_done: &mut Option<SyncSender<()>>,
) -> Result<(), String> {
    let message: Value =
        serde_json::from_str(&line).map_err(|_| "浏览器 worker 响应不是有效 JSON".to_string())?;
    if message.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
        || message.get("type").and_then(Value::as_str) != Some("response")
    {
        return Err("浏览器 worker 响应协议不匹配".into());
    }
    let request_id = message
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "浏览器 worker 响应缺少 requestId".to_string())?;
    let Some(item) = pending.remove(request_id) else {
        return Err(format!("浏览器 worker 返回未知 requestId: {request_id}"));
    };
    let result = if message.get("ok").and_then(Value::as_bool) == Some(true) {
        message
            .get("result")
            .cloned()
            .ok_or_else(|| "浏览器 worker 响应缺少 result".to_string())
    } else {
        let code = message
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("WORKER_ERROR");
        let detail = message
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("浏览器 worker 请求失败");
        Err(format!("{code}: {detail}"))
    };
    if let Some(reply) = item.reply {
        let _ = reply.send(result.clone());
    }
    if let Some(reply) = item.shutdown_reply {
        *shutdown_requested = true;
        *shutdown_done = Some(reply);
    }
    Ok(())
}

fn expire_pending(
    inner: &ManagerInner,
    stdin: &mut ChildStdin,
    pending: &mut HashMap<String, PendingRequest>,
) -> Result<(), String> {
    let now = Instant::now();
    let expired = pending
        .iter()
        .filter(|(_, item)| item.deadline <= now)
        .map(|(request_id, _)| request_id.clone())
        .collect::<Vec<_>>();
    for request_id in expired {
        let Some(item) = pending.remove(&request_id) else {
            continue;
        };
        if let Some(reply) = item.reply {
            let _ = reply.send(Err("浏览器 worker 请求超时".into()));
        }
        if item.shutdown_reply.is_some() {
            return Err("浏览器 worker 关闭超时".into());
        }
        if item.action == "open-url" {
            let cancel_id = inner.next_supervisor_id();
            let cancel = json!({
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": cancel_id,
                "action": "cancel",
                "accountId": item.account_id,
                "targetRequestId": request_id,
            });
            send_request(stdin, &cancel)?;
            pending.insert(
                cancel_id,
                PendingRequest {
                    reply: None,
                    shutdown_reply: None,
                    deadline: now + Duration::from_secs(5),
                    action: "cancel".into(),
                    account_id: item.account_id,
                },
            );
        }
    }
    Ok(())
}

fn fail_pending(pending: &mut HashMap<String, PendingRequest>, message: &str) {
    for (_, item) in pending.drain() {
        if let Some(reply) = item.reply {
            let _ = reply.send(Err(message.to_string()));
        }
        if let Some(reply) = item.shutdown_reply {
            let _ = reply.send(());
        }
    }
}

fn graceful_worker_exit(child: &mut Child, stdin: ChildStdin) {
    drop(stdin);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                terminate_worker_tree(child);
                return;
            }
        }
    }
}

fn terminate_worker_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(unix)]
    {
        let process_group = -(pid as i32);
        // SAFETY: this signals only the process group created for this worker.
        unsafe { libc::kill(process_group, libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            // SAFETY: signal 0 only probes the worker's process group.
            let alive = unsafe { libc::kill(process_group, 0) } == 0;
            if !alive {
                return;
            }
            thread::sleep(Duration::from_millis(40));
        }
        // SAFETY: terminate descendants that did not exit with their worker.
        unsafe { libc::kill(process_group, libc::SIGKILL) };
        let _ = child.wait();
    }
    #[cfg(windows)]
    {
        let pid = pid.to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = child.wait();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        handle_worker_line, node_version_major, read_worker_output, PendingRequest, ReaderEvent,
        MAX_WORKER_REQUEST_BYTES, MAX_WORKER_RESPONSE_BYTES,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn worker_output_limit_is_bounded() {
        assert_eq!(MAX_WORKER_REQUEST_BYTES, 64 * 1024);
        assert_eq!(MAX_WORKER_RESPONSE_BYTES, 768 * 1024);
    }

    #[test]
    fn requires_node_22_and_parses_only_a_semver_version_line() {
        assert_eq!(node_version_major(b"v22.22.3\n"), Some(22));
        assert_eq!(node_version_major(b"v21.7.3"), Some(21));
        assert_eq!(node_version_major(b"node 22"), None);
        assert_eq!(node_version_major(b"\xff"), None);
    }

    #[test]
    fn bounds_worker_stdout_lines_before_json_parsing() {
        let (sender, receiver) = mpsc::channel();
        read_worker_output(Cursor::new(vec![b'x'; MAX_WORKER_RESPONSE_BYTES + 1]), sender);
        assert!(
            matches!(receiver.recv().unwrap(), ReaderEvent::Error(message) if message.contains("768KB"))
        );
    }

    #[test]
    fn accepts_search_response_above_request_limit_but_below_response_limit() {
        let (sender, receiver) = mpsc::channel();
        let mut line = vec![b'x'; 100 * 1024];
        line.push(b'\n');
        read_worker_output(Cursor::new(line), sender);
        assert!(matches!(receiver.recv().unwrap(), ReaderEvent::Line(value) if value.len() == 100 * 1024));
    }

    #[test]
    fn accepts_only_matching_worker_response_ids() {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let mut pending = HashMap::from([(
            "request-1".to_string(),
            PendingRequest {
                reply: Some(reply_tx),
                shutdown_reply: None,
                deadline: Instant::now() + Duration::from_secs(1),
                action: "status".into(),
                account_id: Some(9),
            },
        )]);
        let mut shutdown_requested = false;
        let mut shutdown_done = None;
        let response = json!({
            "protocolVersion": 1,
            "type": "response",
            "requestId": "request-1",
            "ok": true,
            "result": {"status":"running","accountId":9}
        });
        let line = serde_json::to_string(&response).unwrap();
        handle_worker_line(
            &mut pending,
            line,
            &mut shutdown_requested,
            &mut shutdown_done,
        )
        .unwrap();
        assert_eq!(reply_rx.recv().unwrap().unwrap()["status"], "running");
        assert!(!shutdown_requested);
        assert!(shutdown_done.is_none());
        assert!(pending.is_empty());
    }

    #[test]
    fn rejects_unknown_worker_response_id() {
        let mut pending = HashMap::new();
        let mut shutdown_requested = false;
        let mut shutdown_done = None;
        let response = json!({
            "protocolVersion": 1,
            "type": "response",
            "requestId": "not-pending",
            "ok": true,
            "result": {}
        });

        let error = handle_worker_line(
            &mut pending,
            serde_json::to_string(&response).unwrap(),
            &mut shutdown_requested,
            &mut shutdown_done,
        )
        .unwrap_err();

        assert!(error.contains("未知 requestId"));
    }
}
