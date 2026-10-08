use super::{ModelApiProviderConfig, ModelApiProviderKind};
use serde_json::Value;
use std::sync::{Once, OnceLock};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ERROR_BODY_BYTES: usize = 8 * 1024;
const MAX_MODELS_BODY_BYTES: usize = 1024 * 1024;
const MAX_PENDING_SSE_LINE_BYTES: usize = 1024 * 1024;

static RUSTLS_PROVIDER: Once = Once::new();
static HTTP_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

fn client() -> Result<reqwest::Client, String> {
    RUSTLS_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    HTTP_CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .build()
                .map_err(|error| format!("创建模型接口客户端失败: {error}"))
        })
        .clone()
}

fn endpoint_request(
    client: &reqwest::Client,
    provider: &ModelApiProviderConfig,
    url: &str,
) -> reqwest::RequestBuilder {
    let request = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json");
    match provider.kind {
        ModelApiProviderKind::OpenaiCompatible => request.header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", provider.api_key.trim()),
        ),
        ModelApiProviderKind::AnthropicCompatible => request
            .header("x-api-key", provider.api_key.trim())
            .header("anthropic-version", "2023-06-01"),
    }
}

fn completion_request(
    client: &reqwest::Client,
    provider: &ModelApiProviderConfig,
    model: &str,
    prompt: &str,
) -> reqwest::RequestBuilder {
    let payload = match provider.kind {
        ModelApiProviderKind::OpenaiCompatible => serde_json::json!({
            "model": model,
            "stream": true,
            "messages": [{ "role": "user", "content": prompt }],
        }),
        ModelApiProviderKind::AnthropicCompatible => serde_json::json!({
            "model": model,
            "stream": true,
            "max_tokens": 4096,
            "messages": [{ "role": "user", "content": prompt }],
        }),
    };
    let request = client
        .post(provider.endpoint.trim())
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&payload);
    match provider.kind {
        ModelApiProviderKind::OpenaiCompatible => request.header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", provider.api_key.trim()),
        ),
        ModelApiProviderKind::AnthropicCompatible => request
            .header("x-api-key", provider.api_key.trim())
            .header("anthropic-version", "2023-06-01"),
    }
}

async fn read_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = tokio::time::timeout(RESPONSE_IDLE_TIMEOUT, response.chunk())
        .await
        .map_err(|_| "读取模型接口响应超时".to_string())?
        .map_err(|error| format!("读取模型接口响应失败: {error}"))?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err("模型接口响应超过允许大小".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn error_message(response: reqwest::Response) -> String {
    let status = response.status();
    match read_limited(response, MAX_ERROR_BODY_BYTES).await {
        Ok(body) => {
            let summary: String = String::from_utf8_lossy(&body).chars().take(240).collect();
            if summary.is_empty() {
                format!("模型接口返回 HTTP {}", status.as_u16())
            } else {
                format!("模型接口返回 HTTP {}：{summary}", status.as_u16())
            }
        }
        Err(_) => format!("模型接口返回 HTTP {}", status.as_u16()),
    }
}

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

pub(super) async fn list_models(provider: &ModelApiProviderConfig) -> Result<Vec<String>, String> {
    if provider.api_key.trim().is_empty() {
        return Err("请先填写 API Key".to_string());
    }
    let client = client()?;
    let response = tokio::time::timeout(
        Duration::from_secs(30),
        endpoint_request(&client, provider, &models_endpoint(&provider.endpoint)).send(),
    )
    .await
    .map_err(|_| "读取模型列表超时".to_string())?
    .map_err(|error| format!("连接模型接口失败: {error}"))?;
    if !response.status().is_success() {
        return Err(error_message(response).await);
    }
    let body = read_limited(response, MAX_MODELS_BODY_BYTES).await?;
    let value: Value =
        serde_json::from_slice(&body).map_err(|error| format!("解析模型列表失败: {error}"))?;
    let mut models = Vec::new();
    if let Some(items) = value.get("data").and_then(Value::as_array) {
        for item in items {
            if let Some(id) = item
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
            {
                if !models.iter().any(|existing| existing == id) {
                    models.push(id.to_string());
                }
            }
        }
    }
    if models.is_empty() {
        return Err("模型列表为空，请检查 Endpoint 是否支持 /models".to_string());
    }
    Ok(models)
}

#[derive(Debug, PartialEq, Eq)]
enum SseEvent {
    Continue,
    Done,
    Text(String),
}

fn parse_sse_line(line: &str, kind: ModelApiProviderKind) -> Result<SseEvent, String> {
    let line = line.trim_end_matches('\r').trim();
    if line.is_empty() || line.starts_with(':') {
        return Ok(SseEvent::Continue);
    }
    if let Some(event) = line.strip_prefix("event:").map(str::trim) {
        return Ok(if event == "message_stop" {
            SseEvent::Done
        } else {
            SseEvent::Continue
        });
    }
    let Some(payload) = line.strip_prefix("data:").map(str::trim) else {
        return Ok(SseEvent::Continue);
    };
    if payload == "[DONE]" {
        return Ok(SseEvent::Done);
    }
    let value: Value =
        serde_json::from_str(payload).map_err(|error| format!("解析模型流事件失败: {error}"))?;
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("模型服务返回错误");
        return Err(format!("模型服务错误：{message}"));
    }
    let text = match kind {
        ModelApiProviderKind::OpenaiCompatible => value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("delta"))
            .and_then(|delta| delta.get("content"))
            .and_then(Value::as_str),
        ModelApiProviderKind::AnthropicCompatible => {
            if value.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                None
            } else {
                value
                    .get("delta")
                    .and_then(|delta| delta.get("text"))
                    .and_then(Value::as_str)
            }
        }
    };
    Ok(text
        .filter(|text| !text.is_empty())
        .map(|text| SseEvent::Text(text.to_string()))
        .unwrap_or(SseEvent::Continue))
}

