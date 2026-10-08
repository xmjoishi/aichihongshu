//! Chrome/Edge Native Messaging adapter, implemented in the desktop executable.
//! It forwards one bounded JSON frame to the app's owner-only Unix socket.

use serde_json::Value;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::time::Duration;

const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 160 * 1024;
const SOCKET_TIMEOUT: Duration = Duration::from_secs(3);
const CAPTURE_IMAGE_CHUNK_TIMEOUT: Duration = Duration::from_secs(10);
const CAPTURE_IMAGE_FINISH_TIMEOUT: Duration = Duration::from_secs(30);

fn socket_timeout_for_message(message: &Value) -> Duration {
    match message.get("action").and_then(Value::as_str) {
        Some("finish_capture_image_upload") => CAPTURE_IMAGE_FINISH_TIMEOUT,
        Some(
            "begin_capture_image_upload"
            | "write_capture_image_chunk"
            | "fail_capture_image_upload",
        ) => CAPTURE_IMAGE_CHUNK_TIMEOUT,
        _ => SOCKET_TIMEOUT,
    }
}

pub fn run() -> i32 {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    match process_frames(&mut input, &mut output, forward_message) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

fn process_frames(
    input: &mut impl Read,
    output: &mut impl Write,
    mut dispatch: impl FnMut(&[u8]) -> Value,
) -> Result<(), String> {
    loop {
        let Some(message) =
            read_frame(input).map_err(|error| format!("Native Messaging frame error: {error}"))?
        else {
            return Ok(());
        };
        let response = dispatch(&message);
        write_frame_to(output, &response)
            .map_err(|error| format!("Native Messaging response error: {error}"))?;
    }
}

fn read_frame(input: &mut impl Read) -> Result<Option<Vec<u8>>, String> {
    let mut header = [0_u8; 4];
    if input
        .read(&mut header[..1])
        .map_err(|error| format!("读取消息长度失败: {error}"))?
        == 0
    {
        return Ok(None);
    }
    input
        .read_exact(&mut header[1..])
        .map_err(|error| format!("读取消息长度失败: {error}"))?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err(format!("消息长度无效: {length}"));
    }
    let mut payload = vec![0; length];
    input
        .read_exact(&mut payload)
        .map_err(|error| format!("读取消息失败: {error}"))?;
    Ok(Some(payload))
}

fn write_frame_to(output: &mut impl Write, value: &Value) -> Result<(), String> {
    let payload = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if payload.len() > MAX_RESPONSE_BYTES {
        return Err("Native Messaging 响应超过 160KB".to_string());
    }
    let length = u32::try_from(payload.len()).map_err(|error| error.to_string())?;
    output
        .write_all(&length.to_le_bytes())
        .and_then(|_| output.write_all(&payload))
        .and_then(|_| output.flush())
        .map_err(|error| error.to_string())
}

