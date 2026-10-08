use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};
use std::future::Future;
use std::sync::Once;
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 8 * 1024;
static RUSTLS_PROVIDER: Once = Once::new();

/// Sends a non-streaming chat completion through a provider stored in the local
/// Model API settings. The provider value is read and kept on the Rust side so
/// API keys are never returned to the browser.
pub async fn complete_compatible_chat(
    provider: &Value,
    model: &str,
    system: &str,
    messages: &[Value],
    max_tokens: u32,
) -> Result<String, String> {
    let endpoint = provider
        .get("endpoint")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Model API Provider 缺少请求地址".to_string())?;
    let api_key = provider
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "该 Model API Provider 尚未配置 API Key".to_string())?;
    let model = model.trim();
    if model.is_empty() {
        return Err("Model API 模型名称不能为空".to_string());
    }

    let endpoint_url =
        reqwest::Url::parse(endpoint).map_err(|_| "Model API 请求地址无效".to_string())?;
    if !matches!(endpoint_url.scheme(), "http" | "https")
        || endpoint_url.host_str().is_none()
        || !endpoint_url.username().is_empty()
        || endpoint_url.password().is_some()
        || endpoint_url.fragment().is_some()
    {
        return Err("Model API 请求地址必须是有效的 HTTP(S) 地址".to_string());
    }

    let kind = provider
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "Model API Provider 类型无效".to_string())?;
    let payload = match kind {
        "openai-compatible" => {
            let mut request_messages = Vec::with_capacity(messages.len() + 1);
            if !system.trim().is_empty() {
                request_messages.push(json!({"role":"system","content":system}));
            }
            request_messages.extend(messages.iter().cloned());
            json!({
                "model": model,
                "stream": false,
                "max_tokens": max_tokens,
                "messages": request_messages,
            })
        }
        "anthropic-compatible" => json!({
            "model": model,
            "stream": false,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
        }),
        _ => return Err("Model API Provider 类型暂不支持文本生成".to_string()),
    };

    RUSTLS_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120));
    if let Some(proxy) = std::env::var_os("HTTPS_PROXY").or_else(|| std::env::var_os("https_proxy"))
    {
        let proxy = proxy.to_string_lossy();
        if let Ok(configured) = reqwest::Proxy::all(proxy.as_ref()) {
            builder = builder.proxy(configured);
        }
    }
    let client = builder
        .build()
        .map_err(|error| format!("创建模型接口客户端失败：{error}"))?;
    let mut request = client
        .post(endpoint_url)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .json(&payload);
    match kind {
        "openai-compatible" => {
            request = request.header(AUTHORIZATION, format!("Bearer {api_key}"));
        }
        "anthropic-compatible" => {
            request = request
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01");
        }
        _ => unreachable!("provider kind was validated"),
    }
    let response = request.send().await.map_err(|error| {
        format!(
            "连接模型接口失败：{}",
            scrub_secret(&error.to_string(), api_key)
        )
    })?;
    let status = response.status();
    let body = read_body_bounded(
        response,
        if status.is_success() {
            MAX_RESPONSE_BYTES
        } else {
            MAX_ERROR_BYTES
        },
    )
    .await
    .map_err(|error| scrub_secret(&error, api_key))?;
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&body)
            .chars()
            .take(240)
            .collect::<String>();
        let detail = scrub_secret(detail.trim(), api_key);
        return Err(if detail.is_empty() {
            format!("模型接口返回 HTTP {}", status.as_u16())
        } else {
            format!("模型接口返回 HTTP {}：{detail}", status.as_u16())
        });
    }
    let value: Value =
        serde_json::from_slice(&body).map_err(|_| "模型接口返回了无效 JSON".to_string())?;
    let text = match kind {
        "openai-compatible" => value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_string),
        "anthropic-compatible" => value
            .get("content")
            .and_then(Value::as_array)
            .and_then(|blocks| {
                blocks.iter().find_map(|block| {
                    (block.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| block.get("text").and_then(Value::as_str))
                        .flatten()
                })
            })
            .map(str::to_string),
        _ => None,
    };
    text.filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "模型接口未返回文本内容".to_string())
}