async fn open_stream(
    provider: &ModelApiProviderConfig,
    model: &str,
    prompt: &str,
) -> Result<reqwest::Response, String> {
    if provider.api_key.trim().is_empty() {
        return Err("该 Provider 未配置 API Key".to_string());
    }
    if provider.endpoint.trim().is_empty() {
        return Err("该 Provider 未配置 Endpoint".to_string());
    }
    let client = client()?;
    let response = tokio::time::timeout(
        RESPONSE_IDLE_TIMEOUT,
        completion_request(&client, provider, model, prompt).send(),
    )
    .await
    .map_err(|_| "等待模型接口响应超时".to_string())?
    .map_err(|error| format!("连接模型接口失败: {error}"))?;
    if !response.status().is_success() {
        return Err(error_message(response).await);
    }
    Ok(response)
}

pub(super) async fn run_stream_cancellable(
    provider: &ModelApiProviderConfig,
    model: &str,
    prompt: &str,
    mut on_text: impl FnMut(String) -> bool,
) -> Result<(), String> {
    let mut response = open_stream(provider, model, prompt).await?;
    let mut pending = Vec::new();
    loop {
        let chunk = tokio::time::timeout(RESPONSE_IDLE_TIMEOUT, response.chunk())
            .await
            .map_err(|_| "读取模型响应超时（60 秒无数据）".to_string())?
            .map_err(|error| format!("读取模型响应失败: {error}"))?;
        let Some(chunk) = chunk else {
            if !pending.is_empty() {
                let line = std::str::from_utf8(&pending)
                    .map_err(|error| format!("模型响应不是有效 UTF-8: {error}"))?;
                if let SseEvent::Text(text) = parse_sse_line(line, provider.kind)? {
                    let _ = on_text(text);
                }
            }
            return Ok(());
        };
        pending.extend_from_slice(&chunk);
        while let Some(line_end) = pending.iter().position(|byte| *byte == b'\n') {
            let mut bytes = pending.drain(..=line_end).collect::<Vec<_>>();
            bytes.pop();
            let line = std::str::from_utf8(&bytes)
                .map_err(|error| format!("模型响应不是有效 UTF-8: {error}"))?;
            match parse_sse_line(line, provider.kind)? {
                SseEvent::Continue => {}
                SseEvent::Done => return Ok(()),
                SseEvent::Text(text) => {
                    if !on_text(text) {
                        return Ok(());
                    }
                }
            }
        }
        if pending.len() > MAX_PENDING_SSE_LINE_BYTES {
            return Err("模型流单行超过允许大小".to_string());
        }
    }
}