fn forward_message(raw: &[u8]) -> Value {
    let Ok(message) = serde_json::from_slice::<Value>(raw) else {
        return serde_json::json!({"ok": false, "errorCode": "INVALID_MESSAGE", "error": "剪藏消息不是有效 JSON"});
    };
    let channel = crate::browser_capture::runtime_channel();
    let expected_channel = message.get("expectedChannel").and_then(Value::as_str);
    if expected_channel.is_some_and(|expected| expected != channel) {
        return serde_json::json!({
            "ok": false,
            "errorCode": "CHANNEL_MISMATCH",
            "error": "所选桌面通道不匹配",
            "channel": channel,
            "protocolVersion": crate::browser_capture::PROTOCOL_VERSION,
        });
    }
    match message.get("action").and_then(Value::as_str) {
        Some("list_capture_instances") => {
            return serde_json::json!({
                "ok": true,
                "status": "instances",
                "channel": channel,
                "protocolVersion": crate::browser_capture::PROTOCOL_VERSION,
                "instances": crate::browser_capture::list_capture_instances(channel),
            });
        }
        Some("launch_capture_instance") => {
            let workspace_id = message
                .get("targetWorkspaceId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            return match crate::browser_capture::launch_capture_instance(channel, workspace_id) {
                Ok(()) => serde_json::json!({
                    "ok": true,
                    "status": "launch_requested",
                    "channel": channel,
                    "workspaceId": workspace_id,
                    "protocolVersion": crate::browser_capture::PROTOCOL_VERSION,
                }),
                Err(code) => serde_json::json!({
                    "ok": false,
                    "errorCode": code,
                    "error": if code == "INSTANCE_START_FAILED" { "启动对应桌面实例失败" } else { "所选桌面实例未注册" },
                    "channel": channel,
                    "workspaceId": workspace_id,
                    "protocolVersion": crate::browser_capture::PROTOCOL_VERSION,
                }),
            };
        }
        _ => {}
    }

    // Explicit QA socket override remains a test seam and never participates in
    // production instance discovery or automatic fallback.
    if let Ok(path) = std::env::var("AICHIHONGSHU_CAPTURE_SOCKET") {
        if !path.trim().is_empty() {
            return forward_message_to(raw, std::path::Path::new(path.trim()));
        }
    }

    let selected_workspace = message
        .get("expectedWorkspaceId")
        .and_then(Value::as_str)
        .filter(|workspace| !workspace.is_empty());
    let socket = if let Some(workspace_id) = selected_workspace {
        match crate::browser_capture::capture_instance_socket(channel, workspace_id) {
            Ok(path) => path,
            Err(code) => {
                return serde_json::json!({
                    "ok": false,
                    "errorCode": code,
                    "error": "所选桌面实例注册不可用；请显式选择实例或重新注册",
                    "channel": channel,
                    "workspaceId": workspace_id,
                    "protocolVersion": crate::browser_capture::PROTOCOL_VERSION,
                })
            }
        }
    } else {
        let online = crate::browser_capture::list_capture_instances(channel)
            .into_iter()
            .filter(|instance| instance.online)
            .collect::<Vec<_>>();
        if online.len() != 1 {
            let code = if online.is_empty() {
                "INSTANCE_OFFLINE"
            } else {
                "INSTANCE_SELECTION_REQUIRED"
            };
            return serde_json::json!({
                "ok": false,
                "errorCode": code,
                "error": if online.is_empty() { "没有在线的匹配桌面实例" } else { "有多个桌面实例，请先选择目标" },
                "channel": channel,
                "protocolVersion": crate::browser_capture::PROTOCOL_VERSION,
                "instances": crate::browser_capture::list_capture_instances(channel),
            });
        }
        match crate::browser_capture::capture_instance_socket(channel, &online[0].workspace_id) {
            Ok(path) => path,
            Err(code) => {
                return serde_json::json!({"ok": false, "errorCode": code, "channel": channel})
            }
        }
    };
    forward_message_to(raw, &socket)
}