/// Streams text deltas from a compatible provider. Returning `false` from the
/// callback stops reading immediately, which lets the HTTP caller propagate
/// browser cancellation without leaving the provider request running.
pub async fn stream_compatible_chat(
    provider: &Value,
    model: &str,
    system: &str,
    messages: &[Value],
    max_tokens: u32,
    cancelled: impl Future<Output = ()>,
    mut on_text: impl FnMut(String) -> bool,
) -> Result<(), String> {
    let endpoint = provider
        .get("endpoint")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Model API Provider 缺少请求地址".to_string())?;
    let api_key = provider
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "该 Model API Provider 尚未配置 API Key".to_string())?;
    let model = model.trim();
    if model.is_empty() {
        return Err("Model API 模型名称不能为空".to_string());
    }
    let endpoint_url =
        reqwest::Url::parse(endpoint).map_err(|_| "Model API 请求地址无效".to_string())?;
    if !matches!(endpoint_url.scheme(), "http" | "https")
        || endpoint_url.host_str().is_none()
        || !endpoint_url.username().is_empty()
        || endpoint_url.password().is_some()
        || endpoint_url.fragment().is_some()
    {
        return Err("Model API 请求地址必须是有效的 HTTP(S) 地址".to_string());
    }
    let kind = provider
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "Model API Provider 类型无效".to_string())?;
    let payload = match kind {
        "openai-compatible" => {
            let mut request_messages = Vec::with_capacity(messages.len() + 1);
            if !system.trim().is_empty() {
                request_messages.push(json!({"role":"system","content":system}));
            }
            request_messages.extend(messages.iter().cloned());
            json!({
                "model": model,
                "stream": true,
                "max_tokens": max_tokens,
                "messages": request_messages,
            })
        }
        "anthropic-compatible" => json!({
            "model": model,
            "stream": true,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
        }),
        _ => return Err("Model API Provider 类型暂不支持文本生成".to_string()),
    };

    RUSTLS_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("创建模型接口客户端失败：{error}"))?;
    let mut request = client
        .post(endpoint_url)
        .header(ACCEPT, "text/event-stream")
        .header(CONTENT_TYPE, "application/json")
        .json(&payload);
    let mut cancelled = Box::pin(cancelled);
    match kind {
        "openai-compatible" => {
            request = request.header(AUTHORIZATION, format!("Bearer {api_key}"));
        }
        "anthropic-compatible" => {
            request = request
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01");
        }
        _ => unreachable!("provider kind was validated"),
    }
    let mut response = tokio::select! {
        _ = &mut cancelled => return Ok(()),
        result = tokio::time::timeout(Duration::from_secs(60), request.send()) => {
            result
                .map_err(|_| "等待模型接口响应超时".to_string())?
                .map_err(|error| format!(
                    "连接模型接口失败：{}",
                    scrub_secret(&error.to_string(), api_key)
                ))?
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let body = tokio::select! {
            _ = &mut cancelled => return Ok(()),
            result = read_body_bounded(response, MAX_ERROR_BYTES) => {
                result.map_err(|error| scrub_secret(&error, api_key))?
            }
        };
        let detail = scrub_secret(
            &String::from_utf8_lossy(&body)
                .chars()
                .take(240)
                .collect::<String>(),
            api_key,
        );
        return Err(if detail.trim().is_empty() {
            format!("模型接口返回 HTTP {}", status.as_u16())
        } else {
            format!("模型接口返回 HTTP {}：{}", status.as_u16(), detail.trim())
        });
    }

    let mut pending = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = &mut cancelled => return Ok(()),
            result = tokio::time::timeout(Duration::from_secs(60), response.chunk()) => {
                result
                    .map_err(|_| "读取模型响应超时（60 秒无数据）".to_string())?
                    .map_err(|error| format!(
                        "读取模型响应失败：{}",
                        scrub_secret(&error.to_string(), api_key)
                    ))?
            }
        };
        let Some(chunk) = chunk else {
            if !pending.is_empty() {
                let line = std::str::from_utf8(&pending)
                    .map_err(|_| "模型响应不是有效 UTF-8".to_string())?;
                if let Some(text) =
                    parse_stream_line(line, kind).map_err(|error| scrub_secret(&error, api_key))?
                {
                    let _ = on_text(text);
                }
            }
            return Ok(());
        };
        pending.extend_from_slice(&chunk);
        while let Some(line_end) = pending.iter().position(|byte| *byte == b'\n') {
            let mut bytes = pending.drain(..=line_end).collect::<Vec<_>>();
            bytes.pop();
            let line =
                std::str::from_utf8(&bytes).map_err(|_| "模型响应不是有效 UTF-8".to_string())?;
            if let Some(text) =
                parse_stream_line(line, kind).map_err(|error| scrub_secret(&error, api_key))?
            {
                if !on_text(text) {
                    return Ok(());
                }
            }
        }
        if pending.len() > 1024 * 1024 {
            return Err("模型流单行超过允许大小".to_string());
        }
    }
}

