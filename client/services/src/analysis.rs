use aichihongshu_db::LocalDb;
use serde_json::{json, Value};
use std::sync::Once;
use std::time::Duration;

const SETTINGS_KEY: &str = "model_api_settings_v1";
const MINIMAX_ANALYZE_URL: &str = "https://api.minimaxi.com/v1/coding_plan/vlm";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const ANALYSIS_PROMPT: &str = r#"你是一位专业的家居设计顾问。请分析这张家居物品图片，用 JSON 格式返回以下字段：

{
  "title": "物品名称（简洁，10字以内）",
  "style": "设计风格（如：现代简约/北欧/中式/工业/法式/日式/混搭，选最符合的1-2个）",
  "material": "主要材质（如：实木/大理石/藤编/金属/布艺/玻璃等）",
  "color": "主色调（如：米白/原木色/深灰/莫兰迪绿等）",
  "scene": "适用场景（如：客厅/卧室/书房/餐厅/玄关/阳台等）",
  "tags": ["标签1", "标签2", "标签3", "标签4", "标签5"],
  "pairing_suggestions": "搭配建议（2-3句话，说明如何与其他家居搭配）",
  "xhs_selling_points": ["小红书卖点1", "小红书卖点2", "小红书卖点3"]
}

tags 要包含：风格词、材质词、场景词、情绪词（如治愈/高级感/温暖），共5个左右。
xhs_selling_points 是最适合在小红书内容中突出的卖点，口语化，有情绪价值。
只返回 JSON，不要其他说明文字。"#;

static RUSTLS_PROVIDER: Once = Once::new();

fn read_dotenv_key(key: &str) -> Option<String> {
    let contents = std::fs::read_to_string(std::env::current_dir().ok()?.join(".env")).ok()?;
    contents.lines().find_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let (name, value) = line.split_once('=')?;
        if name.trim() != key {
            return None;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|value| value.strip_suffix('\''))
            })
            .unwrap_or(value)
            .trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn configured_minimax_key(db: &LocalDb) -> Result<Option<String>, String> {
    let Some(raw) = db.get_app_setting(SETTINGS_KEY)? else {
        return Ok(None);
    };
    let settings: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("解析模型配置失败，无法读取 MiniMax 密钥：{error}"))?;
    Ok(settings
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|providers| {
            providers
                .iter()
                .find(|provider| provider.get("id").and_then(Value::as_str) == Some("minimax"))
        })
        .and_then(|provider| provider.get("apiKey").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

fn minimax_key(db: &LocalDb) -> Result<String, String> {
    if let Some(key) = configured_minimax_key(db)? {
        return Ok(key);
    }
    for key in ["MINIMAX_API_KEY", "AICHIHONGSHU_MINIMAX_API_KEY"] {
        if let Some(value) = std::env::var(key)
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            return Ok(value.trim().to_string());
        }
        if let Some(value) = read_dotenv_key(key) {
            return Ok(value);
        }
    }
    Err("未配置 MiniMax Token Plan 密钥；请在模型设置中配置 MiniMax API Key，或临时设置 MINIMAX_API_KEY".to_string())
}

