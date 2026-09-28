mod ai_settings;
mod browser_capture;
mod cli_models;
mod db;
mod model_api;
mod pc_harness;

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) struct AppState {
    pub(crate) db: Arc<db::LocalDb>,
    ai_processes: Arc<Mutex<HashMap<String, Child>>>,
    pc_harness: Mutex<pc_harness::PcHarnessRuntime>,
    model_api: model_api::ModelApiRuntime,
}

async fn run_blocking_task<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("等待后台阻塞任务失败: {error}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAIProviderStatus {
    id: String,
    label: String,
    kind: &'static str,
    state: String,
    version: Option<String>,
    text: bool,
    image: bool,
    tools: bool,
    cancel: bool,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAIEvent {
    run_id: String,
    text: Option<String>,
    error: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAIRunRequest {
    run_id: String,
    provider: String,
    prompt: String,
}

fn local_ai_specs() -> [(&'static str, &'static str); 3] {
    [
        ("claude", "Claude CLI"),
        ("codex", "Codex CLI"),
        ("opencode", "OpenCode CLI"),
    ]
}

fn extract_cli_version(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(output);
    text.split_whitespace()
        .find(|part| {
            let value = part.trim_start_matches('v');
            value.split('.').count() >= 2
                && value
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_digit())
        })
        .map(|part| {
            part.trim_start_matches('v')
                .trim_matches(|c: char| {
                    !c.is_ascii_alphanumeric() && c != '.' && c != '-' && c != '+'
                })
                .to_string()
        })
}

fn probe_local_ai_provider(id: &str, label: &str) -> LocalAIProviderStatus {
    let result = Command::new(id)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    match result {
        Ok(output) if output.status.success() => LocalAIProviderStatus {
            id: id.to_string(),
            label: label.to_string(),
            kind: "cli",
            state: "present".to_string(),
            version: extract_cli_version(&[output.stdout, output.stderr].concat()),
            // Installation is only a discovery signal. These become verified only
            // after a real prompt returns text; image/tools are never implied here.
            text: false,
            image: false,
            tools: false,
            cancel: false,
            reason: "已发现 CLI；尚未完成一次真实文本调用，能力保持未验证".to_string(),
        },
        Ok(output) => LocalAIProviderStatus {
            id: id.to_string(),
            label: label.to_string(),
            kind: "cli",
            state: "failed".to_string(),
            version: None,
            text: false,
            image: false,
            tools: false,
            cancel: false,
            reason: format!("--version 退出码 {}", output.status.code().unwrap_or(-1)),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => LocalAIProviderStatus {
            id: id.to_string(),
            label: label.to_string(),
            kind: "cli",
            state: "missing".to_string(),
            version: None,
            text: false,
            image: false,
            tools: false,
            cancel: false,
            reason: "未安装或不在当前桌面进程 PATH 中".to_string(),
        },
        Err(error) => LocalAIProviderStatus {
            id: id.to_string(),
            label: label.to_string(),
            kind: "cli",
            state: "failed".to_string(),
            version: None,
            text: false,
            image: false,
            tools: false,
            cancel: false,
            reason: format!("检测失败: {error}"),
        },
    }
}

#[tauri::command]
async fn probe_local_ai_providers() -> Result<Vec<LocalAIProviderStatus>, String> {
    run_blocking_task(|| {
        Ok(local_ai_specs()
            .into_iter()
            .map(|(id, label)| probe_local_ai_provider(id, label))
            .collect())
    })
    .await
}

fn command_for_provider(provider: &str, prompt: &str) -> Result<Command, String> {
    let mut command = match provider {
        // All three invocations are non-interactive prompt modes. No shell is used,
        // so prompt text cannot become a second command.
        "claude" => {
            let mut command = Command::new("claude");
            command.args([
                "-p",
                prompt,
                "--output-format",
                "stream-json",
                // Claude Code requires --verbose for stream-json print mode.
                // Without it the CLI exits with code 1 before emitting a
                // response, which previously surfaced as an opaque UI error.
                "--verbose",
                "--include-partial-messages",
            ]);
            command
        }
        "codex" => {
            let mut command = Command::new("codex");
            command.args([
                "exec",
                "--color",
                "never",
                "--skip-git-repo-check",
                "--json",
                prompt,
            ]);
            command
        }
        "opencode" => {
            let mut command = Command::new("opencode");
            command.args(["run", "--format", "json", prompt]);
            command
        }
        _ => return Err(format!("不支持的本地 AI Provider: {provider}")),
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(command)
}

fn push_cli_text_candidate(candidates: &mut Vec<String>, value: Option<&Value>) {
    if let Some(text) = value.and_then(Value::as_str) {
        if !text.is_empty() && candidates.last().map(|last| last != text).unwrap_or(true) {
            candidates.push(text.to_string());
        }
    }
}

/// Extract user-visible text from each provider's machine-readable event stream.
/// The providers use different JSONL envelopes, so this boundary keeps the
/// frontend event contract independent from CLI-specific payloads.
fn extract_cli_text(provider: &str, value: &Value) -> Vec<String> {
    let mut candidates = Vec::new();
    match provider {
        "claude" => {
            let event = value.get("event").unwrap_or(value);
            if event.get("type").and_then(Value::as_str) == Some("content_block_delta") {
                push_cli_text_candidate(&mut candidates, event.pointer("/delta/text"));
            }
            if value.get("type").and_then(Value::as_str) == Some("result") {
                push_cli_text_candidate(&mut candidates, value.get("result"));
            }
        }
        "codex" => {
            if value
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|event_type| event_type.starts_with("item."))
            {
                let item = value.get("item").unwrap_or(value);
                if item.get("type").and_then(Value::as_str) == Some("agent_message") {
                    push_cli_text_candidate(&mut candidates, item.get("text"));
                    if let Some(content) = item.get("content").and_then(Value::as_array) {
                        for part in content {
                            push_cli_text_candidate(&mut candidates, part.get("text"));
                        }
                    }
                }
            }
        }
        "opencode" => {
            if value.get("type").and_then(Value::as_str) == Some("text") {
                push_cli_text_candidate(&mut candidates, value.pointer("/part/text"));
                push_cli_text_candidate(&mut candidates, value.get("text"));
            }
        }
        _ => {}
    }
    candidates
}

/// Turn cumulative provider updates into deltas for `local-ai://chunk`.
/// Claude and Codex can emit both partial text and a final cumulative result;
/// prefix/suffix checks prevent the final result from being shown twice while
/// still allowing providers that emit independent chunks.
fn append_cli_delta(candidate: &str, emitted_text: &mut String) -> Option<String> {
    let candidate = candidate.trim_end_matches(['\r', '\n']);
    if candidate.is_empty() {
        return None;
    }
    if emitted_text.is_empty() {
        emitted_text.push_str(candidate);
        return Some(candidate.to_string());
    }
    if candidate.starts_with(emitted_text.as_str()) {
        let delta = candidate[emitted_text.len()..].to_string();
        if delta.is_empty() {
            return None;
        }
        emitted_text.push_str(&delta);
        return Some(delta);
    }
    if emitted_text.ends_with(candidate) {
        return None;
    }
    emitted_text.push_str(candidate);
    Some(candidate.to_string())
}

fn process_cli_output(
    provider: &str,
    bytes: &[u8],
    app: &AppHandle,
    run_id: &str,
    emitted_text: &mut String,
    emitted: &mut bool,
) {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim_end_matches(['\r', '\n']);
    if line.is_empty() {
        return;
    }
    let candidates = serde_json::from_str::<Value>(line)
        .map(|value| extract_cli_text(provider, &value))
        .unwrap_or_else(|_| vec![line.to_string()]);
    for candidate in candidates {
        if let Some(delta) = append_cli_delta(&candidate, emitted_text) {
            *emitted = true;
            let _ = app.emit(
                "local-ai://chunk",
                LocalAIEvent {
                    run_id: run_id.to_string(),
                    text: Some(delta),
                    error: None,
                },
            );
        }
    }
}

fn summarize_cli_stderr(stderr: &str) -> String {
    let cleaned = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        return String::new();
    }
    let mut summary = cleaned;
    if summary.len() > 480 {
        summary.truncate(480);
        summary.push('…');
    }
    summary
}

#[tauri::command]
fn start_local_ai(
    app: AppHandle,
    state: State<'_, AppState>,
    request: LocalAIRunRequest,
) -> Result<(), String> {
    if request.run_id.trim().is_empty() || request.run_id.len() > 120 {
        return Err("本地 AI 运行 ID 无效".to_string());
    }
    if request.prompt.trim().is_empty() || request.prompt.len() > 64_000 {
        return Err("本地 AI 提示词为空或超过 64000 字符".to_string());
    }
    {
        let processes = state
            .ai_processes
            .lock()
            .map_err(|_| "本地 AI 进程锁不可用")?;
        if processes.contains_key(&request.run_id) {
            return Err("本地 AI 运行 ID 已存在".to_string());
        }
    }
    let mut child = command_for_provider(&request.provider, &request.prompt)?
        .spawn()
        .map_err(|error| format!("启动 {} CLI 失败: {error}", request.provider))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("本地 AI CLI 未提供 stdout".to_string());
        }
    };
    let stderr = child.stderr.take();
    let run_id = request.run_id.clone();
    {
        let mut processes = state
            .ai_processes
            .lock()
            .map_err(|_| "本地 AI 进程锁不可用")?;
        if processes.contains_key(&run_id) {
            drop(processes);
            let _ = child.kill();
            let _ = child.wait();
            return Err("本地 AI 运行 ID 已存在".to_string());
        }
        processes.insert(run_id.clone(), child);
    }
    let processes = app.state::<AppState>().ai_processes.clone();
    let stderr_reader = stderr.map(|stderr| {
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut sink = String::new();
            let _ = reader.read_to_string(&mut sink);
            sink
        })
    });
    let provider = request.provider;
    thread::spawn(move || {
        let mut reader = stdout;
        let mut buffer = [0_u8; 8192];
        let mut pending = Vec::new();
        let mut emitted_text = String::new();
        let mut emitted = false;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    if !pending.is_empty() {
                        process_cli_output(
                            &provider,
                            &pending,
                            &app,
                            &run_id,
                            &mut emitted_text,
                            &mut emitted,
                        );
                    }
                    break;
                }
                Ok(size) => {
                    pending.extend_from_slice(&buffer[..size]);
                    while let Some(index) = pending.iter().position(|byte| *byte == b'\n') {
                        let line: Vec<u8> = pending.drain(..=index).collect();
                        process_cli_output(
                            &provider,
                            &line,
                            &app,
                            &run_id,
                            &mut emitted_text,
                            &mut emitted,
                        );
                    }
                    // Machine-readable provider events are JSONL and end in a
                    // newline. This fallback keeps a plain-text CLI responsive
                    // if it writes a long line without a newline.
                    let starts_like_json = pending
                        .iter()
                        .copied()
                        .find(|byte| !byte.is_ascii_whitespace())
                        .is_some_and(|byte| byte == b'{' || byte == b'[');
                    if pending.len() >= 8192 && !starts_like_json {
                        let chunk: Vec<u8> = pending.drain(..).collect();
                        process_cli_output(
                            &provider,
                            &chunk,
                            &app,
                            &run_id,
                            &mut emitted_text,
                            &mut emitted,
                        );
                    }
                }
                Err(error) => {
                    let _ = app.emit(
                        "local-ai://error",
                        LocalAIEvent {
                            run_id: run_id.clone(),
                            text: None,
                            error: Some(format!("读取本地 AI 输出失败: {error}")),
                        },
                    );
                    break;
                }
            }
        }
        let status = processes
            .lock()
            .ok()
            .and_then(|mut entries| entries.remove(&run_id))
            .and_then(|mut child| child.wait().ok());
        // Wait for stderr after the process exits so failures include the
        // provider's actionable diagnostic (auth, invalid flags, quota, etc.)
        // instead of only the generic exit code.
        let stderr_summary = stderr_reader
            .and_then(|reader| reader.join().ok())
            .map(|stderr| summarize_cli_stderr(&stderr))
            .unwrap_or_default();
        match status {
            Some(status) if status.success() && emitted => {
                let _ = app.emit(
                    "local-ai://done",
                    LocalAIEvent {
                        run_id,
                        text: None,
                        error: None,
                    },
                );
            }
            Some(status) if status.success() => {
                let _ = app.emit(
                    "local-ai://error",
                    LocalAIEvent {
                        run_id,
                        text: None,
                        error: Some("本地 AI CLI 成功退出但没有返回文本".to_string()),
                    },
                );
            }
            Some(status) => {
                let message = format!(
                    "本地 AI CLI 退出码 {}{}",
                    status.code().unwrap_or(-1),
                    if stderr_summary.is_empty() {
                        String::new()
                    } else {
                        format!("：{stderr_summary}")
                    }
                );
                let _ = app.emit(
                    "local-ai://error",
                    LocalAIEvent {
                        run_id,
                        text: None,
                        error: Some(message),
                    },
                );
            }
            None => {}
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_local_ai(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    if let Some(mut child) = state
        .ai_processes
        .lock()
        .map_err(|_| "本地 AI 进程锁不可用")?
        .remove(&run_id)
    {
        child
            .kill()
            .map_err(|error| format!("停止本地 AI CLI 失败: {error}"))?;
        let _ = child.wait();
    }
    Ok(())
}

/// 读取 PC Harness 运行状态、配对令牌与可用局域网地址。
#[tauri::command]
fn pc_harness_status(state: State<'_, AppState>) -> Result<pc_harness::PcHarnessStatus, String> {
    let runtime = state
        .pc_harness
        .lock()
        .map_err(|_| "PC Harness 状态锁不可用")?;
    Ok(runtime.status(&state.db))
}

/// 轻量查询手机前台连接状态，供记忆页轮询，不重复探测局域网地址。
#[tauri::command]
fn pc_harness_mobile_connection(state: State<'_, AppState>) -> Result<bool, String> {
    let runtime = state
        .pc_harness
        .lock()
        .map_err(|_| "PC Harness 状态锁不可用")?;
    Ok(runtime.mobile_connected(&state.db))
}

/// PC Harness 启停意图持久化键：仅记录用户显式开关，默认不自动启动。
const PC_HARNESS_DESIRED_RUNNING_KEY: &str = "pc_harness_desired_running";
const PC_HARNESS_TOKEN_KEY: &str = "pc_harness_token";

/// 显式开启手机 Companion 局域网服务。默认不监听。
#[tauri::command]
fn start_pc_harness(state: State<'_, AppState>) -> Result<pc_harness::PcHarnessStatus, String> {
    let mut runtime = state
        .pc_harness
        .lock()
        .map_err(|_| "PC Harness 状态锁不可用")?;
    let status = runtime.start(state.db.clone())?;
    let _ = state
        .db
        .set_app_setting(PC_HARNESS_DESIRED_RUNNING_KEY, "1");
    if let Some(token) = status.pairing_token.as_deref() {
        let _ = state.db.set_app_setting(PC_HARNESS_TOKEN_KEY, token);
    }
    Ok(status)
}

/// 停止手机 Companion 局域网服务并释放端口。
#[tauri::command]
fn stop_pc_harness(state: State<'_, AppState>) -> Result<pc_harness::PcHarnessStatus, String> {
    let mut runtime = state
        .pc_harness
        .lock()
        .map_err(|_| "PC Harness 状态锁不可用")?;
    let status = runtime.stop(&state.db)?;
    let _ = state
        .db
        .set_app_setting(PC_HARNESS_DESIRED_RUNNING_KEY, "0");
    Ok(status)
}

/// 轮换配对令牌（旧令牌立即失效）。
#[tauri::command]
fn rotate_pc_harness_token(
    state: State<'_, AppState>,
) -> Result<pc_harness::PcHarnessStatus, String> {
    let mut runtime = state
        .pc_harness
        .lock()
        .map_err(|_| "PC Harness 状态锁不可用")?;
    let token = runtime.rotate_token();
    let _ = state.db.set_app_setting(PC_HARNESS_TOKEN_KEY, &token);
    Ok(runtime.status(&state.db))
}

/// 通过在线手机写入手机记忆池；Rust 侧不直接更改 origin=mobile 缓存。
#[tauri::command]
async fn pc_harness_mobile_memory_command(
    state: State<'_, AppState>,
    operation: String,
    payload: Value,
) -> Result<pc_harness::MobileMemoryCommandReceipt, String> {
    let account_id = state
        .db
        .current_active_account()
        .map_err(|error| format!("读取当前账号失败: {error}"))?
        .id;
    let broker = state
        .pc_harness
        .lock()
        .map_err(|_| "PC Harness 状态锁不可用")?
        .memory_command_broker();
    tauri::async_runtime::spawn_blocking(move || broker.execute(account_id, operation, payload))
        .await
        .map_err(|error| format!("等待手机记忆命令失败: {error}"))?
}

/// 读取应用级 Model API 配置（脱敏视图）。
#[tauri::command]
async fn read_model_api_settings(
    state: State<'_, AppState>,
) -> Result<model_api::ModelApiSettingsView, String> {
    let db = Arc::clone(&state.db);
    run_blocking_task(move || {
        let settings = model_api::read_settings(&db)?;
        Ok(model_api::settings_view(&settings))
    })
    .await
}

/// 新建或更新一个 Model API Provider。
#[tauri::command]
fn upsert_model_api_provider(
    state: State<'_, AppState>,
    input: model_api::ModelApiProviderInput,
) -> Result<model_api::ModelApiSettingsView, String> {
    model_api::upsert_provider(&state.db, input)
}

/// 删除自定义 Provider（内置项只允许清空密钥）。
#[tauri::command]
fn delete_model_api_provider(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<model_api::ModelApiSettingsView, String> {
    model_api::delete_provider(&state.db, &provider_id)
}

/// 设置全局默认「Provider + 模型」。
#[tauri::command]
fn set_model_api_default_target(
    state: State<'_, AppState>,
    input: model_api::ModelApiDefaultTargetInput,
) -> Result<model_api::ModelApiSettingsView, String> {
    model_api::set_default_target(&state.db, input)
}

/// 用最小请求验证 Provider 配置是否可用。
#[tauri::command]
async fn test_model_api_provider(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<String, String> {
    let db = Arc::clone(&state.db);
    run_blocking_task(move || {
        let settings = model_api::read_settings(&db)?;
        model_api::test_provider(&settings, &provider_id)
    })
    .await
}

/// 读取 AI 运行时设置（默认目标 + 本地 CLI 配置）。
#[tauri::command]
async fn read_ai_runtime_settings(
    state: State<'_, AppState>,
) -> Result<ai_settings::AiRuntimeSettings, String> {
    let db = Arc::clone(&state.db);
    run_blocking_task(move || ai_settings::read_settings(&db)).await
}

/// 保存 AI 运行时设置（即时保存入口）。
#[tauri::command]
fn save_ai_runtime_settings(
    state: State<'_, AppState>,
    settings: ai_settings::AiRuntimeSettings,
) -> Result<ai_settings::AiRuntimeSettings, String> {
    ai_settings::save_settings(&state.db, settings)
}

/// 拉取 Provider 可用模型列表。
#[tauri::command]
async fn list_model_api_models(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<Vec<String>, String> {
    let db = Arc::clone(&state.db);
    run_blocking_task(move || {
        let settings = model_api::read_settings(&db)?;
        model_api::list_models(&settings, &provider_id)
    })
    .await
}

/// 扫描本地 CLI 可用模型（预置 + 发现/配置项）。
#[tauri::command]
async fn list_local_cli_models(provider: String) -> Result<Vec<cli_models::LocalCliModel>, String> {
    run_blocking_task(move || cli_models::list_local_cli_models(&provider)).await
}

/// 启动一次 Model API 流式文本调用；事件与本地 CLI 共用 `local-ai://*`。
#[tauri::command]
fn start_model_api_run(
    app: AppHandle,
    state: State<'_, AppState>,
    request: model_api::ModelApiRunRequest,
) -> Result<(), String> {
    if request.run_id.trim().is_empty() || request.run_id.len() > 120 {
        return Err("Model API 运行 ID 无效".to_string());
    }
    if request.prompt.trim().is_empty() || request.prompt.len() > 64_000 {
        return Err("Model API 提示词为空或超过 64000 字符".to_string());
    }
    let settings = model_api::read_settings(&state.db)?;
    let provider = settings
        .providers
        .iter()
        .find(|item| item.id == request.provider_id)
        .cloned()
        .ok_or_else(|| format!("未找到 Model API Provider：{}", request.provider_id))?;
    let model = request
        .model
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if provider.model.trim().is_empty() {
                provider.enabled_models.first().cloned().unwrap_or_default()
            } else {
                provider.model.clone()
            }
        });
    if model.is_empty() {
        return Err("该 Provider 未配置模型".to_string());
    }
    let stop = state.model_api.register(&request.run_id)?;
    let run_id = request.run_id.clone();
    let prompt = request.prompt.clone();
    thread::spawn(move || {
        let mut on_text = |delta: String| {
            if stop.load(std::sync::atomic::Ordering::SeqCst) {
                return false;
            }
            model_api::emit_event(
                &app,
                "local-ai://chunk",
                model_api::ModelApiEvent {
                    run_id: run_id.clone(),
                    text: Some(delta),
                    error: None,
                },
            );
            true
        };
        let result = model_api::run_stream(&provider, &model, &prompt, &stop, &mut on_text);
        let app_state = app.state::<AppState>();
        app_state.model_api.finish(&run_id);
        let cancelled = stop.load(std::sync::atomic::Ordering::SeqCst);
        match result {
            Ok(()) => {
                model_api::emit_event(
                    &app,
                    "local-ai://done",
                    model_api::ModelApiEvent {
                        run_id,
                        text: None,
                        error: None,
                    },
                );
            }
            Err(_error) if cancelled => {
                model_api::emit_event(
                    &app,
                    "local-ai://done",
                    model_api::ModelApiEvent {
                        run_id,
                        text: None,
                        error: None,
                    },
                );
            }
            Err(error) => {
                model_api::emit_event(
                    &app,
                    "local-ai://error",
                    model_api::ModelApiEvent {
                        run_id,
                        text: None,
                        error: Some(error),
                    },
                );
            }
        }
    });
    Ok(())
}

/// 取消进行中的 Model API 调用。
#[tauri::command]
fn cancel_model_api_run(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    state.model_api.cancel(&run_id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    runtime: &'static str,
    python_backend: bool,
    database: &'static str,
    database_path: String,
}

/// 返回桌面宿主自身的运行时边界，供前端启动自检和后续本地 command 迁移使用。
/// 这里不探测、更不拉起 Python；旧 Python CLI/MCP 仍作为独立入口保留。
#[tauri::command]
fn runtime_status(state: State<'_, AppState>) -> RuntimeStatus {
    RuntimeStatus {
        runtime: "tauri-rust",
        python_backend: false,
        database: "ready",
        database_path: state.db.path().display().to_string(),
    }
}

/// 读取当前运营账号隔离范围内的最小本地工作区快照。
/// 这是首个 vertical slice：只读 profile/items/notes，不替换全站 HTTP adapter。
#[tauri::command]
async fn read_status(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
    section: Option<String>,
) -> Result<db::WorkspaceSnapshot, String> {
    let db = Arc::clone(&state.db);
    run_blocking_task(move || {
        db.snapshot_section_for_account(account_pool_id, section.as_deref().unwrap_or("all"))
            .map_err(|error| format!("读取本地工作区失败: {error}"))
    })
    .await
}

/// 读取当前运营账号隔离范围内的图片，避免桌面端依赖旧 Python HTTP 图片接口。
#[tauri::command]
async fn read_local_image(
    state: State<'_, AppState>,
    item_id: i64,
    account_pool_id: Option<i64>,
    variant: Option<String>,
) -> Result<Option<String>, String> {
    let db = Arc::clone(&state.db);
    run_blocking_task(move || {
        db.image_data_url_for_account(
            item_id,
            account_pool_id,
            variant.as_deref().unwrap_or("original"),
        )
    })
    .await
}

/// 创建一个属于当前运营账号的本地草稿，用于验证 Rust SQLite 写入和账号池边界。
#[tauri::command]
fn create_local_draft(
    state: State<'_, AppState>,
    title: String,
    account_pool_id: Option<i64>,
) -> Result<db::NoteSummary, String> {
    state
        .db
        .create_local_draft_for_account(&title, account_pool_id)
        .map_err(|error| format!("创建本地草稿失败: {error}"))
}

/// 保存当前账号的本地笔记编辑字段，并要求调用方带上内容版本。
#[tauri::command]
fn update_local_note(
    state: State<'_, AppState>,
    update: db::LocalNoteUpdate,
) -> Result<db::NoteSummary, String> {
    state.db.update_local_note(update)
}

/// 保存当前账号的本地笔记状态，并要求调用方带上内容版本。
#[tauri::command]
fn update_local_note_status(
    state: State<'_, AppState>,
    update: db::LocalNoteStatusUpdate,
) -> Result<db::NoteSummary, String> {
    state.db.update_local_note_status(update)
}

/// 将不可变发布快照写入本地 outbox；不访问平台、不提交内容。
#[tauri::command]
fn prepare_local_publish(
    state: State<'_, AppState>,
    preparation: db::LocalPublishOutboxPrepare,
) -> Result<db::PublishOutboxSummary, String> {
    state.db.prepare_local_publish(preparation)
}

/// 记录手工发布后的提交、确认、失败或结果不明状态；不执行平台请求。
#[tauri::command]
fn update_local_publish(
    state: State<'_, AppState>,
    update: db::LocalPublishOutboxUpdate,
) -> Result<db::PublishOutboxSummary, String> {
    state.db.update_local_publish(update)
}

/// 读取当前账号可恢复的本地发布历史。
#[tauri::command]
fn read_local_publish_outbox(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
    note_id: Option<i64>,
) -> Result<Vec<db::PublishOutboxSummary>, String> {
    state.db.local_publish_outbox(account_pool_id, note_id)
}

/// 把笔记关联素材按上传顺序复制到本地暂存目录，返回带序号的文件清单。
#[tauri::command]
fn stage_local_note_images(
    state: State<'_, AppState>,
    note_id: i64,
    account_pool_id: Option<i64>,
) -> Result<db::StagedImagesSummary, String> {
    state.db.stage_local_note_images(note_id, account_pool_id)
}

/// 在系统文件管理器中打开笔记暂存目录；目录路径由宿主根据账号归属计算。
#[tauri::command]
fn open_local_stage_dir(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    note_id: i64,
    account_pool_id: Option<i64>,
) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let stage_dir = state.db.local_note_stage_dir(note_id, account_pool_id)?;
    if !stage_dir.is_dir() {
        return Err("暂存目录不存在，请先暂存图片".to_string());
    }
    let stage_path = stage_dir.display().to_string();
    app.opener()
        .open_path(stage_path, None::<&str>)
        .map_err(|error| format!("打开暂存文件夹失败: {error}"))?;
    Ok(stage_dir.display().to_string())
}

/// 确认发布后清理笔记暂存目录。
#[tauri::command]
fn clear_local_note_stage(
    state: State<'_, AppState>,
    note_id: i64,
    account_pool_id: Option<i64>,
) -> Result<(), String> {
    state.db.clear_local_note_stage(note_id, account_pool_id)
}

/// 保存当前账号笔记的素材关联顺序，并要求调用方带上内容版本。
#[tauri::command]
fn update_local_note_items(
    state: State<'_, AppState>,
    update: db::LocalNoteItemsUpdate,
) -> Result<db::NoteSummary, String> {
    state.db.update_local_note_items(update)
}

/// 将当前账号本地笔记移入回收站，关联素材继续保留。
#[tauri::command]
fn delete_local_note(
    state: State<'_, AppState>,
    note_id: i64,
    account_pool_id: i64,
) -> Result<db::NoteSummary, String> {
    state.db.delete_local_note(note_id, account_pool_id)
}

/// 从当前账号笔记回收站恢复笔记，关联素材不自动恢复。
#[tauri::command]
fn restore_local_note(
    state: State<'_, AppState>,
    note_id: i64,
    account_pool_id: i64,
) -> Result<db::NoteSummary, String> {
    state.db.restore_local_note(note_id, account_pool_id)
}

/// 导入前端读取的图片字节；文件落位与数据库写入由 Rust 负责并带失败补偿。
#[tauri::command]
fn import_local_image(
    state: State<'_, AppState>,
    import: db::LocalImageImport,
) -> Result<db::ItemSummary, String> {
    state.db.import_local_image(import)
}

/// 用用户选择的新图片修复本地素材断链或替换图片内容，并递增图片版本。
#[tauri::command]
fn repair_local_image(
    state: State<'_, AppState>,
    repair: db::LocalImageRepair,
) -> Result<db::ItemSummary, String> {
    state.db.repair_local_image(repair)
}

/// 软删除当前账号素材，记录进入回收站并保留磁盘文件。
#[tauri::command]
fn delete_local_item(
    state: State<'_, AppState>,
    item_id: i64,
    account_pool_id: i64,
) -> Result<(), String> {
    state.db.delete_local_item(item_id, account_pool_id)
}

/// 从当前账号回收站恢复素材。
#[tauri::command]
fn restore_local_item(
    state: State<'_, AppState>,
    item_id: i64,
    account_pool_id: i64,
) -> Result<db::ItemSummary, String> {
    state.db.restore_local_item(item_id, account_pool_id)
}

/// 永久清理当前账号回收站素材；仍被笔记引用或路径越界时整体拒绝。
#[tauri::command]
fn purge_local_items(
    state: State<'_, AppState>,
    item_ids: Vec<i64>,
    account_pool_id: i64,
) -> Result<db::PurgeItemsResult, String> {
    state.db.purge_local_items(&item_ids, account_pool_id)
}

/// 保存当前账号素材的标题、标签和分析维度元数据，不改变图片内容版本。
#[tauri::command]
fn update_local_item_metadata(
    state: State<'_, AppState>,
    update: db::LocalItemMetadataUpdate,
) -> Result<db::ItemSummary, String> {
    state.db.update_local_item_metadata(update)
}

/// 从当前账号素材创建带有有序关联的本地草稿。
#[tauri::command]
fn create_local_draft_from_items(
    state: State<'_, AppState>,
    item_ids: Vec<i64>,
    account_pool_id: Option<i64>,
) -> Result<db::NoteSummary, String> {
    state
        .db
        .create_local_draft_from_items(&item_ids, account_pool_id)
}

/// 读取本地账号池，供桌面端顶栏切换运营账号，不回退到 HTTP。
#[tauri::command]
fn read_account_pool(state: State<'_, AppState>) -> Result<db::AccountPoolSnapshot, String> {
    state
        .db
        .account_pool()
        .map_err(|error| format!("读取本地账号池失败: {error}"))
}

/// 切换本地激活运营账号，并由前端重新读取当前账号快照。
#[tauri::command]
fn activate_local_account(
    state: State<'_, AppState>,
    account_id: i64,
) -> Result<db::ActiveAccount, String> {
    state
        .db
        .activate_account(account_id)
        .map_err(|error| format!("切换本地账号失败: {error}"))
}

/// 创建本地账号池记录；只创建受管空目录，不复制浏览器登录态。
#[tauri::command]
fn create_local_account(
    state: State<'_, AppState>,
    account: db::LocalAccountCreate,
) -> Result<(), String> {
    state.db.create_local_account(account)
}

/// 更新本地账号池展示字段和状态。
#[tauri::command]
fn update_local_account(
    state: State<'_, AppState>,
    account: db::LocalAccountUpdate,
) -> Result<(), String> {
    state.db.update_local_account(account)
}

/// 退休非激活本地账号，保留业务数据和受管目录。
#[tauri::command]
fn retire_local_account(state: State<'_, AppState>, account_id: i64) -> Result<(), String> {
    state.db.retire_local_account(account_id)
}

/// 保存当前运营账号的本地人设和内容策略字段。
#[tauri::command]
fn update_local_profile(
    state: State<'_, AppState>,
    update: db::LocalProfileUpdate,
) -> Result<(), String> {
    state.db.update_local_profile(update)
}

/// 读取当前账号的本地灵感/浏览器剪藏。
#[tauri::command]
async fn read_local_inspirations(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
) -> Result<Vec<db::InspirationSummary>, String> {
    let db = Arc::clone(&state.db);
    run_blocking_task(move || db.local_inspirations(account_pool_id)).await
}

/// 保存当前账号的本地灵感/浏览器剪藏。
#[tauri::command]
fn save_local_inspiration(
    state: State<'_, AppState>,
    inspiration: db::LocalInspirationCreate,
) -> Result<(), String> {
    state.db.save_local_inspiration(inspiration)
}

/// 将当前账号的本地灵感显式关联到一条草稿。
#[tauri::command]
fn convert_local_inspiration(
    state: State<'_, AppState>,
    id: String,
    account_pool_id: i64,
    note_id: i64,
) -> Result<db::InspirationSummary, String> {
    state
        .db
        .convert_local_inspiration(&id, account_pool_id, note_id)
}

/// 在当前账号下保存手工榜样账号信息。
#[tauri::command]
fn create_local_reference_account(
    state: State<'_, AppState>,
    account: db::LocalReferenceAccountCreate,
) -> Result<(), String> {
    state.db.create_local_reference_account(account)
}

/// 保存一条页面快照（扩展解析当前页 / 单篇刷新）。
#[tauri::command]
fn save_page_snapshot(
    state: State<'_, AppState>,
    snapshot: db::PageSnapshotCreate,
) -> Result<db::PageSnapshotSummary, String> {
    state.db.save_page_snapshot(snapshot)
}

/// 按来源 URL 读取页面快照历史。
#[tauri::command]
fn list_page_snapshots(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
    source_url: String,
    limit: Option<i64>,
) -> Result<Vec<db::PageSnapshotSummary>, String> {
    state
        .db
        .list_page_snapshots(account_pool_id, &source_url, limit)
}

/// 安装到指定浏览器（chrome / edge）：写宿主 + 打开扩展页 + 打开扩展目录。
#[tauri::command]
fn install_browser_capture_host(browser: String) -> Result<String, String> {
    browser_capture::install_for_browser(&browser)
}

/// 复制扩展目录到 ~/aichihongshu-extensions/vX.Y.Z/（NOOMD 式副本）。
#[tauri::command]
fn copy_browser_extension_dir() -> Result<String, String> {
    browser_capture::copy_extension_dir()
}

/// 复制扩展目录路径到剪贴板。
#[tauri::command]
fn copy_browser_extension_path() -> Result<String, String> {
    browser_capture::copy_extension_path()
}

/// 在访达中显示扩展目录（项目目录）。
#[tauri::command]
fn open_browser_extension_dir() -> Result<String, String> {
    browser_capture::open_extension_dir()
}

/// 连接自检：扩展文件 / 宿主脚本 / 宿主清单 / 应用 socket。
#[tauri::command]
fn test_browser_capture_link() -> Result<Vec<(String, bool, String)>, String> {
    browser_capture::test_link()
}

/// 浏览器剪藏链路状态（扩展版本 / 协议版本 / 宿主安装情况）。
#[tauri::command]
fn browser_capture_status() -> browser_capture::BrowserCaptureStatus {
    browser_capture::status()
}

/// 打开浏览器扩展管理页（Chrome / Edge 分流）。
#[tauri::command]
fn open_browser_extensions_page(browser: Option<String>) -> Result<String, String> {
    let kind = browser.as_deref().unwrap_or("chrome").to_ascii_lowercase();
    browser_capture::open_extensions_page(&kind)
}

/// 本机可用浏览器（chrome / edge）。
#[tauri::command]
fn detect_capture_browsers() -> Vec<String> {
    browser_capture::detect_browsers()
}

/// 更新当前账号下榜样账号的名称、粉丝数或风格描述。
#[tauri::command]
fn update_local_reference_account(
    state: State<'_, AppState>,
    account: db::LocalReferenceAccountUpdate,
) -> Result<(), String> {
    state.db.update_local_reference_account(account)
}

/// 删除当前账号下榜样账号记录。
#[tauri::command]
fn delete_local_reference_account(
    state: State<'_, AppState>,
    id: i64,
    account_pool_id: i64,
) -> Result<(), String> {
    state.db.delete_local_reference_account(id, account_pool_id)
}

/// 读取当前账号的经验库注入开关。
#[tauri::command]
async fn read_local_knowledge_preferences(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
) -> Result<db::LocalKnowledgePreferences, String> {
    let db = Arc::clone(&state.db);
    run_blocking_task(move || db.local_knowledge_preferences(account_pool_id)).await
}

/// 保存当前账号的经验库注入开关。
#[tauri::command]
fn save_local_knowledge_preferences(
    state: State<'_, AppState>,
    preferences: db::LocalKnowledgePreferencesUpdate,
) -> Result<db::LocalKnowledgePreferences, String> {
    state.db.save_local_knowledge_preferences(preferences)
}

/// 读取当前账号的本地 AI 快捷操作。
#[tauri::command]
async fn list_prompt_configs(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
) -> Result<Vec<db::PromptConfig>, String> {
    let db = Arc::clone(&state.db);
    run_blocking_task(move || db.list_prompt_configs(account_pool_id)).await
}

/// 新增或更新当前账号的本地 AI 快捷操作。
#[tauri::command]
fn upsert_prompt_config(
    state: State<'_, AppState>,
    payload: db::PromptConfigUpsert,
) -> Result<Vec<db::PromptConfig>, String> {
    state.db.upsert_prompt_config(payload)
}

/// 删除当前账号的本地 AI 快捷操作。
#[tauri::command]
fn delete_prompt_config(
    state: State<'_, AppState>,
    key: String,
    account_pool_id: i64,
) -> Result<Vec<db::PromptConfig>, String> {
    state.db.delete_prompt_config(&key, account_pool_id)
}

/// 列出记忆条目（L3），按账号隔离，可按 origin/kind/确认状态过滤。
#[tauri::command]
async fn list_memory_entries(
    state: State<'_, AppState>,
    filter: db::MemoryEntryFilter,
) -> Result<Vec<db::MemoryEntry>, String> {
    let db = Arc::clone(&state.db);
    run_blocking_task(move || db.list_memory_entries(filter)).await
}

/// 新增记忆条目（默认候选）。
#[tauri::command]
fn create_memory_entry(
    state: State<'_, AppState>,
    entry: db::MemoryEntryCreate,
) -> Result<db::MemoryEntry, String> {
    state.db.create_memory_entry(entry)
}

/// 编辑记忆内容字段。
#[tauri::command]
fn update_memory_entry(
    state: State<'_, AppState>,
    entry: db::MemoryEntryUpdate,
) -> Result<db::MemoryEntry, String> {
    state.db.update_memory_entry(entry)
}

/// 删除记忆条目。
#[tauri::command]
fn delete_memory_entry(
    state: State<'_, AppState>,
    id: i64,
    account_pool_id: i64,
) -> Result<(), String> {
    state.db.delete_memory_entry(id, account_pool_id)
}

/// 启用/停用记忆条目。
#[tauri::command]
fn set_memory_entry_enabled(
    state: State<'_, AppState>,
    id: i64,
    account_pool_id: i64,
    enabled: bool,
) -> Result<db::MemoryEntry, String> {
    state
        .db
        .set_memory_entry_enabled(id, account_pool_id, enabled)
}

/// 记忆确认状态迁移（候选→确认/否定，确认→过时）。
#[tauri::command]
fn transition_memory_entry_status(
    state: State<'_, AppState>,
    transition: db::MemoryEntryTransition,
) -> Result<db::MemoryEntry, String> {
    state.db.transition_memory_entry_status(transition)
}

/// 列出经验提示词（L2）。
#[tauri::command]
async fn list_experience_prompts(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
    origin: Option<String>,
) -> Result<Vec<db::ExperiencePrompt>, String> {
    let db = Arc::clone(&state.db);
    run_blocking_task(move || db.list_experience_prompts(account_pool_id, origin)).await
}

/// 新增或更新经验提示词。
#[tauri::command]
fn upsert_experience_prompt(
    state: State<'_, AppState>,
    prompt: db::ExperiencePromptUpsert,
) -> Result<Vec<db::ExperiencePrompt>, String> {
    state.db.upsert_experience_prompt(prompt)
}

/// 删除经验提示词。
#[tauri::command]
fn delete_experience_prompt(
    state: State<'_, AppState>,
    id: i64,
    account_pool_id: i64,
    origin: String,
) -> Result<Vec<db::ExperiencePrompt>, String> {
    state
        .db
        .delete_experience_prompt(id, account_pool_id, origin)
}

/// 读取 L0/L1 系统经验规则。
#[tauri::command]
fn read_memory_system_rules(state: State<'_, AppState>) -> Result<db::MemorySystemRules, String> {
    state.db.read_memory_system_rules()
}

/// 保存 L1 系统经验覆盖文本。
#[tauri::command]
fn save_memory_l1_override(
    state: State<'_, AppState>,
    content: String,
) -> Result<db::MemorySystemRules, String> {
    state.db.save_memory_l1_override(&content)
}

/// 恢复 L1 系统经验默认。
#[tauri::command]
fn reset_memory_l1_override(state: State<'_, AppState>) -> Result<db::MemorySystemRules, String> {
    state.db.reset_memory_l1_override()
}

/// 更新当前账号笔记的互动统计。
#[tauri::command]
fn update_local_note_stats(
    state: State<'_, AppState>,
    update: db::LocalNoteStatsUpdate,
) -> Result<db::NoteSummary, String> {
    state.db.update_local_note_stats(update)
}

/// 保存本地 AI 运行的脱敏元数据，不保存提示词或生成正文。
#[tauri::command]
fn save_local_ai_run(
    state: State<'_, AppState>,
    run: db::LocalAIRunUpsert,
) -> Result<db::AIRunSummary, String> {
    state.db.upsert_local_ai_run(run)
}

/// 更新本地 AI 运行状态，供完成、失败、取消和重启中断回写。
#[tauri::command]
fn update_local_ai_run(
    state: State<'_, AppState>,
    run: db::LocalAIRunUpdate,
) -> Result<db::AIRunSummary, String> {
    state.db.update_local_ai_run(run)
}

/// 读取当前账号和对象作用域下最近一次本地 AI 运行。
#[tauri::command]
fn read_local_ai_run(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
    note_id: Option<i64>,
    item_id: Option<i64>,
) -> Result<Option<db::AIRunSummary>, String> {
    state
        .db
        .latest_local_ai_run(account_pool_id, note_id, item_id)
}

/// 保存本地 AI 生成的限长文本产物，不保存完整提示词或凭据。
#[tauri::command]
fn save_local_ai_artifact(
    state: State<'_, AppState>,
    artifact: db::LocalAIRunArtifactCreate,
) -> Result<db::AIRunArtifactSummary, String> {
    state.db.save_local_ai_artifact(artifact)
}

/// 读取当前账号和对象作用域下最近的本地 AI 产物。
#[tauri::command]
fn read_local_ai_artifacts(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
    note_id: Option<i64>,
    item_id: Option<i64>,
) -> Result<Vec<db::AIRunArtifactSummary>, String> {
    state
        .db
        .local_ai_artifacts(account_pool_id, note_id, item_id)
}

fn setup_error(message: impl Into<String>) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::new(
        std::io::ErrorKind::Other,
        message.into(),
    ))
}

