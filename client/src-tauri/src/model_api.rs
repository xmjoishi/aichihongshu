//! Model API：应用级多 Provider 配置与 OpenAI/Anthropic 兼容流式调用。
//!
//! 配置与凭据同存 `app_settings`（本地 SQLite），读取视图脱敏；
//! 真实请求只在 Rust 侧拼装，API Key 不回传前端、不写日志。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::db::LocalDb;

pub const MODEL_API_SETTINGS_KEY: &str = "model_api_settings_v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelApiProviderKind {
    OpenaiCompatible,
    AnthropicCompatible,
}

impl ModelApiProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ModelApiProviderKind::OpenaiCompatible => "openai-compatible",
            ModelApiProviderKind::AnthropicCompatible => "anthropic-compatible",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelApiProviderConfig {
    pub id: String,
    pub kind: ModelApiProviderKind,
    pub label: String,
    pub endpoint: String,
    /// 仅存 Rust 侧；视图输出脱敏。
    pub api_key: String,
    pub model: String,
    pub vision_model: String,
    pub enabled_models: Vec<String>,
    pub builtin: bool,
    /// 预置目录标记（openrouter/siliconflow/...），自定义为空。
    #[serde(default)]
    pub preset: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelApiSettings {
    pub providers: Vec<ModelApiProviderConfig>,
    pub default_provider_id: String,
    pub default_model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelApiProviderView {
    pub id: String,
    pub kind: ModelApiProviderKind,
    pub label: String,
    pub endpoint: String,
    pub configured: bool,
    pub api_key_masked: String,
    pub model: String,
    pub vision_model: String,
    pub enabled_models: Vec<String>,
    pub builtin: bool,
    pub preset: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelApiSettingsView {
    pub providers: Vec<ModelApiProviderView>,
    pub default_provider_id: String,
    pub default_model: String,
}

fn mask_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.len() <= 8 {
        return "****".to_string();
    }
    format!("{}****{}", &trimmed[..4], &trimmed[trimmed.len() - 4..])
}

fn provider_view(provider: &ModelApiProviderConfig) -> ModelApiProviderView {
    ModelApiProviderView {
        id: provider.id.clone(),
        kind: provider.kind,
        label: provider.label.clone(),
        endpoint: provider.endpoint.clone(),
        configured: !provider.api_key.trim().is_empty(),
        api_key_masked: mask_key(&provider.api_key),
        model: provider.model.clone(),
        vision_model: provider.vision_model.clone(),
        enabled_models: provider.enabled_models.clone(),
        builtin: provider.builtin,
        preset: provider.preset.clone(),
    }
}

fn default_settings() -> ModelApiSettings {
    ModelApiSettings {
        providers: builtin_catalog(),
        default_provider_id: String::new(),
        default_model: String::new(),
    }
}

/// 预置目录：内置四家 + 常见兼容服务模板，未配置凭据时只是可连接入口。
pub fn builtin_catalog() -> Vec<ModelApiProviderConfig> {
    let entry = |id: &str,
                 kind: ModelApiProviderKind,
                 label: &str,
                 endpoint: &str,
                 model: &str,
                 builtin: bool,
                 preset: Option<&str>|
     -> ModelApiProviderConfig {
        ModelApiProviderConfig {
            id: id.to_string(),
            kind,
            label: label.to_string(),
            endpoint: endpoint.to_string(),
            api_key: String::new(),
            model: model.to_string(),
            vision_model: String::new(),
            enabled_models: vec![model.to_string()],
            builtin,
            preset: preset.map(|value| value.to_string()),
        }
    };
    vec![
        entry(
            "deepseek",
            ModelApiProviderKind::OpenaiCompatible,
            "DeepSeek",
            "https://api.deepseek.com/chat/completions",
            "deepseek-chat",
            true,
            None,
        ),
        entry(
            "minimax",
            ModelApiProviderKind::AnthropicCompatible,
            "MiniMax",
            "https://api.minimaxi.com/anthropic/v1/messages",
            "MiniMax-M2.7",
            true,
            None,
        ),
        entry(
            "openai",
            ModelApiProviderKind::OpenaiCompatible,
            "OpenAI",
            "https://api.openai.com/v1/chat/completions",
            "gpt-4o-mini",
            true,
            None,
        ),
        entry(
            "anthropic",
            ModelApiProviderKind::AnthropicCompatible,
            "Anthropic",
            "https://api.anthropic.com/v1/messages",
            "claude-sonnet-4-5",
            true,
            None,
        ),
        entry(
            "openrouter",
            ModelApiProviderKind::OpenaiCompatible,
            "OpenRouter",
            "https://openrouter.ai/api/v1/chat/completions",
            "openai/gpt-4o-mini",
            false,
            Some("openrouter"),
        ),
        entry(
            "siliconflow",
            ModelApiProviderKind::OpenaiCompatible,
            "SiliconFlow",
            "https://api.siliconflow.cn/v1/chat/completions",
            "deepseek-ai/DeepSeek-V3",
            false,
            Some("siliconflow"),
        ),
        entry(
            "zhipu",
            ModelApiProviderKind::OpenaiCompatible,
            "智谱 GLM",
            "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            "glm-4-air",
            false,
            Some("zhipu"),
        ),
        entry(
            "volcengine",
            ModelApiProviderKind::OpenaiCompatible,
            "火山方舟 / 豆包",
            "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
            "doubao-seed-1-6-flash",
            false,
            Some("volcengine"),
        ),
        entry(
            "ollama",
            ModelApiProviderKind::OpenaiCompatible,
            "Ollama",
            "http://127.0.0.1:11434/v1/chat/completions",
            "llama3.2",
            false,
            Some("ollama"),
        ),
    ]
}

fn normalize_settings(raw: ModelApiSettings) -> ModelApiSettings {
    let mut providers = raw.providers;
    for catalog in builtin_catalog() {
        if let Some(existing) = providers.iter_mut().find(|item| item.id == catalog.id) {
            if existing.endpoint.trim().is_empty() {
                existing.endpoint = catalog.endpoint.clone();
            }
            if existing.kind != catalog.kind && existing.api_key.trim().is_empty() {
                existing.kind = catalog.kind;
            }
            if existing.preset.is_none() {
                existing.preset = catalog.preset.clone();
            }
            if existing.enabled_models.is_empty() && !existing.model.trim().is_empty() {
                existing.enabled_models = vec![existing.model.clone()];
            }
        } else {
            providers.push(catalog);
        }
    }
    for provider in providers.iter_mut() {
        provider.id = provider.id.trim().to_string();
        provider.label = if provider.label.trim().is_empty() {
            provider.id.clone()
        } else {
            provider.label.trim().to_string()
        };
        if provider.enabled_models.is_empty() && !provider.model.trim().is_empty() {
            provider.enabled_models = vec![provider.model.clone()];
        }
        if provider.model.trim().is_empty() {
            provider.model = provider.enabled_models.first().cloned().unwrap_or_default();
        }
    }
    let default_provider_id = if providers
        .iter()
        .any(|item| item.id == raw.default_provider_id)
    {
        raw.default_provider_id
    } else {
        String::new()
    };
    let default_model = if default_provider_id.is_empty() {
        String::new()
    } else {
        raw.default_model
    };
    ModelApiSettings {
        providers,
        default_provider_id,
        default_model,
    }
}

pub fn read_settings(db: &LocalDb) -> Result<ModelApiSettings, String> {
    let raw = db.get_app_setting(MODEL_API_SETTINGS_KEY)?;
    let parsed = match raw {
        Some(value) => serde_json::from_str::<ModelApiSettings>(&value)
            .map_err(|error| format!("解析 Model API 配置失败: {error}"))?,
        None => default_settings(),
    };
    Ok(normalize_settings(parsed))
}

pub fn save_settings(db: &LocalDb, settings: ModelApiSettings) -> Result<ModelApiSettings, String> {
    let normalized = normalize_settings(settings);
    let value = serde_json::to_string(&normalized)
        .map_err(|error| format!("序列化 Model API 配置失败: {error}"))?;
    db.set_app_setting(MODEL_API_SETTINGS_KEY, &value)?;
    Ok(normalized)
}

pub fn settings_view(settings: &ModelApiSettings) -> ModelApiSettingsView {
    ModelApiSettingsView {
        providers: settings.providers.iter().map(provider_view).collect(),
        default_provider_id: settings.default_provider_id.clone(),
        default_model: settings.default_model.clone(),
    }
}

fn find_provider<'a>(
    settings: &'a ModelApiSettings,
    provider_id: &str,
) -> Result<&'a ModelApiProviderConfig, String> {
    settings
        .providers
        .iter()
        .find(|item| item.id == provider_id)
        .ok_or_else(|| format!("未找到 Model API Provider：{provider_id}"))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelApiProviderInput {
    pub id: Option<String>,
    pub kind: ModelApiProviderKind,
    pub label: String,
    pub endpoint: String,
    /// 为空表示不修改既有密钥。
    pub api_key: Option<String>,
    pub model: String,
    pub vision_model: Option<String>,
    pub enabled_models: Vec<String>,
}

fn apply_input(provider: &mut ModelApiProviderConfig, input: ModelApiProviderInput) {
    provider.kind = input.kind;
    provider.label = input.label.trim().to_string();
    provider.endpoint = input.endpoint.trim().to_string();
    if let Some(api_key) = input.api_key {
        // 显式传入（含空字符串）才覆盖；None 保留旧密钥。
        provider.api_key = api_key.trim().to_string();
    }
    provider.model = input.model.trim().to_string();
    provider.vision_model = input.vision_model.unwrap_or_default().trim().to_string();
    let mut enabled: Vec<String> = input
        .enabled_models
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect();
    if enabled.is_empty() && !provider.model.is_empty() {
        enabled.push(provider.model.clone());
    }
    if !provider.model.is_empty() && !enabled.contains(&provider.model) {
        enabled.push(provider.model.clone());
    }
    provider.enabled_models = enabled;
}

pub fn upsert_provider(
    db: &LocalDb,
    input: ModelApiProviderInput,
) -> Result<ModelApiSettingsView, String> {
    let mut settings = read_settings(db)?;
    let existing_id = input
        .id
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(id) = existing_id {
        let provider = find_provider(&settings, &id)?;
        // builtin/preset 身份字段保留；仅更新用户可编辑字段。
        let mut next = provider.clone();
        apply_input(&mut next, input);
        next.id = id;
        let index = settings
            .providers
            .iter()
            .position(|item| item.id == next.id)
            .ok_or_else(|| "未找到 Model API Provider".to_string())?;
        settings.providers[index] = next;
    } else {
        let id = format!(
            "custom-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_millis())
                .unwrap_or(0)
        );
        let mut provider = ModelApiProviderConfig {
            id: id.clone(),
            kind: input.kind,
            label: String::new(),
            endpoint: String::new(),
            api_key: String::new(),
            model: String::new(),
            vision_model: String::new(),
            enabled_models: Vec::new(),
            builtin: false,
            preset: None,
        };
        apply_input(&mut provider, input);
        provider.id = id;
        settings.providers.push(provider);
    }
    let saved = save_settings(db, settings)?;
    Ok(settings_view(&saved))
}

pub fn delete_provider(db: &LocalDb, provider_id: &str) -> Result<ModelApiSettingsView, String> {
    let mut settings = read_settings(db)?;
    let target = find_provider(&settings, provider_id)?;
    if target.builtin {
        return Err("内置 Provider 不可删除，可清空密钥后不再使用".to_string());
    }
    settings.providers.retain(|item| item.id != provider_id);
    if settings.default_provider_id == provider_id {
        settings.default_provider_id = String::new();
        settings.default_model = String::new();
    }
    let saved = save_settings(db, settings)?;
    Ok(settings_view(&saved))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelApiDefaultTargetInput {
    pub provider_id: String,
    pub model: String,
}

pub fn set_default_target(
    db: &LocalDb,
    input: ModelApiDefaultTargetInput,
) -> Result<ModelApiSettingsView, String> {
    let mut settings = read_settings(db)?;
    let provider = find_provider(&settings, &input.provider_id)?;
    let model = input.model.trim();
    if model.is_empty() {
        return Err("默认模型不能为空".to_string());
    }
    if provider.api_key.trim().is_empty() {
        return Err("该 Provider 尚未配置 API Key".to_string());
    }
    settings.default_provider_id = provider.id.clone();
    settings.default_model = model.to_string();
    let saved = save_settings(db, settings)?;
    Ok(settings_view(&saved))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelApiRunRequest {
    pub run_id: String,
    pub provider_id: String,
    pub model: Option<String>,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelApiEvent {
    pub run_id: String,
    pub text: Option<String>,
    pub error: Option<String>,
}

fn build_openai_payload(model: &str, prompt: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "stream": true,
        "messages": [{ "role": "user", "content": prompt }],
    })
}

fn build_anthropic_payload(model: &str, prompt: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "stream": true,
        "max_tokens": 4096,
        "messages": [{ "role": "user", "content": prompt }],
    })
}