pub(super) async fn test_provider(provider: &ModelApiProviderConfig) -> Result<String, String> {
    let model = if provider.model.trim().is_empty() {
        provider.enabled_models.first().cloned().unwrap_or_default()
    } else {
        provider.model.clone()
    };
    if model.trim().is_empty() {
        return Err("请先填写模型名称".to_string());
    }
    let mut collected = String::new();
    run_stream_cancellable(provider, &model, "Reply with a short greeting.", |delta| {
        let remaining = 40usize.saturating_sub(collected.chars().count());
        collected.extend(delta.chars().take(remaining));
        collected.chars().count() < 40
    })
    .await?;
    if collected.trim().is_empty() {
        Ok("连接成功，但本次未返回文本".to_string())
    } else {
        Ok(format!("连接成功，样例输出：{collected}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{list_models, models_endpoint, parse_sse_line, run_stream_cancellable, SseEvent};
    use crate::model_api::{ModelApiProviderConfig, ModelApiProviderKind};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};

    fn provider(endpoint: String) -> ModelApiProviderConfig {
        ModelApiProviderConfig {
            id: "mock".to_string(),
            kind: ModelApiProviderKind::OpenaiCompatible,
            label: "Mock provider".to_string(),
            endpoint,
            api_key: "test-key".to_string(),
            model: "mock-model".to_string(),
            vision_model: String::new(),
            enabled_models: vec!["mock-model".to_string()],
            builtin: false,
            preset: None,
        }
    }

    fn mock_server(response: Vec<u8>) -> (String, Arc<Mutex<Vec<u8>>>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock HTTP server");
        let address = listener.local_addr().expect("read mock server address");
        let request = Arc::new(Mutex::new(Vec::new()));
        let captured_request = Arc::clone(&request);
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept mock request");
            let mut request_bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = stream.read(&mut buffer).expect("read mock request");
                if read == 0 {
                    break;
                }
                request_bytes.extend_from_slice(&buffer[..read]);
                let Some(headers_end) = request_bytes
                    .windows(4)
                    .position(|part| part == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request_bytes[..headers_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if request_bytes.len() >= headers_end + 4 + content_length {
                    break;
                }
            }
            *captured_request.lock().expect("lock captured request") = request_bytes;
            let _ = stream.write_all(&response);
            let _ = stream.flush();
        });
        (format!("http://{address}"), request, server)
    }

    fn response(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    fn append_chunk(response: &mut Vec<u8>, chunk: &[u8]) {
        response.extend_from_slice(format!("{:X}\r\n", chunk.len()).as_bytes());
        response.extend_from_slice(chunk);
        response.extend_from_slice(b"\r\n");
    }

    #[test]
    fn models_endpoint_handles_compatible_paths() {
        assert_eq!(
            models_endpoint("https://example.test/v1/chat/completions"),
            "https://example.test/v1/models"
        );
        assert_eq!(
            models_endpoint("https://example.test/anthropic/v1/messages"),
            "https://example.test/anthropic/v1/models"
        );
    }

    #[test]
    fn openai_sse_reports_text_done_and_service_errors() {
        assert_eq!(
            parse_sse_line(
                "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}",
                ModelApiProviderKind::OpenaiCompatible
            )
            .unwrap(),
            SseEvent::Text("hello".to_string())
        );
        assert_eq!(
            parse_sse_line("data: [DONE]", ModelApiProviderKind::OpenaiCompatible).unwrap(),
            SseEvent::Done
        );
        assert!(parse_sse_line(
            "data: {\"error\":{\"message\":\"bad key\"}}",
            ModelApiProviderKind::OpenaiCompatible
        )
        .is_err());
    }

    #[test]
    fn anthropic_sse_reports_text_and_terminal_event() {
        assert_eq!(
            parse_sse_line(
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"你好\"}}",
                ModelApiProviderKind::AnthropicCompatible
            )
            .unwrap(),
            SseEvent::Text("你好".to_string())
        );
        assert_eq!(
            parse_sse_line(
                "event: message_stop",
                ModelApiProviderKind::AnthropicCompatible
            )
            .unwrap(),
            SseEvent::Done
        );
    }

    #[test]
    fn list_models_uses_authorized_request_and_deduplicates_results() {
        let body = br#"{"data":[{"id":"model-a"},{"id":"model-a"},{"id":"model-b"}]}"#;
        let (base_url, request, server) = mock_server(response("200 OK", "application/json", body));
        let provider = provider(format!("{base_url}/v1/chat/completions"));

        let models = tauri::async_runtime::block_on(list_models(&provider))
            .expect("mock model list should load");
        assert_eq!(models, vec!["model-a", "model-b"]);
        server.join().expect("mock server should finish");

        let request = String::from_utf8_lossy(&request.lock().expect("lock request")).into_owned();
        assert!(request.starts_with("GET /v1/models HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-key"));
    }

    #[test]
    fn list_models_returns_status_without_leaking_oversized_error_body() {
        let body = vec![b'x'; 16 * 1024];
        let (base_url, _, server) = mock_server(response("401 Unauthorized", "text/plain", &body));
        let provider = provider(format!("{base_url}/v1/chat/completions"));

        let error = tauri::async_runtime::block_on(list_models(&provider))
            .expect_err("unauthorized mock response should fail");
        assert!(error.contains("HTTP 401"));
        assert!(error.len() < 300);
        server.join().expect("mock server should finish");
    }

    #[test]
    fn stream_handles_transport_chunk_boundaries_and_stops_after_callback_cancels() {
        let (base_url, request, server) = mock_server({
            let event = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n";
            let bytes = event.as_bytes();
            let split = bytes
                .iter()
                .position(|byte| *byte >= 0x80)
                .expect("event should contain UTF-8 bytes")
                + 1;
            let mut response = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
            append_chunk(&mut response, &bytes[..split]);
            append_chunk(&mut response, &bytes[split..]);
            append_chunk(
                &mut response,
                b"data: {\"choices\":[{\"delta\":{\"content\":\"must not be delivered\"}}]}\n\n",
            );
            response.extend_from_slice(b"0\r\n\r\n");
            response
        });
        let provider = provider(format!("{base_url}/v1/chat/completions"));
        let mut deltas = Vec::new();

        tauri::async_runtime::block_on(run_stream_cancellable(
            &provider,
            "mock-model",
            "hello",
            |delta| {
                deltas.push(delta);
                false
            },
        ))
        .expect("mock stream should stop on callback cancellation");
        server.join().expect("mock server should finish");

        assert_eq!(deltas, vec!["你好"]);
        let request = String::from_utf8_lossy(&request.lock().expect("lock request")).into_owned();
        assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
        assert!(request.contains("\"model\":\"mock-model\""));
    }
}