fn resolve_database_path(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| setup_error(format!("定位应用数据目录失败: {error}")))?;

    #[cfg(debug_assertions)]
    {
        if let Ok(qa_workspace) = std::env::var("AICHIHONGSHU_QA_WORKSPACE") {
            let qa_root = PathBuf::from(qa_workspace);
            if !qa_root.is_absolute() {
                return Err(setup_error("AICHIHONGSHU_QA_WORKSPACE 必须是绝对路径"));
            }
            let marker = qa_root.join(".aichihongshu-qa-workspace");
            if !marker.is_file() {
                return Err(setup_error(format!(
                    "拒绝使用未标记的 QA 工作区: {}",
                    qa_root.display()
                )));
            }
            return Ok(qa_root.join("data").join("app.db"));
        }

        let project_db = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data/app.db");
        if project_db.is_file() {
            return Ok(project_db);
        }
    }

    Ok(app_data_dir.join("app.db"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let db_path = resolve_database_path(app.handle())?;
            let db = db::LocalDb::open(db_path)
                .map_err(|error| setup_error(format!("初始化本地数据库失败: {error}")))?;
            let db = Arc::new(db);
            // 恢复 PC Harness：上次配对令牌 + 用户显式开启意图；默认仍不自动启动。
            let mut harness_runtime = pc_harness::PcHarnessRuntime::new();
            match db.get_app_setting(PC_HARNESS_TOKEN_KEY) {
                Ok(Some(token)) => harness_runtime.restore_token(&token),
                Ok(None) => {
                    let _ = db.set_app_setting(PC_HARNESS_TOKEN_KEY, &harness_runtime.token());
                }
                Err(error) => {
                    eprintln!("[aichihongshu] 读取 PC Harness 令牌失败: {error}");
                }
            }
            let restore_harness = matches!(
                db.get_app_setting(PC_HARNESS_DESIRED_RUNNING_KEY),
                Ok(Some(value)) if value == "1"
            );
            app.manage(AppState {
                db,
                ai_processes: Arc::new(Mutex::new(HashMap::new())),
                pc_harness: Mutex::new(harness_runtime),
                model_api: model_api::ModelApiRuntime::default(),
            });
            if restore_harness {
                let state = app.state::<AppState>();
                if let Err(error) = start_pc_harness(state) {
                    eprintln!("[aichihongshu] 恢复 PC Harness 监听失败: {error}");
                }
            }
            // 浏览器剪藏回传链路（N12 最小原型）：owner-only Unix socket，
            // 失败只记日志，不影响应用启动。
            browser_capture::spawn(app.handle().clone());
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            read_status,
            read_local_image,
            create_local_draft,
            update_local_note,
            update_local_note_status,
            prepare_local_publish,
            update_local_publish,
            read_local_publish_outbox,
            stage_local_note_images,
            open_local_stage_dir,
            clear_local_note_stage,
            update_local_note_items,
            delete_local_note,
            restore_local_note,
            import_local_image,
            repair_local_image,
            delete_local_item,
            restore_local_item,
            purge_local_items,
            update_local_item_metadata,
            create_local_draft_from_items,
            read_account_pool,
            activate_local_account,
            create_local_account,
            update_local_account,
            retire_local_account,
            update_local_profile,
            read_local_inspirations,
            save_local_inspiration,
            convert_local_inspiration,
            create_local_reference_account,
            update_local_reference_account,
            delete_local_reference_account,
            save_page_snapshot,
            list_page_snapshots,
            install_browser_capture_host,
            copy_browser_extension_dir,
            copy_browser_extension_path,
            open_browser_extensions_page,
            open_browser_extension_dir,
            test_browser_capture_link,
            detect_capture_browsers,
            browser_capture_status,
            read_local_knowledge_preferences,
            save_local_knowledge_preferences,
            list_prompt_configs,
            upsert_prompt_config,
            delete_prompt_config,
            list_memory_entries,
            create_memory_entry,
            update_memory_entry,
            delete_memory_entry,
            set_memory_entry_enabled,
            transition_memory_entry_status,
            list_experience_prompts,
            upsert_experience_prompt,
            delete_experience_prompt,
            read_memory_system_rules,
            save_memory_l1_override,
            reset_memory_l1_override,
            update_local_note_stats,
            save_local_ai_run,
            update_local_ai_run,
            read_local_ai_run,
            save_local_ai_artifact,
            read_local_ai_artifacts,
            probe_local_ai_providers,
            start_local_ai,
            cancel_local_ai,
            pc_harness_status,
            pc_harness_mobile_connection,
            start_pc_harness,
            stop_pc_harness,
            rotate_pc_harness_token,
            pc_harness_mobile_memory_command,
            read_model_api_settings,
            upsert_model_api_provider,
            delete_model_api_provider,
            set_model_api_default_target,
            test_model_api_provider,
            start_model_api_run,
            cancel_model_api_run,
            read_ai_runtime_settings,
            save_ai_runtime_settings,
            list_model_api_models,
            list_local_cli_models
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, _| {});
}

#[cfg(test)]
mod tests {
    use super::command_for_provider;

    #[test]
    fn local_cli_commands_are_non_interactive_and_keep_prompt_as_one_argument() {
        for (provider, expected) in [
            (
                "claude",
                vec![
                    "-p",
                    "prompt",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--include-partial-messages",
                ],
            ),
            (
                "codex",
                vec![
                    "exec",
                    "--color",
                    "never",
                    "--skip-git-repo-check",
                    "--json",
                    "prompt",
                ],
            ),
            ("opencode", vec!["run", "--format", "json", "prompt"]),
        ] {
            let command =
                command_for_provider(provider, "prompt").expect("provider should be allowed");
            let args: Vec<String> = command
                .get_args()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect();
            assert_eq!(args, expected);
        }
    }

    #[test]
    fn local_cli_provider_is_allowlisted() {
        let error = command_for_provider("sh -c 'echo unsafe'", "prompt")
            .expect_err("shell text must be rejected");
        assert!(error.contains("不支持的本地 AI Provider"));
    }
}