fn parse_openai_chunk(line: &str, buffer: &mut String) -> Option<String> {
    let payload = line.strip_prefix("data:")?.trim();
    if payload == "[DONE]" {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let delta = value
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()?;
    accumulate_delta(delta, buffer)
}

fn parse_anthropic_chunk(line: &str, buffer: &mut String) -> Option<String> {
    let payload = line.strip_prefix("data:")?.trim();
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let event_type = value.get("type")?.as_str()?;
    if event_type != "content_block_delta" {
        return None;
    }
    let delta = value.get("delta")?.get("text")?.as_str()?;
    accumulate_delta(delta, buffer)
}

fn process_sse_line(
    line: &str,
    kind: ModelApiProviderKind,
    buffer: &mut String,
    on_text: &mut impl FnMut(String) -> bool,
) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') || trimmed.starts_with("event:") {
        return true;
    }
    let emitted = match kind {
        ModelApiProviderKind::OpenaiCompatible => parse_openai_chunk(trimmed, buffer),
        ModelApiProviderKind::AnthropicCompatible => parse_anthropic_chunk(trimmed, buffer),
    };
    emitted.map(on_text).unwrap_or(true)
}

/// 累积并只返回新增片段，避免重复推送。
fn accumulate_delta(delta: &str, buffer: &mut String) -> Option<String> {
    if delta.is_empty() {
        return None;
    }
    buffer.push_str(delta);
    Some(delta.to_string())
}