fn parse_stream_line(line: &str, kind: &str) -> Result<Option<String>, String> {
    let line = line.trim_end_matches('\r').trim();
    if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
        return Ok(None);
    }
    let Some(payload) = line.strip_prefix("data:").map(str::trim) else {
        return Ok(None);
    };
    if payload == "[DONE]" {
        return Ok(None);
    }
    let value: Value =
        serde_json::from_str(payload).map_err(|_| "解析模型流事件失败".to_string())?;
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("模型服务返回错误");
        return Err(format!(
            "模型服务错误：{}",
            message.chars().take(240).collect::<String>()
        ));
    }
    let text = match kind {
        "openai-compatible" => value
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str),
        "anthropic-compatible"
            if value.get("type").and_then(Value::as_str) == Some("content_block_delta") =>
        {
            value.pointer("/delta/text").and_then(Value::as_str)
        }
        _ => None,
    };
    Ok(text.filter(|text| !text.is_empty()).map(str::to_string))
}

async fn read_body_bounded(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = response;
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(60), response.chunk())
            .await
            .map_err(|_| "读取模型接口响应超时".to_string())?
            .map_err(|error| format!("读取模型接口响应失败：{error}"))?;
        let Some(chunk) = chunk else {
            break;
        };
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("模型接口响应超过允许大小".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn scrub_secret(message: &str, secret: &str) -> String {
    if secret.is_empty() {
        message.to_string()
    } else {
        message.replace(secret, "[已隐藏]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_endpoint_and_provider_kind_without_revealing_credentials() {
        let provider = json!({
            "kind":"openai-compatible",
            "endpoint":"file:///etc/passwd",
            "apiKey":"sensitive-value",
        });
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(complete_compatible_chat(
                &provider,
                "model",
                "system",
                &[],
                10,
            ))
            .unwrap_err();
        assert!(error.contains("HTTP(S)"));
        assert!(!error.contains("sensitive-value"));
    }

    #[test]
    fn requires_a_saved_api_key_before_requesting_a_provider() {
        let provider = json!({
            "kind":"anthropic-compatible",
            "endpoint":"https://example.invalid/v1/messages",
            "apiKey":"",
        });
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(complete_compatible_chat(
                &provider,
                "model",
                "system",
                &[],
                10,
            ))
            .unwrap_err();
        assert!(error.contains("尚未配置 API Key"));
    }

    #[test]
    fn parses_openai_and_anthropic_stream_deltas_and_ignores_terminal_markers() {
        assert_eq!(
            parse_stream_line(
                "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}",
                "openai-compatible"
            )
            .unwrap()
            .as_deref(),
            Some("hello")
        );
        assert_eq!(
            parse_stream_line(
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"你好\"}}",
                "anthropic-compatible"
            )
            .unwrap()
            .as_deref(),
            Some("你好")
        );
        assert_eq!(
            parse_stream_line("data: [DONE]", "openai-compatible").unwrap(),
            None
        );
    }
}