fn response_content(body: &Value) -> Result<&str, String> {
    let status_code = body
        .get("base_resp")
        .and_then(|base_resp| base_resp.get("status_code"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if status_code != 0 {
        let message = body
            .get("base_resp")
            .and_then(|base_resp| base_resp.get("status_msg"))
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(format!("MiniMax API 错误 {status_code}：{message}"));
    }
    body.get("content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .ok_or_else(|| "MiniMax API 未返回内容".to_string())
}

async fn read_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取 MiniMax 图片分析结果失败：{error}"))?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err("MiniMax 图片分析响应超过允许大小".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn parse_analysis_response(body: &Value) -> Result<Value, String> {
    let raw = response_content(body)?;
    let cleaned = if raw.starts_with("```") {
        let lines: Vec<&str> = raw.split('\n').collect();
        let start = 1;
        let end = if lines.last().is_some_and(|line| line.trim() == "```") {
            lines.len().saturating_sub(1)
        } else {
            lines.len()
        };
        lines[start..end].join("\n")
    } else {
        raw.to_string()
    };
    let mut analysis = match serde_json::from_str::<Value>(&cleaned) {
        Ok(Value::Object(map)) => Value::Object(map),
        Ok(other) => json!({"raw_text": other.to_string(), "parse_error": true}),
        Err(_) => json!({"raw_text": cleaned, "parse_error": true}),
    };
    if let Value::Object(fields) = &mut analysis {
        fields.insert("_raw_response".into(), Value::String(cleaned));
    }
    Ok(analysis)
}

fn analysis_payload(data_url: &str) -> Value {
    json!({"prompt": ANALYSIS_PROMPT, "image_url": data_url})
}

async fn analyze_data_url_at(
    endpoint: &str,
    api_key: &str,
    data_url: &str,
) -> Result<Value, String> {
    RUSTLS_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| format!("创建图片分析客户端失败：{error}"))?;
    let response = client
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("MM-API-Source", "rn-home-app")
        .bearer_auth(api_key)
        .json(&analysis_payload(data_url))
        .send()
        .await
        .map_err(|error| format!("连接 MiniMax 图片分析接口失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = read_limited(response, 8 * 1024)
            .await
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        return Err(if body.trim().is_empty() {
            format!("MiniMax 图片分析接口返回 HTTP {}", status.as_u16())
        } else {
            format!(
                "MiniMax 图片分析接口返回 HTTP {}：{}",
                status.as_u16(),
                body.trim()
            )
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_RESPONSE_BYTES)
    {
        return Err("MiniMax 图片分析响应超过允许大小".to_string());
    }
    let bytes = read_limited(response, MAX_RESPONSE_BYTES).await?;
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("解析 MiniMax 图片分析响应失败：{error}"))?;
    parse_analysis_response(&body)
}

pub fn analyze_data_url(db: &LocalDb, data_url: &str) -> Result<Value, String> {
    if !data_url.starts_with("data:image/") || !data_url.contains(";base64,") {
        return Err("图片数据格式无效，要求 base64 data URL".to_string());
    }
    let api_key = minimax_key(db)?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("启动图片分析运行时失败：{error}"))?
        .block_on(analyze_data_url_at(MINIMAX_ANALYZE_URL, &api_key, data_url))
}

pub fn analyze_file(db: &LocalDb, path: &std::path::Path) -> Result<Value, String> {
    if !path.is_file() {
        return Err(format!("图片不存在：{}", path.display()));
    }
    let mime = match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    };
    let bytes = std::fs::read(path).map_err(|error| format!("读取图片失败：{error}"))?;
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    analyze_data_url(db, &format!("data:{mime};base64,{encoded}"))
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_data_url_at, configured_minimax_key, parse_analysis_response, response_content,
    };
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn parses_json_fences_and_preserves_raw_model_text() {
        let parsed = parse_analysis_response(&json!({
            "content": "```json\n{\"title\":\"藤编椅\",\"tags\":[\"北欧\"]}\n```"
        }))
        .unwrap();
        assert_eq!(parsed["title"], "藤编椅");
        assert_eq!(
            parsed["_raw_response"],
            "{\"title\":\"藤编椅\",\"tags\":[\"北欧\"]}"
        );
    }

    #[test]
    fn malformed_model_json_remains_available_as_raw_text() {
        let parsed = parse_analysis_response(&json!({"content":"不是 JSON"})).unwrap();
        assert_eq!(parsed["raw_text"], "不是 JSON");
        assert_eq!(parsed["parse_error"], true);
    }

    #[test]
    fn rejects_minimax_api_errors_and_missing_content() {
        assert!(response_content(&json!({
            "base_resp":{"status_code":1001,"status_msg":"bad key"}, "content":"{}"
        }))
        .unwrap_err()
        .contains("1001"));
        assert!(response_content(&json!({"content":" "})).is_err());
    }

    #[test]
    fn reads_minimax_key_from_app_provider_setting() {
        let root = std::env::temp_dir().join(format!("rn-analysis-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let db_path = root.join("app.db");
        let db = aichihongshu_db::LocalDb::open(db_path).unwrap();
        db.set_app_setting(
            super::SETTINGS_KEY,
            r#"{"providers":[{"id":"openai","apiKey":"ignored"},{"id":"minimax","apiKey":"stored-secret"}]}"#,
        )
        .unwrap();
        assert_eq!(
            configured_minimax_key(&db).unwrap().as_deref(),
            Some("stored-secret")
        );
        drop(db);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn builds_the_legacy_minimax_vlm_payload() {
        let payload = super::analysis_payload("data:image/png;base64,aGVsbG8=");
        assert_eq!(payload["image_url"], "data:image/png;base64,aGVsbG8=");
        assert!(payload["prompt"].as_str().unwrap().contains("只返回 JSON"));
    }

    #[test]
    #[ignore = "sandbox policy forbids local TCP listeners; run on an unrestricted test host"]
    fn sends_the_legacy_minimax_vlm_contract_and_parses_its_result() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock MiniMax server");
        let address = listener.local_addr().expect("read mock address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept image analysis");
            let mut request = Vec::new();
            let mut buffer = [0u8; 8192];
            loop {
                let read = stream.read(&mut buffer).expect("read HTTP request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                let Some(headers_end) = request.windows(4).position(|part| part == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..headers_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if request.len() >= headers_end + 4 + content_length {
                    break;
                }
            }
            let body = json!({
                "base_resp": {"status_code": 0},
                "content": "```json\n{\"title\":\"藤编椅\",\"style\":\"北欧\"}\n```"
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write HTTP headers");
            stream
                .write_all(body.as_bytes())
                .expect("write MiniMax JSON");
            stream.flush().expect("flush MiniMax response");
            request
        });
        let endpoint = format!("http://{address}/v1/coding_plan/vlm");
        let parsed = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("build test runtime")
            .block_on(analyze_data_url_at(
                &endpoint,
                "test-secret",
                "data:image/png;base64,aGVsbG8=",
            ))
            .expect("analyze image through the compatible endpoint");
        let request = String::from_utf8_lossy(&server.join().expect("mock server should finish"))
            .into_owned();
        assert!(request.starts_with("POST /v1/coding_plan/vlm HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-secret"));
        assert!(request
            .to_ascii_lowercase()
            .contains("mm-api-source: rn-home-app"));
        assert!(request.contains("data:image/png;base64,aGVsbG8="));
        assert_eq!(parsed["title"], "藤编椅");
        assert_eq!(parsed["style"], "北欧");
    }
}