fn read_sse_stream<R: Read>(
    reader: R,
    kind: ModelApiProviderKind,
    stop: &AtomicBool,
    mut on_text: impl FnMut(String) -> bool,
) -> Result<(), String> {
    let mut lines = BufReader::new(reader).lines();
    let mut buffer = String::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let line = match lines.next() {
            Some(Ok(line)) => line,
            Some(Err(error)) => return Err(format!("读取模型响应失败: {error}")),
            None => return Ok(()),
        };
        if !process_sse_line(&line, kind, &mut buffer, &mut on_text) {
            return Ok(());
        }
    }
}

const MODEL_API_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const MODEL_API_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const MAX_MODEL_API_ERROR_BODY_BYTES: usize = 8 * 1024;
static RUSTLS_PROVIDER: std::sync::Once = std::sync::Once::new();

async fn model_api_http_error(mut response: reqwest::Response) -> String {
    let status = response.status();
    let mut body = Vec::new();
    while body.len() < MAX_MODEL_API_ERROR_BODY_BYTES {
        let next = tokio::time::timeout(MODEL_API_READ_TIMEOUT, response.chunk()).await;
        let Ok(Ok(Some(chunk))) = next else { break };
        let remaining = MAX_MODEL_API_ERROR_BODY_BYTES - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    }
    let summary: String = String::from_utf8_lossy(&body).chars().take(240).collect();
    if summary.is_empty() {
        format!("模型接口返回 HTTP {}", status.as_u16())
    } else {
        format!("模型接口返回 HTTP {}：{summary}", status.as_u16())
    }
}