fn forward_message_to(raw: &[u8], socket_path: &std::path::Path) -> Value {
    let Ok(message) = serde_json::from_slice::<Value>(raw) else {
        return serde_json::json!({"ok": false, "error": "剪藏消息不是有效 JSON"});
    };
    let Ok(encoded) = serde_json::to_vec(&message) else {
        return serde_json::json!({"ok": false, "error": "剪藏消息编码失败"});
    };
    let socket_timeout = socket_timeout_for_message(&message);

    let result = (|| -> Result<Value, String> {
        let mut stream =
            UnixStream::connect(socket_path).map_err(|_| "无法连接所选桌面实例".to_string())?;
        stream
            .set_read_timeout(Some(socket_timeout))
            .map_err(|error| socket_io_message("设置回执读取超时失败", error))?;
        stream
            .set_write_timeout(Some(socket_timeout))
            .map_err(|error| socket_io_message("设置请求发送超时失败", error))?;
        stream
            .write_all(&encoded)
            .and_then(|_| stream.write_all(b"\n"))
            .map_err(|error| socket_io_message("发送到桌面应用失败", error))?;
        stream
            .shutdown(Shutdown::Write)
            .map_err(|error| format!("结束消息发送失败: {error}"))?;

        let mut response = Vec::new();
        let mut chunk = [0_u8; 2048];
        loop {
            let read = stream
                .read(&mut chunk)
                .map_err(|error| socket_io_message("读取桌面应用回执失败", error))?;
            if read == 0 {
                break;
            }
            let newline = chunk[..read].iter().position(|byte| *byte == b'\n');
            let take = newline.unwrap_or(read);
            if response.len() + take > MAX_RESPONSE_BYTES {
                return Err("桌面应用回执超过 160KB".to_string());
            }
            response.extend_from_slice(&chunk[..take]);
            if newline.is_some() {
                break;
            }
        }
        if response.is_empty() {
            return Err("桌面应用没有返回回执".to_string());
        }
        serde_json::from_slice(&response).map_err(|_| "桌面应用回执不是有效 JSON".to_string())
    })();

    let mut response = match result {
        Ok(response) if response.is_object() => response,
        Ok(_) => {
            serde_json::json!({"ok": false, "errorCode": "UNKNOWN_ERROR", "error": "桌面应用回执格式无效"})
        }
        Err(error) => {
            let error_code = if error == "无法连接所选桌面实例" {
                "INSTANCE_OFFLINE"
            } else if error.starts_with("NATIVE_TIMEOUT:") {
                "UNKNOWN_TIMEOUT"
            } else {
                "UNKNOWN_ERROR"
            };
            serde_json::json!({"ok": false, "errorCode": error_code, "error": error})
        }
    };
    if let Some(object) = response.as_object_mut() {
        if object.get("ok").and_then(Value::as_bool) == Some(false)
            && object.get("errorCode").is_none()
        {
            let error = object
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let error_code = if error.starts_with("NATIVE_TIMEOUT:") {
                "UNKNOWN_TIMEOUT"
            } else {
                "UNKNOWN_ERROR"
            };
            object.insert(
                "errorCode".to_string(),
                Value::String(error_code.to_string()),
            );
        }
        object.entry("channel".to_string()).or_insert(Value::String(
            crate::browser_capture::runtime_channel().to_string(),
        ));
        object
            .entry("workspaceId".to_string())
            .or_insert(Value::String(crate::browser_capture::workspace_identity()));
        object
            .entry("appVersion".to_string())
            .or_insert(Value::String(env!("CARGO_PKG_VERSION").to_string()));
    }
    response
}

fn socket_io_message(context: &str, error: std::io::Error) -> String {
    let prefix = if matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    ) {
        "NATIVE_TIMEOUT: "
    } else {
        ""
    };
    format!("{prefix}{context}: {error}")
}

#[cfg(test)]
mod tests {
    use super::{
        forward_message, forward_message_to, process_frames, read_frame,
        socket_timeout_for_message, CAPTURE_IMAGE_CHUNK_TIMEOUT, CAPTURE_IMAGE_FINISH_TIMEOUT,
        MAX_MESSAGE_BYTES, MAX_RESPONSE_BYTES, SOCKET_TIMEOUT,
    };
    use serde_json::{json, Value};
    use std::io::{BufRead, BufReader, Cursor, Write};
    use std::os::unix::net::UnixListener;
    use std::sync::Arc;

    #[test]
    fn native_host_reports_invalid_json_without_opening_socket() {
        let response = forward_message(b"not-json");
        assert_eq!(
            response,
            json!({"ok": false, "errorCode": "INVALID_MESSAGE", "error": "剪藏消息不是有效 JSON"})
        );
    }

    #[test]
    fn native_messaging_frame_cap_matches_extension_host_contract() {
        assert_eq!(MAX_MESSAGE_BYTES, 256 * 1024);
        assert_eq!(MAX_RESPONSE_BYTES, 160 * 1024);
    }

    #[test]
    fn native_image_transfer_timeout_allows_local_thumbnail_persistence() {
        assert_eq!(
            socket_timeout_for_message(&json!({"action":"write_capture_image_chunk"})),
            CAPTURE_IMAGE_CHUNK_TIMEOUT
        );
        assert_eq!(
            socket_timeout_for_message(&json!({"action":"finish_capture_image_upload"})),
            CAPTURE_IMAGE_FINISH_TIMEOUT
        );
        assert_eq!(
            socket_timeout_for_message(&json!({"action":"lookup_capture_request"})),
            SOCKET_TIMEOUT
        );
    }