fn process_complete_sse_lines(
    pending: &mut Vec<u8>,
    kind: ModelApiProviderKind,
    buffer: &mut String,
    on_text: &mut impl FnMut(String) -> bool,
) -> Result<bool, String> {
    while let Some(line_end) = pending.iter().position(|byte| *byte == b'\n') {
        let mut line = pending.drain(..=line_end).collect::<Vec<_>>();
        line.pop(); // newline
        let line = std::str::from_utf8(&line)
            .map_err(|error| format!("模型响应不是有效 UTF-8: {error}"))?;
        if !process_sse_line(line, kind, buffer, on_text) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Cancellable async SSE reader used by interactive runs. Aborting its Tauri
/// task drops the reqwest response immediately, including while waiting for a
/// network chunk; the synchronous reader remains only for the short test call.
pub async fn run_stream_cancellable(
    provider: &ModelApiProviderConfig,
    model: &str,
    prompt: &str,
    mut on_text: impl FnMut(String) -> bool,
) -> Result<(), String> {
    let api_key = provider.api_key.trim();
    if api_key.is_empty() {
        return Err("该 Provider 未配置 API Key".to_string());
    }
    let endpoint = provider.endpoint.trim();
    if endpoint.is_empty() {
        return Err("该 Provider 未配置 Endpoint".to_string());
    }
    RUSTLS_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    let client = reqwest::Client::builder()
        .connect_timeout(MODEL_API_CONNECT_TIMEOUT)
        .build()
        .map_err(|error| format!("创建模型接口客户端失败: {error}"))?;
    let payload = match provider.kind {
        ModelApiProviderKind::OpenaiCompatible => build_openai_payload(model, prompt),
        ModelApiProviderKind::AnthropicCompatible => build_anthropic_payload(model, prompt),
    };
    let mut request = client
        .post(endpoint)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&payload);
    request = match provider.kind {
        ModelApiProviderKind::OpenaiCompatible => {
            request.header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"))
        }
        ModelApiProviderKind::AnthropicCompatible => request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
    };
    let mut response = tokio::time::timeout(MODEL_API_READ_TIMEOUT, request.send())
        .await
        .map_err(|_| "等待模型接口响应超时".to_string())?
        .map_err(|error| format!("连接模型接口失败: {error}"))?;
    if !response.status().is_success() {
        return Err(model_api_http_error(response).await);
    }

    let mut pending = Vec::new();
    let mut text_buffer = String::new();
    loop {
        let chunk = tokio::time::timeout(MODEL_API_READ_TIMEOUT, response.chunk())
            .await
            .map_err(|_| "读取模型响应超时（60 秒无数据）".to_string())?
            .map_err(|error| format!("读取模型响应失败: {error}"))?;
        let Some(chunk) = chunk else {
            if !pending.is_empty() {
                let line = std::str::from_utf8(&pending)
                    .map_err(|error| format!("模型响应不是有效 UTF-8: {error}"))?;
                let _ = process_sse_line(line, provider.kind, &mut text_buffer, &mut on_text);
            }
            return Ok(());
        };
        pending.extend_from_slice(&chunk);
        if !process_complete_sse_lines(&mut pending, provider.kind, &mut text_buffer, &mut on_text)?
        {
            return Ok(());
        }
    }
}

fn http_error_message(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            let mut body = String::new();
            let mut reader = response.into_reader();
            let _ = reader.read_to_string(&mut body);
            let summary: String = body.chars().take(240).collect();
            if summary.is_empty() {
                format!("模型接口返回 HTTP {code}")
            } else {
                format!("模型接口返回 HTTP {code}：{summary}")
            }
        }
        ureq::Error::Transport(error) => format!("连接模型接口失败: {error}"),
    }
}

/// 由对话端点推导模型列表端点。
/// `https://api.x.com/v1/chat/completions` → `https://api.x.com/v1/models`
fn models_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    for suffix in [
        "/chat/completions",
        "/completions",
        "/messages",
        "/v1/messages",
    ] {
        if let Some(base) = trimmed.strip_suffix(suffix) {
            let base = base.trim_end_matches('/');
            if base.ends_with("/v1") || base.ends_with("/v3") || base.ends_with("/paas/v4") {
                return format!("{base}/models");
            }
            return format!("{base}/v1/models");
        }
    }
    if trimmed.ends_with("/models") {
        return trimmed.to_string();
    }
    format!("{trimmed}/models")
}

/// 拉取 Provider 可用模型列表（OpenAI/Anthropic 兼容 `/models`）。
pub fn list_models(settings: &ModelApiSettings, provider_id: &str) -> Result<Vec<String>, String> {
    let provider = find_provider(settings, provider_id)?;
    if provider.api_key.trim().is_empty() {
        return Err("请先填写 API Key".to_string());
    }
    let url = models_endpoint(&provider.endpoint);
    let mut request = match provider.kind {
        ModelApiProviderKind::OpenaiCompatible => ureq::get(&url).set(
            "Authorization",
            &format!("Bearer {}", provider.api_key.trim()),
        ),
        ModelApiProviderKind::AnthropicCompatible => ureq::get(&url)
            .set("x-api-key", provider.api_key.trim())
            .set("anthropic-version", "2023-06-01"),
    };
    request = request
        .set("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(30));
    let response = request.call().map_err(http_error_message)?;
    let mut body = String::new();
    response
        .into_reader()
        .read_to_string(&mut body)
        .map_err(|error| format!("读取模型列表失败: {error}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|error| format!("解析模型列表失败: {error}"))?;
    let mut models = Vec::new();
    if let Some(items) = value.get("data").and_then(|data| data.as_array()) {
        for item in items {
            let id = item
                .get("id")
                .and_then(|id| id.as_str())
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty());
            if let Some(id) = id {
                if !models.contains(&id) {
                    models.push(id);
                }
            }
        }
    }
    if models.is_empty() {
        return Err("模型列表为空，请检查 Endpoint 是否支持 /models".to_string());
    }
    Ok(models)
}

/// 测试连接：发一条最小 prompt，只要求拿到任意文本或明确的鉴权/参数错误。
pub fn test_provider(settings: &ModelApiSettings, provider_id: &str) -> Result<String, String> {
    let provider = find_provider(settings, provider_id)?;
    if provider.api_key.trim().is_empty() {
        return Err("请先填写 API Key".to_string());
    }
    if provider.endpoint.trim().is_empty() {
        return Err("请先填写 Endpoint".to_string());
    }
    let model = if provider.model.trim().is_empty() {
        provider.enabled_models.first().cloned().unwrap_or_default()
    } else {
        provider.model.clone()
    };
    if model.is_empty() {
        return Err("请先填写模型名称".to_string());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let mut collected = String::new();
    run_stream(provider, &model, "ping", &stop, &mut |delta| {
        collected.push_str(&delta);
        !collected.is_empty()
    })?;
    if collected.trim().is_empty() {
        Ok("连接成功，但本次未返回文本".to_string())
    } else {
        Ok(format!(
            "连接成功，样例输出：{}",
            collected.chars().take(40).collect::<String>()
        ))
    }
}

pub fn run_stream(
    provider: &ModelApiProviderConfig,
    model: &str,
    prompt: &str,
    stop: &AtomicBool,
    on_text: &mut dyn FnMut(String) -> bool,
) -> Result<(), String> {
    let api_key = provider.api_key.trim();
    if api_key.is_empty() {
        return Err("该 Provider 未配置 API Key".to_string());
    }
    let endpoint = provider.endpoint.trim();
    if endpoint.is_empty() {
        return Err("该 Provider 未配置 Endpoint".to_string());
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(60))
        .build();
    let (payload, mut request) = match provider.kind {
        ModelApiProviderKind::OpenaiCompatible => (
            build_openai_payload(model, prompt),
            agent
                .post(endpoint)
                .set("Authorization", &format!("Bearer {api_key}")),
        ),
        ModelApiProviderKind::AnthropicCompatible => (
            build_anthropic_payload(model, prompt),
            agent
                .post(endpoint)
                .set("x-api-key", api_key)
                .set("anthropic-version", "2023-06-01"),
        ),
    };
    request = request
        .set("Content-Type", "application/json")
        .set("Accept", "text/event-stream");
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    let response = request.send_json(payload).map_err(http_error_message)?;
    let reader = response.into_reader();
    read_sse_stream(reader, provider.kind, stop, on_text)
}

#[derive(Default)]
pub struct ModelApiRuntime {
    runs: Mutex<HashMap<String, Option<tauri::async_runtime::JoinHandle<()>>>>,
}

impl ModelApiRuntime {
    pub fn register(&self, run_id: &str) -> Result<(), String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "Model API 运行锁不可用".to_string())?;
        if runs.contains_key(run_id) {
            return Err("该 Model API 运行 ID 已存在".to_string());
        }
        runs.insert(run_id.to_string(), None);
        Ok(())
    }

    pub fn attach_task(&self, run_id: &str, task: tauri::async_runtime::JoinHandle<()>) {
        if let Ok(mut runs) = self.runs.lock() {
            if let Some(entry) = runs.get_mut(run_id) {
                *entry = Some(task);
                return;
            }
        }
        // The run may have been cancelled or completed before the task handle
        // was installed. In that race, do not leave the request running.
        task.abort();
    }

    pub fn finish(&self, run_id: &str) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(run_id);
        }
    }

    pub fn cancel(&self, run_id: &str) -> Result<(), String> {
        let task = self
            .runs
            .lock()
            .map_err(|_| "Model API 运行锁不可用".to_string())?
            .remove(run_id)
            .flatten();
        if let Some(task) = task {
            task.abort();
        }
        Ok(())
    }
}

pub fn emit_event(app: &AppHandle, event: &str, payload: ModelApiEvent) {
    let _ = app.emit(event, payload);
}

#[cfg(test)]
mod tests {
    use super::ModelApiRuntime;
    use std::sync::mpsc;
    use std::time::Duration;

    struct DropNotifier(mpsc::Sender<()>);

    impl Drop for DropNotifier {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }

    #[test]
    fn cancelling_a_run_aborts_its_task() {
        let runtime = ModelApiRuntime::default();
        runtime.register("cancel-test").expect("register run");
        let (started_tx, started_rx) = mpsc::channel();
        let (dropped_tx, dropped_rx) = mpsc::channel();
        let task = tauri::async_runtime::spawn(async move {
            let _drop_notifier = DropNotifier(dropped_tx);
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        runtime.attach_task("cancel-test", task);

        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("task should start");
        runtime.cancel("cancel-test").expect("cancel run");
        dropped_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("cancellation should drop the task");
    }
}