    #[test]
    fn native_host_reads_a_persistent_port_until_clean_eof() {
        let mut bytes = Vec::new();
        for payload in [
            br#"{"action":"ping"}"#.as_slice(),
            br#"{"action":"next"}"#.as_slice(),
        ] {
            bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            bytes.extend_from_slice(payload);
        }
        let mut input = std::io::Cursor::new(bytes);
        assert_eq!(
            read_frame(&mut input).unwrap(),
            Some(br#"{"action":"ping"}"#.to_vec())
        );
        assert_eq!(
            read_frame(&mut input).unwrap(),
            Some(br#"{"action":"next"}"#.to_vec())
        );
        assert_eq!(read_frame(&mut input).unwrap(), None);
    }

    #[test]
    fn native_host_forwards_one_json_line_and_returns_the_socket_ack() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let socket_path =
            std::path::PathBuf::from(format!("/tmp/ah-nmh-{}-{stamp}.sock", std::process::id()));
        let listener = UnixListener::bind(&socket_path).expect("test socket should bind");
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("host should connect");
            let mut line = String::new();
            BufReader::new(stream.try_clone().expect("clone stream"))
                .read_line(&mut line)
                .expect("read request");
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap(),
                json!({"action": "ping"})
            );
            stream
                .write_all(
                    b"{\"ok\":true,\"status\":\"ready\",\"workspaceId\":\"actual-desktop\"}\n",
                )
                .expect("write acknowledgement");
        });
        let response = forward_message_to(br#"{"action":"ping"}"#, &socket_path);
        worker.join().expect("socket worker should finish");
        let _ = std::fs::remove_file(socket_path);
        assert_eq!(response["ok"], true);
        assert_eq!(response["status"], "ready");
        assert_eq!(
            response["channel"],
            crate::browser_capture::runtime_channel()
        );
        assert_eq!(response["appVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(response["workspaceId"], "actual-desktop");
    }

    #[test]
    fn native_frames_complete_isolated_original_image_upload_with_retry_and_identity_checks() {
        use crate::db::{LocalAccountCreate, LocalDb, LocalInspirationCreate};
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
        use sha2::{Digest, Sha256};

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aichihongshu-native-image-e2e-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("create isolated test directory");
        let database_path = root.join("isolated.db");
        let db = LocalDb::open(database_path.clone()).expect("open isolated database");
        let account_id = db
            .create_local_account(LocalAccountCreate {
                alias: "Native framed upload QA account".to_string(),
                role: "operation".to_string(),
                notes: None,
            })
            .expect("create isolated account");
        let other_account_id = db
            .create_local_account(LocalAccountCreate {
                alias: "Native framed upload other account".to_string(),
                role: "operation".to_string(),
                notes: None,
            })
            .expect("create second isolated account");
        db.set_app_setting("active_account_id", &account_id.to_string())
            .expect("select isolated test account");
        let request_id = "native-framed-image-request";
        let inspiration_id = format!("bc:{account_id}:{request_id}");
        let image_urls = (0..3)
            .map(|position| {
                serde_json::json!({
                    "url": format!("https://cdn.fixture.invalid/image-{position}.png"),
                    "order": position
                })
            })
            .collect::<Vec<_>>();
        db.save_browser_capture_inspiration(LocalInspirationCreate {
            id: inspiration_id.clone(),
            account_pool_id: account_id,
            title: "三张原图的隔离剪藏".to_string(),
            source_url: "https://www.xiaohongshu.com/explore/native-frame-fixture".to_string(),
            body: "正文先入本地，再通过协议分块保存原图。".to_string(),
            observed_at: "2026-10-05T10:00:00Z".to_string(),
            reason: String::new(),
            dedupe_key: None,
            material_type: Some("note_material".to_string()),
            author: Some("isolated QA author".to_string()),
            capture_modules: Some(vec!["images".to_string()]),
        })
        .expect("save isolated clipping text");
        db.save_browser_capture_payload(
            &inspiration_id,
            account_id,
            &serde_json::json!({ "images": image_urls, "comments": [] }).to_string(),
        )
        .expect("save selected image metadata");
        db.register_browser_capture_request(account_id, request_id, &inspiration_id, true)
            .expect("register original request id");

        let images = (0_u64..3)
            .map(|seed| {
                let raster = RgbImage::from_fn(320, 320, |x, y| {
                    let mut value = (u64::from(x) << 32) | u64::from(y);
                    value ^= (seed + 1).wrapping_mul(0x9e37_79b9_7f4a_7c15);
                    value ^= value >> 30;
                    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
                    value ^= value >> 27;
                    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
                    value ^= value >> 31;
                    Rgb([value as u8, (value >> 8) as u8, (value >> 16) as u8])
                });
                let mut encoded = Cursor::new(Vec::new());
                DynamicImage::ImageRgb8(raster)
                    .write_to(&mut encoded, ImageFormat::Png)
                    .expect("encode deterministic original image");
                let bytes = encoded.into_inner();
                assert!(
                    bytes.len() > 64 * 1024,
                    "fixture should require multiple chunks"
                );
                bytes
            })
            .collect::<Vec<_>>();

        let runtime_channel = crate::browser_capture::runtime_channel();
        let wrong_channel = if runtime_channel == "dev" {
            "prod"
        } else {
            "dev"
        };
        let workspace_id = crate::browser_capture::workspace_identity();
        let transfer_base = |action: &str, account: i64, request: &str, position: usize| {
            json!({
                "action": action,
                "protocolVersion": crate::browser_capture::PROTOCOL_VERSION,
                "imageTransferProtocol": true,
                "targetAccountId": account,
                "inspirationId": inspiration_id,
                "requestId": request,
                "expectedChannel": runtime_channel,
                "expectedWorkspaceId": workspace_id,
                "position": position,
                "extensionVersion": "0.9.0"
            })
        };
        let decorate_begin = |mut begin: Value| {
            begin["totalBytes"] = json!(images[0].len());
            begin["sha256"] = json!(format!("{:x}", Sha256::digest(&images[0])));
            begin["mimeType"] = json!("image/png");
            begin
        };
        let mut messages = vec![];
        let mut wrong_workspace = decorate_begin(transfer_base(
            "begin_capture_image_upload",
            account_id,
            request_id,
            0,
        ));
        wrong_workspace["expectedWorkspaceId"] = json!("other-workspace");
        messages.push(wrong_workspace);
        let mut wrong_channel_message = decorate_begin(transfer_base(
            "begin_capture_image_upload",
            account_id,
            request_id,
            0,
        ));
        wrong_channel_message["expectedChannel"] = json!(wrong_channel);
        messages.push(wrong_channel_message);
        messages.push(decorate_begin(transfer_base(
            "begin_capture_image_upload",
            other_account_id,
            request_id,
            0,
        )));
        messages.push(decorate_begin(transfer_base(
            "begin_capture_image_upload",
            account_id,
            "a-different-request-id",
            0,
        )));

        let mut partial_lookup_index = None;
        let mut retry_begin_index = None;
        let mut failed_image_index = None;
        let mut finish_indices = Vec::new();
        for (position, original) in images.iter().enumerate() {
            let digest = format!("{:x}", Sha256::digest(original));
            let mut begin = transfer_base(
                "begin_capture_image_upload",
                account_id,
                request_id,
                position,
            );
            begin["totalBytes"] = json!(original.len());
            begin["sha256"] = json!(digest);
            begin["mimeType"] = json!("image/png");
            messages.push(begin);

            if position == 1 {
                let partial = &original[..64 * 1024];
                let mut write = transfer_base(
                    "write_capture_image_chunk",
                    account_id,
                    request_id,
                    position,
                );
                write["offset"] = json!(0);
                write["dataBase64"] = json!(STANDARD.encode(partial));
                messages.push(write);
                failed_image_index = Some(messages.len());
                messages.push(transfer_base(
                    "fail_capture_image_upload",
                    account_id,
                    request_id,
                    position,
                ));
                partial_lookup_index = Some(messages.len());
                messages.push(json!({
                    "action": "lookup_capture_request",
                    "protocolVersion": crate::browser_capture::PROTOCOL_VERSION,
                    "targetAccountId": account_id,
                    "requestId": request_id,
                    "expectedChannel": runtime_channel,
                    "expectedWorkspaceId": workspace_id
                }));

                let mut retry = transfer_base(
                    "begin_capture_image_upload",
                    account_id,
                    request_id,
                    position,
                );
                retry["totalBytes"] = json!(original.len());
                retry["sha256"] = json!(digest);
                retry["mimeType"] = json!("image/png");
                retry_begin_index = Some(messages.len());
                messages.push(retry);
            }

            let mut offset = 0_usize;
            for chunk in original.chunks(64 * 1024) {
                let mut write = transfer_base(
                    "write_capture_image_chunk",
                    account_id,
                    request_id,
                    position,
                );
                write["offset"] = json!(offset);
                write["dataBase64"] = json!(STANDARD.encode(chunk));
                messages.push(write);
                offset += chunk.len();
            }
            finish_indices.push(messages.len());
            messages.push(transfer_base(
                "finish_capture_image_upload",
                account_id,
                request_id,
                position,
            ));
        }
        let final_lookup_index = messages.len();
        messages.push(json!({
            "action": "lookup_capture_request",
            "protocolVersion": crate::browser_capture::PROTOCOL_VERSION,
            "targetAccountId": account_id,
            "requestId": request_id,
            "expectedChannel": runtime_channel,
            "expectedWorkspaceId": workspace_id
        }));
        let ready_begin_index = messages.len();
        let ready_digest = format!("{:x}", Sha256::digest(&images[0]));
        let mut ready_begin =
            transfer_base("begin_capture_image_upload", account_id, request_id, 0);
        ready_begin["totalBytes"] = json!(images[0].len());
        ready_begin["sha256"] = json!(ready_digest);
        ready_begin["mimeType"] = json!("image/png");
        messages.push(ready_begin);
        let other_account_lookup_index = messages.len();
        messages.push(json!({
            "action": "lookup_capture_request",
            "protocolVersion": crate::browser_capture::PROTOCOL_VERSION,
            "targetAccountId": other_account_id,
            "requestId": request_id,
            "expectedChannel": runtime_channel,
            "expectedWorkspaceId": workspace_id
        }));

        let app = crate::mock_app_for_browser_capture(Arc::new(db));
        let app_handle = app.handle().clone();
        let socket_path =
            std::path::PathBuf::from(format!("/tmp/ah-img-{}-{stamp}.sock", std::process::id()));
        let listener = UnixListener::bind(&socket_path).expect("bind isolated capture socket");
        let request_count = messages.len();
        let server = std::thread::spawn(move || {
            for _ in 0..request_count {
                let (mut stream, _) = listener.accept().expect("accept framed Native action");
                let response =
                    match crate::browser_capture::process_message(&mut stream, &app_handle) {
                        Ok(value) => value,
                        Err(error) => json!({ "ok": false, "error": error }),
                    };
                let encoded = serde_json::to_vec(&response).expect("encode local action response");
                stream
                    .write_all(&encoded)
                    .expect("write local action response");
                stream
                    .write_all(b"\n")
                    .expect("terminate local action response");
            }
        });

        let mut native_input = Vec::new();
        for message in &messages {
            let payload = serde_json::to_vec(message).expect("encode framed Native request");
            let length = u32::try_from(payload.len()).expect("request fits Native frame");
            native_input.extend_from_slice(&length.to_le_bytes());
            native_input.extend_from_slice(&payload);
        }
        let mut native_output = Vec::new();
        process_frames(&mut Cursor::new(native_input), &mut native_output, |raw| {
            forward_message_to(raw, &socket_path)
        })
        .expect("process actual Native Messaging frames");
        server
            .join()
            .expect("isolated app socket server should finish");

        let mut output = Cursor::new(native_output);
        let responses = (0..messages.len())
            .map(|_| {
                let frame = read_frame(&mut output)
                    .expect("read Native response frame")
                    .expect("response frame should exist");
                serde_json::from_slice::<Value>(&frame).expect("decode Native response JSON")
            })
            .collect::<Vec<_>>();
        assert!(output.position() as usize == output.get_ref().len());
        for (message, response) in messages.iter().zip(&responses) {
            if message["action"] == "write_capture_image_chunk" {
                let offset = message["offset"].as_u64().expect("write offset");
                let chunk = STANDARD
                    .decode(message["dataBase64"].as_str().expect("base64 chunk"))
                    .expect("valid frame contains base64 bytes");
                assert_eq!(response["ok"], true);
                assert_eq!(
                    response["upload"]["nextOffset"],
                    offset + chunk.len() as u64
                );
            }
        }
        assert!(!responses[0]["ok"].as_bool().unwrap_or(false));
        assert!(responses[0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("工作区"));
        assert!(!responses[1]["ok"].as_bool().unwrap_or(false));
        assert!(responses[1]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("通道"));
        assert!(!responses[2]["ok"].as_bool().unwrap_or(false));
        assert!(
            responses[2]["error"]
                .as_str()
                .unwrap_or_default()
                .contains("账号"),
            "cross-account action should report an account-scoped rejection: {}",
            responses[2]
        );
        assert!(!responses[3]["ok"].as_bool().unwrap_or(false));
        assert!(responses[3]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("requestId"));
        assert_eq!(
            responses[4]["upload"]["nextOffset"], 0,
            "first original image starts at offset zero"
        );
        assert_eq!(
            responses[4]["protocolVersion"],
            crate::browser_capture::PROTOCOL_VERSION
        );
        assert_eq!(
            responses[partial_lookup_index.expect("partial lookup should be included")]
                ["captureStatus"]["imagesTotal"],
            3
        );
        assert_eq!(
            responses[partial_lookup_index.unwrap()]["captureStatus"]["imagesReady"],
            1
        );
        assert_eq!(
            responses[partial_lookup_index.unwrap()]["captureStatus"]["imagesFailed"],
            1
        );
        assert_eq!(
            responses[failed_image_index.expect("failed image action should be included")]
                ["status"],
            "failed"
        );
        assert_eq!(
            responses[retry_begin_index.expect("retry begin should be included")]["upload"]
                ["nextOffset"],
            0,
            "a failed image restarts only that image under the same request id"
        );
        assert_eq!(
            responses[final_lookup_index]["captureStatus"]["imagesReady"],
            3
        );
        assert_eq!(
            responses[final_lookup_index]["captureStatus"]["imagesFailed"],
            0
        );
        assert_eq!(
            responses[final_lookup_index]["captureStatus"]["collectionSaved"],
            true
        );
        assert_eq!(responses[ready_begin_index]["upload"]["alreadyReady"], true);
        assert_eq!(
            responses[ready_begin_index]["upload"]["nextOffset"],
            images[0].len()
        );
        for index in finish_indices {
            assert_eq!(responses[index]["status"], "ready");
        }
        assert_eq!(
            responses[other_account_lookup_index]["captureStatus"]["imagesReady"], 0,
            "another account cannot observe the request's image state"
        );
        assert_eq!(
            responses[other_account_lookup_index]["captureStatus"]["collectionSaved"],
            false
        );

        drop(app);
        let reopened = LocalDb::open(database_path).expect("reopen isolated database offline");
        for (position, original) in images.iter().enumerate() {
            let image = reopened
                .read_browser_collection_image(&inspiration_id, account_id, position as i64, false)
                .expect("read persisted original without URL access");
            let (_, encoded) = image
                .split_once(',')
                .expect("data URL should contain bytes");
            assert_eq!(
                STANDARD.decode(encoded).expect("decode local image bytes"),
                *original,
                "local original must preserve selected position {position}"
            );
        }
        drop(reopened);
        std::fs::remove_file(&socket_path).expect("remove isolated capture socket");
        std::fs::remove_dir_all(root).expect("remove isolated database and assets");
    }
}
