use aichihongshu_db::{
    BrowserProfileNote, BrowserProfileSnapshot, ItemSummary, LocalAccountCreate,
    LocalAccountUpdate, LocalDb, LocalImageImport, LocalItemAnalysisTitlePolicy,
    LocalItemMetadataUpdate, LocalNoteCreate, LocalNoteStatsUpdate, LocalNoteStatusUpdate,
    LocalNoteUpdate, LocalProfileUpdate, LocalReferenceAccountApiUpsert,
    LocalReferenceAccountCreate, LocalReferenceAccountUpdate, NoteSummary, PromptConfigUpsert,
    ReferenceNote, WorkspaceSnapshot,
};
use aichihongshu_services::browser_worker::{
    BrowserWorkerConfig, BrowserWorkerManager, WorkerCommand,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Body, Bytes, Frame, Incoming};
use hyper::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, HOST, ORIGIN, VARY, X_CONTENT_TYPE_OPTIONS,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;

pub const DEFAULT_PORT: u16 = 8765;
const MAX_QUERY_LIMIT: usize = 200;
const MAX_REQUEST_BODY_BYTES: usize = 1_048_576;
const MAX_IMAGE_UPLOAD_BYTES: usize = 25 * 1024 * 1024;
const MAX_MULTIPART_BODY_BYTES: usize = MAX_IMAGE_UPLOAD_BYTES + 64 * 1024;
const MAX_AI_STREAM_BYTES: usize = 4 * 1024 * 1024;
const MAX_CRAWLER_SSE_BYTES: usize = 32 * 1024;
static NEXT_CREATOR_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
type HttpBody = http_body_util::combinators::BoxBody<Bytes, Infallible>;
type StreamCompletion = Box<dyn FnOnce(String) -> Result<(), String> + Send + 'static>;

fn full_body(bytes: Bytes) -> HttpBody {
    Full::new(bytes).map_err(|never| match never {}).boxed()
}

struct HttpState {
    db: Arc<LocalDb>,
    browser_worker: BrowserWorkerManager,
    profile_refresh: Mutex<HashMap<i64, ProfileRefreshStatus>>,
    port: u16,
    allowed_origins: Vec<String>,
    session_token: String,
}

#[derive(Clone, Default, Serialize)]
struct ProfileRefreshStatus {
    running: bool,
    last_error: Option<String>,
}

#[derive(Deserialize)]
struct CreatorCaptureRequest {
    url: String,
    name: Option<String>,
    #[serde(default = "default_true")]
    save_db: bool,
}

fn default_true() -> bool {
    true
}

pub fn serve(db: LocalDb, port: u16) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("创建 Rust HTTP runtime 失败：{error}"))?;
    runtime.block_on(serve_async(db, port))
}

async fn serve_async(db: LocalDb, port: u16) -> Result<(), String> {
    let address = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&address)
        .await
        .map_err(|error| format!("无法监听 {address}：{error}"))?;
    let browser_worker = create_browser_worker(&db)?;
    let state = Arc::new(HttpState {
        db: Arc::new(db),
        browser_worker,
        profile_refresh: Mutex::new(HashMap::new()),
        port,
        allowed_origins: allowed_origins(port),
        session_token: create_http_token()?,
    });
    eprintln!("Rust HTTP adapter listening on http://{address}");

    let shutdown = wait_for_shutdown();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            signal = &mut shutdown => {
                signal?;
                break;
            }
            accepted = listener.accept() => {
                let (stream, peer) = accepted
                    .map_err(|error| format!("接受 HTTP 连接失败：{error}"))?;
                if !peer.ip().is_loopback() {
                    continue;
                }
                let io = TokioIo::new(stream);
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    let service = service_fn(move |request| dispatch(request, Arc::clone(&state)));
                    if let Err(error) = http1::Builder::new().serve_connection(io, service).await {
                        eprintln!("Rust HTTP connection ended: {error}");
                    }
                });
            }
        }
    }
    state.browser_worker.shutdown();
    Ok(())
}

async fn wait_for_shutdown() -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .map_err(|error| format!("注册服务退出信号失败：{error}"))?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.map_err(|error| format!("等待 Ctrl-C 失败：{error}")),
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .map_err(|error| format!("等待 Ctrl-C 失败：{error}"))
    }
}

fn create_browser_worker(db: &LocalDb) -> Result<BrowserWorkerManager, String> {
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
    let data_root = db
        .path()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("browser-worker")
        .join("sessions");
    BrowserWorkerManager::new(BrowserWorkerConfig {
        node,
        worker_dir,
        data_root,
    })
}

fn allowed_origins(port: u16) -> Vec<String> {
    let mut origins = vec![
        "http://localhost:1420".to_string(),
        "http://127.0.0.1:1420".to_string(),
        "http://localhost:1422".to_string(),
        "http://127.0.0.1:1422".to_string(),
        format!("http://localhost:{port}"),
        format!("http://127.0.0.1:{port}"),
    ];
    if let Some(extra) = std::env::var_os("AICHIHONGSHU_WEB_ORIGINS") {
        origins.extend(
            extra
                .to_string_lossy()
                .split(',')
                .map(str::trim)
                .filter(|origin| is_loopback_origin(origin))
                .map(str::to_string),
        );
    }
    origins.sort();
    origins.dedup();
    origins
}

fn create_http_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| format!("生成 HTTP 会话令牌失败：{error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn bearer_token_matches(header: Option<&str>, expected: &str) -> bool {
    let Some(provided) = header.and_then(|value| value.strip_prefix("Bearer ")) else {
        return false;
    };
    if provided.len() != expected.len() {
        return false;
    }
    provided
        .bytes()
        .zip(expected.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn is_loopback_origin(origin: &str) -> bool {
    let Some(authority) = origin.strip_prefix("http://") else {
        return false;
    };
    if authority.is_empty() || authority.contains(['/', '?', '#', '@']) {
        return false;
    }
    let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let Some((host, rest)) = bracketed.split_once(']') else {
            return false;
        };
        let Some(port) = rest.strip_prefix(':') else {
            return false;
        };
        (host, port)
    } else {
        let Some((host, port)) = authority.rsplit_once(':') else {
            return false;
        };
        (host, port)
    };
    let Ok(port) = port.parse::<u16>() else {
        return false;
    };
    port > 0 && matches!(host, "localhost" | "127.0.0.1" | "::1")
}

async fn dispatch(
    request: Request<Incoming>,
    state: Arc<HttpState>,
) -> Result<Response<HttpBody>, Infallible> {
    Ok(handle_request(request, state).await)
}

enum BodyReadError {
    TooLarge,
    Read(String),
}

async fn read_limited_body<B>(mut body: B, limit: usize) -> Result<Bytes, BodyReadError>
where
    B: Body<Data = Bytes> + Unpin,
    B::Error: std::fmt::Display,
{
    let mut bytes = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|error| BodyReadError::Read(error.to_string()))?;
        if let Ok(data) = frame.into_data() {
            if bytes.len().saturating_add(data.len()) > limit {
                return Err(BodyReadError::TooLarge);
            }
            bytes.extend_from_slice(&data);
        }
    }
    Ok(Bytes::from(bytes))
}

async fn handle_request<B>(request: Request<B>, state: Arc<HttpState>) -> Response<HttpBody>
where
    B: Body<Data = Bytes> + Unpin,
    B::Error: std::fmt::Display,
{
    let host = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !is_loopback_host(host, state.port) {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"detail":"仅接受发往本机 loopback 的 Host"}),
            None,
        );
    }

    let origin_header = request.headers().get(ORIGIN).cloned();
    let origin = origin_header.as_ref().and_then(|value| value.to_str().ok());
    let content_type_header = request.headers().get(CONTENT_TYPE).cloned();
    let content_type = content_type_header
        .as_ref()
        .and_then(|value| value.to_str().ok());
    let risk_acknowledged = request
        .headers()
        .get("x-risk-acknowledged")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "yes" | "true" | "1" | "ok"
            )
        });
    if let Some(origin) = origin {
        if !state
            .allowed_origins
            .iter()
            .any(|allowed| allowed == origin)
        {
            return json_response(
                StatusCode::FORBIDDEN,
                json!({"detail":"请求来源不在本机应用允许列表中"}),
                None,
            );
        }
    }

    if request.method() != Method::GET
        && request.method() != Method::HEAD
        && request.method() != Method::OPTIONS
    {
        if origin.is_none() {
            return json_response(
                StatusCode::FORBIDDEN,
                json!({"detail":"写请求必须包含允许的 Origin"}),
                None,
            );
        }
        let authorization = request
            .headers()
            .get(hyper::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok());
        if !bearer_token_matches(authorization, &state.session_token) {
            return json_response(
                StatusCode::FORBIDDEN,
                json!({"detail":"本地写入会话令牌无效或已过期"}),
                origin,
            );
        }
    }

    if request.method() == Method::OPTIONS {
        if origin.is_none() {
            return json_response(
                StatusCode::FORBIDDEN,
                json!({"detail":"跨域预检请求缺少 Origin"}),
                None,
            );
        }
        return preflight_response(origin.unwrap());
    }

    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let is_multipart_upload = method == Method::POST
        && (path == "/api/library" || path == "/api/library/")
        && content_type.is_some_and(|value| {
            value.split(';').next().is_some_and(|media_type| {
                media_type
                    .trim()
                    .eq_ignore_ascii_case("multipart/form-data")
            })
        });
    let query = match parse_query(request.uri().query().unwrap_or_default()) {
        Ok(query) => query,
        Err(error) => {
            return json_response(StatusCode::BAD_REQUEST, json!({"detail":error}), origin)
        }
    };
    let body = if method == Method::POST
        || method == Method::PUT
        || method == Method::PATCH
        || method == Method::DELETE
    {
        let body_limit = if is_multipart_upload {
            MAX_MULTIPART_BODY_BYTES
        } else {
            MAX_REQUEST_BODY_BYTES
        };
        match read_limited_body(request.into_body(), body_limit).await {
            Ok(body) => body,
            Err(BodyReadError::TooLarge) => {
                return json_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    json!({"detail":if is_multipart_upload {"图片上传超过 25 MiB 限制"} else {"请求体超过 1 MiB 限制"}}),
                    origin,
                )
            }
            Err(BodyReadError::Read(error)) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"detail":format!("读取请求体失败：{error}")}),
                    origin,
                )
            }
        }
    } else {
        Bytes::new()
    };

    let response = match (method.clone(), path.as_str()) {
        (Method::GET, "/") => json_response(
            StatusCode::OK,
            json!({"name":"爱吃红薯","version":env!("CARGO_PKG_VERSION"),"backend":"rust"}),
            origin,
        ),
        (Method::GET, "/health") => json_response(
            StatusCode::OK,
            json!({"status":"ok","version":env!("CARGO_PKG_VERSION"),"backend":"rust"}),
            origin,
        ),
        (Method::GET, "/api/session") => {
            if origin.is_none() {
                json_response(
                    StatusCode::FORBIDDEN,
                    json!({"detail":"获取本地写入会话必须来自允许的应用来源"}),
                    None,
                )
            } else {
                let mut response = json_response(
                    StatusCode::OK,
                    json!({"token":state.session_token.as_str()}),
                    origin,
                );
                response.headers_mut().insert(
                    CACHE_CONTROL,
                    hyper::header::HeaderValue::from_static("no-store"),
                );
                response
            }
        }
        (Method::POST, "/api/ai/quick") => route_ai_quick(&state.db, &body, origin).await,
        (Method::POST, "/api/ai/chat") => route_ai_chat(&state.db, &body, origin),
        (Method::POST, "/api/ai/inspire") => route_ai_inspire(&state.db, &body, origin),
        (Method::POST, "/api/crawler/creator") => {
            route_crawler_creator(&state, &body, origin, risk_acknowledged)
        }
        _ if path == "/api/crawler/browser"
            && matches!(method, Method::GET | Method::POST | Method::DELETE) =>
        {
            route_crawler_browser(&state, &method, &query, origin).await
        }
        (Method::GET, "/api/profile") | (Method::GET, "/api/profile/") => {
            match profile_snapshot(&state.db) {
                Ok(snapshot) => {
                    json_response(StatusCode::OK, legacy_json(snapshot.profile), origin)
                }
                Err(error) => db_error(error, origin),
            }
        }
        (Method::GET, "/api/profile/refresh-status") => {
            let status = state
                .db
                .current_active_account()
                .ok()
                .and_then(|account| {
                    state
                        .profile_refresh
                        .lock()
                        .ok()
                        .and_then(|statuses| statuses.get(&account.id).cloned())
                })
                .unwrap_or_default();
            json_response(StatusCode::OK, json!(status), origin)
        }
        _ if method != Method::GET
            && (path == "/api/profile"
                || path == "/api/profile/"
                || path == "/api/profile/refresh") =>
        {
            route_profile_write(&state, &method, &path, &body, content_type, origin)
        }
        (Method::GET, "/api/account-pool") | (Method::GET, "/api/account-pool/") => {
            match state.db.account_pool() {
                Ok(pool) => json_response(StatusCode::OK, legacy_json(pool), origin),
                Err(error) => db_error(error.to_string(), origin),
            }
        }
        (Method::GET, "/api/account-pool/active") => match state.db.account_pool() {
            Ok(pool) => {
                let active = pool.items.into_iter().find(|account| account.is_active);
                match active {
                    Some(account) => json_response(StatusCode::OK, legacy_json(account), origin),
                    None => json_response(
                        StatusCode::NOT_FOUND,
                        json!({"detail":"尚未设置激活账号"}),
                        origin,
                    ),
                }
            }
            Err(error) => db_error(error.to_string(), origin),
        },
        (Method::GET, "/api/account-pool/protection/status") => match state.db.account_pool() {
            Ok(pool) => {
                let active = pool.items.into_iter().find(|account| account.is_active);
                let policies = json!({
                    "publish_auto":"retired",
                    "crawler_search":"warn",
                    "crawler_creator":"warn",
                    "profile_refresh":"allow",
                    "browser_open":"allow",
                });
                json_response(
                    StatusCode::OK,
                    json!({"active":active.map(legacy_json),"policies":policies}),
                    origin,
                )
            }
            Err(error) => db_error(error.to_string(), origin),
        },
        (Method::GET, "/api/accounts") | (Method::GET, "/api/accounts/") => {
            match scoped_snapshot(&state.db, "references") {
                Ok(snapshot) => {
                    let mut accounts = snapshot.reference_accounts;
                    accounts.sort_by(|left, right| right.avg_likes.total_cmp(&left.avg_likes));
                    json_response(StatusCode::OK, legacy_json(accounts), origin)
                }
                Err(error) => db_error(error, origin),
            }
        }
        (Method::GET, "/api/knowledge/rules") => route_knowledge_rules(&state.db, origin),
        (Method::GET, "/api/knowledge/my-samples") => {
            match state.db.local_knowledge_my_samples(None) {
                Ok(samples) => json_response(StatusCode::OK, legacy_json(samples), origin),
                Err(error) => db_error(error, origin),
            }
        }
        (Method::GET, "/api/knowledge/inspirations") => {
            match state.db.legacy_knowledge_inspirations(None) {
                Ok(items) => json_response(StatusCode::OK, legacy_json(items), origin),
                Err(error) => db_error(error, origin),
            }
        }
        (Method::GET, "/api/knowledge/ref-samples") => {
            match state.db.legacy_knowledge_reference_samples(None) {
                Ok(groups) => json_response(StatusCode::OK, Value::Array(groups), origin),
                Err(error) => db_error(error, origin),
            }
        }
        (Method::GET, "/api/settings/env") => route_settings_env_get(&state.db, origin),
        _ if method == Method::PATCH && path == "/api/settings/env" => {
            route_settings_env_patch(&state.db, &body, content_type, origin)
        }
        _ if method == Method::POST
            && path.starts_with("/api/accounts/")
            && path.ends_with("/analyze") =>
        {
            route_reference_analyze(&state.db, &path, origin).await
        }
        _ if method == Method::POST
            && path.starts_with("/api/accounts/")
            && path.ends_with("/imitate") =>
        {
            route_reference_imitate(&state.db, &path, &body, content_type, origin).await
        }
        (Method::GET, "/api/settings/prompts") => match state.db.list_prompt_configs(None) {
            Ok(prompts) => json_response(StatusCode::OK, legacy_json(prompts), origin),
            Err(error) => db_error(error, origin),
        },
        _ if path == "/api/settings/prompts" || path.starts_with("/api/settings/prompts/") => {
            route_prompt_write(&state.db, &method, &path, &body, content_type, origin)
        }
        _ if method != Method::GET
            && (path == "/api/account-pool"
                || path == "/api/account-pool/"
                || path.starts_with("/api/account-pool/")) =>
        {
            route_account_pool_write(&state.db, &method, &path, &body, content_type, origin)
        }
        _ if method != Method::GET
            && (path == "/api/accounts"
                || path == "/api/accounts/"
                || path.starts_with("/api/accounts/")) =>
        {
            route_reference_account_write(&state.db, &method, &path, &body, content_type, origin)
        }
        _ if method != Method::GET && path.starts_with("/api/knowledge/my-samples/") => {
            route_knowledge_sample_write(&state.db, &path, &body, content_type, origin)
        }
        _ if method != Method::GET && path.starts_with("/api/knowledge/rules/") => {
            route_knowledge_rule_write(&state.db, &path, &body, content_type, origin)
        }
        _ if method != Method::GET
            && (path == "/api/knowledge/inspirations"
                || path.starts_with("/api/knowledge/inspirations/")) =>
        {
            route_knowledge_inspiration_write(
                &state.db,
                &method,
                &path,
                &body,
                content_type,
                origin,
            )
        }
        _ if method != Method::GET
            && (path == "/api/knowledge/ref-samples"
                || path.starts_with("/api/knowledge/ref-samples/")) =>
        {
            route_knowledge_reference_sample_write(
                &state.db,
                &method,
                &path,
                &body,
                content_type,
                origin,
            )
        }
        _ if method != Method::GET
            && (path == "/api/content"
                || path == "/api/content/"
                || path.starts_with("/api/content/")) =>
        {
            route_content_write(&state.db, &method, &path, &body, content_type, origin).await
        }
        _ if method != Method::GET
            && (path == "/api/library"
                || path == "/api/library/"
                || path.starts_with("/api/library/")) =>
        {
            route_library_write(&state.db, &method, &path, &body, content_type, origin)
        }
        (Method::GET, "/api/library/trash/list") => match scoped_snapshot(&state.db, "library") {
            Ok(snapshot) => {
                json_response(StatusCode::OK, legacy_json(snapshot.trash_items), origin)
            }
            Err(error) => db_error(error, origin),
        },
        (Method::GET, "/api/library") | (Method::GET, "/api/library/") => {
            match scoped_snapshot(&state.db, "library") {
                Ok(snapshot) => match filter_items(snapshot.items, &query) {
                    Ok(items) => json_response(StatusCode::OK, legacy_json(items), origin),
                    Err(error) => json_response(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        json!({"detail":error}),
                        origin,
                    ),
                },
                Err(error) => db_error(error, origin),
            }
        }
        (Method::GET, "/api/content") | (Method::GET, "/api/content/") => {
            match scoped_snapshot(&state.db, "notes") {
                Ok(snapshot) => match filter_notes(snapshot.notes, &query) {
                    Ok(notes) => json_response(StatusCode::OK, legacy_json(notes), origin),
                    Err(error) => json_response(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        json!({"detail":error}),
                        origin,
                    ),
                },
                Err(error) => db_error(error, origin),
            }
        }
        _ if method == Method::GET && path.starts_with("/api/analytics/") => {
            route_analytics_get(&state.db, &path, &query, origin)
        }
        _ if method == Method::GET
            && path.starts_with("/api/accounts/")
            && path.ends_with("/insights") =>
        {
            route_reference_insights(&state.db, &path, &query, origin).await
        }
        _ if method == Method::GET && path.starts_with("/api/accounts/") => {
            route_account_get(&state.db, &path, origin)
        }
        _ if method == Method::GET && path.starts_with("/api/library/") => {
            route_library_get(&state.db, &path, origin)
        }
        _ if method == Method::GET && path.starts_with("/api/content/") => {
            route_content_get(&state.db, &path, origin)
        }
        _ => json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"Rust HTTP adapter 尚未实现此路由"}),
            origin,
        ),
    };

    response
}

struct LegacyInspireRequest {
    topic: String,
    item_ids: Vec<i64>,
    extra_image_desc: String,
    account_ids: Vec<String>,
    extra_instruction: String,
}

fn route_ai_inspire(db: &LocalDb, body: &Bytes, origin: Option<&str>) -> Response<HttpBody> {
    let request = match parse_legacy_inspire_request(body) {
        Ok(request) => request,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let (system, user_message) = match build_legacy_inspire_prompt(db, &request) {
        Ok(prompt) => prompt,
        Err(error) => return db_error(error, origin),
    };
    let (provider, model) = match default_model_provider(db) {
        Ok(provider) => provider,
        Err(error) => return sse_error_response(error, origin),
    };
    stream_ai_response(
        provider,
        model,
        system,
        vec![json!({"role":"user","content":user_message})],
        4096,
        origin,
    )
}

fn parse_legacy_inspire_request(body: &Bytes) -> Result<LegacyInspireRequest, String> {
    let object = parse_json_object(body)?;
    let request_string = |key: &str| -> Result<String, String> {
        match object.get(key) {
            None => Ok(String::new()),
            Some(Value::String(value)) if value.chars().count() <= 8_000 => Ok(value.clone()),
            Some(Value::String(_)) => Err(format!("{key} 超过 8,000 字符")),
            Some(_) => Err(format!("{key} 必须是字符串")),
        }
    };
    let item_ids = match object.get("item_ids") {
        None => Vec::new(),
        Some(Value::Array(values)) if values.len() <= 30 => values
            .iter()
            .map(|value| {
                value
                    .as_i64()
                    .filter(|id| *id > 0)
                    .ok_or_else(|| "item_ids 必须是正整数数组".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(Value::Array(_)) => return Err("item_ids 最多允许 30 个".to_string()),
        Some(_) => return Err("item_ids 必须是数组".to_string()),
    };
    let account_ids = match object.get("account_ids") {
        None => Vec::new(),
        Some(Value::Array(values)) if values.len() <= 30 => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|id| !id.trim().is_empty() && id.len() <= 200)
                    .map(str::to_string)
                    .ok_or_else(|| "account_ids 必须是非空字符串数组".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(Value::Array(_)) => return Err("account_ids 最多允许 30 个".to_string()),
        Some(_) => return Err("account_ids 必须是数组".to_string()),
    };
    Ok(LegacyInspireRequest {
        topic: request_string("topic")?,
        item_ids,
        extra_image_desc: request_string("extra_image_desc")?,
        account_ids,
        extra_instruction: request_string("extra_instruction")?,
    })
}

fn build_legacy_inspire_prompt(
    db: &LocalDb,
    request: &LegacyInspireRequest,
) -> Result<(String, String), String> {
    let active = db
        .current_active_account()
        .map_err(|error| error.to_string())?;
    let profile_snapshot = db
        .snapshot_section_for_account(Some(active.id), "profile")
        .map_err(|error| format!("读取灵感生成上下文失败：{error}"))?;
    let profile = profile_snapshot.profile;
    let persona_name = profile
        .as_ref()
        .and_then(|value| value.persona_name.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("运营者");
    let persona_tone = profile
        .as_ref()
        .and_then(|value| value.persona_tone.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("接地气，短句，先吐槽再给结论");
    let niche = profile
        .as_ref()
        .and_then(|value| value.niche.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("家居软装");
    let taboos = profile
        .as_ref()
        .map(|value| value.persona_taboos.join("、"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "无".to_string());

    let history = db
        .local_analytics_inspire_insights(Some(active.id))
        .map_err(|error| format!("读取灵感历史数据失败：{error}"))?;
    let mut insight_parts = Vec::new();
    if !history.best_hours.is_empty() {
        let hours_text = history
            .best_hours
            .iter()
            .map(|hour| format!("{hour}点"))
            .collect::<Vec<_>>()
            .join("、");
        insight_parts.push(format!(
            "历史数据显示，在 {hours_text} 发布的帖子平均互动最高"
        ));
    }
    if let Some(average_length) = history.average_top_title_length {
        insight_parts.push(format!("高赞笔记标题平均字数约 {:.0} 字", average_length));
    }
    if !history.top_tags.is_empty() {
        insight_parts.push(format!(
            "历史高赞帖常用标签：{}",
            history
                .top_tags
                .iter()
                .map(|tag| format!("#{tag}"))
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    let insights = if insight_parts.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n【你的历史数据洞察（供参考）】\n{}",
            insight_parts
                .into_iter()
                .map(|part| format!("• {part}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };

    let mut selected_items = Vec::new();
    for item_id in &request.item_ids {
        let (item_account_id, item) = db
            .get_local_item_for_cli(*item_id)
            .map_err(|error| format!("读取灵感素材失败：{error}"))?;
        if item_account_id != active.id {
            return Err("账号上下文已变化".to_string());
        }
        if let Some(item) = item {
            selected_items.push(item);
        }
    }
    let mut items_text = String::new();
    if !request.item_ids.is_empty() {
        let item_lines = selected_items
            .iter()
            .map(|item| {
                let mut line = format!(
                    "- 【{}】风格：{}，场景：{}，颜色：{}，材质：{}",
                    item.title,
                    item.style.as_deref().unwrap_or(""),
                    item.scene.as_deref().unwrap_or(""),
                    item.color.as_deref().unwrap_or(""),
                    item.material.as_deref().unwrap_or("")
                );
                if let Some(analysis) = item
                    .analysis_raw
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                {
                    line.push_str(&format!(
                        "\n  AI图片分析：{}",
                        truncate_chars(analysis, 400)
                    ));
                }
                line
            })
            .collect::<Vec<_>>();
        items_text = format!(
            "\n\n【已选图库素材（{} 张）】\n{}",
            selected_items.len(),
            item_lines.join("\n")
        );
    }
    if !request.extra_image_desc.trim().is_empty() {
        items_text.push_str(&format!(
            "\n\n【还需要的图片（暂无实物，请在正文中说明）】\n{}",
            request.extra_image_desc
        ));
    }

    let references = if request.account_ids.is_empty() {
        Vec::new()
    } else {
        db.snapshot_section_for_account(Some(active.id), "references")
            .map_err(|error| format!("读取灵感榜样账号失败：{error}"))?
            .reference_accounts
    };
    let reference_by_id = references
        .iter()
        .map(|account| (account.account_id.as_str(), account))
        .collect::<HashMap<_, _>>();
    let account_lines = request
        .account_ids
        .iter()
        .filter_map(|id| reference_by_id.get(id.as_str()).copied())
        .map(|account| {
            let style_raw = account.content_style.as_deref().unwrap_or_default();
            let style_summary = if style_raw.trim_start().starts_with('{') {
                serde_json::from_str::<Value>(style_raw)
                    .ok()
                    .map(|style| {
                        ["tone", "format", "hook"]
                            .into_iter()
                            .filter_map(|key| style.get(key).and_then(Value::as_str))
                            .filter(|value| !value.trim().is_empty())
                            .collect::<Vec<_>>()
                            .join("、")
                    })
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| truncate_chars(style_raw, 200))
            } else {
                truncate_chars(style_raw, 200)
            };
            let top_titles = account
                .top_notes
                .iter()
                .take(3)
                .map(|note| note.title.as_str())
                .collect::<Vec<_>>()
                .join("；");
            format!(
                "- 【{}】风格特点：{}{}",
                account.name.as_deref().unwrap_or("榜样"),
                style_summary,
                if top_titles.is_empty() {
                    String::new()
                } else {
                    format!("\n  高赞标题参考：{top_titles}")
                }
            )
        })
        .collect::<Vec<_>>();
    let accounts_text = if account_lines.is_empty() {
        String::new()
    } else {
        format!("\n\n【参考榜样账号风格】\n{}", account_lines.join("\n"))
    };

    let system = format!(
        "你是「爱吃红薯」小红书家居运营助手，正在帮助账号「{persona_name}」做创意灵感发散，生成一篇完整笔记草稿。\n\n【账号定位】{niche}\n【语气风格】{persona_tone}\n【禁忌词】{taboos}（这些词绝对不能出现）{insights}\n\n输出格式（严格按以下四段，每段用对应分隔符，直接输出内容，不要有多余说明）：\n---标题候选---\n（悬念型标题示例：出租屋住了两年，我才发现这件事）\n（数字型标题示例：3个动作让客厅从乱到净，房东都夸）\n（痛点型标题示例：餐桌永远堆东西？我用这招治好了）\n---正文---\n（完整正文，短句换行，emoji 点缀，先钩子/痛点，再展开，最后互动引导）\n---互动引导---\n（1-2 句结尾互动语，如「你们家是什么风格？」）\n---话题标签---\n#标签1 #标签2 #标签3 #标签4 #标签5\n\n规则：\n- 标题每个不超过 20 字，三个候选各有差异（悬念型/数字型/痛点型）\n- 正文 150-300 字，不堆砌感叹号，不使用禁忌词\n- 如有「还需要什么图」的素材说明，在正文合适位置注明「📷 需配图：xxx」"
    );
    let topic = if request.topic.trim().is_empty() {
        "（未指定，请根据素材自由发挥）"
    } else {
        request.topic.trim()
    };
    let mut user_message = format!("话题/热点关键词：{topic}{items_text}{accounts_text}");
    if !request.extra_instruction.trim().is_empty() {
        user_message.push_str(&format!("\n\n【额外要求】{}", request.extra_instruction));
    }
    Ok((system, user_message))
}

async fn route_ai_quick(db: &LocalDb, body: &Bytes, origin: Option<&str>) -> Response<HttpBody> {
    let object = match parse_json_object(body) {
        Ok(object) => object,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let raw_messages = object
        .get("messages")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= 64);
    let Some(raw_messages) = raw_messages else {
        return json_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"detail":"messages 必须是 1 到 64 条消息的数组"}),
            origin,
        );
    };
    let mut messages = Vec::with_capacity(raw_messages.len());
    let mut total_chars = 0usize;
    for message in raw_messages {
        let Some(role) = message.get("role").and_then(Value::as_str) else {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":"messages.role 必须是字符串"}),
                origin,
            );
        };
        let Some(content) = message.get("content").and_then(Value::as_str) else {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":"messages.content 必须是字符串"}),
                origin,
            );
        };
        if !matches!(role, "user" | "assistant") || content.chars().count() > 32_000 {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":"AI 消息角色无效或单条内容超过 32,000 字符"}),
                origin,
            );
        }
        total_chars = total_chars.saturating_add(content.chars().count());
        if total_chars > 64_000 {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":"AI 消息总长度超过 64,000 字符"}),
                origin,
            );
        }
        messages.push(json!({"role":role,"content":content}));
    }

    let note_id = match optional_json_integer(&object, "note_id") {
        Ok(value) => value,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let item_id = match optional_json_integer(&object, "item_id") {
        Ok(value) => value,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let system_extra = match optional_json_string(&object, "system_extra") {
        Ok(value) => value,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let system = match build_legacy_chat_system(db, note_id, item_id, system_extra.as_deref()) {
        Ok(system) => system,
        Err(error) => return db_error(error, origin),
    };
    let (provider, model) = match default_model_provider(db) {
        Ok(provider) => provider,
        Err(error) => return json_response(StatusCode::OK, json!({"error":error}), origin),
    };
    match aichihongshu_services::text_api::complete_compatible_chat(
        &provider, &model, &system, &messages, 1024,
    )
    .await
    {
        Ok(text) => json_response(StatusCode::OK, json!({"text":text}), origin),
        Err(error) => json_response(StatusCode::OK, json!({"error":error}), origin),
    }
}

struct ParsedAiChatRequest {
    messages: Vec<Value>,
    note_id: Option<i64>,
    item_id: Option<i64>,
    system_extra: Option<String>,
}

fn parse_ai_chat_request(body: &Bytes) -> Result<ParsedAiChatRequest, String> {
    let object = parse_json_object(body)?;
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= 64)
        .ok_or_else(|| "messages 必须是 1 到 64 条消息的数组".to_string())?;
    let mut output = Vec::with_capacity(messages.len());
    let mut total_chars = 0usize;
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| "messages.role 必须是字符串".to_string())?;
        let content = message
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| "messages.content 必须是字符串".to_string())?;
        let length = content.chars().count();
        if !matches!(role, "user" | "assistant") || length > 32_000 {
            return Err("AI 消息角色无效或单条内容超过 32,000 字符".to_string());
        }
        total_chars = total_chars.saturating_add(length);
        if total_chars > 64_000 {
            return Err("AI 消息总长度超过 64,000 字符".to_string());
        }
        output.push(json!({"role":role,"content":content}));
    }
    let note_id = optional_json_integer(&object, "note_id")?;
    let item_id = optional_json_integer(&object, "item_id")?;
    let system_extra = optional_json_string(&object, "system_extra")?;
    Ok(ParsedAiChatRequest {
        messages: output,
        note_id,
        item_id,
        system_extra,
    })
}

pub fn default_model_provider(db: &LocalDb) -> Result<(Value, String), String> {
    if let Some(raw) = db.get_app_setting("model_api_settings_v1")? {
        let settings: Value =
            serde_json::from_str(&raw).map_err(|_| "Model API 配置格式无效".to_string())?;
        let providers = settings
            .get("providers")
            .and_then(Value::as_array)
            .ok_or_else(|| "Model API Provider 配置无效".to_string())?;
        let default_id = settings
            .get("defaultProviderId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let selected = providers
            .iter()
            .find(|provider| {
                !default_id.is_empty()
                    && provider.get("id").and_then(Value::as_str) == Some(default_id)
            })
            .or_else(|| {
                providers.iter().find(|provider| {
                    provider.get("id").and_then(Value::as_str) == Some("minimax")
                        && provider
                            .get("apiKey")
                            .and_then(Value::as_str)
                            .is_some_and(|key| !key.trim().is_empty())
                })
            });
        if let Some(provider) = selected {
            let model = settings
                .get("defaultModel")
                .and_then(Value::as_str)
                .filter(|value| {
                    !default_id.is_empty()
                        && provider.get("id").and_then(Value::as_str) == Some(default_id)
                        && !value.trim().is_empty()
                })
                .or_else(|| provider.get("model").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string();
            if model.trim().is_empty() {
                return Err("默认 Model API 模型名称为空".to_string());
            }
            return Ok((provider.clone(), model));
        }
    }
    legacy_minimax_text_provider().ok_or_else(|| "尚未配置默认 Model API Provider".to_string())
}

fn legacy_minimax_text_provider() -> Option<(Value, String)> {
    let api_key = configured_legacy_value(&["MINIMAX_API_KEY", "AICHIHONGSHU_MINIMAX_API_KEY"])?;
    let base_url = configured_legacy_value(&["MINIMAX_BASE_URL"])
        .unwrap_or_else(|| "https://api.minimaxi.com/anthropic".to_string());
    let endpoint = if base_url.trim_end_matches('/').ends_with("/messages") {
        base_url
    } else {
        format!("{}/v1/messages", base_url.trim_end_matches('/'))
    };
    let model = configured_legacy_value(&["MINIMAX_TEXT_MODEL"])
        .unwrap_or_else(|| "MiniMax-M2.7".to_string());
    Some((
        json!({
            "id":"minimax-legacy-env",
            "kind":"anthropic-compatible",
            "endpoint":endpoint,
            "apiKey":api_key,
            "model":model,
        }),
        model,
    ))
}

fn configured_legacy_value(keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| {
            std::env::var(key)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| {
            let contents =
                std::fs::read_to_string(std::env::current_dir().ok()?.join(".env")).ok()?;
            contents.lines().find_map(|line| {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    return None;
                }
                let line = line.strip_prefix("export ").unwrap_or(line);
                let (name, value) = line.split_once('=')?;
                if !keys.contains(&name.trim()) {
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
        })
}

fn route_ai_chat(db: &LocalDb, body: &Bytes, origin: Option<&str>) -> Response<HttpBody> {
    let ParsedAiChatRequest {
        messages,
        note_id,
        item_id,
        system_extra,
    } = match parse_ai_chat_request(body) {
        Ok(request) => request,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let system = match build_legacy_chat_system(db, note_id, item_id, system_extra.as_deref()) {
        Ok(system) => system,
        Err(error) => return db_error(error, origin),
    };
    let (provider, model) = match default_model_provider(db) {
        Ok(provider) => provider,
        Err(error) => return sse_error_response(error, origin),
    };
    stream_ai_response(provider, model, system, messages, 2048, origin)
}

fn stream_ai_response(
    provider: Value,
    model: String,
    system: String,
    messages: Vec<Value>,
    max_tokens: u32,
    origin: Option<&str>,
) -> Response<HttpBody> {
    stream_ai_response_with_completion(provider, model, system, messages, max_tokens, None, origin)
}

fn stream_ai_response_with_completion(
    provider: Value,
    model: String,
    system: String,
    messages: Vec<Value>,
    max_tokens: u32,
    on_complete: Option<StreamCompletion>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .map(|bytes| (Ok::<Frame<Bytes>, Infallible>(Frame::data(bytes)), receiver))
    });
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(CACHE_CONTROL, "no-cache")
        .header("x-accel-buffering", "no")
        .body(StreamBody::new(stream).boxed())
        .expect("static SSE headers are valid");
    add_cors_headers(response.headers_mut(), origin);

    tokio::spawn(async move {
        let output = sender.clone();
        let mut output_size = 0usize;
        let mut output_overflowed = false;
        let mut full_text = String::new();
        let emit_completion = on_complete.is_some();
        let result = aichihongshu_services::text_api::stream_compatible_chat(
            &provider,
            &model,
            &system,
            &messages,
            max_tokens,
            sender.closed(),
            |text| {
                let Ok(payload) = serde_json::to_vec(&json!({"text":text})) else {
                    return false;
                };
                let mut event = Vec::with_capacity(payload.len() + 8);
                event.extend_from_slice(b"data: ");
                event.extend_from_slice(&payload);
                event.extend_from_slice(b"\n\n");
                if output_size.saturating_add(event.len()) > MAX_AI_STREAM_BYTES {
                    output_overflowed = true;
                    return false;
                }
                output_size += event.len();
                if output.send(Bytes::from(event)).is_ok() {
                    full_text.push_str(&text);
                    true
                } else {
                    false
                }
            },
        )
        .await;
        let error = if output_overflowed {
            Some("模型输出超过 4 MiB 限制".to_string())
        } else {
            result.err()
        };
        let mut error = error;
        if error.is_none() {
            if let Some(on_complete) = on_complete {
                let content = full_text.clone();
                match tokio::task::spawn_blocking(move || on_complete(content)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(persist_error)) => error = Some(persist_error),
                    Err(join_error) => {
                        error = Some(format!("保存榜样 AI 结果失败：{join_error}"));
                    }
                }
            }
        }
        if let Some(error) = error {
            send_sse_event(&sender, &json!({"error":error}));
        } else if emit_completion {
            send_sse_event(&sender, &json!({"done":true,"full":full_text}));
        }
        let _ = sender.send(Bytes::from_static(b"data: [DONE]\n\n"));
    });
    response
}

fn send_sse_event(sender: &tokio::sync::mpsc::UnboundedSender<Bytes>, value: &Value) {
    if let Ok(payload) = serde_json::to_vec(value) {
        let mut event = Vec::with_capacity(payload.len() + 8);
        event.extend_from_slice(b"data: ");
        event.extend_from_slice(&payload);
        event.extend_from_slice(b"\n\n");
        let _ = sender.send(Bytes::from(event));
    }
}

fn sse_error_response(error: String, origin: Option<&str>) -> Response<HttpBody> {
    let error = serde_json::to_string(&json!({"error":error})).unwrap_or_default();
    let bytes = Bytes::from(format!("data: {error}\n\ndata: [DONE]\n\n"));
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(CACHE_CONTROL, "no-cache")
        .body(full_body(bytes))
        .expect("static SSE headers are valid");
    add_cors_headers(response.headers_mut(), origin);
    response
}

fn build_legacy_chat_system(
    db: &LocalDb,
    note_id: Option<i64>,
    item_id: Option<i64>,
    extra: Option<&str>,
) -> Result<String, String> {
    let active = db
        .current_active_account()
        .map_err(|error| error.to_string())?;
    let profile_snapshot = db
        .snapshot_section_for_account(Some(active.id), "profile")
        .map_err(|error| format!("读取 AI 账号人设失败：{error}"))?;
    let profile = profile_snapshot.profile;
    let persona_name = profile
        .as_ref()
        .and_then(|value| value.persona_name.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("运营者");
    let persona_tone = profile
        .as_ref()
        .and_then(|value| value.persona_tone.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("接地气，短句，先吐槽再给结论");
    let niche = profile
        .as_ref()
        .and_then(|value| value.niche.as_deref())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("家居软装");
    let taboos = profile
        .as_ref()
        .map(|value| value.persona_taboos.join("、"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "无".to_string());

    let mut context = String::new();
    if let Some(id) = item_id {
        let (account_pool_id, item) = db
            .get_local_item_for_cli(id)
            .map_err(|error| format!("读取 AI 素材上下文失败：{error}"))?;
        if account_pool_id != active.id {
            return Err("账号上下文已变化".to_string());
        }
        if let Some(item) = item {
            context.push_str(&format!(
                "\n\n当前操作的图库物品：{}，风格：{}，场景：{}，标签：{}",
                item.title,
                item.style.as_deref().unwrap_or(""),
                item.scene.as_deref().unwrap_or(""),
                item.tags.join(", ")
            ));
            if let Some(analysis) = item
                .analysis_raw
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                context.push_str(&format!(
                    "\n图片 AI 分析：{}",
                    truncate_chars(analysis, 500)
                ));
            }
        }
    }
    if let Some(id) = note_id {
        let (account_pool_id, note) = db
            .get_local_note_for_legacy(id)
            .map_err(|error| format!("读取 AI 笔记上下文失败：{error}"))?;
        if account_pool_id != active.id {
            return Err("账号上下文已变化".to_string());
        }
        if let Some(note) = note {
            context.push_str(&format!(
                "\n\n当前编辑的笔记草稿：\n标题：{}\n正文：{}",
                note.title.as_deref().unwrap_or("（无）"),
                note.body
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .map(|value| truncate_chars(value, 300))
                    .unwrap_or_else(|| "（无）".to_string())
            ));
            let mut items = Vec::new();
            for item_id in &note.item_ids {
                let (item_account_id, item) = db
                    .get_local_item_for_cli(*item_id)
                    .map_err(|error| format!("读取 AI 笔记素材上下文失败：{error}"))?;
                if item_account_id != account_pool_id {
                    return Err("账号上下文已变化".to_string());
                }
                if let Some(item) = item {
                    let mut description = format!(
                        "- 【{}】风格：{}，场景：{}，颜色：{}，材质：{}",
                        item.title,
                        item.style.as_deref().unwrap_or(""),
                        item.scene.as_deref().unwrap_or(""),
                        item.color.as_deref().unwrap_or(""),
                        item.material.as_deref().unwrap_or("")
                    );
                    if let Some(analysis) = item
                        .analysis_raw
                        .as_deref()
                        .filter(|value| !value.trim().is_empty())
                    {
                        description
                            .push_str(&format!("\n  AI分析：{}", truncate_chars(analysis, 400)));
                    }
                    items.push(description);
                }
            }
            if !items.is_empty() {
                context.push_str(&format!(
                    "\n\n笔记关联图片（{} 张）：\n{}",
                    items.len(),
                    items.join("\n")
                ));
            }
        }
    }

    let mut system = format!(
        "你是「爱吃红薯」小红书家居运营助手，正在帮助账号「{persona_name}」创作内容。\n\n【账号定位】{niche}\n【语气风格】{persona_tone}\n【禁忌词】{taboos}（这些词绝对不能出现在正文或标题中）{context}\n\n创作规则：\n- 标题：不超过 20 字，有钩子，避免感叹号堆砌\n- 正文：短句换行，口语化，先抛问题再给解决方案\n- 标签：5-8 个，以 # 开头，贴合内容垂类\n- 禁止使用禁忌词列表中的任何词汇"
    );
    if let Some(extra) = extra.filter(|value| !value.trim().is_empty()) {
        system.push_str("\n\n");
        system.push_str(extra);
    }
    Ok(system)
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn route_knowledge_rules(db: &LocalDb, origin: Option<&str>) -> Response<HttpBody> {
    let context = match db.local_content_knowledge_context(None) {
        Ok(context) => context,
        Err(error) => return db_error(error, origin),
    };
    let rules = context
        .rule_summaries
        .into_iter()
        .map(|rule| {
            json!({
                "key":rule.key,
                "label":rule.label,
                "desc":rule.desc,
                "value":rule.value,
                "enabled":rule.enabled,
            })
        })
        .collect::<Vec<_>>();
    json_response(StatusCode::OK, Value::Array(rules), origin)
}

fn route_knowledge_rule_write(
    db: &LocalDb,
    path: &str,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    let key = path
        .strip_prefix("/api/knowledge/rules/")
        .unwrap_or_default();
    if key.is_empty() || key.contains('/') {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"经验规律不存在"}),
            origin,
        );
    }
    if !is_json_content_type(content_type) {
        return json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"detail":"请求体必须使用 application/json"}),
            origin,
        );
    }
    let object = match parse_json_object(body) {
        Ok(object) => object,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let Some(enabled) = object.get("enabled").and_then(Value::as_bool) else {
        return json_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"detail":"enabled 必须是布尔值"}),
            origin,
        );
    };
    let active = match db.current_active_account() {
        Ok(account) => account,
        Err(error) => return db_error(error, origin),
    };
    let current = match db.local_knowledge_preferences(Some(active.id)) {
        Ok(preferences) => preferences,
        Err(error) => return db_error(error, origin),
    };
    let mut disabled_rule_keys = current.disabled_rule_keys;
    if enabled {
        disabled_rule_keys.retain(|disabled_key| disabled_key != key);
    } else if !disabled_rule_keys
        .iter()
        .any(|disabled_key| disabled_key == key)
    {
        disabled_rule_keys.push(key.to_string());
    }
    let update = aichihongshu_db::LocalKnowledgePreferencesUpdate {
        account_pool_id: active.id,
        disabled_rule_keys,
        use_my_samples: current.use_my_samples,
        use_reference_samples: current.use_reference_samples,
        use_inspirations: current.use_inspirations,
    };
    match db.save_local_knowledge_preferences(update) {
        Ok(_) => json_response(StatusCode::OK, json!({"ok":true}), origin),
        Err(error) => mutation_error(error, origin),
    }
}

fn route_knowledge_reference_sample_write(
    db: &LocalDb,
    method: &Method,
    path: &str,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    if method == Method::POST && path == "/api/knowledge/ref-samples" {
        if !is_json_content_type(content_type) {
            return json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                json!({"detail":"请求体必须使用 application/json"}),
                origin,
            );
        }
        let object = match parse_json_object(body) {
            Ok(object) => object,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let account_id = match required_json_string(&object, "account_id") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let title = match required_json_string(&object, "title") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let sample_body = match optional_json_string(&object, "body") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let note_url = match optional_json_string(&object, "note_url") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let likes = match optional_json_integer(&object, "likes") {
            Ok(value) => value.unwrap_or_default(),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let account_pool_id = match db.current_active_account() {
            Ok(account) => account.id,
            Err(error) => return db_error(error, origin),
        };
        return match db.add_local_knowledge_reference_sample(
            &account_id,
            account_pool_id,
            &title,
            sample_body.as_deref(),
            likes,
            note_url.as_deref(),
        ) {
            Ok((true, _)) => {
                json_response(StatusCode::OK, json!({"ok":true,"duplicate":true}), origin)
            }
            Ok((false, count)) => {
                json_response(StatusCode::OK, json!({"ok":true,"count":count}), origin)
            }
            Err(error) => mutation_error(error, origin),
        };
    }

    if method == Method::DELETE {
        let Some(suffix) = path.strip_prefix("/api/knowledge/ref-samples/") else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"榜样样本不存在"}),
                origin,
            );
        };
        let Some((account_id_raw, index_raw)) = suffix.rsplit_once('/') else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"榜样样本不存在"}),
                origin,
            );
        };
        let account_id = match decode_query_part(account_id_raw) {
            Ok(account_id) => account_id,
            Err(error) => {
                return json_response(StatusCode::BAD_REQUEST, json!({"detail":error}), origin)
            }
        };
        let Ok(index) = index_raw.parse::<i64>() else {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"detail":"索引超出范围"}),
                origin,
            );
        };
        let account_pool_id = match db.current_active_account() {
            Ok(account) => account.id,
            Err(error) => return db_error(error, origin),
        };
        return match db.delete_local_knowledge_reference_sample(&account_id, account_pool_id, index)
        {
            Ok(count) => json_response(StatusCode::OK, json!({"ok":true,"count":count}), origin),
            Err(error) if error.contains("索引超出范围") => {
                json_response(StatusCode::BAD_REQUEST, json!({"detail":error}), origin)
            }
            Err(error) => mutation_error(error, origin),
        };
    }
    json_response(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({"detail":"榜样样本路由不支持此操作"}),
        origin,
    )
}

fn route_knowledge_inspiration_write(
    db: &LocalDb,
    method: &Method,
    path: &str,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    if method == Method::POST && path == "/api/knowledge/inspirations" {
        if !is_json_content_type(content_type) {
            return json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                json!({"detail":"请求体必须使用 application/json"}),
                origin,
            );
        }
        let object = match parse_json_object(body) {
            Ok(object) => object,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let title = match required_json_string(&object, "title") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let keyword = match optional_json_string(&object, "keyword") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let note_ref = match optional_json_string(&object, "note_ref") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let source = match optional_json_string(&object, "source") {
            Ok(value) => value.unwrap_or_else(|| "manual".to_string()),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let likes_ref = match optional_json_integer(&object, "likes_ref") {
            Ok(value) => value.unwrap_or_default(),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        return match db.create_legacy_knowledge_inspiration(
            &title,
            keyword.as_deref(),
            &source,
            likes_ref,
            note_ref.as_deref(),
        ) {
            Ok(item) => json_response(StatusCode::OK, legacy_json(item), origin),
            Err(error) => mutation_error(error, origin),
        };
    }

    if *method == Method::DELETE {
        let id_segment = path
            .strip_prefix("/api/knowledge/inspirations/")
            .unwrap_or_default();
        let Ok(inspiration_id) = id_segment.parse::<i64>() else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"灵感不存在"}),
                origin,
            );
        };
        let account_pool_id = match db.current_active_account() {
            Ok(account) => account.id,
            Err(error) => return db_error(error, origin),
        };
        return match db.delete_legacy_knowledge_inspiration(inspiration_id, account_pool_id) {
            Ok(()) => json_response(StatusCode::OK, json!({"ok":true}), origin),
            Err(error) => mutation_error(error, origin),
        };
    }
    json_response(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({"detail":"灵感路由不支持此操作"}),
        origin,
    )
}

fn route_knowledge_sample_write(
    db: &LocalDb,
    path: &str,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    let id_segment = path
        .strip_prefix("/api/knowledge/my-samples/")
        .unwrap_or_default();
    let Ok(note_id) = id_segment.parse::<i64>() else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"样本笔记不存在"}),
            origin,
        );
    };
    if !is_json_content_type(content_type) {
        return json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"detail":"请求体必须使用 application/json"}),
            origin,
        );
    }
    let object = match parse_json_object(body) {
        Ok(object) => object,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let Some(enabled) = object.get("use_as_reference").and_then(Value::as_bool) else {
        return json_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"detail":"use_as_reference 必须是布尔值"}),
            origin,
        );
    };
    let account_pool_id = match db.current_active_account() {
        Ok(account) => account.id,
        Err(error) => return db_error(error, origin),
    };
    match db.set_local_note_reference_usage(note_id, account_pool_id, enabled) {
        Ok(()) => json_response(
            StatusCode::OK,
            json!({"ok":true,"use_as_reference":enabled}),
            origin,
        ),
        Err(error) => mutation_error(error, origin),
    }
}

struct DraftGenerationInput {
    item_ids: Vec<i64>,
    account_id: Option<String>,
}

struct GeneratedDraftContent {
    title: String,
    body: String,
    tags: Vec<String>,
}

fn parse_draft_generation_input(body: &Bytes) -> Result<DraftGenerationInput, String> {
    let object = parse_json_object(body)?;
    let mut item_ids = match object.get("item_ids") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_i64()
                    .filter(|id| *id > 0)
                    .ok_or_else(|| "item_ids 必须是正整数数组".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("item_ids 必须是整数数组".to_string()),
    };
    if item_ids.is_empty() {
        if let Some(item_id) = optional_json_integer(&object, "item_id")? {
            if item_id <= 0 {
                return Err("item_id 必须是正整数".to_string());
            }
            item_ids.push(item_id);
        }
    }
    let account_id = optional_json_string(&object, "account_id")?;
    Ok(DraftGenerationInput {
        item_ids,
        account_id,
    })
}

fn generated_section(text: &str, marker: &str) -> String {
    let mut found = false;
    let mut lines = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if !found {
            if trimmed.starts_with(marker) {
                found = true;
            }
            continue;
        }
        if trimmed.starts_with("---") {
            break;
        }
        lines.push(line);
    }
    lines.join("\n").trim().to_string()
}

fn strip_chinese_parenthetical_annotations(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut in_annotation = false;
    for character in text.chars() {
        match character {
            '（' => in_annotation = true,
            '）' => in_annotation = false,
            _ if !in_annotation => output.push(character),
            _ => {}
        }
    }
    output
}

fn parse_generated_draft(text: &str) -> GeneratedDraftContent {
    let title_section = generated_section(text, "---标题候选");
    let title = title_section
        .lines()
        .map(strip_chinese_parenthetical_annotations)
        .map(|line| line.trim().to_string())
        .map(|line| {
            [
                "情绪型：",
                "问题型：",
                "场景型：",
                "情绪型:",
                "问题型:",
                "场景型:",
            ]
            .iter()
            .find_map(|prefix| line.strip_prefix(prefix))
            .unwrap_or(&line)
            .trim()
            .to_string()
        })
        .find(|line| !line.is_empty())
        .unwrap_or_default();

    let body_section =
        strip_chinese_parenthetical_annotations(&generated_section(text, "---正文---"));
    let mut paragraphs = body_section
        .replace("\r\n", "\n")
        .split("\n\n")
        .map(str::trim)
        .filter(|paragraph| !paragraph.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let cta = strip_chinese_parenthetical_annotations(&generated_section(text, "---互动引导---"));
    if !cta.trim().is_empty() {
        paragraphs.push(cta.trim().to_string());
    }
    let body = paragraphs.join("\n\n");

    let tag_section = generated_section(text, "---话题标签---");
    let tag_characters = tag_section.chars().collect::<Vec<_>>();
    let mut tags = Vec::new();
    let mut cursor = 0;
    while cursor < tag_characters.len() {
        if tag_characters[cursor] != '#' {
            cursor += 1;
            continue;
        }
        cursor += 1;
        let start = cursor;
        while cursor < tag_characters.len()
            && (tag_characters[cursor].is_alphanumeric()
                || tag_characters[cursor] == '_'
                || tag_characters[cursor] == '-')
        {
            cursor += 1;
        }
        if cursor > start {
            tags.push(tag_characters[start..cursor].iter().collect());
        }
    }

    GeneratedDraftContent { title, body, tags }
}

async fn route_content_draft_generate(
    db: &LocalDb,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    if !is_json_content_type(content_type) {
        return json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"detail":"请求体必须使用 application/json"}),
            origin,
        );
    }
    let request = match parse_draft_generation_input(body) {
        Ok(request) => request,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    if request.item_ids.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"detail":"item_id 或 item_ids 不能为空"}),
            origin,
        );
    }
    if request.item_ids.len() > 9 {
        return json_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"detail":"一篇笔记最多关联 9 张图片"}),
            origin,
        );
    }
    let active = match db.current_active_account() {
        Ok(account) => account,
        Err(error) => return db_error(error, origin),
    };
    let snapshot = match db.snapshot_section_for_account(Some(active.id), "workspace") {
        Ok(snapshot) => snapshot,
        Err(error) => return db_error(error.to_string(), origin),
    };
    let items_by_id = snapshot
        .items
        .iter()
        .map(|item| (item.id, item))
        .collect::<HashMap<_, _>>();
    let mut items = Vec::with_capacity(request.item_ids.len());
    for item_id in &request.item_ids {
        let Some(item) = items_by_id.get(item_id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":format!("物品 {item_id} 不存在")}),
                origin,
            );
        };
        items.push((**item).clone());
    }
    let reference = request.account_id.as_deref().and_then(|account_id| {
        snapshot
            .reference_accounts
            .iter()
            .find(|account| account.account_id == account_id)
    });
    let knowledge = match db.local_content_knowledge_context(Some(active.id)) {
        Ok(context) => context,
        Err(error) => return db_error(error, origin),
    };
    let prompt = if items.len() == 1 {
        aichihongshu_services::prompt::build_draft_prompt_with_knowledge(
            &items[0],
            snapshot.profile.as_ref(),
            reference,
            "",
            Some(&knowledge),
        )
    } else {
        aichihongshu_services::prompt::build_multi_draft_prompt(
            &items,
            snapshot.profile.as_ref(),
            reference,
            "",
            Some(&knowledge),
        )
    };
    if prompt.chars().count() > 100_000 {
        return json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({"detail":"创作 prompt 超过 100000 个字符"}),
            origin,
        );
    }
    let (provider, model) = match default_model_provider(db) {
        Ok(provider) => provider,
        Err(error) => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"detail":format!("AI 生成失败：{error}")}),
                origin,
            )
        }
    };
    let messages = [json!({"role":"user","content":prompt})];
    let ai_text = match aichihongshu_services::text_api::complete_compatible_chat(
        &provider, &model, "", &messages, 2048,
    )
    .await
    {
        Ok(text) => text,
        Err(error) => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"detail":format!("AI 生成失败：{error}")}),
                origin,
            )
        }
    };
    let generated = parse_generated_draft(&ai_text);
    let note = match db.create_local_note(LocalNoteCreate {
        account_pool_id: active.id,
        item_ids: request.item_ids,
        account_ref: request.account_id,
        title: (!generated.title.is_empty()).then_some(generated.title.clone()),
        body: (!generated.body.is_empty()).then_some(generated.body.clone()),
        tags: generated.tags.clone(),
        cover_desc: None,
        prompt_used: Some(prompt),
        note_type: "text".to_string(),
        video_path: None,
    }) {
        Ok(note) => note,
        Err(error) => return mutation_error(error, origin),
    };
    json_response(
        StatusCode::OK,
        json!({
            "note_id":note.id,
            "title":generated.title,
            "body":generated.body,
            "tags":generated.tags,
        }),
        origin,
    )
}

fn local_knowledge_summary(knowledge: &aichihongshu_db::LocalContentKnowledgeContext) -> String {
    let mut parts = Vec::new();
    if !knowledge.rules.is_empty() {
        parts.push(format!("{} 条互动规律", knowledge.rules.len()));
    }
    if !knowledge.my_samples.is_empty() {
        parts.push(format!("{} 篇高赞样本", knowledge.my_samples.len()));
    }
    if !knowledge.reference_samples.is_empty() {
        parts.push(format!("{} 篇榜样参考", knowledge.reference_samples.len()));
    }
    if !knowledge.inspirations.is_empty() {
        parts.push(format!("{} 条选题灵感", knowledge.inspirations.len()));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("已注入：{}", parts.join(" · "))
    }
}

fn route_content_prompt_draft(
    db: &LocalDb,
    path: &str,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    if !is_json_content_type(content_type) {
        return json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"detail":"请求体必须使用 application/json"}),
            origin,
        );
    }
    let object = match parse_json_object(body) {
        Ok(object) => object,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let is_multi = path == "/api/content/draft/multi";
    let item_ids = if is_multi {
        match object.get("item_ids") {
            Some(Value::Array(values)) => values
                .iter()
                .map(|value| {
                    value
                        .as_i64()
                        .filter(|id| *id > 0)
                        .ok_or_else(|| "item_ids 必须是正整数数组".to_string())
                })
                .collect::<Result<Vec<_>, _>>(),
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(_) => Err("item_ids 必须是整数数组".to_string()),
        }
    } else {
        match optional_json_integer(&object, "item_id") {
            Ok(Some(item_id)) if item_id > 0 => Ok(vec![item_id]),
            Ok(Some(_)) => Err("item_id 必须是正整数".to_string()),
            Ok(None) => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    };
    let item_ids = match item_ids {
        Ok(item_ids) => item_ids,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    if item_ids.is_empty() {
        let detail = if is_multi {
            "item_ids 不能为空"
        } else {
            "item_id 不能为空"
        };
        return json_response(StatusCode::BAD_REQUEST, json!({"detail":detail}), origin);
    }
    if item_ids.len() > 9 {
        return json_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"detail":"一篇笔记最多关联 9 张图片"}),
            origin,
        );
    }
    let account_id = match optional_json_string(&object, "account_id") {
        Ok(account_id) => account_id,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let save = if is_multi {
        true
    } else {
        match optional_json_bool(&object, "save") {
            Ok(save) => save.unwrap_or(false),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        }
    };
    let active = match db.current_active_account() {
        Ok(account) => account,
        Err(error) => return db_error(error, origin),
    };
    let snapshot = match db.snapshot_section_for_account(Some(active.id), "workspace") {
        Ok(snapshot) => snapshot,
        Err(error) => return db_error(error.to_string(), origin),
    };
    let items_by_id = snapshot
        .items
        .iter()
        .map(|item| (item.id, item))
        .collect::<HashMap<_, _>>();
    let mut items = Vec::with_capacity(item_ids.len());
    for item_id in &item_ids {
        let Some(item) = items_by_id.get(item_id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":format!("物品 {item_id} 不存在")}),
                origin,
            );
        };
        items.push((**item).clone());
    }
    let reference = account_id.as_deref().and_then(|account_id| {
        snapshot
            .reference_accounts
            .iter()
            .find(|account| account.account_id == account_id)
    });
    let knowledge = match db.local_content_knowledge_context(Some(active.id)) {
        Ok(context) => context,
        Err(error) => return db_error(error, origin),
    };
    let prompt = if is_multi {
        aichihongshu_services::prompt::build_multi_draft_prompt(
            &items,
            snapshot.profile.as_ref(),
            reference,
            "",
            Some(&knowledge),
        )
    } else {
        aichihongshu_services::prompt::build_draft_prompt_with_knowledge(
            &items[0],
            snapshot.profile.as_ref(),
            reference,
            "",
            Some(&knowledge),
        )
    };
    if prompt.chars().count() > 100_000 {
        return json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({"detail":"创作 prompt 超过 100000 个字符"}),
            origin,
        );
    }
    let knowledge_summary = local_knowledge_summary(&knowledge);
    let note_id = if save {
        match db.create_local_note(LocalNoteCreate {
            account_pool_id: active.id,
            item_ids,
            account_ref: account_id,
            title: None,
            body: None,
            tags: Vec::new(),
            cover_desc: None,
            prompt_used: Some(prompt.clone()),
            note_type: "text".to_string(),
            video_path: None,
        }) {
            Ok(note) => Some(note.id),
            Err(error) => return mutation_error(error, origin),
        }
    } else {
        None
    };
    if is_multi {
        json_response(
            StatusCode::OK,
            json!({
                "note_id":note_id,
                "item_count":items.len(),
                "knowledge_summary":knowledge_summary,
            }),
            origin,
        )
    } else {
        json_response(
            StatusCode::OK,
            json!({
                "prompt":prompt,
                "note_id":note_id,
                "knowledge_summary":knowledge_summary,
            }),
            origin,
        )
    }
}

async fn route_content_write(
    db: &LocalDb,
    method: &Method,
    path: &str,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if method == Method::POST
        && segments.len() == 4
        && segments[0..2] == ["api", "content"]
        && segments[2].parse::<i64>().is_ok()
        && segments[3] == "publish-auto"
    {
        return retired_publish_response(
            "自动发布入口已退役。请在发布准备页检查内容，通过受控浏览器填充后由用户手动提交。",
            "manual_publish_assistant",
            origin,
        );
    }
    if method == Method::POST
        && (path == "/api/content/draft" || path == "/api/content/draft/multi")
    {
        return route_content_prompt_draft(db, path, body, content_type, origin);
    }
    if method == Method::POST && path == "/api/content/draft/generate" {
        return route_content_draft_generate(db, body, content_type, origin).await;
    }
    if !is_json_content_type(content_type) && !body.is_empty() {
        return json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"detail":"请求体必须使用 application/json"}),
            origin,
        );
    }
    let object = if body.is_empty() {
        serde_json::Map::new()
    } else {
        match parse_json_object(body) {
            Ok(object) => object,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        }
    };

    if method == Method::POST && (path == "/api/content" || path == "/api/content/") {
        let item_ids = match note_item_ids(&object) {
            Ok(item_ids) => item_ids,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let tags = match optional_json_string_list(&object, "tags") {
            Ok(Some(tags)) => tags,
            Ok(None) => Vec::new(),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let optional_string = |key| optional_json_string(&object, key);
        let (account_ref, title, body_text, cover_desc, prompt_used) = match (
            optional_string("account_ref"),
            optional_string("title"),
            optional_string("body"),
            optional_string("cover_desc"),
            optional_string("prompt_used"),
        ) {
            (Ok(account_ref), Ok(title), Ok(body), Ok(cover_desc), Ok(prompt_used)) => {
                (account_ref, title, body, cover_desc, prompt_used)
            }
            (Err(error), _, _, _, _)
            | (_, Err(error), _, _, _)
            | (_, _, Err(error), _, _)
            | (_, _, _, Err(error), _)
            | (_, _, _, _, Err(error)) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let note_type = match optional_json_string(&object, "note_type") {
            Ok(note_type) => note_type.unwrap_or_else(|| "text".to_string()),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let account_pool_id = match db.current_active_account() {
            Ok(account) => account.id,
            Err(error) => return db_error(error, origin),
        };
        let input = LocalNoteCreate {
            account_pool_id,
            item_ids,
            account_ref,
            title,
            body: body_text,
            tags,
            cover_desc,
            prompt_used,
            note_type,
            video_path: None,
        };
        return match db.create_local_note(input) {
            Ok(note) => json_response(StatusCode::OK, legacy_json(note), origin),
            Err(error) => mutation_error(error, origin),
        };
    }

    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() < 3 || segments[0..2] != ["api", "content"] {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"笔记路由不存在"}),
            origin,
        );
    }
    let Ok(note_id) = segments[2].parse::<i64>() else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"笔记不存在"}),
            origin,
        );
    };
    let (account_pool_id, existing) = match db.get_local_note_for_legacy(note_id) {
        Ok(result) => result,
        Err(error) => return db_error(error, origin),
    };
    let Some(existing) = existing else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":format!("笔记 {note_id} 不存在")}),
            origin,
        );
    };

    if segments.len() == 4 && segments[3] == "status" && method == Method::PATCH {
        let status = match required_json_string(&object, "status") {
            Ok(status) => status,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let note_url = match optional_json_string(&object, "note_url") {
            Ok(note_url) => note_url,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let update = LocalNoteStatusUpdate {
            note_id,
            account_pool_id,
            expected_version: existing.content_version,
            status,
            note_url,
        };
        return match db.update_local_note_status(update) {
            Ok(note) => json_response(StatusCode::OK, legacy_json(note), origin),
            Err(error) => mutation_error(error, origin),
        };
    }

    if segments.len() == 4 && segments[3] == "stats" && method == Method::PATCH {
        let mut updated = existing;
        for field in ["likes", "comments", "collects"] {
            let Some(value) = object.get(field) else {
                continue;
            };
            if value.is_null() {
                continue;
            }
            let Some(value) = value.as_i64() else {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":format!("{field} 必须是整数")}),
                    origin,
                );
            };
            match db.update_local_note_stats(LocalNoteStatsUpdate {
                note_id,
                account_pool_id,
                expected_version: updated.content_version,
                field: field.to_string(),
                value,
            }) {
                Ok(note) => updated = note,
                Err(error) => return mutation_error(error, origin),
            }
        }
        return json_response(StatusCode::OK, legacy_json(updated), origin);
    }

    if segments.len() == 3 && method == Method::PATCH {
        let has_update_fields = object.iter().any(|(key, value)| {
            !value.is_null()
                && matches!(
                    key.as_str(),
                    "title" | "body" | "tags" | "item_ids" | "item_id" | "note_type" | "cover_desc"
                )
        });
        if !has_update_fields {
            return json_response(StatusCode::OK, legacy_json(existing), origin);
        }
        let title = match optional_json_string(&object, "title") {
            Ok(value) => value.unwrap_or_else(|| existing.title.clone().unwrap_or_default()),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let body_text = match optional_json_string(&object, "body") {
            Ok(value) => value.unwrap_or_else(|| existing.body.clone().unwrap_or_default()),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let tags = match optional_json_string_list(&object, "tags") {
            Ok(value) => value.unwrap_or(existing.tags),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let item_ids = match note_item_ids(&object) {
            Ok(value) if object.contains_key("item_ids") || object.contains_key("item_id") => value,
            Ok(_) => existing.item_ids,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let note_type = match optional_json_string(&object, "note_type") {
            Ok(value) => value.unwrap_or(existing.note_type),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let cover_desc = match optional_json_string(&object, "cover_desc") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        return match db.update_local_note_with_cover(
            LocalNoteUpdate {
                note_id,
                account_pool_id,
                expected_version: existing.content_version,
                title,
                body: body_text,
                tags,
                note_type,
                item_ids,
                video_path: None,
            },
            cover_desc,
        ) {
            Ok(note) => json_response(StatusCode::OK, legacy_json(note), origin),
            Err(error) => mutation_error(error, origin),
        };
    }

    if segments.len() == 3 && method == Method::DELETE {
        return match db.delete_local_note(note_id, account_pool_id) {
            Ok(_) => json_response(StatusCode::OK, json!({"ok":true}), origin),
            Err(error) => mutation_error(error, origin),
        };
    }

    if segments.len() == 4 && segments[3] == "stage-images" {
        if method == Method::POST {
            return match db.stage_local_note_images(note_id, Some(account_pool_id)) {
                Ok(staged) => {
                    let files = staged
                        .files
                        .iter()
                        .map(|file| {
                            json!({
                                "index": file.index,
                                "filename": file.filename,
                                "item_id": file.item_id,
                                "title": file.title,
                                "url": format!("/api/content/{note_id}/stage-images/{}", file.filename),
                            })
                        })
                        .collect::<Vec<_>>();
                    json_response(
                        StatusCode::OK,
                        json!({
                            "note_id": staged.note_id,
                            "stage_dir": staged.stage_dir,
                            "count": files.len(),
                            "files": files,
                        }),
                        origin,
                    )
                }
                Err(error) => mutation_error(error, origin),
            };
        }
        if method == Method::DELETE {
            return match db.clear_local_note_stage(note_id, Some(account_pool_id)) {
                Ok(()) => {
                    json_response(StatusCode::OK, json!({"ok":true,"note_id":note_id}), origin)
                }
                Err(error) => mutation_error(error, origin),
            };
        }
    }

    if segments.len() == 4 && segments[3] == "open-stage-dir" && method == Method::POST {
        let stage_dir = match db.local_note_stage_dir(note_id, Some(account_pool_id)) {
            Ok(path) => path,
            Err(error) => return mutation_error(error, origin),
        };
        if !stage_dir.is_dir() {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"暂存目录不存在，请先准备图片"}),
                origin,
            );
        }
        return match open_directory_in_file_manager(&stage_dir) {
            Ok(()) => json_response(
                StatusCode::OK,
                json!({"ok":true,"path":stage_dir.display().to_string()}),
                origin,
            ),
            Err(error) => json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"detail":error}),
                origin,
            ),
        };
    }

    json_response(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({"detail":"笔记路由不支持此操作"}),
        origin,
    )
}

fn start_profile_refresh(state: &Arc<HttpState>, origin: Option<&str>) -> Response<HttpBody> {
    let snapshot = match profile_snapshot(&state.db) {
        Ok(snapshot) => snapshot,
        Err(error) => return db_error(error, origin),
    };
    let Some(profile) = snapshot.profile else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"尚未初始化账号人设"}),
            origin,
        );
    };
    let Some(profile_account_id) = profile
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"detail":"人设中未设置 account_id，无法触发主页刷新。请先填写小红书账号 ID。"}),
            origin,
        );
    };
    let account_pool_id = snapshot.active_account.id;
    {
        let Ok(mut statuses) = state.profile_refresh.lock() else {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"detail":"主页刷新状态暂不可用"}),
                origin,
            );
        };
        if statuses
            .get(&account_pool_id)
            .is_some_and(|status| status.running)
        {
            return json_response(
                StatusCode::CONFLICT,
                json!({"detail":"已有刷新任务正在运行，请稍候"}),
                origin,
            );
        }
        statuses.insert(
            account_pool_id,
            ProfileRefreshStatus {
                running: true,
                last_error: None,
            },
        );
    }

    let task_state = Arc::clone(state);
    let task_profile_id = profile_account_id.clone();
    tokio::spawn(async move {
        let worker = task_state.browser_worker.clone();
        let db = Arc::clone(&task_state.db);
        let result = tokio::task::spawn_blocking(move || {
            capture_operator_profile(&db, &worker, account_pool_id, &task_profile_id)
        })
        .await
        .unwrap_or_else(|error| Err(format!("等待主页采集任务失败：{error}")));
        if let Ok(mut statuses) = task_state.profile_refresh.lock() {
            statuses.insert(
                account_pool_id,
                ProfileRefreshStatus {
                    running: false,
                    last_error: result.err(),
                },
            );
        }
    });

    json_response(
        StatusCode::OK,
        json!({"message":"刷新任务已启动","account_id":profile_account_id}),
        origin,
    )
}

fn capture_operator_profile(
    db: &LocalDb,
    worker: &BrowserWorkerManager,
    account_pool_id: i64,
    profile_account_id: &str,
) -> Result<(), String> {
    let url = format!("https://www.xiaohongshu.com/user/profile/{profile_account_id}");
    let captured = worker.collect_profile(account_pool_id, url)?;
    let capture_state = captured
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("partial");
    match capture_state {
        "login-required" => {
            return Err("独立浏览器尚未登录小红书。请在新打开的浏览器中完成登录，再刷新。".into());
        }
        "verification-required" => {
            return Err("小红书要求安全验证。请在独立浏览器中手动完成验证，再刷新。".into());
        }
        "not-profile" => return Err("当前页面不是小红书主页，请检查账号 ID 后重试。".into()),
        "complete" | "partial" => {}
        _ => return Err("主页采集返回了未知状态，未写入资料。".into()),
    }
    let profile = captured
        .get("profile")
        .filter(|value| !value.is_null())
        .ok_or_else(|| "主页未返回可用资料，未写入数据库。".to_string())?;
    if profile.get("profileId").and_then(Value::as_str) != Some(profile_account_id) {
        return Err("采集到的主页 ID 与当前账号不一致，未写入数据库。".into());
    }
    let tags = profile
        .get("tags")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let profile_updated = db.update_profile_from_browser_snapshot(BrowserProfileSnapshot {
        account_pool_id,
        profile_account_id,
        display_name: profile.get("displayName").and_then(Value::as_str),
        followers: profile.get("followers").and_then(Value::as_i64),
        total_notes: profile.get("totalNotes").and_then(Value::as_i64),
        avatar_url: profile.get("avatarUrl").and_then(Value::as_str),
        xhs_bio: profile.get("bio").and_then(Value::as_str),
        xhs_follows: profile.get("follows").and_then(Value::as_i64),
        ip_location: profile.get("ipLocation").and_then(Value::as_str),
        xhs_tags: (!tags.is_empty()).then_some(tags.as_slice()),
    })?;
    if !profile_updated {
        return Err("该主页 ID 尚未绑定到当前运营账号；为避免写错账号，资料没有更新。".into());
    }
    let notes = captured
        .get("notes")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let notes = serde_json::from_value::<Vec<BrowserProfileNote>>(notes)
        .map_err(|error| format!("主页笔记格式无效，资料已更新但笔记未同步：{error}"))?;
    db.sync_profile_notes_from_browser_snapshot(
        account_pool_id,
        profile_account_id,
        None,
        capture_state == "complete",
        &notes,
    )?;
    Ok(())
}

fn selected_browser_account_id(
    requested: Option<&String>,
    active_account_id: i64,
) -> Result<i64, String> {
    let Some(requested) = requested else {
        return Ok(active_account_id);
    };
    let account_id = requested
        .parse::<i64>()
        .map_err(|_| "account_id 必须是正整数".to_string())?;
    if account_id <= 0 {
        return Err("account_id 必须是正整数".into());
    }
    Ok(account_id)
}

async fn route_crawler_browser(
    state: &Arc<HttpState>,
    method: &Method,
    query: &HashMap<String, String>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    let pool = match state.db.account_pool() {
        Ok(pool) => pool,
        Err(error) => return db_error(error.to_string(), origin),
    };
    let active_id = match pool.items.iter().find(|account| account.is_active) {
        Some(account) => account.id,
        None => {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"尚未设置激活账号"}),
                origin,
            )
        }
    };
    let account_id = match selected_browser_account_id(query.get("account_id"), active_id) {
        Ok(account_id) => account_id,
        Err(error) => {
            return json_response(StatusCode::BAD_REQUEST, json!({"detail":error}), origin)
        }
    };
    let Some(account) = pool.items.iter().find(|account| account.id == account_id) else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":format!("账号 {account_id} 不存在")}),
            origin,
        );
    };
    if *method == Method::POST && account.status == "retired" {
        return json_response(
            StatusCode::CONFLICT,
            json!({"detail":"已退休账号不能启动浏览器会话"}),
            origin,
        );
    }
    let worker = state.browser_worker.clone();
    let action = method.clone();
    let result = tokio::task::spawn_blocking(move || {
        if action == Method::GET {
            worker.status(account_id)
        } else if action == Method::POST {
            worker.open_session(account_id)
        } else {
            worker.close_session(account_id)
        }
    })
    .await
    .unwrap_or_else(|error| Err(format!("浏览器会话任务失败：{error}")));
    match result {
        Ok(result) if *method == Method::GET => json_response(
            StatusCode::OK,
            json!({
                "running": result.get("status").and_then(Value::as_str) == Some("running"),
                "account_id": account_id,
            }),
            origin,
        ),
        Ok(result) if *method == Method::POST => json_response(
            StatusCode::OK,
            json!({
                "status": result.get("status").and_then(Value::as_str).unwrap_or("launched"),
                "account_id": account_id,
            }),
            origin,
        ),
        Ok(result) => json_response(
            StatusCode::OK,
            json!({
                "status": if result.get("status").and_then(Value::as_str) == Some("stopped") {
                    "not_running"
                } else {
                    "closed"
                },
                "account_id": account_id,
            }),
            origin,
        ),
        Err(error) => json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"detail":error}),
            origin,
        ),
    }
}

fn route_crawler_creator(
    state: &Arc<HttpState>,
    body: &Bytes,
    origin: Option<&str>,
    risk_acknowledged: bool,
) -> Response<HttpBody> {
    let request: CreatorCaptureRequest = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":format!("榜样账号请求格式无效：{error}")}),
                origin,
            )
        }
    };
    let (profile_account_id, profile_url) = match normalize_creator_profile_url(&request.url) {
        Ok(value) => value,
        Err(error) => {
            return json_response(StatusCode::BAD_REQUEST, json!({"detail":error}), origin)
        }
    };
    let name = request
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if name
        .as_ref()
        .is_some_and(|value| value.chars().count() > 200)
    {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"detail":"榜样账号名称不能超过 200 个字符"}),
            origin,
        );
    }
    let active = match state.db.current_active_account() {
        Ok(active) => active,
        Err(error) => return db_error(error, origin),
    };
    if active.role == "operation" && !risk_acknowledged {
        return json_response(
            StatusCode::PRECONDITION_REQUIRED,
            json!({"detail":{
                "code":"REQUIRES_CONFIRMATION",
                "action":"crawler_creator",
                "alias":active.alias,
                "role":active.role,
                "message":format!("当前是运营账号「{}」，抓取榜样主页可能触发小红书风控。建议切换到辅助账号；如确认继续，请确认风险。", active.alias)
            }}),
            origin,
        );
    }

    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
    let worker_request_id = format!(
        "rn-creator-{}-{}",
        std::process::id(),
        NEXT_CREATOR_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    );
    let _ = send_creator_sse(
        &sender,
        json!({"message":"正在启动独立浏览器并读取主页...","done":false}),
    );
    let state = Arc::clone(state);
    tokio::spawn(async move {
        let db = Arc::clone(&state.db);
        let worker = state.browser_worker.clone();
        let cancellation_worker = worker.clone();
        let account_pool_id = active.id;
        let cancellation_request_id = worker_request_id.clone();
        let capture_cancelled = Arc::new(AtomicBool::new(false));
        let task_finished = Arc::new(AtomicBool::new(false));
        let capture_cancelled_for_task = Arc::clone(&capture_cancelled);
        let task_finished_for_task = Arc::clone(&task_finished);
        let capture_task = tokio::task::spawn_blocking(move || {
            let result = capture_reference_profile(
                &db,
                &worker,
                account_pool_id,
                ReferenceCaptureRequest {
                    request_id: &worker_request_id,
                    cancelled: &capture_cancelled_for_task,
                    profile_account_id: &profile_account_id,
                    profile_url: &profile_url,
                    preferred_name: name.as_deref(),
                    save_db: request.save_db,
                },
            );
            task_finished_for_task.store(true, Ordering::Release);
            result
        });
        tokio::pin!(capture_task);
        let result = loop {
            tokio::select! {
                joined = &mut capture_task => {
                    break joined.unwrap_or_else(|error| Err(format!("等待榜样主页采集任务失败：{error}")));
                }
                _ = tokio::time::sleep(Duration::from_millis(150)) => {
                    if sender.is_closed() {
                        capture_cancelled.store(true, Ordering::Release);
                        for _ in 0..60 {
                            if task_finished.load(Ordering::Acquire) {
                                break;
                            }
                            let worker = cancellation_worker.clone();
                            let request_id = cancellation_request_id.clone();
                            let result = tokio::task::spawn_blocking(move || {
                                worker.cancel_task(account_pool_id, request_id)
                            })
                            .await
                            .ok()
                            .and_then(Result::ok);
                            if result
                                .as_ref()
                                .and_then(|value| value.get("status"))
                                .and_then(Value::as_str)
                                == Some("cancelled")
                            {
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        return;
                    }
                }
            }
        };
        match result {
            Ok(profile) => {
                let message = if request.save_db {
                    "导入完成"
                } else {
                    "主页读取完成"
                };
                let _ = send_creator_sse(
                    &sender,
                    json!({
                        "message":message,
                        "done":true,
                        "nickname":profile["displayName"],
                        "account_id":profile["accountId"],
                    }),
                );
            }
            Err(error) => {
                let _ =
                    send_creator_sse(&sender, json!({"message":error,"done":true,"error":true}));
            }
        }
        let _ = sender.send(Bytes::from_static(b"data: [DONE]\n\n"));
    });

    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .map(|bytes| (Ok::<Frame<Bytes>, Infallible>(Frame::data(bytes)), receiver))
    });
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(CACHE_CONTROL, "no-cache")
        .header("x-accel-buffering", "no")
        .body(StreamBody::new(stream).boxed())
        .expect("static crawler SSE headers are valid");
    add_cors_headers(response.headers_mut(), origin);
    response
}

fn send_creator_sse(sender: &tokio::sync::mpsc::UnboundedSender<Bytes>, event: Value) -> bool {
    let Ok(payload) = serde_json::to_vec(&event) else {
        return false;
    };
    if payload.len() > MAX_CRAWLER_SSE_BYTES {
        return false;
    }
    let mut data = Vec::with_capacity(payload.len() + 8);
    data.extend_from_slice(b"data: ");
    data.extend_from_slice(&payload);
    data.extend_from_slice(b"\n\n");
    sender.send(Bytes::from(data)).is_ok()
}

fn normalize_creator_profile_url(input: &str) -> Result<(String, String), String> {
    let input = input.trim();
    if input.is_empty() || input.chars().count() > 2_048 {
        return Err("请输入有效的小红书主页 URL 或账号 ID".into());
    }
    let (host, path) = if let Some((scheme, remainder)) = input.split_once("://") {
        if !scheme.eq_ignore_ascii_case("https") {
            return Err("榜样主页必须使用 HTTPS".into());
        }
        let (host, path_and_query) = remainder.split_once('/').unwrap_or((remainder, ""));
        if !matches!(
            host.to_ascii_lowercase().as_str(),
            "www.xiaohongshu.com" | "xiaohongshu.com"
        ) || host.contains('@')
        {
            return Err("榜样主页 URL 必须来自小红书官网".into());
        }
        let path = path_and_query.split(['?', '#']).next().unwrap_or_default();
        (Some(host), path)
    } else if input.contains('/') || input.contains(':') {
        return Err("榜样主页 URL 格式无效".into());
    } else {
        (None, input)
    };
    let profile_account_id = if host.is_some() {
        path.strip_prefix("user/profile/")
            .ok_or_else(|| "请输入小红书个人主页链接".to_string())?
            .trim_end_matches('/')
    } else {
        path
    };
    if profile_account_id.is_empty()
        || profile_account_id.len() > 128
        || !profile_account_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("小红书账号 ID 格式无效".into());
    }
    let profile_account_id = profile_account_id.to_string();
    let profile_url = format!("https://www.xiaohongshu.com/user/profile/{profile_account_id}");
    Ok((profile_account_id, profile_url))
}

struct ReferenceCaptureRequest<'a> {
    request_id: &'a str,
    cancelled: &'a AtomicBool,
    profile_account_id: &'a str,
    profile_url: &'a str,
    preferred_name: Option<&'a str>,
    save_db: bool,
}

fn capture_reference_profile(
    db: &LocalDb,
    worker: &BrowserWorkerManager,
    account_pool_id: i64,
    request: ReferenceCaptureRequest<'_>,
) -> Result<Value, String> {
    let captured = worker.collect_profile_with_request_id_cancellable(
        account_pool_id,
        request.profile_url.to_string(),
        request.request_id.to_string(),
        request.cancelled,
    )?;
    let capture_state = captured
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("partial");
    match capture_state {
        "login-required" => {
            return Err("独立浏览器尚未登录小红书。请在新打开的浏览器中完成登录，再抓取。".into());
        }
        "verification-required" => {
            return Err("小红书要求安全验证。请在独立浏览器中手动完成验证，再重试。".into());
        }
        "not-profile" => return Err("当前页面不是小红书主页，请检查链接后重试。".into()),
        "complete" | "partial" => {}
        _ => return Err("主页采集返回了未知状态，未写入数据。".into()),
    }
    let profile = captured
        .get("profile")
        .filter(|value| !value.is_null())
        .ok_or_else(|| "主页未返回可用资料。".to_string())?;
    if profile.get("profileId").and_then(Value::as_str) != Some(request.profile_account_id) {
        return Err("采集到的主页 ID 与请求目标不一致，未写入数据。".into());
    }
    let display_name = request
        .preferred_name
        .filter(|value| !value.trim().is_empty())
        .or_else(|| profile.get("displayName").and_then(Value::as_str));
    let followers = profile.get("followers").and_then(Value::as_i64);
    let total_notes = profile.get("totalNotes").and_then(Value::as_i64);
    if request.save_db {
        db.create_local_reference_account(LocalReferenceAccountCreate {
            account_pool_id,
            account_id: request.profile_account_id.to_string(),
            name: display_name.map(str::to_string),
            followers: followers.unwrap_or_default(),
        })?;
        let reference_id = db
            .local_reference_account_id_for_capture(account_pool_id, request.profile_account_id)?
            .ok_or_else(|| "榜样账号没有写入当前运营账号的数据池。".to_string())?;
        let updated = db.update_reference_account_from_browser_snapshot(
            account_pool_id,
            reference_id,
            request.profile_account_id,
            display_name,
            followers,
            total_notes,
        )?;
        if !updated {
            return Err("榜样账号与当前运营账号不匹配，已停止写入。".into());
        }
        let notes = captured
            .get("notes")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let notes = serde_json::from_value::<Vec<BrowserProfileNote>>(notes)
            .map_err(|error| format!("主页笔记格式无效：{error}"))?;
        db.sync_profile_notes_from_browser_snapshot(
            account_pool_id,
            request.profile_account_id,
            Some(reference_id),
            capture_state == "complete",
            &notes,
        )?;
    }
    Ok(json!({"accountId":request.profile_account_id,"displayName":display_name}))
}

fn route_profile_write(
    state: &Arc<HttpState>,
    method: &Method,
    path: &str,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    if *method == Method::POST && path == "/api/profile/refresh" {
        return start_profile_refresh(state, origin);
    }
    if *method != Method::PATCH || !matches!(path, "/api/profile" | "/api/profile/") {
        return json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"detail":"人设路由不支持此操作"}),
            origin,
        );
    }
    if !is_json_content_type(content_type) {
        return json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"detail":"请求体必须使用 application/json"}),
            origin,
        );
    }
    let object = match parse_json_object(body) {
        Ok(object) => object,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let editable_fields = [
        "account_id",
        "display_name",
        "niche",
        "target_audience",
        "persona_name",
        "persona_bio",
        "persona_tone",
        "posting_rhythm",
        "content_pillars",
        "persona_taboos",
        "preferred_styles",
        "preferred_scenes",
        "hashtag_pool",
        "followers",
        "avatar_url",
        "xhs_bio",
        "xhs_follows",
        "ip_location",
        "xhs_tags",
        "risk_warning_ack",
    ];
    if !editable_fields
        .iter()
        .any(|field| object.get(*field).is_some_and(|value| !value.is_null()))
    {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"detail":"没有可更新的字段"}),
            origin,
        );
    }
    let db = &state.db;
    let snapshot = match profile_snapshot(db) {
        Ok(snapshot) => snapshot,
        Err(error) => return db_error(error, origin),
    };
    let Some(existing) = snapshot.profile else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"当前账号尚未初始化人设"}),
            origin,
        );
    };
    let string_field = |key: &str, current: Option<String>| {
        optional_json_string(&object, key).map(|value| value.or(current))
    };
    let (
        account_id,
        display_name,
        niche,
        target_audience,
        persona_name,
        persona_bio,
        persona_tone,
        posting_rhythm,
    ) = match (
        string_field("account_id", existing.account_id),
        string_field("display_name", existing.display_name),
        string_field("niche", existing.niche),
        string_field("target_audience", existing.target_audience),
        string_field("persona_name", existing.persona_name),
        string_field("persona_bio", existing.persona_bio),
        string_field("persona_tone", existing.persona_tone),
        string_field("posting_rhythm", existing.posting_rhythm),
    ) {
        (
            Ok(account_id),
            Ok(display_name),
            Ok(niche),
            Ok(target_audience),
            Ok(persona_name),
            Ok(persona_bio),
            Ok(persona_tone),
            Ok(posting_rhythm),
        ) => (
            account_id,
            display_name,
            niche,
            target_audience,
            persona_name,
            persona_bio,
            persona_tone,
            posting_rhythm,
        ),
        (Err(error), _, _, _, _, _, _, _)
        | (_, Err(error), _, _, _, _, _, _)
        | (_, _, Err(error), _, _, _, _, _)
        | (_, _, _, Err(error), _, _, _, _)
        | (_, _, _, _, Err(error), _, _, _)
        | (_, _, _, _, _, Err(error), _, _)
        | (_, _, _, _, _, _, Err(error), _)
        | (_, _, _, _, _, _, _, Err(error)) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let list_field = |key: &str, current: Vec<String>| {
        optional_json_string_list(&object, key).map(|value| value.unwrap_or(current))
    };
    let (content_pillars, persona_taboos, preferred_styles, preferred_scenes, hashtag_pool) = match (
        list_field("content_pillars", existing.content_pillars),
        list_field("persona_taboos", existing.persona_taboos),
        list_field("preferred_styles", existing.preferred_styles),
        list_field("preferred_scenes", existing.preferred_scenes),
        list_field("hashtag_pool", existing.hashtag_pool),
    ) {
        (Ok(a), Ok(b), Ok(c), Ok(d), Ok(e)) => (a, b, c, d, e),
        (Err(error), _, _, _, _)
        | (_, Err(error), _, _, _)
        | (_, _, Err(error), _, _)
        | (_, _, _, Err(error), _)
        | (_, _, _, _, Err(error)) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let followers = match optional_json_integer(&object, "followers") {
        Ok(followers) if followers.is_none_or(|value| value >= 0) => followers,
        Ok(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"detail":"粉丝数不能小于 0"}),
                origin,
            )
        }
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let xhs_follows = match optional_json_integer(&object, "xhs_follows") {
        Ok(follows) if follows.is_none_or(|value| value >= 0) => follows,
        Ok(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"detail":"关注数不能小于 0"}),
                origin,
            )
        }
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let risk_warning_ack = match optional_json_integer(&object, "risk_warning_ack") {
        Ok(ack) if ack.is_none_or(|value| matches!(value, 0 | 1)) => ack,
        Ok(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"detail":"风险确认字段只能是 0 或 1"}),
                origin,
            )
        }
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let (avatar_url, xhs_bio, ip_location, xhs_tags) = match (
        optional_json_string(&object, "avatar_url"),
        optional_json_string(&object, "xhs_bio"),
        optional_json_string(&object, "ip_location"),
        optional_json_string_list(&object, "xhs_tags"),
    ) {
        (Ok(a), Ok(b), Ok(c), Ok(d)) => (a, b, c, d),
        (Err(error), _, _, _)
        | (_, Err(error), _, _)
        | (_, _, Err(error), _)
        | (_, _, _, Err(error)) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let update = LocalProfileUpdate {
        account_pool_id: existing.account_pool_id,
        account_id,
        display_name,
        niche,
        target_audience,
        content_pillars,
        followers,
        persona_name,
        persona_bio,
        persona_tone,
        persona_taboos,
        preferred_styles,
        preferred_scenes,
        hashtag_pool,
        posting_rhythm,
        avatar_url,
        xhs_bio,
        xhs_follows,
        ip_location,
        xhs_tags,
        risk_warning_ack,
    };
    if let Err(error) = db.update_local_profile(update) {
        return mutation_error(error, origin);
    }
    match profile_snapshot(db) {
        Ok(snapshot) => json_response(StatusCode::OK, legacy_json(snapshot.profile), origin),
        Err(error) => db_error(error, origin),
    }
}

fn route_account_pool_write(
    db: &LocalDb,
    method: &Method,
    path: &str,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    let needs_body = *method == Method::POST
        && matches!(path, "/api/account-pool" | "/api/account-pool/")
        || *method == Method::PATCH;
    if needs_body && !is_json_content_type(content_type) {
        return json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"detail":"请求体必须使用 application/json"}),
            origin,
        );
    }
    let object = if body.is_empty() {
        serde_json::Map::new()
    } else {
        match parse_json_object(body) {
            Ok(object) => object,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        }
    };

    if *method == Method::POST && matches!(path, "/api/account-pool" | "/api/account-pool/") {
        let alias = match required_json_string(&object, "alias") {
            Ok(alias) => alias,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let role = match optional_json_string(&object, "role") {
            Ok(role) => role.unwrap_or_else(|| "operation".to_string()),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let notes = match optional_json_string(&object, "notes") {
            Ok(notes) => notes,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        return match db.create_local_account(LocalAccountCreate { alias, role, notes }) {
            Ok(account_id) => account_by_id(db, account_id, origin),
            Err(error) => account_mutation_error(error, origin),
        };
    }

    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() < 3 || segments[0..2] != ["api", "account-pool"] {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"账号路由不存在"}),
            origin,
        );
    }
    let Ok(account_id) = segments[2].parse::<i64>() else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"账号不存在"}),
            origin,
        );
    };

    if segments.len() == 4 && segments[3] == "activate" && *method == Method::POST {
        return match db.activate_account(account_id) {
            Ok(_) => account_by_id(db, account_id, origin),
            Err(error) => account_mutation_error(error.to_string(), origin),
        };
    }
    if segments.len() == 4 && segments[3] == "mark-banned" && *method == Method::POST {
        return match db.mark_local_account_banned(account_id) {
            Ok(()) => account_by_id(db, account_id, origin),
            Err(error) => account_mutation_error(error, origin),
        };
    }

    if segments.len() == 3 && *method == Method::DELETE {
        return match db.retire_local_account(account_id) {
            Ok(()) => json_response(StatusCode::OK, json!({"ok":true}), origin),
            Err(error) => account_mutation_error(error, origin),
        };
    }

    if segments.len() == 3 && *method == Method::PATCH {
        let existing = match find_pool_account(db, account_id) {
            Ok(Some(account)) => account,
            Ok(None) => {
                return json_response(
                    StatusCode::NOT_FOUND,
                    json!({"detail":format!("账号 {account_id} 不存在")}),
                    origin,
                )
            }
            Err(error) => return db_error(error, origin),
        };
        let parse_field = |key: &str, current: Option<String>| {
            optional_json_string(&object, key).map(|value| value.or(current))
        };
        let (alias, role, notes, status, xhs_user_id, display_name) = match (
            parse_field("alias", Some(existing.alias.clone())),
            parse_field("role", Some(existing.role.clone())),
            parse_field("notes", existing.notes.clone()),
            parse_field("status", Some(existing.status.clone())),
            parse_field("xhs_user_id", existing.xhs_user_id.clone()),
            parse_field("display_name", existing.display_name.clone()),
        ) {
            (Ok(alias), Ok(role), Ok(notes), Ok(status), Ok(xhs_user_id), Ok(display_name)) => (
                alias.unwrap_or_default(),
                role.unwrap_or_default(),
                notes,
                status.unwrap_or_default(),
                xhs_user_id,
                display_name,
            ),
            (Err(error), _, _, _, _, _)
            | (_, Err(error), _, _, _, _)
            | (_, _, Err(error), _, _, _)
            | (_, _, _, Err(error), _, _)
            | (_, _, _, _, Err(error), _)
            | (_, _, _, _, _, Err(error)) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let followers = match optional_json_integer(&object, "followers") {
            Ok(value) => value.or(Some(existing.followers)),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        return match db.update_local_account(LocalAccountUpdate {
            account_id,
            alias,
            role,
            xhs_user_id,
            display_name,
            status,
            followers,
            notes,
        }) {
            Ok(()) => account_by_id(db, account_id, origin),
            Err(error) => account_mutation_error(error, origin),
        };
    }

    json_response(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({"detail":"账号路由不支持此操作"}),
        origin,
    )
}

async fn route_reference_imitate(
    db: &LocalDb,
    path: &str,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() != 4
        || segments[0] != "api"
        || segments[1] != "accounts"
        || segments[3] != "imitate"
    {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"榜样账号不存在"}),
            origin,
        );
    }
    if !is_json_content_type(content_type) {
        return json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"detail":"请求体必须使用 application/json"}),
            origin,
        );
    }
    let object = match parse_json_object(body) {
        Ok(object) => object,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let note_title = match required_json_string(&object, "note_title") {
        Ok(value) if !value.trim().is_empty() => value,
        Ok(_) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":"note_title 不能为空"}),
                origin,
            )
        }
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let note_likes = match optional_json_integer(&object, "note_likes") {
        Ok(value) if value.is_none_or(|value| value >= 0) => value.unwrap_or(0),
        Ok(_) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":"note_likes 不能小于 0"}),
                origin,
            )
        }
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let item_title = match optional_json_string(&object, "item_title") {
        Ok(value) => value.filter(|value| !value.trim().is_empty()),
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let snapshot = match scoped_snapshot(db, "references") {
        Ok(snapshot) => snapshot,
        Err(error) => return db_error(error, origin),
    };
    let Some(account) = snapshot
        .reference_accounts
        .iter()
        .find(|account| account.account_id == segments[2])
    else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":format!("账号 {} 不存在", segments[2])}),
            origin,
        );
    };
    let account_name = account.name.as_deref().unwrap_or(&account.account_id);
    let mut style_text = account.content_style.clone().unwrap_or_default();
    if let Ok(Value::Object(style)) = serde_json::from_str::<Value>(&style_text) {
        let keywords = style
            .get("keywords")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("、")
            })
            .unwrap_or_default();
        let tone = style
            .get("tone")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let hook = style
            .get("hook")
            .and_then(Value::as_str)
            .unwrap_or_default();
        style_text = format!("关键词：{keywords}；语气：{tone}；标题套路：{hook}");
    }
    let item_info = item_title
        .as_deref()
        .map(|title| format!("，要写的物品/主题是「{title}」"))
        .unwrap_or_default();
    let system = "你是小红书内容创作专家，帮助创作者基于竞品分析生成具体的创作指导 Prompt。";
    let prompt = format!(
        "请为以下情况生成一个完整的小红书笔记创作 Prompt：\n\n参考账号：「{account_name}」\n参考文章：「{note_title}」（❤{}）\n该账号风格：{}\n创作任务：模仿该账号风格{item_info}，写一篇小红书笔记\n\n请输出一个给 AI 的完整创作 Prompt，包含：\n1. 风格要求（语气、格式、开头方式）\n2. 标题要求（模仿上面标题的套路，但内容不同）\n3. 正文结构要求\n4. 话题标签建议\n\n直接输出 Prompt 文本，不要解释。",
        format_grouped_count(note_likes),
        if style_text.is_empty() { "（未分析）" } else { &style_text }
    );
    let (provider, model) = match default_model_provider(db) {
        Ok(provider) => provider,
        Err(error) => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"detail":format!("AI 生成失败：{error}")}),
                origin,
            )
        }
    };
    let messages = [json!({"role":"user","content":prompt})];
    match aichihongshu_services::text_api::complete_compatible_chat(
        &provider, &model, system, &messages, 800,
    )
    .await
    {
        Ok(prompt) => json_response(
            StatusCode::OK,
            json!({"prompt":prompt,"account_name":account_name,"reference_title":note_title}),
            origin,
        ),
        Err(error) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"detail":format!("AI 生成失败：{error}")}),
            origin,
        ),
    }
}

async fn route_reference_analyze(
    db: &LocalDb,
    path: &str,
    origin: Option<&str>,
) -> Response<HttpBody> {
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() != 4
        || segments[0] != "api"
        || segments[1] != "accounts"
        || segments[3] != "analyze"
    {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"榜样账号不存在"}),
            origin,
        );
    }
    let snapshot = match scoped_snapshot(db, "references") {
        Ok(snapshot) => snapshot,
        Err(error) => return db_error(error, origin),
    };
    let Some(account) = snapshot
        .reference_accounts
        .iter()
        .find(|account| account.account_id == segments[2])
    else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":format!("账号 {} 不存在", segments[2])}),
            origin,
        );
    };
    let notes_text = account
        .top_notes
        .iter()
        .take(20)
        .enumerate()
        .map(|(index, note)| format!("{}. {}（❤{}）", index + 1, note.title, note.likes))
        .collect::<Vec<_>>()
        .join("\n");
    let notes_text = if notes_text.is_empty() {
        "（暂无高赞笔记数据）"
    } else {
        &notes_text
    };
    let raw_data = account
        .raw_data
        .as_deref()
        .map(|value| value.chars().take(2_000).collect::<String>())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "（无原始数据）".to_string());
    let account_name = account.name.as_deref().unwrap_or(&account.account_id);
    let system = "你是一位小红书内容策略专家，擅长从账号数据中提炼内容风格特征。";
    let prompt = format!(
        "请分析小红书账号「{account_name}」的内容风格特征。\n\n高赞笔记标题列表：\n{notes_text}\n\n原始账号数据摘要：\n{raw_data}\n\n请从以下维度输出风格分析（JSON 格式）：\n{{\n  \"keywords\": [\"关键词1\", \"关键词2\", ...],   // 3-6个核心风格关键词（用于展示标签）\n  \"tone\": \"语气特征描述\",                     // 一句话描述语气\n  \"format\": \"内容格式特征\",                   // 图文排版、封面风格等\n  \"hook\": \"开头/标题钩子套路\",               // 标题/开头的套路\n  \"audience\": \"目标受众描述\",\n  \"summary\": \"综合风格概述（100字内）\"\n}}\n\n只输出 JSON，不要其他解释。"
    );
    let (provider, model) = match default_model_provider(db) {
        Ok(provider) => provider,
        Err(error) => return sse_error_response(error, origin),
    };
    let database_path = db.path().to_path_buf();
    let active_account_id = snapshot.active_account.id;
    let platform_account_id = account.account_id.clone();
    let on_complete = Box::new(move |content: String| {
        let clean = strip_json_markdown_fence(&content);
        let db =
            LocalDb::open(database_path).map_err(|error| format!("打开本地数据库失败：{error}"))?;
        db.store_local_reference_ai_result(active_account_id, &platform_account_id, "style", &clean)
    });
    stream_ai_response_with_completion(
        provider,
        model,
        system.to_string(),
        vec![json!({"role":"user","content":prompt})],
        2048,
        Some(on_complete),
        origin,
    )
}

async fn route_reference_insights(
    db: &LocalDb,
    path: &str,
    query: &HashMap<String, String>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() != 4
        || segments[0] != "api"
        || segments[1] != "accounts"
        || segments[3] != "insights"
    {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"榜样账号不存在"}),
            origin,
        );
    }
    let refresh = match query.get("refresh").map(String::as_str) {
        None | Some("false") | Some("0") => false,
        Some("true") | Some("1") => true,
        Some(_) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":"refresh 必须是布尔值"}),
                origin,
            )
        }
    };
    let snapshot = match scoped_snapshot(db, "references") {
        Ok(snapshot) => snapshot,
        Err(error) => return db_error(error, origin),
    };
    let Some(account) = snapshot
        .reference_accounts
        .iter()
        .find(|account| account.account_id == segments[2])
    else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":format!("账号 {} 不存在", segments[2])}),
            origin,
        );
    };
    if let Some(cached) = account
        .insights
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if !refresh {
            return static_sse_response(
                &[json!({"text":cached,"cached":true}), json!({"done":true})],
                origin,
            );
        }
    }
    let mut style_text = account.content_style.clone().unwrap_or_default();
    if let Ok(Value::Object(style)) = serde_json::from_str::<Value>(&style_text) {
        style_text = style
            .get("summary")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(&style_text)
            .to_string();
    }
    let notes_text = account
        .top_notes
        .iter()
        .take(15)
        .enumerate()
        .map(|(index, note)| format!("{}. {}（❤{}）", index + 1, note.title, note.likes))
        .collect::<Vec<_>>()
        .join("\n");
    let notes_text = if notes_text.is_empty() {
        "（暂无高赞笔记）"
    } else {
        &notes_text
    };
    let capture_evidence = account
        .raw_data
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let sample_scope = capture_evidence.as_ref().map(|evidence| {
        let notes = evidence
            .get("notes")
            .and_then(Value::as_array)
            .or_else(|| evidence.as_array());
        let loaded = evidence
            .get("scope")
            .and_then(|scope| scope.get("loadedNotes"))
            .and_then(Value::as_u64)
            .or_else(|| notes.map(|notes| notes.len() as u64));
        let state = evidence
            .get("scope")
            .and_then(|scope| scope.get("state"))
            .and_then(Value::as_str)
            .map(|state| match state {
                "complete" => "已滚动到当前可加载列表底部（单次最多 30 条）",
                "partial" => "部分加载或达到 30 条安全上限",
                _ => "范围未记录",
            })
            .unwrap_or("范围未记录");
        let samples = evidence.get("metricSamples");
        let sample_count = |key: &str| {
            samples
                .and_then(|samples| samples.get(key))
                .and_then(Value::as_u64)
                .or_else(|| {
                    notes.map(|notes| {
                        notes
                            .iter()
                            .filter(|note| note.get(key).is_some_and(|value| !value.is_null()))
                            .count() as u64
                    })
                })
                .map(|count| count.to_string())
                .unwrap_or_else(|| "未知".to_string())
        };
        format!(
            "主页采集范围：{state}，可见笔记样本 {} 条；互动指标有效样本：赞 {} 条、评 {} 条、藏 {} 条。",
            loaded.map(|count| count.to_string()).unwrap_or_else(|| "未知".to_string()),
            sample_count("likes"), sample_count("comments"), sample_count("collects")
        )
    }).unwrap_or_else(|| "主页采集范围与互动指标样本数未记录。".to_string());
    let likes_have_sample = capture_evidence
        .as_ref()
        .and_then(|evidence| evidence.get("metricSamples"))
        .and_then(|samples| samples.get("likes"))
        .and_then(Value::as_u64)
        .is_none_or(|count| count > 0);
    let average_likes_text = if likes_have_sample {
        python_float_string(account.avg_likes)
    } else {
        "未知（没有可用赞数样本）".to_string()
    };
    let account_name = account.name.as_deref().unwrap_or(&account.account_id);
    let system = "你是小红书内容运营专家，帮助内容创作者从竞品账号中提炼可学习的创作方法论。";
    let prompt = format!(
        "账号「{account_name}」数据：\n- 粉丝数：{}\n- 均赞：{}\n- 样本范围：{sample_scope}\n- 风格分析：{}\n\n已提供的高赞笔记样本：\n{notes_text}\n\n请输出 4-6 条「值得学习的地方」，每条格式：\n**[要点名称]**：具体说明（30字内，结合上面的数据给出可操作的结论）\n\n要求：\n- 结论只能依据已提供的主页资料、笔记标题和有样本数支撑的互动数据；说明结论来自当前样本，不代表账号全部内容\n- 不推断曝光、浏览量、流量来源、点击转化、引流效果、完播率或其他未提供指标；避免把相关性写成因果\n- 没有样本支持的指标写“未知”，不能按 0 处理\n- 聚焦可复制、可操作的方法，避免泛泛而谈\n- 结合具体标题案例佐证\n- 语气简洁直接",
        format_grouped_count(account.followers),
        average_likes_text,
        if style_text.is_empty() { "（未分析）" } else { &style_text }
    );
    let (provider, model) = match default_model_provider(db) {
        Ok(provider) => provider,
        Err(error) => return sse_error_response(error, origin),
    };
    let database_path = db.path().to_path_buf();
    let active_account_id = snapshot.active_account.id;
    let platform_account_id = account.account_id.clone();
    let on_complete = Box::new(move |content: String| {
        let db =
            LocalDb::open(database_path).map_err(|error| format!("打开本地数据库失败：{error}"))?;
        db.store_local_reference_ai_result(
            active_account_id,
            &platform_account_id,
            "insights",
            &content,
        )
    });
    stream_ai_response_with_completion(
        provider,
        model,
        system.to_string(),
        vec![json!({"role":"user","content":prompt})],
        2048,
        Some(on_complete),
        origin,
    )
}

fn static_sse_response(events: &[Value], origin: Option<&str>) -> Response<HttpBody> {
    let mut body = String::new();
    for event in events {
        if let Ok(payload) = serde_json::to_string(event) {
            body.push_str("data: ");
            body.push_str(&payload);
            body.push_str("\n\n");
        }
    }
    body.push_str("data: [DONE]\n\n");
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(CACHE_CONTROL, "no-cache")
        .header("x-accel-buffering", "no")
        .body(full_body(Bytes::from(body)))
        .expect("static SSE headers are valid");
    add_cors_headers(response.headers_mut(), origin);
    response
}

fn strip_json_markdown_fence(value: &str) -> String {
    let value = value.trim();
    let value = value
        .strip_prefix("```json")
        .or_else(|| value.strip_prefix("```JSON"))
        .or_else(|| value.strip_prefix("```"))
        .unwrap_or(value);
    value
        .strip_suffix("```")
        .unwrap_or(value)
        .trim()
        .to_string()
}

fn format_grouped_count(value: i64) -> String {
    let digits = value.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(character);
    }
    grouped
}

fn python_float_string(value: f64) -> String {
    let rendered = value.to_string();
    if value.is_finite()
        && !rendered.contains('.')
        && !rendered.contains('e')
        && !rendered.contains('E')
    {
        format!("{rendered}.0")
    } else {
        rendered
    }
}

fn route_reference_account_write(
    db: &LocalDb,
    method: &Method,
    path: &str,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    let collection_path = matches!(path, "/api/accounts" | "/api/accounts/");
    let needs_body = (*method == Method::POST && collection_path) || *method == Method::PATCH;
    if needs_body && !is_json_content_type(content_type) {
        return json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"detail":"请求体必须使用 application/json"}),
            origin,
        );
    }
    let object = if body.is_empty() {
        serde_json::Map::new()
    } else {
        match parse_json_object(body) {
            Ok(object) => object,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        }
    };
    let active_id = match db.current_active_account() {
        Ok(account) => account.id,
        Err(error) => return db_error(error, origin),
    };
    if *method == Method::POST && collection_path {
        let account_id = match required_json_string(&object, "account_id") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let name = match optional_json_string(&object, "name") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let followers = match optional_json_integer(&object, "followers") {
            Ok(value) => value.unwrap_or_default(),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let note_count = match optional_json_integer(&object, "note_count") {
            Ok(value) => value.unwrap_or_default(),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let avg_likes = match optional_json_number(&object, "avg_likes") {
            Ok(value) => value.unwrap_or_default(),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let avg_comments = match optional_json_number(&object, "avg_comments") {
            Ok(value) => value.unwrap_or_default(),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let avg_collects = match optional_json_number(&object, "avg_collects") {
            Ok(value) => value.unwrap_or_default(),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let content_style = match optional_json_string(&object, "content_style") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let top_notes = match object.get("top_notes") {
            None | Some(Value::Null) => Vec::new(),
            Some(value) => match serde_json::from_value::<Vec<ReferenceNote>>(value.clone()) {
                Ok(notes) => notes,
                Err(_) => {
                    return json_response(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        json!({"detail":"top_notes 必须是热门笔记对象数组"}),
                        origin,
                    )
                }
            },
        };
        return match db.upsert_local_reference_account_api(LocalReferenceAccountApiUpsert {
            account_pool_id: active_id,
            account_id: account_id.clone(),
            name,
            followers,
            note_count,
            avg_likes,
            avg_comments,
            avg_collects,
            content_style,
            top_notes,
        }) {
            Ok(()) => reference_account_by_platform_id(db, &account_id, origin),
            Err(error) => mutation_error(error, origin),
        };
    }

    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() != 3 || segments[0..2] != ["api", "accounts"] {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"榜样账号路由不存在"}),
            origin,
        );
    }
    let platform_id = segments[2];
    if *method == Method::DELETE {
        return match db.delete_local_reference_account_by_platform_id(platform_id, active_id) {
            Ok(()) => json_response(StatusCode::OK, json!({"ok":true}), origin),
            Err(error) => mutation_error(error, origin),
        };
    }
    if *method == Method::PATCH {
        let snapshot = match scoped_snapshot(db, "references") {
            Ok(snapshot) => snapshot,
            Err(error) => return db_error(error, origin),
        };
        let Some(existing) = snapshot
            .reference_accounts
            .into_iter()
            .find(|account| account.account_id == platform_id)
        else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":format!("榜样账号 {platform_id} 不存在")}),
                origin,
            );
        };
        let name = match optional_json_string(&object, "name") {
            Ok(value) => value.or(existing.name.clone()),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let followers = match optional_json_integer(&object, "followers") {
            Ok(value) => value.unwrap_or(existing.followers),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let content_style = match optional_json_string(&object, "content_style") {
            Ok(value) => value.or(existing.content_style.clone()),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let note_count = match optional_json_integer(&object, "note_count") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let avg_likes = match optional_json_number(&object, "avg_likes") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let avg_comments = match optional_json_number(&object, "avg_comments") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let avg_collects = match optional_json_number(&object, "avg_collects") {
            Ok(value) => value,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        return match db.update_local_reference_account(LocalReferenceAccountUpdate {
            id: existing.id,
            account_pool_id: active_id,
            account_id: platform_id.to_string(),
            name,
            followers,
            content_style,
            note_count,
            avg_likes,
            avg_comments,
            avg_collects,
        }) {
            Ok(()) => reference_account_by_platform_id(db, platform_id, origin),
            Err(error) => mutation_error(error, origin),
        };
    }
    json_response(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({"detail":"榜样账号路由不支持此操作"}),
        origin,
    )
}

fn reference_account_by_platform_id(
    db: &LocalDb,
    platform_id: &str,
    origin: Option<&str>,
) -> Response<HttpBody> {
    match scoped_snapshot(db, "references") {
        Ok(snapshot) => snapshot
            .reference_accounts
            .into_iter()
            .find(|account| account.account_id == platform_id)
            .map(|account| json_response(StatusCode::OK, legacy_json(account), origin))
            .unwrap_or_else(|| {
                json_response(
                    StatusCode::NOT_FOUND,
                    json!({"detail":format!("榜样账号 {platform_id} 不存在")}),
                    origin,
                )
            }),
        Err(error) => db_error(error, origin),
    }
}

fn find_pool_account(
    db: &LocalDb,
    account_id: i64,
) -> Result<Option<aichihongshu_db::PoolAccount>, String> {
    db.account_pool()
        .map(|pool| {
            pool.items
                .into_iter()
                .find(|account| account.id == account_id)
        })
        .map_err(|error| error.to_string())
}

fn account_by_id(db: &LocalDb, account_id: i64, origin: Option<&str>) -> Response<HttpBody> {
    match find_pool_account(db, account_id) {
        Ok(Some(account)) => json_response(StatusCode::OK, legacy_json(account), origin),
        Ok(None) => json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":format!("账号 {account_id} 不存在")}),
            origin,
        ),
        Err(error) => db_error(error, origin),
    }
}

fn account_mutation_error(error: String, origin: Option<&str>) -> Response<HttpBody> {
    let status = if error.contains("不存在") || error.contains("已经退休") {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::BAD_REQUEST
    };
    json_response(status, json!({"detail":error}), origin)
}

struct MultipartImageUpload {
    file_name: String,
    mime_type: String,
    bytes: Vec<u8>,
    title: Option<String>,
    analyze: bool,
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    (!needle.is_empty())
        .then(|| {
            haystack
                .windows(needle.len())
                .position(|window| window == needle)
        })
        .flatten()
}

fn disposition_parameter(disposition: &str, expected: &str) -> Option<String> {
    let mut parameters = disposition.split(';');
    if !parameters.next()?.trim().eq_ignore_ascii_case("form-data") {
        return None;
    }
    parameters.find_map(|parameter| {
        let (name, value) = parameter.split_once('=')?;
        if !name.trim().eq_ignore_ascii_case(expected) {
            return None;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(value);
        Some(value.to_string())
    })
}

fn image_mime_for_file_name(file_name: &str) -> Option<&'static str> {
    match Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())?
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn parse_multipart_image(body: &[u8], content_type: &str) -> Result<MultipartImageUpload, String> {
    let mut parameters = content_type.split(';');
    if !parameters
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("multipart/form-data"))
    {
        return Err("请求体必须使用 multipart/form-data".to_string());
    }
    let boundary = parameters
        .find_map(|parameter| {
            let (name, value) = parameter.split_once('=')?;
            name.trim()
                .eq_ignore_ascii_case("boundary")
                .then(|| value.trim().trim_matches('"').to_string())
        })
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 70
                && value
                    .bytes()
                    .all(|byte| (0x21..=0x7e).contains(&byte) && byte != b'"')
        })
        .ok_or_else(|| "multipart boundary 无效".to_string())?;
    let marker = format!("--{boundary}");
    let marker = marker.as_bytes();
    if !body.starts_with(marker) {
        return Err("multipart 内容与 boundary 不匹配".to_string());
    }

    let mut cursor = marker.len();
    let mut file: Option<(String, String, Vec<u8>)> = None;
    let mut title = None;
    let mut analyze = true;
    loop {
        if body.get(cursor..cursor.saturating_add(2)) == Some(b"--") {
            cursor += 2;
            if body.get(cursor..cursor.saturating_add(2)) == Some(b"\r\n") {
                cursor += 2;
            }
            if cursor != body.len() {
                return Err("multipart 结束标记后存在多余内容".to_string());
            }
            break;
        }
        if body.get(cursor..cursor.saturating_add(2)) != Some(b"\r\n") {
            return Err("multipart part 边界格式无效".to_string());
        }
        cursor += 2;
        let headers_end = find_bytes(&body[cursor..], b"\r\n\r\n")
            .map(|offset| cursor + offset)
            .ok_or_else(|| "multipart part 缺少 headers 结束符".to_string())?;
        if headers_end.saturating_sub(cursor) > 16 * 1024 {
            return Err("multipart part headers 超过 16 KiB".to_string());
        }
        let headers = std::str::from_utf8(&body[cursor..headers_end])
            .map_err(|_| "multipart part headers 编码无效".to_string())?;
        let mut disposition = None;
        let mut part_mime = None;
        for header in headers.lines() {
            let (name, value) = header
                .split_once(':')
                .ok_or_else(|| "multipart part header 格式无效".to_string())?;
            if name.trim().eq_ignore_ascii_case("content-disposition") {
                disposition = Some(value.trim().to_string());
            } else if name.trim().eq_ignore_ascii_case("content-type") {
                part_mime = Some(
                    value
                        .split(';')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .to_ascii_lowercase(),
                );
            }
        }
        let disposition =
            disposition.ok_or_else(|| "multipart part 缺少 Content-Disposition".to_string())?;
        let name = disposition_parameter(&disposition, "name")
            .ok_or_else(|| "multipart part 缺少字段名".to_string())?;
        let filename = disposition_parameter(&disposition, "filename");
        let data_start = headers_end + 4;
        let mut delimiter = b"\r\n".to_vec();
        delimiter.extend_from_slice(marker);
        let data_len = find_bytes(&body[data_start..], &delimiter)
            .ok_or_else(|| "multipart part 缺少结束 boundary".to_string())?;
        let data_end = data_start + data_len;
        let data = &body[data_start..data_end];

        if name == "file" {
            if file.is_some() {
                return Err("一次只能上传一个素材文件".to_string());
            }
            let raw_filename = filename.ok_or_else(|| "上传字段 file 缺少文件名".to_string())?;
            let file_name = raw_filename
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            if file_name.is_empty()
                || file_name.len() > 255
                || file_name == "."
                || file_name == ".."
                || file_name.chars().any(char::is_control)
            {
                return Err("上传文件名无效".to_string());
            }
            if data.is_empty() || data.len() > MAX_IMAGE_UPLOAD_BYTES {
                return Err("图片大小必须在 1B 到 25 MiB 之间".to_string());
            }
            let expected_mime = image_mime_for_file_name(&file_name)
                .ok_or_else(|| "仅支持 JPG、PNG、GIF、WEBP 或 AVIF 图片".to_string())?;
            let mime_type = part_mime.unwrap_or_else(|| expected_mime.to_string());
            let mime_type = if mime_type.is_empty() || mime_type == "application/octet-stream" {
                expected_mime.to_string()
            } else {
                mime_type
            };
            if mime_type != expected_mime {
                return Err("图片 MIME 类型与扩展名不匹配".to_string());
            }
            file = Some((file_name, mime_type, data.to_vec()));
        } else if filename.is_some() {
            return Err("只允许通过 file 字段上传图片".to_string());
        } else if name == "title" {
            if title.is_some() {
                return Err("title 字段不能重复".to_string());
            }
            let value = std::str::from_utf8(data)
                .map_err(|_| "title 必须是 UTF-8 文本".to_string())?
                .trim();
            if value.chars().count() > 200 {
                return Err("title 不能超过 200 个字符".to_string());
            }
            if !value.is_empty() {
                title = Some(value.to_string());
            }
        } else if name == "analyze" {
            let value = std::str::from_utf8(data)
                .map_err(|_| "analyze 必须是 UTF-8 文本".to_string())?
                .trim()
                .to_ascii_lowercase();
            analyze = match value.as_str() {
                "true" | "1" | "on" | "yes" => true,
                "false" | "0" | "off" | "no" => false,
                _ => return Err("analyze 必须是布尔值".to_string()),
            };
        }
        cursor = data_end + 2 + marker.len();
    }

    let (file_name, mime_type, bytes) =
        file.ok_or_else(|| "multipart 缺少 file 图片字段".to_string())?;
    Ok(MultipartImageUpload {
        file_name,
        mime_type,
        bytes,
        title,
        analyze,
    })
}

fn schedule_image_analysis(
    db: &LocalDb,
    item_id: i64,
    account_pool_id: i64,
    image_version: i64,
    data_url: String,
) {
    let database_path = db.path().to_path_buf();
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let db = LocalDb::open(database_path)
                .map_err(|error| format!("打开素材分析数据库失败：{error}"))?;
            let analysis = aichihongshu_services::analysis::analyze_data_url(&db, &data_url)?;
            db.update_local_item_analysis(
                item_id,
                account_pool_id,
                image_version,
                &analysis,
                LocalItemAnalysisTitlePolicy::IfDefault,
            )?;
            Ok(())
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            eprintln!("[library] 素材分析任务未完成");
        }
    });
}

fn route_library_write(
    db: &LocalDb,
    method: &Method,
    path: &str,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    let account_pool_id = match db.current_active_account() {
        Ok(account) => account.id,
        Err(error) => return db_error(error, origin),
    };

    if method == Method::DELETE
        && segments.len() == 4
        && segments[0..3] == ["api", "library", "trash"]
        && segments[3] == "purge-all"
    {
        let snapshot = match db.snapshot_section_for_account(Some(account_pool_id), "library") {
            Ok(snapshot) => snapshot,
            Err(error) => return db_error(error.to_string(), origin),
        };
        let item_ids = snapshot
            .trash_items
            .iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        if item_ids.is_empty() {
            return json_response(StatusCode::OK, json!({"ok":true,"deleted":0}), origin);
        }
        return match db.purge_local_items(&item_ids, account_pool_id) {
            Ok(result) => json_response(
                StatusCode::OK,
                json!({"ok":true,"deleted":result.purged_ids.len()}),
                origin,
            ),
            Err(error) => mutation_error(error, origin),
        };
    }

    if method == Method::POST
        && segments.len() == 5
        && segments[0..3] == ["api", "library", "trash"]
        && segments[4] == "restore"
    {
        let Ok(item_id) = segments[3].parse::<i64>() else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"素材不存在"}),
                origin,
            );
        };
        return match db.restore_local_item(item_id, account_pool_id) {
            Ok(_) => json_response(StatusCode::OK, json!({"ok":true}), origin),
            Err(error) => mutation_error(error, origin),
        };
    }

    if method == Method::DELETE
        && segments.len() == 5
        && segments[0..3] == ["api", "library", "trash"]
        && segments[4] == "purge"
    {
        let Ok(item_id) = segments[3].parse::<i64>() else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"素材不存在"}),
                origin,
            );
        };
        return match db.purge_local_items(&[item_id], account_pool_id) {
            Ok(_) => json_response(StatusCode::OK, json!({"ok":true}), origin),
            Err(error) => mutation_error(error, origin),
        };
    }

    if segments.len() == 4
        && segments[0..2] == ["api", "library"]
        && segments[3] == "tags"
        && method == Method::PATCH
    {
        if !is_json_content_type(content_type) {
            return json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                json!({"detail":"请求体必须使用 application/json"}),
                origin,
            );
        }
        let object = match parse_json_object(body) {
            Ok(object) => object,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let tag = match required_json_string(&object, "tag") {
            Ok(tag) if !tag.trim().is_empty() => tag,
            Ok(_) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":"tag 不能为空"}),
                    origin,
                )
            }
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let action = match optional_json_string(&object, "action") {
            Ok(action) => action.unwrap_or_else(|| "add".to_string()),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        if !matches!(action.as_str(), "add" | "remove") {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"detail":"action 必须是 add 或 remove"}),
                origin,
            );
        }
        let Ok(item_id) = segments[2].parse::<i64>() else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"素材不存在"}),
                origin,
            );
        };
        let snapshot = match db.snapshot_section_for_account(Some(account_pool_id), "library") {
            Ok(snapshot) => snapshot,
            Err(error) => return db_error(error.to_string(), origin),
        };
        let Some(item) = snapshot.items.into_iter().find(|item| item.id == item_id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"物品不存在"}),
                origin,
            );
        };
        let mut tags = item.tags.clone();
        if action == "add" {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        } else {
            tags.retain(|existing| existing != &tag);
        }
        return match db.update_local_item_metadata(LocalItemMetadataUpdate {
            item_id,
            account_pool_id,
            expected_metadata_version: item.metadata_version,
            title: item.title,
            tags,
            style: item.style,
            material: item.material,
            scene: item.scene,
            color: item.color,
        }) {
            Ok(item) => json_response(StatusCode::OK, legacy_json(item), origin),
            Err(error) => mutation_error(error, origin),
        };
    }

    if method == Method::DELETE && segments.len() == 3 && segments[0..2] == ["api", "library"] {
        let Ok(item_id) = segments[2].parse::<i64>() else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"素材不存在"}),
                origin,
            );
        };
        return match db.delete_local_item(item_id, account_pool_id) {
            Ok(()) => json_response(StatusCode::OK, json!({"ok":true}), origin),
            Err(error) => mutation_error(error, origin),
        };
    }

    if method == Method::POST
        && segments.len() == 4
        && segments[0..2] == ["api", "library"]
        && segments[3] == "analyze"
    {
        let Ok(item_id) = segments[2].parse::<i64>() else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"物品不存在"}),
                origin,
            );
        };
        let snapshot = match db.snapshot_section_for_account(Some(account_pool_id), "library") {
            Ok(snapshot) => snapshot,
            Err(error) => return db_error(error.to_string(), origin),
        };
        let Some(item) = snapshot.items.into_iter().find(|item| item.id == item_id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"物品不存在"}),
                origin,
            );
        };
        let data_url =
            match db.image_data_url_for_account(item_id, Some(account_pool_id), "original") {
                Ok(Some(data_url)) => data_url,
                Ok(None) => {
                    return json_response(
                        StatusCode::NOT_FOUND,
                        json!({"detail":"图片文件不存在"}),
                        origin,
                    )
                }
                Err(error) => return mutation_error(error, origin),
            };
        schedule_image_analysis(db, item.id, account_pool_id, item.image_version, data_url);
        return json_response(StatusCode::OK, legacy_json(item), origin);
    }

    if method == Method::POST && (path == "/api/library" || path == "/api/library/") {
        let Some(content_type) = content_type else {
            return json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                json!({"detail":"请求体必须使用 multipart/form-data"}),
                origin,
            );
        };
        let upload = match parse_multipart_image(body, content_type) {
            Ok(upload) => upload,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let image_data_url = upload.analyze.then(|| {
            format!(
                "data:{};base64,{}",
                upload.mime_type,
                BASE64.encode(&upload.bytes)
            )
        });
        let mut item = match db.import_local_image_for_account(
            account_pool_id,
            LocalImageImport {
                account_pool_id,
                file_name: upload.file_name,
                mime_type: Some(upload.mime_type),
                data_base64: BASE64.encode(&upload.bytes),
                thumbnail_data_base64: None,
            },
        ) {
            Ok(item) => item,
            Err(error) => return mutation_error(error, origin),
        };
        if let Some(title) = upload.title {
            item = match db.update_local_item_metadata(LocalItemMetadataUpdate {
                item_id: item.id,
                account_pool_id,
                expected_metadata_version: item.metadata_version,
                title,
                tags: item.tags.clone(),
                style: item.style.clone(),
                material: item.material.clone(),
                scene: item.scene.clone(),
                color: item.color.clone(),
            }) {
                Ok(item) => item,
                Err(error) => return mutation_error(error, origin),
            };
        }
        if let Some(data_url) = image_data_url {
            schedule_image_analysis(db, item.id, account_pool_id, item.image_version, data_url);
        }
        return json_response(StatusCode::OK, legacy_json(item), origin);
    }

    json_response(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({"detail":"素材路由不支持此操作"}),
        origin,
    )
}

fn note_item_ids(object: &serde_json::Map<String, Value>) -> Result<Vec<i64>, String> {
    if let Some(value) = object.get("item_ids") {
        if value.is_null() {
            return Ok(Vec::new());
        }
        return value
            .as_array()
            .ok_or_else(|| "item_ids 必须是整数数组".to_string())?
            .iter()
            .map(|value| {
                value
                    .as_i64()
                    .ok_or_else(|| "item_ids 必须是整数数组".to_string())
            })
            .collect();
    }
    match object.get("item_id") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => value
            .as_i64()
            .map(|id| vec![id])
            .ok_or_else(|| "item_id 必须是整数".to_string()),
    }
}

fn optional_json_string_list(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<Vec<String>>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("{key} 必须是字符串数组"))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(_) => Err(format!("{key} 必须是字符串数组")),
    }
}

fn mutation_error(error: String, origin: Option<&str>) -> Response<HttpBody> {
    let status = if error.contains("不存在")
        || error.contains("不属于当前账号")
        || error.contains("不在当前账号回收站")
    {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::UNPROCESSABLE_ENTITY
    };
    json_response(status, json!({"detail":error}), origin)
}

fn route_settings_env_get(db: &LocalDb, origin: Option<&str>) -> Response<HttpBody> {
    let settings = match read_model_api_settings(db) {
        Ok(settings) => settings,
        Err(error) => return db_error(error, origin),
    };
    let provider = settings
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|providers| {
            providers
                .iter()
                .find(|provider| provider.get("id").and_then(Value::as_str) == Some("minimax"))
        });
    let db_key = provider
        .and_then(|provider| provider.get("apiKey"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let migrated = match db.get_app_setting("settings_env_migrated_v1") {
        Ok(value) => value.as_deref() == Some("true"),
        Err(error) => return db_error(error, origin),
    };
    let use_legacy = db_key.is_none() && !migrated;
    let api_key = db_key
        .map(str::to_string)
        .or_else(|| configured_legacy_value(&["MINIMAX_API_KEY", "AICHIHONGSHU_MINIMAX_API_KEY"]))
        .unwrap_or_default();
    let endpoint = provider
        .and_then(|provider| provider.get("endpoint"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| configured_legacy_value(&["MINIMAX_BASE_URL"]))
        .unwrap_or_else(|| "https://api.minimaxi.com/anthropic/v1/messages".to_string());
    let text_model = provider
        .and_then(|provider| provider.get("model"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| configured_legacy_value(&["MINIMAX_TEXT_MODEL"]))
        .unwrap_or_else(|| "MiniMax-M2.7".to_string());
    let vision_model = provider
        .and_then(|provider| provider.get("visionModel"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let base_url = if use_legacy {
        configured_legacy_value(&["MINIMAX_BASE_URL"])
            .unwrap_or_else(|| endpoint_to_base_url(&endpoint))
    } else {
        endpoint_to_base_url(&endpoint)
    };
    let text_model = if use_legacy {
        configured_legacy_value(&["MINIMAX_TEXT_MODEL"]).unwrap_or(text_model)
    } else {
        text_model
    };
    let vision_model = if use_legacy {
        configured_legacy_value(&["MINIMAX_VISION_MODEL"])
            .unwrap_or_else(|| vision_model.to_string())
    } else {
        vision_model.to_string()
    };
    let masked_key = if api_key.trim().is_empty() {
        String::new()
    } else {
        let prefix = api_key.chars().take(8).collect::<String>();
        if api_key.chars().count() > 8 {
            format!("{prefix}****")
        } else {
            "****".to_string()
        }
    };
    json_response(
        StatusCode::OK,
        json!({
            "MINIMAX_API_KEY":masked_key,
            "MINIMAX_BASE_URL":base_url,
            "MINIMAX_TEXT_MODEL":text_model,
            "MINIMAX_VISION_MODEL":vision_model,
            "DB_PATH":configured_legacy_value(&["DB_PATH"]).unwrap_or_default(),
            "ASSETS_DIR":configured_legacy_value(&["ASSETS_DIR"]).unwrap_or_default(),
        }),
        origin,
    )
}

fn route_settings_env_patch(
    db: &LocalDb,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    if !is_json_content_type(content_type) {
        return json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"detail":"请求体必须使用 application/json"}),
            origin,
        );
    }
    let object = match parse_json_object(body) {
        Ok(object) => object,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let (api_key, base_url, text_model, vision_model) = match (
        optional_json_string(&object, "MINIMAX_API_KEY"),
        optional_json_string(&object, "MINIMAX_BASE_URL"),
        optional_json_string(&object, "MINIMAX_TEXT_MODEL"),
        optional_json_string(&object, "MINIMAX_VISION_MODEL"),
    ) {
        (Ok(a), Ok(b), Ok(c), Ok(d)) => (a, b, c, d),
        (Err(error), _, _, _)
        | (_, Err(error), _, _)
        | (_, _, Err(error), _)
        | (_, _, _, Err(error)) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let api_key = api_key.filter(|value| !value.trim().is_empty() && !value.contains("****"));
    let base_url = match base_url.filter(|value| !value.trim().is_empty()) {
        Some(value) => match minimax_endpoint(&value) {
            Ok(endpoint) => Some(endpoint),
            Err(error) => {
                return json_response(StatusCode::BAD_REQUEST, json!({"detail":error}), origin)
            }
        },
        None => None,
    };
    let text_model = text_model.filter(|value| !value.trim().is_empty());
    let vision_model = vision_model.map(|value| value.trim().to_string());
    if api_key.is_none() && base_url.is_none() && text_model.is_none() && vision_model.is_none() {
        return json_response(StatusCode::OK, json!({"ok":true}), origin);
    }

    let mut settings = match read_model_api_settings(db) {
        Ok(settings) => settings,
        Err(error) => return db_error(error, origin),
    };
    if !settings.is_object() {
        settings = default_model_api_settings();
    }
    if !settings.get("providers").is_some_and(Value::is_array) {
        settings["providers"] = json!([]);
    }
    let minimax_is_default =
        settings.get("defaultProviderId").and_then(Value::as_str) == Some("minimax");
    {
        let providers = settings["providers"]
            .as_array_mut()
            .expect("array just set");
        let provider_index = providers
            .iter()
            .position(|provider| provider.get("id").and_then(Value::as_str) == Some("minimax"));
        let index = if let Some(index) = provider_index {
            index
        } else {
            providers.push(default_minimax_provider());
            providers.len() - 1
        };
        let provider = &mut providers[index];
        if !provider.is_object() {
            *provider = default_minimax_provider();
        }
        if let Some(value) = api_key {
            provider["apiKey"] = Value::String(value);
        }
        if let Some(value) = base_url {
            provider["endpoint"] = Value::String(value);
        }
        if let Some(value) = text_model.as_ref() {
            provider["model"] = Value::String(value.clone());
            if !provider.get("enabledModels").is_some_and(Value::is_array) {
                provider["enabledModels"] = json!([]);
            }
            let enabled_models = provider["enabledModels"]
                .as_array_mut()
                .expect("array just set");
            if !enabled_models
                .iter()
                .any(|model| model.as_str() == Some(value))
            {
                enabled_models.push(Value::String(value.clone()));
            }
        }
        if let Some(value) = vision_model {
            provider["visionModel"] = Value::String(value);
        }
    }
    if minimax_is_default {
        if let Some(value) = text_model {
            settings["defaultModel"] = Value::String(value);
        }
    }
    if let Err(error) = db.set_app_setting("model_api_settings_v1", &settings.to_string()) {
        return db_error(error, origin);
    }
    if let Err(error) = db.set_app_setting("settings_env_migrated_v1", "true") {
        return db_error(error, origin);
    }
    json_response(StatusCode::OK, json!({"ok":true}), origin)
}

fn read_model_api_settings(db: &LocalDb) -> Result<Value, String> {
    match db.get_app_setting("model_api_settings_v1")? {
        Some(raw) => serde_json::from_str(&raw).map_err(|_| "Model API 配置格式无效".to_string()),
        None => Ok(default_model_api_settings()),
    }
}

fn default_model_api_settings() -> Value {
    json!({
        "providers":[default_minimax_provider()],
        "defaultProviderId":"",
        "defaultModel":"",
    })
}

fn default_minimax_provider() -> Value {
    json!({
        "id":"minimax",
        "kind":"anthropic-compatible",
        "label":"MiniMax",
        "endpoint":"https://api.minimaxi.com/anthropic/v1/messages",
        "apiKey":"",
        "model":"MiniMax-M2.7",
        "visionModel":"",
        "enabledModels":["MiniMax-M2.7"],
        "builtin":true,
        "preset":null,
    })
}

fn endpoint_to_base_url(endpoint: &str) -> String {
    endpoint
        .strip_suffix("/v1/messages")
        .or_else(|| endpoint.strip_suffix("/messages"))
        .unwrap_or(endpoint)
        .trim_end_matches('/')
        .to_string()
}

fn minimax_endpoint(base_or_endpoint: &str) -> Result<String, String> {
    let value = base_or_endpoint.trim();
    if value
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
        || value.contains('?')
        || value.contains('#')
        || value.contains('@')
    {
        return Err("MiniMax Base URL 无效".to_string());
    }
    let (scheme, rest) = value
        .split_once("://")
        .ok_or_else(|| "MiniMax Base URL 必须以 http:// 或 https:// 开头".to_string())?;
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
        return Err("MiniMax Base URL 必须以 http:// 或 https:// 开头".to_string());
    }
    let authority = rest.split('/').next().unwrap_or_default();
    if authority.is_empty() {
        return Err("MiniMax Base URL 缺少有效主机名".to_string());
    }
    let valid_port = |port: &str| port.parse::<u16>().ok().is_some_and(|value| value > 0);
    if let Some(ipv6) = authority.strip_prefix('[') {
        let Some(end) = ipv6.find(']') else {
            return Err("MiniMax Base URL 缺少有效主机名".to_string());
        };
        let address = &ipv6[..end];
        let suffix = &ipv6[end + 1..];
        if address.is_empty()
            || (!suffix.is_empty() && !suffix.strip_prefix(':').is_some_and(valid_port))
        {
            return Err("MiniMax Base URL 缺少有效主机名".to_string());
        }
    } else {
        let mut host_and_port = authority.split(':');
        let host = host_and_port.next().unwrap_or_default();
        let port = host_and_port.next();
        if host.is_empty()
            || host_and_port.next().is_some()
            || port.is_some_and(|port| !valid_port(port))
        {
            return Err("MiniMax Base URL 缺少有效主机名".to_string());
        }
    }
    let value = value.trim_end_matches('/');
    if value.ends_with("/v1/messages") || value.ends_with("/messages") {
        Ok(value.to_string())
    } else {
        Ok(format!("{value}/v1/messages"))
    }
}

fn route_prompt_write(
    db: &LocalDb,
    method: &Method,
    path: &str,
    body: &Bytes,
    content_type: Option<&str>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    if method == Method::POST && path == "/api/settings/prompts" {
        if !is_json_content_type(content_type) {
            return json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                json!({"detail":"请求体必须使用 application/json"}),
                origin,
            );
        }
        let object = match parse_json_object(body) {
            Ok(object) => object,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let active = match db.current_active_account() {
            Ok(account) => account,
            Err(error) => return db_error(error, origin),
        };
        let config = match prompt_config_from_create(&object, active.id) {
            Ok(config) => config,
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let existing = match db.list_prompt_configs(Some(active.id)) {
            Ok(prompts) => prompts,
            Err(error) => return db_error(error, origin),
        };
        if existing.iter().any(|prompt| prompt.key == config.key) {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"detail":format!("prompt key '{}' already exists", config.key)}),
                origin,
            );
        }
        return match db.upsert_prompt_config(config) {
            Ok(_) => json_response(StatusCode::OK, json!({"ok":true}), origin),
            Err(error) => json_response(StatusCode::BAD_REQUEST, json!({"detail":error}), origin),
        };
    }

    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() != 4 || segments[0..3] != ["api", "settings", "prompts"] {
        return json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"detail":"提示词路由不支持此操作"}),
            origin,
        );
    }
    let key = segments[3];
    if method == Method::DELETE {
        let active = match db.current_active_account() {
            Ok(account) => account,
            Err(error) => return db_error(error, origin),
        };
        return match db.delete_prompt_config(key, active.id) {
            Ok(_) => json_response(StatusCode::OK, json!({"ok":true}), origin),
            Err(error) => db_error(error, origin),
        };
    }
    if method != Method::PUT {
        return json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"detail":"提示词路由不支持此操作"}),
            origin,
        );
    }
    if !is_json_content_type(content_type) {
        return json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({"detail":"请求体必须使用 application/json"}),
            origin,
        );
    }
    let object = match parse_json_object(body) {
        Ok(object) => object,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    let active = match db.current_active_account() {
        Ok(account) => account,
        Err(error) => return db_error(error, origin),
    };
    let existing = match db.list_prompt_configs(Some(active.id)) {
        Ok(prompts) => prompts,
        Err(error) => return db_error(error, origin),
    };
    let Some(existing) = existing.into_iter().find(|prompt| prompt.key == key) else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"prompt not found"}),
            origin,
        );
    };
    if object.values().all(Value::is_null) {
        return json_response(StatusCode::OK, json!({"ok":true}), origin);
    }
    let config = match prompt_config_from_update(&object, existing, active.id) {
        Ok(config) => config,
        Err(error) => {
            return json_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"detail":error}),
                origin,
            )
        }
    };
    match db.upsert_prompt_config(config) {
        Ok(_) => json_response(StatusCode::OK, json!({"ok":true}), origin),
        Err(error) => json_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({"detail":error}),
            origin,
        ),
    }
}

fn parse_json_object(body: &Bytes) -> Result<serde_json::Map<String, Value>, String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|error| format!("JSON 格式无效：{error}"))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "请求体必须是 JSON 对象".to_string())
}

fn is_json_content_type(content_type: Option<&str>) -> bool {
    content_type
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

fn prompt_config_from_create(
    object: &serde_json::Map<String, Value>,
    account_pool_id: i64,
) -> Result<PromptConfigUpsert, String> {
    Ok(PromptConfigUpsert {
        account_pool_id,
        key: required_json_string(object, "key")?,
        label: required_json_string(object, "label")?,
        prompt: required_json_string(object, "prompt")?,
        sort_order: optional_json_integer(object, "sort_order")?.unwrap_or(0),
        enabled: optional_json_bool(object, "enabled")?.unwrap_or(true),
    })
}

fn prompt_config_from_update(
    object: &serde_json::Map<String, Value>,
    existing: aichihongshu_db::PromptConfig,
    account_pool_id: i64,
) -> Result<PromptConfigUpsert, String> {
    Ok(PromptConfigUpsert {
        account_pool_id,
        key: existing.key,
        label: optional_json_string(object, "label")?.unwrap_or(existing.label),
        prompt: optional_json_string(object, "prompt")?.unwrap_or(existing.prompt),
        sort_order: optional_json_integer(object, "sort_order")?.unwrap_or(existing.sort_order),
        enabled: optional_json_bool(object, "enabled")?.unwrap_or(existing.enabled),
    })
}

fn required_json_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{key} 必须是字符串"))
}

fn optional_json_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{key} 必须是字符串")),
    }
}

fn optional_json_integer(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<i64>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("{key} 必须是整数")),
    }
}

fn optional_json_number(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<f64>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| format!("{key} 必须是数字")),
    }
}

fn optional_json_bool(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<bool>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(|| format!("{key} 必须是布尔值")),
    }
}

fn route_account_get(db: &LocalDb, path: &str, origin: Option<&str>) -> Response<HttpBody> {
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() != 3 || segments[0..2] != ["api", "accounts"] {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"榜样账号路由不存在"}),
            origin,
        );
    }
    match scoped_snapshot(db, "references") {
        Ok(snapshot) => snapshot
            .reference_accounts
            .into_iter()
            .find(|account| account.account_id == segments[2])
            .map(|account| json_response(StatusCode::OK, legacy_json(account), origin))
            .unwrap_or_else(|| {
                json_response(
                    StatusCode::NOT_FOUND,
                    json!({"detail":format!("榜样账号 {} 不存在", segments[2])}),
                    origin,
                )
            }),
        Err(error) => db_error(error, origin),
    }
}

fn route_analytics_get(
    db: &LocalDb,
    path: &str,
    query: &HashMap<String, String>,
    origin: Option<&str>,
) -> Response<HttpBody> {
    if path == "/api/analytics/summary" {
        return match db.local_analytics_summary(None) {
            Ok(summary) => {
                let local_today = match db.local_calendar_day() {
                    Ok(day) => day,
                    Err(error) => return db_error(error.to_string(), origin),
                };
                let profile = summary
                    .profile
                    .as_ref()
                    .map(|profile| serde_json::to_value(profile).unwrap_or(Value::Null))
                    .unwrap_or_else(|| json!({}));
                let top_notes = summary
                    .top_notes
                    .iter()
                    .map(|note| {
                        json!({
                            "id": note.id,
                            "title": note.title,
                            "likes": note.likes,
                            "comments": note.comments,
                            "collects": note.collects,
                            "item_title": note.item_title,
                            "note_url": note.note_url,
                        })
                    })
                    .collect::<Vec<_>>();
                let body = json!({
                    "library":{"total_items":summary.item_count},
                    "notes":{
                        "total":summary.note_count,
                        "by_status":summary.note_status_counts,
                        "published_avg":{
                            "likes":round_one(summary.published_avg[0]),
                            "comments":round_one(summary.published_avg[1]),
                            "collects":round_one(summary.published_avg[2]),
                        },
                    },
                    "accounts":{"total":summary.reference_count},
                    "my_profile":profile,
                    "top_notes":top_notes,
                    "suggestions":{
                        "items_without_notes":summary.items_without_notes,
                        "days_since_publish":days_since_latest_publish(summary.latest_published_at.as_deref(), &local_today),
                        "draft_count":summary.note_status_counts.get("draft").copied().unwrap_or(0),
                    },
                });
                json_response(StatusCode::OK, body, origin)
            }
            Err(error) => db_error(error.to_string(), origin),
        };
    }
    if path == "/api/analytics/insights" {
        return match db.local_analytics_insights(None) {
            Ok(insights) => json_response(StatusCode::OK, analytics_insights(&insights), origin),
            Err(error) => db_error(error.to_string(), origin),
        };
    }
    if path == "/api/analytics/notes-trend" {
        let mut granularity = query
            .get("granularity")
            .cloned()
            .unwrap_or_else(|| "auto".to_string());
        return match db.local_analytics_trend(None) {
            Ok(trend) => match notes_trend(&trend.days, &mut granularity) {
                Ok(body) => json_response(StatusCode::OK, body, origin),
                Err(error) => db_error(error, origin),
            },
            Err(error) => db_error(error.to_string(), origin),
        };
    }
    if path == "/api/analytics/topics" {
        let limit = match parse_query_usize(query, "limit", 30) {
            Ok(limit) => limit.min(1000),
            Err(error) => {
                return json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"detail":error}),
                    origin,
                )
            }
        };
        let active_account = match db.current_active_account() {
            Ok(account) => account,
            Err(error) => return db_error(error, origin),
        };
        let published_tags =
            match db.list_local_published_note_tags_for_analytics(active_account.id) {
                Ok(tags) => tags,
                Err(error) => return db_error(error, origin),
            };
        let crawl_keywords = match db.list_local_crawl_keywords_for_analytics(active_account.id) {
            Ok(keywords) => keywords,
            Err(error) => return db_error(error, origin),
        };
        return json_response(
            StatusCode::OK,
            analytics_topics(&published_tags, &crawl_keywords, limit),
            origin,
        );
    }
    if path != "/api/analytics/notes" {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"detail":"Rust HTTP adapter 尚未实现此分析路由"}),
            origin,
        );
    }
    let sort = match query.get("sort").map(String::as_str) {
        Some("collects") => "collects",
        Some("comments") => "comments",
        _ => "likes",
    };
    let account_pool_id = match db.current_active_account() {
        Ok(account) => account.id,
        Err(error) => return db_error(error, origin),
    };
    match db.list_local_published_notes_for_analytics(account_pool_id, sort) {
        Ok(notes) => {
            let result = notes
                .into_iter()
                .map(|(note, cover_image)| {
                    let engagement_rate = (note.likes + note.comments + note.collects) as f64
                        / note.likes.max(1) as f64;
                    json!({
                        "id": note.id,
                        "title": note.title,
                        "likes": note.likes,
                        "comments": note.comments,
                        "collects": note.collects,
                        "published_at": note.published_at,
                        "note_url": note.note_url,
                        "cover_desc": note.cover_desc,
                        "cover_image": cover_image,
                        "engagement_rate": (engagement_rate * 100.0).round() / 100.0,
                    })
                })
                .collect::<Vec<_>>();
            json_response(StatusCode::OK, Value::Array(result), origin)
        }
        Err(error) => db_error(error, origin),
    }
}

fn analytics_insights(insights: &aichihongshu_db::AnalyticsInsights) -> Value {
    let ranges = ["<10", "10-20", "20-30", "30+"];
    let title_length_dist = ranges
        .into_iter()
        .zip(insights.title_buckets)
        .map(|(range, (total_likes, count))| {
            let avg_likes = if count == 0 {
                0.0
            } else {
                round_one(total_likes as f64 / count as f64)
            };
            json!({"range":range,"avg_likes":avg_likes,"count":count})
        })
        .collect::<Vec<_>>();
    let hour_dist = insights
        .hours
        .iter()
        .map(|hour| json!({"hour":hour.hour,"avg_likes":hour.avg_likes,"count":hour.count}))
        .collect::<Vec<_>>();
    let tag_freq = insights
        .tags
        .iter()
        .map(|tag| json!({"tag":tag.tag,"count":tag.count,"avg_likes":tag.avg_likes}))
        .collect::<Vec<_>>();
    json!({
        "title_length_dist":title_length_dist,
        "hour_dist":hour_dist,
        "tag_freq":tag_freq,
        "comparison":{
            "mine":{
                "avg_likes":round_one(insights.published_avg[0]),
                "avg_comments":round_one(insights.published_avg[1]),
                "avg_collects":round_one(insights.published_avg[2]),
            },
            "reference":{
                "avg_likes":round_one(insights.reference_avg[0]),
                "avg_comments":round_one(insights.reference_avg[1]),
                "avg_collects":round_one(insights.reference_avg[2]),
            }
        }
    })
}

fn notes_trend(
    days: &[aichihongshu_db::AnalyticsTrendDay],
    granularity: &mut String,
) -> Result<Value, String> {
    if granularity == "auto" {
        *granularity = if days.len() > 14 { "week" } else { "day" }.to_string();
    }
    let mut daily = days.to_vec();
    if granularity == "week" {
        let mut weekly = HashMap::<i64, (i64, i64)>::new();
        for item in daily {
            let week_day = parse_calendar_day(&item.day)
                .and_then(|(year, month, day)| civil_days(year, month, day))
                .ok_or("趋势日期格式无效")?;
            let week_start = week_day - (week_day + 3).rem_euclid(7);
            let stats = weekly.entry(week_start).or_default();
            stats.0 += item.count;
            stats.1 += item.total_likes;
        }
        let mut grouped = weekly.into_iter().collect::<Vec<_>>();
        grouped.sort_by_key(|(day, _)| *day);
        daily = grouped
            .into_iter()
            .map(|(day, (count, total_likes))| {
                let (year, month, day) = civil_from_days(day);
                aichihongshu_db::AnalyticsTrendDay {
                    day: format!("{year:04}-{month:02}-{day:02}"),
                    count,
                    total_likes,
                }
            })
            .collect();
    }
    let items = daily
        .into_iter()
        .map(|item| json!({"day":item.day,"count":item.count,"total_likes":item.total_likes}))
        .collect::<Vec<_>>();
    Ok(json!({"granularity":granularity,"items":items}))
}

fn analytics_topics(
    published_tags: &[Vec<String>],
    crawl_keywords: &[String],
    limit: usize,
) -> Value {
    let mut counts = HashMap::<String, usize>::new();
    let mut first_seen = Vec::new();
    let mut add_topic = |word: String| {
        if let Some(count) = counts.get_mut(&word) {
            *count += 1;
        } else {
            first_seen.push(word.clone());
            counts.insert(word, 1);
        }
    };
    for tags in published_tags {
        for tag in tags {
            let word = tag.trim().trim_start_matches('#');
            if !word.is_empty() {
                add_topic(word.to_string());
            }
        }
    }
    for keyword_batch in crawl_keywords {
        for word in keyword_batch.split(',').map(str::trim) {
            if !word.is_empty() {
                add_topic(word.to_string());
            }
        }
    }
    let mut topics = first_seen
        .into_iter()
        .filter_map(|word| counts.remove(&word).map(|count| (word, count)))
        .collect::<Vec<_>>();
    topics.sort_by(|(_, left_count), (_, right_count)| right_count.cmp(left_count));
    let topics = topics
        .into_iter()
        .take(limit)
        .map(|(word, count)| json!({"word":word,"count":count}))
        .collect::<Vec<_>>();
    json!({"topics":topics})
}

fn round_one(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn days_since_latest_publish(latest_published_at: Option<&str>, local_today: &str) -> Option<i64> {
    latest_published_at.and_then(|timestamp| {
        let (year, month, day) = parse_calendar_day(timestamp)?;
        let published_days = civil_days(year, month, day)?;
        let (today_year, today_month, today_day) = parse_calendar_day(local_today)?;
        let today_days = civil_days(today_year, today_month, today_day)?;
        Some(today_days - published_days)
    })
}

fn parse_calendar_day(timestamp: &str) -> Option<(i64, i64, i64)> {
    let date = timestamp.get(..10)?;
    let mut parts = date.split('-');
    let year = parts.next()?.parse().ok()?;
    let month = parts.next()?.parse().ok()?;
    let day = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) {
        return None;
    }
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap_year => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if !(1..=days_in_month).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

fn civil_days(year: i64, month: i64, day: i64) -> Option<i64> {
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}

fn route_library_get(db: &LocalDb, path: &str, origin: Option<&str>) -> Response<HttpBody> {
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() == 4 && segments[0..2] == ["api", "library"] && segments[3] == "image" {
        let Ok(id) = segments[2].parse::<i64>() else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"素材不存在"}),
                origin,
            );
        };
        return match db.image_data_url_for_account(id, None, "original") {
            Ok(Some(data_url)) => match image_data_url_to_response(&data_url, origin) {
                Ok(response) => response,
                Err(error) => json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({"detail":error}),
                    origin,
                ),
            },
            Ok(None) => json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":format!("物品 {id} 不存在")}),
                origin,
            ),
            Err(error) => db_error(error, origin),
        };
    }
    if segments.len() == 3 && segments[0..2] == ["api", "library"] {
        let Ok(id) = segments[2].parse::<i64>() else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"素材不存在"}),
                origin,
            );
        };
        return match scoped_snapshot(db, "library") {
            Ok(snapshot) => snapshot
                .items
                .into_iter()
                .find(|item| item.id == id)
                .map(|item| json_response(StatusCode::OK, legacy_json(item), origin))
                .unwrap_or_else(|| {
                    json_response(
                        StatusCode::NOT_FOUND,
                        json!({"detail":format!("物品 {id} 不存在")}),
                        origin,
                    )
                }),
            Err(error) => db_error(error, origin),
        };
    }
    json_response(
        StatusCode::NOT_FOUND,
        json!({"detail":"素材路由不存在"}),
        origin,
    )
}

fn route_content_get(db: &LocalDb, path: &str, origin: Option<&str>) -> Response<HttpBody> {
    if path == "/api/content/xhs-login-status" {
        return retired_publish_response(
            "旧登录探测入口已退役。请通过账号池打开受控浏览器会话并手动完成登录；服务不读取旧浏览器配置。",
            "managed_browser_session",
            origin,
        );
    }
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() == 5
        && segments[0..2] == ["api", "content"]
        && segments[2].parse::<i64>().is_ok()
        && segments[3] == "publish-status"
    {
        return retired_publish_response(
            "旧自动发布任务状态已退役。请在发布准备页查看本地发布回执；平台提交结果由用户手动确认。",
            "manual_publish_receipt",
            origin,
        );
    }
    if segments.len() == 5 && segments[0..2] == ["api", "content"] && segments[3] == "stage-images"
    {
        let Ok(note_id) = segments[2].parse::<i64>() else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"笔记不存在"}),
                origin,
            );
        };
        let filename = match decode_query_part(segments[4]) {
            Ok(filename) => filename,
            Err(error) => {
                return json_response(StatusCode::BAD_REQUEST, json!({"detail":error}), origin)
            }
        };
        let Some(content_type) = staged_image_content_type(&filename) else {
            return json_response(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                json!({"detail":"暂存图片格式不受支持"}),
                origin,
            );
        };
        return match db.local_note_stage_image_bytes(note_id, None, &filename) {
            Ok(bytes) => match image_bytes_to_response(content_type, bytes, origin) {
                Ok(response) => response,
                Err(error) => json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({"detail":error}),
                    origin,
                ),
            },
            Err(error)
                if error.contains("无效")
                    || error.contains("超出目录范围")
                    || error.contains("超出根目录范围") =>
            {
                json_response(StatusCode::BAD_REQUEST, json!({"detail":error}), origin)
            }
            Err(error) if error.contains("不存在") => {
                json_response(StatusCode::NOT_FOUND, json!({"detail":error}), origin)
            }
            Err(error) if error.contains("50 MiB") => json_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"detail":error}),
                origin,
            ),
            Err(error) => db_error(error, origin),
        };
    }
    if segments.len() == 4 && segments[0..2] == ["api", "content"] && segments[3] == "export" {
        let Ok(id) = segments[2].parse::<i64>() else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"笔记不存在"}),
                origin,
            );
        };
        return match db.get_local_note_for_legacy(id) {
            Ok((account_pool_id, Some(note))) => {
                let item_title = if let Some(item_id) = note.item_id {
                    match db.get_local_item_for_cli(item_id) {
                        Ok((item_account_id, item)) if item_account_id == account_pool_id => {
                            item.map(|item| item.title).unwrap_or_default()
                        }
                        Ok(_) => {
                            return json_response(
                                StatusCode::CONFLICT,
                                json!({"detail":"账号上下文已变化，请重试"}),
                                origin,
                            )
                        }
                        Err(error) => return db_error(error, origin),
                    }
                } else {
                    String::new()
                };
                let markdown = crate::export_markdown(&note, &item_title);
                json_response(StatusCode::OK, json!({"markdown":markdown}), origin)
            }
            Ok((_, None)) => {
                return json_response(
                    StatusCode::NOT_FOUND,
                    json!({"detail":format!("笔记 ID {id} 不存在")}),
                    origin,
                )
            }
            Err(error) => db_error(error, origin),
        };
    }
    if segments.len() == 3 && segments[0..2] == ["api", "content"] {
        let Ok(id) = segments[2].parse::<i64>() else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":"笔记不存在"}),
                origin,
            );
        };
        return match db.get_local_note_for_legacy(id) {
            Ok((_, Some(note))) => json_response(StatusCode::OK, legacy_json(note), origin),
            Ok((_, None)) => json_response(
                StatusCode::NOT_FOUND,
                json!({"detail":format!("笔记 ID {id} 不存在")}),
                origin,
            ),
            Err(error) => db_error(error, origin),
        };
    }
    json_response(
        StatusCode::NOT_FOUND,
        json!({"detail":"笔记路由不存在"}),
        origin,
    )
}

fn retired_publish_response(
    detail: &str,
    replacement: &str,
    origin: Option<&str>,
) -> Response<HttpBody> {
    json_response(
        StatusCode::GONE,
        json!({
            "detail": detail,
            "replacement": replacement,
            "automatic_submission": false,
        }),
        origin,
    )
}

fn scoped_snapshot(db: &LocalDb, section: &str) -> Result<WorkspaceSnapshot, String> {
    db.snapshot_section_for_account(None, section)
        .map_err(|error| format!("读取本地工作区失败：{error}"))
}

fn profile_snapshot(db: &LocalDb) -> Result<WorkspaceSnapshot, String> {
    let snapshot = scoped_snapshot(db, "profile")?;
    if snapshot.profile.is_none() {
        db.update_local_profile(LocalProfileUpdate {
            account_pool_id: snapshot.active_account.id,
            account_id: None,
            display_name: Some(snapshot.active_account.alias.clone()),
            niche: None,
            target_audience: None,
            content_pillars: Vec::new(),
            followers: None,
            persona_name: None,
            persona_bio: None,
            persona_tone: None,
            persona_taboos: Vec::new(),
            preferred_styles: Vec::new(),
            preferred_scenes: Vec::new(),
            hashtag_pool: Vec::new(),
            posting_rhythm: None,
            avatar_url: None,
            xhs_bio: None,
            xhs_follows: None,
            ip_location: None,
            xhs_tags: None,
            risk_warning_ack: None,
        })?;
    }
    scoped_snapshot(db, "profile")
}

fn filter_items(
    mut items: Vec<ItemSummary>,
    query: &HashMap<String, String>,
) -> Result<Vec<ItemSummary>, String> {
    if let Some(tag) = query.get("tag") {
        items.retain(|item| {
            item.tags
                .iter()
                .any(|value| value.eq_ignore_ascii_case(tag))
        });
    }
    if let Some(style) = query.get("style") {
        items.retain(|item| {
            item.style
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case(style))
        });
    }
    let offset = parse_query_usize(query, "offset", 0)?;
    let limit = parse_query_usize(query, "limit", 50)?;
    if limit == 0 || limit > MAX_QUERY_LIMIT {
        return Err(format!("limit 必须在 1 到 {MAX_QUERY_LIMIT} 之间"));
    }
    let start = offset.min(items.len());
    Ok(items.into_iter().skip(start).take(limit).collect())
}

fn filter_notes(
    mut notes: Vec<NoteSummary>,
    query: &HashMap<String, String>,
) -> Result<Vec<NoteSummary>, String> {
    if let Some(status) = query.get("status") {
        notes.retain(|note| &note.status == status);
    }
    if let Some(item_id) = query.get("item_id") {
        let item_id = item_id.parse::<i64>().map_err(|_| "item_id 必须是整数")?;
        notes.retain(|note| note.item_id == Some(item_id));
    }
    if let Some(search) = query.get("search") {
        let search = search.to_lowercase();
        notes.retain(|note| {
            note.title
                .as_ref()
                .is_some_and(|value| value.to_lowercase().contains(&search))
                || note
                    .body
                    .as_ref()
                    .is_some_and(|value| value.to_lowercase().contains(&search))
                || note
                    .tags
                    .iter()
                    .any(|tag| tag.to_lowercase().contains(&search))
        });
    }
    match query.get("sort").map(String::as_str).unwrap_or("") {
        "created_asc" => notes.sort_by(|a, b| a.created_at.cmp(&b.created_at)),
        "updated_desc" => notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at)),
        "title_asc" => notes.sort_by(|a, b| a.title.cmp(&b.title)),
        "published_desc" => notes.sort_by(|a, b| {
            b.published_at
                .as_ref()
                .or(b.updated_at.as_ref())
                .cmp(&a.published_at.as_ref().or(a.updated_at.as_ref()))
        }),
        _ => notes.sort_by(|a, b| b.created_at.cmp(&a.created_at)),
    }
    Ok(notes)
}

fn parse_query(query: &str) -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    for pair in query.split('&').filter(|part| !part.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        values.insert(decode_query_part(key)?, decode_query_part(value)?);
    }
    Ok(values)
}

fn decode_query_part(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                    .map_err(|_| "查询参数编码无效")?;
                decoded.push(u8::from_str_radix(hex, 16).map_err(|_| "查询参数编码无效")?);
                index += 3;
            }
            b'%' => return Err("查询参数编码不完整".to_string()),
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).map_err(|_| "查询参数不是有效 UTF-8".to_string())
}

fn parse_query_usize(
    query: &HashMap<String, String>,
    key: &str,
    default: usize,
) -> Result<usize, String> {
    query
        .get(key)
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| format!("{key} 必须是非负整数"))
        })
        .unwrap_or(Ok(default))
}

fn legacy_json<T: Serialize>(value: T) -> Value {
    snake_case_keys(serde_json::to_value(value).unwrap_or(Value::Null))
}

fn snake_case_keys(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(snake_case_keys).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (camel_to_snake(&key), snake_case_keys(value)))
                .collect(),
        ),
        value => value,
    }
}

fn camel_to_snake(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii_uppercase() {
            result.push('_');
            result.push(character.to_ascii_lowercase());
        } else {
            result.push(character);
        }
    }
    result
}

fn image_data_url_to_response(
    data_url: &str,
    origin: Option<&str>,
) -> Result<Response<HttpBody>, String> {
    let (metadata, encoded) = data_url.split_once(',').ok_or("图片数据格式无效")?;
    let mime = metadata
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or("图片 MIME 格式无效")?;
    let bytes = BASE64.decode(encoded).map_err(|_| "图片 Base64 数据无效")?;
    image_bytes_to_response(mime, bytes, origin)
}

fn image_bytes_to_response(
    mime: &str,
    bytes: Vec<u8>,
    origin: Option<&str>,
) -> Result<Response<HttpBody>, String> {
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, mime)
        .header(CONTENT_LENGTH, bytes.len().to_string())
        .header(CACHE_CONTROL, "private, max-age=60")
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(full_body(Bytes::from(bytes)))
        .map_err(|error| error.to_string())?;
    add_cors_headers(response.headers_mut(), origin);
    Ok(response)
}

fn staged_image_content_type(filename: &str) -> Option<&'static str> {
    match Path::new(filename)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn open_directory_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开暂存目录失败：{error}"))
}

fn is_loopback_host(host: &str, port: u16) -> bool {
    let expected_port = port.to_string();
    host.eq_ignore_ascii_case(&format!("localhost:{expected_port}"))
        || host == format!("127.0.0.1:{expected_port}")
        || host == format!("[::1]:{expected_port}")
}

fn json_response(status: StatusCode, body: Value, origin: Option<&str>) -> Response<HttpBody> {
    let bytes = serde_json::to_vec(&body)
        .unwrap_or_else(|_| b"{\"detail\":\"JSON serialization failed\"}".to_vec());
    let mut response = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(CONTENT_LENGTH, bytes.len().to_string())
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(full_body(Bytes::from(bytes)))
        .expect("static response headers are valid");
    add_cors_headers(response.headers_mut(), origin);
    response
}

fn preflight_response(origin: &str) -> Response<HttpBody> {
    let mut response = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(
            ACCESS_CONTROL_ALLOW_METHODS,
            "GET, POST, PATCH, PUT, DELETE, OPTIONS",
        )
        .header(
            ACCESS_CONTROL_ALLOW_HEADERS,
            "authorization, content-type, x-risk-acknowledged",
        )
        .header("access-control-max-age", "600")
        .body(full_body(Bytes::new()))
        .expect("static preflight headers are valid");
    add_cors_headers(response.headers_mut(), Some(origin));
    response
}

fn add_cors_headers(headers: &mut hyper::HeaderMap, origin: Option<&str>) {
    headers.insert(VARY, hyper::header::HeaderValue::from_static("Origin"));
    if let Some(origin) = origin.and_then(|value| hyper::header::HeaderValue::from_str(value).ok())
    {
        headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
}

fn db_error(error: String, origin: Option<&str>) -> Response<HttpBody> {
    json_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"detail":error}),
        origin,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use aichihongshu_db::{
        LocalAccountCreate, LocalImageImport, LocalNoteItemsUpdate, LocalNoteStatsUpdate,
        LocalNoteStatusUpdate, LocalNoteUpdate, LocalReferenceAccountCreate,
    };
    use http_body_util::{BodyExt, Full};
    use hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_state() -> (Arc<HttpState>, PathBuf) {
        static NEXT_TEMP_DB_ID: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = NEXT_TEMP_DB_ID.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("rn-http-{}-{stamp}-{sequence}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let db = LocalDb::open(root.join("app.db")).unwrap();
        (
            Arc::new(HttpState {
                browser_worker: BrowserWorkerManager::new(BrowserWorkerConfig {
                    node: WorkerCommand::ExactPath(root.join("missing-node")),
                    worker_dir: root.join("browser-worker"),
                    data_root: root.join("sessions"),
                })
                .unwrap(),
                db: Arc::new(db),
                profile_refresh: Mutex::new(HashMap::new()),
                port: DEFAULT_PORT,
                allowed_origins: allowed_origins(DEFAULT_PORT),
                session_token: "test-session-token".to_string(),
            }),
            root,
        )
    }

    #[test]
    fn normalizes_only_xiaohongshu_profile_urls_and_drops_tracking_query() {
        assert_eq!(
            normalize_creator_profile_url(
                "https://www.xiaohongshu.com/user/profile/creator-123?xsec_token=secret#notes"
            )
            .unwrap(),
            (
                "creator-123".to_string(),
                "https://www.xiaohongshu.com/user/profile/creator-123".to_string()
            )
        );
        assert_eq!(
            normalize_creator_profile_url("creator_123").unwrap().0,
            "creator_123"
        );
        assert!(
            normalize_creator_profile_url("http://www.xiaohongshu.com/user/profile/id").is_err()
        );
        assert!(normalize_creator_profile_url("https://example.com/user/profile/id").is_err());
        assert!(
            normalize_creator_profile_url("https://www.xiaohongshu.com/user/profile/%2f").is_err()
        );
    }

    #[test]
    fn crawler_browser_account_selection_defaults_to_active_and_rejects_invalid_ids() {
        assert_eq!(selected_browser_account_id(None, 7).unwrap(), 7);
        assert_eq!(
            selected_browser_account_id(Some(&"3".to_string()), 7).unwrap(),
            3
        );
        assert!(selected_browser_account_id(Some(&"0".to_string()), 7).is_err());
        assert!(selected_browser_account_id(Some(&"abc".to_string()), 7).is_err());
    }

    #[tokio::test]
    async fn crawler_browser_http_route_uses_managed_worker_without_exposing_profile_paths() {
        let (state, root) = test_state();
        let response = get(Arc::clone(&state), "/api/crawler/browser?account_id=1").await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert!(!body["detail"].as_str().unwrap().is_empty());
        assert!(body.get("user_data_dir").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn legacy_publish_routes_return_gone_and_point_to_manual_workflow() {
        let (state, root) = test_state();
        let auto_publish = handle_request(
            authorized_write(
                Method::POST,
                "/api/content/1/publish-auto",
                Bytes::from_static(b"{}"),
            ),
            Arc::clone(&state),
        )
        .await;
        assert_eq!(auto_publish.status(), StatusCode::GONE);
        let body = auto_publish.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["replacement"], "manual_publish_assistant");
        assert_eq!(body["automatic_submission"], false);

        let login_status = get(Arc::clone(&state), "/api/content/xhs-login-status").await;
        assert_eq!(login_status.status(), StatusCode::GONE);
        let body = login_status.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["replacement"], "managed_browser_session");

        let publish_status = get(
            Arc::clone(&state),
            "/api/content/1/publish-status/legacy-job",
        )
        .await;
        assert_eq!(publish_status.status(), StatusCode::GONE);
        let body = publish_status
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["replacement"], "manual_publish_receipt");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn creator_import_keeps_risk_gate_and_streams_worker_errors() {
        let (state, root) = test_state();
        let body = Bytes::from(
            serde_json::to_vec(&json!({
                "url":"https://www.xiaohongshu.com/user/profile/creator-123?xsec_token=secret",
                "name":"参考账号",
                "save_db":true
            }))
            .unwrap(),
        );
        let denied = handle_request(
            authorized_write(Method::POST, "/api/crawler/creator", body.clone()),
            Arc::clone(&state),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::PRECONDITION_REQUIRED);
        let denied: Value =
            serde_json::from_slice(&denied.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(denied["detail"]["code"], "REQUIRES_CONFIRMATION");

        let mut request = authorized_write(Method::POST, "/api/crawler/creator", body);
        request.headers_mut().insert(
            "x-risk-acknowledged",
            hyper::header::HeaderValue::from_static("yes"),
        );
        let response = handle_request(request, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[CONTENT_TYPE],
            "text/event-stream; charset=utf-8"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("正在启动独立浏览器"));
        assert!(text.contains("Node runtime"));
        assert!(text.contains("[DONE]"));
        assert!(state
            .db
            .local_reference_account_id_for_capture(
                state.db.current_active_account().unwrap().id,
                "creator-123"
            )
            .unwrap()
            .is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    async fn get(state: Arc<HttpState>, uri: &str) -> Response<HttpBody> {
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header(HOST, "127.0.0.1:8765")
            .body(Full::new(Bytes::new()))
            .unwrap();
        handle_request(request, state).await
    }

    fn authorized_write(method: Method, uri: &str, body: Bytes) -> Request<Full<Bytes>> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(HOST, "127.0.0.1:8765")
            .header(ORIGIN, "http://localhost:1420")
            .header(hyper::header::AUTHORIZATION, "Bearer test-session-token")
            .header(CONTENT_TYPE, "application/json")
            .body(Full::new(body))
            .unwrap()
    }

    fn authorized_multipart_write(uri: &str, boundary: &str, body: Bytes) -> Request<Full<Bytes>> {
        Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header(HOST, "127.0.0.1:8765")
            .header(ORIGIN, "http://localhost:1420")
            .header(hyper::header::AUTHORIZATION, "Bearer test-session-token")
            .header(
                CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Full::new(body))
            .unwrap()
    }

    fn create_published_note(
        db: &LocalDb,
        title: &str,
        tags: Vec<String>,
        likes: i64,
    ) -> NoteSummary {
        let account_id = db.current_active_account().unwrap().id;
        let note = db
            .create_local_draft_for_account(title, Some(account_id))
            .unwrap();
        let note = db
            .update_local_note(LocalNoteUpdate {
                note_id: note.id,
                account_pool_id: account_id,
                expected_version: note.content_version,
                title: title.to_string(),
                body: "fixture body".to_string(),
                tags,
                note_type: "text".to_string(),
                item_ids: Vec::new(),
                video_path: None,
            })
            .unwrap();
        let note = db
            .update_local_note_status(LocalNoteStatusUpdate {
                note_id: note.id,
                account_pool_id: account_id,
                expected_version: note.content_version,
                status: "published".to_string(),
                note_url: Some("https://example.invalid/fixture".to_string()),
            })
            .unwrap();
        db.update_local_note_stats(LocalNoteStatsUpdate {
            note_id: note.id,
            account_pool_id: account_id,
            expected_version: note.content_version,
            field: "likes".to_string(),
            value: likes,
        })
        .unwrap()
    }

    #[test]
    fn parses_legacy_generated_draft_sections() {
        let generated = parse_generated_draft(
            "---标题候选（3 个）---\n情绪型：出租屋也能变舒服\n问题型：怎么收纳？\n\
             ---封面文案---\n一平米焕新\n\
             ---正文---\n（第 1 段·钩子）\n小房间终于不乱了。\n\n\
             （第 2 段·体验）\n这张藤编椅很轻。\n\
             ---互动引导---\n（结尾 1 句）\n你们会怎么搭？\n\
             ---话题标签---\n#出租屋 #藤编家居 #收纳\n\
             ---创作备注---\n使用场景角度。",
        );
        assert_eq!(generated.title, "出租屋也能变舒服");
        assert_eq!(
            generated.body,
            "小房间终于不乱了。\n\n这张藤编椅很轻。\n\n你们会怎么搭？"
        );
        assert_eq!(generated.tags, ["出租屋", "藤编家居", "收纳"]);
    }

    #[tokio::test]
    async fn draft_generation_preserves_error_contract_without_creating_a_partial_note() {
        let (state, root) = test_state();
        state
            .db
            .set_app_setting(
                "model_api_settings_v1",
                &json!({
                    "providers":[{
                        "id":"fixture",
                        "kind":"openai-compatible",
                        "endpoint":"https://example.invalid/v1/chat/completions",
                        "apiKey":"",
                        "model":"fixture-model"
                    }],
                    "defaultProviderId":"fixture",
                    "defaultModel":"fixture-model"
                })
                .to_string(),
            )
            .unwrap();
        let account_id = state.db.current_active_account().unwrap().id;
        let item = state
            .db
            .import_local_image_for_account(
                account_id,
                LocalImageImport {
                    account_pool_id: account_id,
                    file_name: "draft-fixture.jpg".to_string(),
                    mime_type: Some("image/jpeg".to_string()),
                    data_base64: BASE64.encode([0xff, 0xd8, 0xff, 0x01]),
                    thumbnail_data_base64: None,
                },
            )
            .unwrap();
        let response = handle_request(
            authorized_write(
                Method::POST,
                "/api/content/draft/generate",
                Bytes::from(json!({"item_id":item.id}).to_string()),
            ),
            Arc::clone(&state),
        )
        .await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let error: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(error["detail"].as_str().unwrap().contains("AI 生成失败"));
        let snapshot = state
            .db
            .snapshot_section_for_account(Some(account_id), "notes")
            .unwrap();
        assert!(snapshot.notes.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn legacy_single_and_multi_draft_routes_use_account_scoped_prompts() {
        let (state, root) = test_state();
        let account_id = state.db.current_active_account().unwrap().id;
        let import = |file_name: &str, bytes: &[u8]| {
            state
                .db
                .import_local_image_for_account(
                    account_id,
                    LocalImageImport {
                        account_pool_id: account_id,
                        file_name: file_name.to_string(),
                        mime_type: Some("image/jpeg".to_string()),
                        data_base64: BASE64.encode(bytes),
                        thumbnail_data_base64: None,
                    },
                )
                .unwrap()
        };
        let first = import("single-chair.jpg", &[0xff, 0xd8, 0xff, 0x01]);
        let second = import("multi-table.jpg", &[0xff, 0xd8, 0xff, 0x02]);

        let single = handle_request(
            authorized_write(
                Method::POST,
                "/api/content/draft",
                Bytes::from(json!({"item_id":first.id,"save":false}).to_string()),
            ),
            Arc::clone(&state),
        )
        .await;
        assert_eq!(single.status(), StatusCode::OK);
        let bytes = single.into_body().collect().await.unwrap().to_bytes();
        let single: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(single["prompt"].as_str().unwrap().contains("single-chair"));
        assert_eq!(single["note_id"], Value::Null);
        assert_eq!(single["knowledge_summary"], "");

        let multi = handle_request(
            authorized_write(
                Method::POST,
                "/api/content/draft/multi",
                Bytes::from(json!({"item_ids":[first.id,second.id]}).to_string()),
            ),
            Arc::clone(&state),
        )
        .await;
        assert_eq!(multi.status(), StatusCode::OK);
        let bytes = multi.into_body().collect().await.unwrap().to_bytes();
        let multi: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(multi["item_count"], 2);
        let note_id = multi["note_id"].as_i64().unwrap();
        let snapshot = state
            .db
            .snapshot_section_for_account(Some(account_id), "notes")
            .unwrap();
        let note = snapshot
            .notes
            .iter()
            .find(|note| note.id == note_id)
            .unwrap();
        assert_eq!(note.item_ids, [first.id, second.id]);
        assert!(note
            .prompt_used
            .as_deref()
            .unwrap()
            .contains("single-chair"));
        assert!(note.prompt_used.as_deref().unwrap().contains("multi-table"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn serves_health_and_account_scoped_reads_with_legacy_field_names() {
        let (state, root) = test_state();
        let health = get(Arc::clone(&state), "/health").await;
        assert_eq!(health.status(), StatusCode::OK);

        let pool = get(Arc::clone(&state), "/api/account-pool").await;
        assert_eq!(pool.status(), StatusCode::OK);
        let bytes = pool.into_body().collect().await.unwrap().to_bytes();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(value["items"][0]["is_active"].as_bool().unwrap());
        assert!(value["items"][0].get("isActive").is_none());

        let profile = get(Arc::clone(&state), "/api/profile").await;
        assert_eq!(profile.status(), StatusCode::OK);
        let bytes = profile.into_body().collect().await.unwrap().to_bytes();
        let profile = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(profile["display_name"], value["items"][0]["alias"]);

        let items = get(Arc::clone(&state), "/api/library/?offset=0&limit=20").await;
        assert_eq!(items.status(), StatusCode::OK);
        let bytes = items.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), json!([]));

        let prompts = get(Arc::clone(&state), "/api/settings/prompts").await;
        assert_eq!(prompts.status(), StatusCode::OK);
        let bytes = prompts.into_body().collect().await.unwrap().to_bytes();
        let prompts = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert!(prompts.is_array());
        if let Some(prompt) = prompts.as_array().and_then(|items| items.first()) {
            assert!(prompt.get("sort_order").is_some());
            assert!(prompt.get("sortOrder").is_none());
        }

        let analytics = get(Arc::clone(&state), "/api/analytics/notes?sort=unknown").await;
        assert_eq!(analytics.status(), StatusCode::OK);
        let bytes = analytics.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), json!([]));

        let summary = get(Arc::clone(&state), "/api/analytics/summary").await;
        assert_eq!(summary.status(), StatusCode::OK);
        let bytes = summary.into_body().collect().await.unwrap().to_bytes();
        let summary = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(summary["library"]["total_items"], 0);
        assert_eq!(summary["notes"]["published_avg"]["likes"], 0.0);
        assert_eq!(summary["suggestions"]["days_since_publish"], Value::Null);

        let insights = get(Arc::clone(&state), "/api/analytics/insights").await;
        assert_eq!(insights.status(), StatusCode::OK);
        let bytes = insights.into_body().collect().await.unwrap().to_bytes();
        let insights = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(insights["title_length_dist"].as_array().unwrap().len(), 4);
        assert_eq!(insights["hour_dist"], json!([]));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn serves_account_scoped_knowledge_samples_and_protected_toggle() {
        let (state, root) = test_state();
        let note = create_published_note(&state.db, "知识样本", vec!["收纳".to_string()], 25);
        create_published_note(&state.db, "知识参考", vec!["收纳".to_string()], 20);

        let rules_response = get(Arc::clone(&state), "/api/knowledge/rules").await;
        assert_eq!(rules_response.status(), StatusCode::OK);
        let bytes = rules_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let rules = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(rules[0]["key"], "rule_title_len");
        assert_eq!(rules[0]["enabled"], true);
        assert!(rules
            .as_array()
            .unwrap()
            .iter()
            .any(|rule| rule["key"] == "rule_tag_0"));

        let request = authorized_write(
            Method::PATCH,
            "/api/knowledge/rules/rule_title_len",
            Bytes::from(json!({"enabled":false}).to_string()),
        );
        let response = handle_request(request, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let rules_response = get(Arc::clone(&state), "/api/knowledge/rules").await;
        let bytes = rules_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let rules = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(rules[0]["enabled"], false);
        assert!(!state
            .db
            .local_content_knowledge_context(None)
            .unwrap()
            .rules
            .iter()
            .any(|rule| rule.contains("字标题")));

        let response = get(Arc::clone(&state), "/api/knowledge/my-samples").await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let samples = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(samples[0]["id"], note.id);
        assert_eq!(samples[0]["body_preview"], "fixture body");
        assert_eq!(samples[0]["use_as_reference"], false);
        assert!(samples[0].get("useAsReference").is_none());

        let request = authorized_write(
            Method::PATCH,
            &format!("/api/knowledge/my-samples/{}", note.id),
            Bytes::from(json!({"use_as_reference":true}).to_string()),
        );
        let response = handle_request(request, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let result = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["use_as_reference"], true);
        assert!(state.db.local_knowledge_my_samples(None).unwrap()[0].use_as_reference);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn preserves_legacy_knowledge_inspiration_fields_and_soft_deletes_by_account() {
        let (state, root) = test_state();
        let request = authorized_write(
            Method::POST,
            "/api/knowledge/inspirations",
            Bytes::from(
                json!({
                    "title":"租房收纳灵感",
                    "keyword":"窄空间",
                    "source":"crawl",
                    "likes_ref":123,
                    "note_ref":"https://example.invalid/source"
                })
                .to_string(),
            ),
        );
        let response = handle_request(request, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let created = serde_json::from_slice::<Value>(&bytes).unwrap();
        let inspiration_id = created["id"].as_i64().unwrap();
        assert_eq!(created["keyword"], "窄空间");
        assert_eq!(created["source"], "crawl");
        assert_eq!(created["likes_ref"], 123);
        assert_eq!(created["note_ref"], "https://example.invalid/source");
        assert_eq!(created["saved"], true);

        let list = get(Arc::clone(&state), "/api/knowledge/inspirations").await;
        assert_eq!(list.status(), StatusCode::OK);
        let bytes = list.into_body().collect().await.unwrap().to_bytes();
        let list = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["id"], inspiration_id);

        let request = authorized_write(
            Method::DELETE,
            &format!("/api/knowledge/inspirations/{inspiration_id}"),
            Bytes::new(),
        );
        let response = handle_request(request, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let list = get(state, "/api/knowledge/inspirations").await;
        let bytes = list.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), json!([]));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn serves_legacy_reference_sample_crud_with_account_scoping() {
        let (state, root) = test_state();
        state
            .db
            .create_local_reference_account(LocalReferenceAccountCreate {
                account_pool_id: 1,
                account_id: "ref-http".to_string(),
                name: Some("HTTP 榜样".to_string()),
                followers: 10,
            })
            .unwrap();
        let payload = json!({
            "account_id":"ref-http",
            "title":"参考标题",
            "body":"参考正文",
            "likes":88,
            "note_url":"https://example.invalid/reference"
        });
        let response = handle_request(
            authorized_write(
                Method::POST,
                "/api/knowledge/ref-samples",
                Bytes::from(payload.to_string()),
            ),
            Arc::clone(&state),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);

        let list = get(Arc::clone(&state), "/api/knowledge/ref-samples").await;
        assert_eq!(list.status(), StatusCode::OK);
        let bytes = list.into_body().collect().await.unwrap().to_bytes();
        let list = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(list[0]["account_id"], "ref-http");
        assert_eq!(list[0]["notes"][0]["title"], "参考标题");
        assert_eq!(list[0]["notes"][0]["body"], "参考正文");
        assert_eq!(list[0]["notes"][0]["likes"], 88);
        assert_eq!(
            list[0]["notes"][0]["note_url"],
            "https://example.invalid/reference"
        );
        assert!(list[0].get("accountId").is_none());

        let duplicate = handle_request(
            authorized_write(
                Method::POST,
                "/api/knowledge/ref-samples",
                Bytes::from(payload.to_string()),
            ),
            Arc::clone(&state),
        )
        .await;
        let bytes = duplicate.into_body().collect().await.unwrap().to_bytes();
        let duplicate = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(duplicate["duplicate"], true);

        let deleted = handle_request(
            authorized_write(
                Method::DELETE,
                "/api/knowledge/ref-samples/ref-http/0",
                Bytes::new(),
            ),
            Arc::clone(&state),
        )
        .await;
        assert_eq!(deleted.status(), StatusCode::OK);
        let list = get(state, "/api/knowledge/ref-samples").await;
        let bytes = list.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), json!([]));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn stages_and_serves_only_account_owned_publish_images() {
        let (state, root) = test_state();
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let imported = state
            .db
            .import_local_image(LocalImageImport {
                account_pool_id: 1,
                file_name: "cover.png".to_string(),
                mime_type: Some("image/png".to_string()),
                data_base64: png.to_string(),
                thumbnail_data_base64: None,
            })
            .unwrap();
        let note = state
            .db
            .create_local_draft_for_account("暂存 API 测试", Some(1))
            .unwrap();
        state
            .db
            .update_local_note_items(LocalNoteItemsUpdate {
                note_id: note.id,
                account_pool_id: 1,
                expected_version: note.content_version,
                item_ids: vec![imported.id],
            })
            .unwrap();
        let staged_filename = format!("01_{}", imported.image_path.rsplit('/').next().unwrap());

        let response = handle_request(
            authorized_write(
                Method::POST,
                &format!("/api/content/{}/stage-images", note.id),
                Bytes::from_static(b"{}"),
            ),
            Arc::clone(&state),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let staged = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(staged["note_id"], note.id);
        assert_eq!(staged["count"], 1);
        assert_eq!(staged["files"][0]["filename"], staged_filename);
        assert_eq!(
            staged["files"][0]["url"],
            format!("/api/content/{}/stage-images/{staged_filename}", note.id)
        );

        let image = get(
            Arc::clone(&state),
            &format!("/api/content/{}/stage-images/{staged_filename}", note.id),
        )
        .await;
        assert_eq!(image.status(), StatusCode::OK);
        assert_eq!(image.headers()[CONTENT_TYPE], "image/png");
        assert_eq!(
            image.into_body().collect().await.unwrap().to_bytes(),
            BASE64.decode(png).unwrap()
        );

        let traversal = get(
            Arc::clone(&state),
            &format!("/api/content/{}/stage-images/..%2Fapp.db.png", note.id),
        )
        .await;
        assert_eq!(traversal.status(), StatusCode::BAD_REQUEST);

        let response = handle_request(
            authorized_write(
                Method::DELETE,
                &format!("/api/content/{}/stage-images", note.id),
                Bytes::new(),
            ),
            Arc::clone(&state),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let missing = get(
            state,
            &format!("/api/content/{}/stage-images/{staged_filename}", note.id),
        )
        .await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn rejects_untrusted_origin_and_non_loopback_host() {
        let (state, root) = test_state();
        let foreign_origin = Request::builder()
            .method(Method::GET)
            .uri("/api/account-pool")
            .header(HOST, "127.0.0.1:8765")
            .header(ORIGIN, "https://attacker.example")
            .body(Full::new(Bytes::new()))
            .unwrap();
        let response = handle_request(foreign_origin, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response
            .headers()
            .get(ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());

        let rebinding_host = Request::builder()
            .method(Method::GET)
            .uri("/health")
            .header(HOST, "attacker.example:8765")
            .body(Full::new(Bytes::new()))
            .unwrap();
        assert_eq!(
            handle_request(rebinding_host, state).await.status(),
            StatusCode::BAD_REQUEST
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_configured_local_origins_are_accepted() {
        assert!(is_loopback_origin("http://localhost:1422"));
        assert!(is_loopback_origin("http://127.0.0.1:4173"));
        assert!(!is_loopback_origin("https://localhost:1422"));
        assert!(!is_loopback_origin("http://attacker.example:1422"));
        assert!(!is_loopback_origin("http://localhost:1422/path"));
    }

    #[test]
    fn parses_calendar_days_and_leap_dates() {
        assert_eq!(
            parse_calendar_day("1970-01-01 00:00:00"),
            Some((1970, 1, 1))
        );
        assert_eq!(civil_days(1970, 1, 1), Some(0));
        assert_eq!(
            civil_days(2024, 3, 1).unwrap() - civil_days(2024, 2, 28).unwrap(),
            2
        );
        assert_eq!(parse_calendar_day("2025-02-29 12:00:00"), None);
        for date in [(1970, 1, 1), (2024, 2, 29), (2038, 1, 19)] {
            let days = civil_days(date.0, date.1, date.2).unwrap();
            assert_eq!(civil_from_days(days), date);
        }
    }

    #[tokio::test]
    async fn serves_account_scoped_trend_and_topic_routes() {
        let (state, root) = test_state();
        let trend = get(
            Arc::clone(&state),
            "/api/analytics/notes-trend?granularity=week",
        )
        .await;
        assert_eq!(trend.status(), StatusCode::OK);
        let bytes = trend.into_body().collect().await.unwrap().to_bytes();
        let trend = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(trend["granularity"], "week");
        assert_eq!(trend["items"], json!([]));

        let topics = get(Arc::clone(&state), "/api/analytics/topics?limit=0").await;
        assert_eq!(topics.status(), StatusCode::OK);
        let bytes = topics.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            json!({"topics":[]})
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn reads_a_reference_account_within_the_active_account() {
        let (state, root) = test_state();
        let account_pool_id = state.db.current_active_account().unwrap().id;
        state
            .db
            .create_local_reference_account(LocalReferenceAccountCreate {
                account_pool_id,
                account_id: "fixture-account".to_string(),
                name: Some("Fixture Creator".to_string()),
                followers: 42,
            })
            .unwrap();

        let response = get(Arc::clone(&state), "/api/accounts/fixture-account").await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(value["account_id"], "fixture-account");
        assert_eq!(value["followers"], 42);
        assert!(value.get("accountId").is_none());

        let missing = get(state, "/api/accounts/missing").await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn issues_write_session_only_to_an_allowed_web_origin() {
        let (state, root) = test_state();
        let generated_token = create_http_token().unwrap();
        assert_eq!(generated_token.len(), 64);
        assert!(generated_token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let request = Request::builder()
            .method(Method::GET)
            .uri("/api/session")
            .header(HOST, "127.0.0.1:8765")
            .header(ORIGIN, "http://localhost:1420")
            .body(Full::new(Bytes::new()))
            .unwrap();
        let response = handle_request(request, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["token"], "test-session-token");

        let request = Request::builder()
            .method(Method::GET)
            .uri("/api/session")
            .header(HOST, "127.0.0.1:8765")
            .body(Full::new(Bytes::new()))
            .unwrap();
        assert_eq!(
            handle_request(request, Arc::clone(&state)).await.status(),
            StatusCode::FORBIDDEN
        );
        assert!(bearer_token_matches(
            Some("Bearer test-session-token"),
            "test-session-token"
        ));
        assert!(!bearer_token_matches(
            Some("Bearer attacker"),
            "test-session-token"
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn ai_quick_uses_saved_provider_and_keeps_legacy_error_shape_without_key_leaks() {
        let (state, root) = test_state();
        state
            .db
            .set_app_setting(
                "model_api_settings_v1",
                &json!({
                    "providers":[{
                        "id":"fixture",
                        "kind":"openai-compatible",
                        "endpoint":"file:///private/secret",
                        "apiKey":"fixture-sensitive-key",
                        "model":"fixture-model"
                    }],
                    "defaultProviderId":"fixture",
                    "defaultModel":"fixture-model"
                })
                .to_string(),
            )
            .unwrap();
        let request = authorized_write(
            Method::POST,
            "/api/ai/quick",
            Bytes::from(
                json!({
                    "messages":[{"role":"user","content":"改写标题"}],
                    "system_extra":"只输出一个标题"
                })
                .to_string(),
            ),
        );
        let response = handle_request(request, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(value["error"].as_str().unwrap().contains("HTTP(S)"));
        assert!(!String::from_utf8_lossy(&bytes).contains("fixture-sensitive-key"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn ai_chat_returns_a_cancellable_sse_contract_when_provider_is_unconfigured() {
        let (state, root) = test_state();
        state
            .db
            .set_app_setting(
                "model_api_settings_v1",
                &json!({
                    "providers":[{
                        "id":"fixture",
                        "kind":"anthropic-compatible",
                        "endpoint":"https://example.invalid/v1/messages",
                        "apiKey":"",
                        "model":"fixture-model"
                    }],
                    "defaultProviderId":"fixture",
                    "defaultModel":"fixture-model"
                })
                .to_string(),
            )
            .unwrap();
        let request = authorized_write(
            Method::POST,
            "/api/ai/chat",
            Bytes::from(
                json!({
                    "messages":[
                        {"role":"user","content":"你好"},
                        {"role":"assistant","content":"你好！"},
                        {"role":"user","content":"继续"}
                    ]
                })
                .to_string(),
            ),
        );
        let response = handle_request(request, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[CONTENT_TYPE],
            "text/event-stream; charset=utf-8"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("尚未配置 API Key"));
        assert!(text.ends_with("data: [DONE]\n\n"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn ai_inspire_builds_the_legacy_prompt_and_returns_sse_errors() {
        let (state, root) = test_state();
        let account_id = state.db.current_active_account().unwrap().id;
        let conn = rusqlite::Connection::open(state.db.path()).unwrap();
        conn.execute(
            "INSERT INTO notes (title, status, likes, tags, published_at, account_pool_id)
             VALUES ('first tag', 'published', 10, '[\"第二标签\"]', datetime('now'), ?1)",
            [account_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes (title, status, likes, tags, published_at, account_pool_id)
             VALUES ('second tag', 'published', 10, '[\"#井号\"]', datetime('now'), ?1)",
            [account_id],
        )
        .unwrap();
        drop(conn);

        let (system, user_message) = build_legacy_inspire_prompt(
            &state.db,
            &LegacyInspireRequest {
                topic: "小户型收纳".to_string(),
                item_ids: Vec::new(),
                extra_image_desc: "需要一张玄关图".to_string(),
                account_ids: Vec::new(),
                extra_instruction: "语气克制".to_string(),
            },
        )
        .unwrap();
        assert!(system.contains("---标题候选---"));
        assert!(system.contains("---互动引导---"));
        assert!(system.contains("历史高赞帖常用标签：#第二标签、##井号"));
        assert!(user_message.contains("小户型收纳"));
        assert!(user_message.contains("需要一张玄关图"));
        assert!(user_message.contains("语气克制"));

        state
            .db
            .set_app_setting(
                "model_api_settings_v1",
                &json!({
                    "providers":[{
                        "id":"fixture",
                        "kind":"anthropic-compatible",
                        "endpoint":"https://example.invalid/v1/messages",
                        "apiKey":"",
                        "model":"fixture-model"
                    }],
                    "defaultProviderId":"fixture",
                    "defaultModel":"fixture-model"
                })
                .to_string(),
            )
            .unwrap();
        let request = authorized_write(
            Method::POST,
            "/api/ai/inspire",
            Bytes::from(
                json!({
                    "topic":"小户型收纳",
                    "item_ids":[],
                    "extra_image_desc":"需要一张玄关图",
                    "account_ids":[],
                    "extra_instruction":"语气克制"
                })
                .to_string(),
            ),
        );
        let response = handle_request(request, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[CONTENT_TYPE],
            "text/event-stream; charset=utf-8"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let stream = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(stream.contains("尚未配置 API Key"));
        assert!(stream.ends_with("data: [DONE]\n\n"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn blocks_writes_without_origin_and_session_token() {
        let (state, root) = test_state();
        let unauthorized = Request::builder()
            .method(Method::POST)
            .uri("/api/content")
            .header(HOST, "127.0.0.1:8765")
            .header(ORIGIN, "http://localhost:1420")
            .body(Full::new(Bytes::new()))
            .unwrap();
        assert_eq!(
            handle_request(unauthorized, Arc::clone(&state))
                .await
                .status(),
            StatusCode::FORBIDDEN
        );

        let authorized_without_content_type = Request::builder()
            .method(Method::POST)
            .uri("/api/content/draft")
            .header(HOST, "127.0.0.1:8765")
            .header(ORIGIN, "http://localhost:1420")
            .header(hyper::header::AUTHORIZATION, "Bearer test-session-token")
            .body(Full::new(Bytes::new()))
            .unwrap();
        let response = handle_request(authorized_without_content_type, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

        let preflight = Request::builder()
            .method(Method::OPTIONS)
            .uri("/api/content")
            .header(HOST, "127.0.0.1:8765")
            .header(ORIGIN, "http://localhost:1420")
            .body(Full::new(Bytes::new()))
            .unwrap();
        let response = handle_request(preflight, state).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(response.headers()[ACCESS_CONTROL_ALLOW_HEADERS]
            .to_str()
            .unwrap()
            .contains("authorization"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn prompt_crud_requires_session_and_preserves_the_legacy_contract() {
        let (state, root) = test_state();
        let create_body = serde_json::to_vec(&json!({
            "key":"fixture_prompt",
            "label":"Fixture prompt",
            "prompt":"Write a fixture",
            "sort_order":17,
            "enabled":true,
        }))
        .unwrap();
        let create = authorized_write(
            Method::POST,
            "/api/settings/prompts",
            Bytes::from(create_body),
        );
        assert_eq!(
            handle_request(create, Arc::clone(&state)).await.status(),
            StatusCode::OK
        );

        let update_body = serde_json::to_vec(&json!({
            "label":"Updated fixture",
            "enabled":false,
        }))
        .unwrap();
        let update = authorized_write(
            Method::PUT,
            "/api/settings/prompts/fixture_prompt",
            Bytes::from(update_body),
        );
        assert_eq!(
            handle_request(update, Arc::clone(&state)).await.status(),
            StatusCode::OK
        );
        let prompts = get(Arc::clone(&state), "/api/settings/prompts").await;
        let bytes = prompts.into_body().collect().await.unwrap().to_bytes();
        let prompts = serde_json::from_slice::<Value>(&bytes).unwrap();
        let prompt = prompts
            .as_array()
            .unwrap()
            .iter()
            .find(|prompt| prompt["key"] == "fixture_prompt")
            .unwrap();
        assert_eq!(prompt["label"], "Updated fixture");
        assert_eq!(prompt["prompt"], "Write a fixture");
        assert_eq!(prompt["sort_order"], 17);
        assert_eq!(prompt["enabled"], false);

        let oversized = authorized_write(
            Method::POST,
            "/api/settings/prompts",
            Bytes::from(vec![b' '; MAX_REQUEST_BODY_BYTES + 1]),
        );
        assert_eq!(
            handle_request(oversized, Arc::clone(&state)).await.status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );

        let delete = authorized_write(
            Method::DELETE,
            "/api/settings/prompts/fixture_prompt",
            Bytes::new(),
        );
        assert_eq!(
            handle_request(delete, state.clone()).await.status(),
            StatusCode::OK
        );
        let prompts = get(state, "/api/settings/prompts").await;
        let bytes = prompts.into_body().collect().await.unwrap().to_bytes();
        let prompts = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert!(prompts
            .as_array()
            .unwrap()
            .iter()
            .all(|prompt| prompt["key"] != "fixture_prompt"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn note_crud_routes_preserve_legacy_fields_and_use_soft_delete() {
        let (state, root) = test_state();
        let create = authorized_write(
            Method::POST,
            "/api/content/",
            Bytes::from(
                serde_json::to_vec(&json!({
                    "title":"Fixture title",
                    "body":"First draft",
                    "tags":["home", "ideas"],
                    "cover_desc":"A clean cover",
                    "note_type":"text",
                }))
                .unwrap(),
            ),
        );
        let created = handle_request(create, Arc::clone(&state)).await;
        assert_eq!(created.status(), StatusCode::OK);
        let bytes = created.into_body().collect().await.unwrap().to_bytes();
        let created: Value = serde_json::from_slice(&bytes).unwrap();
        let note_id = created["id"].as_i64().unwrap();
        assert_eq!(created["title"], "Fixture title");
        assert_eq!(created["tags"], json!(["home", "ideas"]));
        assert_eq!(created["cover_desc"], "A clean cover");
        assert_eq!(created["status"], "draft");

        let no_op_patch = authorized_write(
            Method::PATCH,
            &format!("/api/content/{note_id}"),
            Bytes::from_static(b"{}"),
        );
        let no_op_patch = handle_request(no_op_patch, Arc::clone(&state)).await;
        let bytes = no_op_patch.into_body().collect().await.unwrap().to_bytes();
        let no_op_patch: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(no_op_patch["content_version"], created["content_version"]);

        let patch = authorized_write(
            Method::PATCH,
            &format!("/api/content/{note_id}"),
            Bytes::from(
                serde_json::to_vec(&json!({"body":"Edited body", "tags":["updated"]})).unwrap(),
            ),
        );
        let patched = handle_request(patch, Arc::clone(&state)).await;
        assert_eq!(patched.status(), StatusCode::OK);
        let bytes = patched.into_body().collect().await.unwrap().to_bytes();
        let patched: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(patched["title"], "Fixture title");
        assert_eq!(patched["body"], "Edited body");
        assert_eq!(patched["tags"], json!(["updated"]));
        let version = patched["content_version"].as_i64().unwrap();

        let status = authorized_write(
            Method::PATCH,
            &format!("/api/content/{note_id}/status"),
            Bytes::from(serde_json::to_vec(&json!({"status":"ready"})).unwrap()),
        );
        let status = handle_request(status, Arc::clone(&state)).await;
        assert_eq!(status.status(), StatusCode::OK);
        let bytes = status.into_body().collect().await.unwrap().to_bytes();
        let status: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(status["status"], "ready");
        assert!(status["content_version"].as_i64().unwrap() > version);

        let stats = authorized_write(
            Method::PATCH,
            &format!("/api/content/{note_id}/stats"),
            Bytes::from(serde_json::to_vec(&json!({"likes":7, "comments":2})).unwrap()),
        );
        let stats = handle_request(stats, Arc::clone(&state)).await;
        assert_eq!(stats.status(), StatusCode::OK);
        let bytes = stats.into_body().collect().await.unwrap().to_bytes();
        let stats: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(stats["likes"], 7);
        assert_eq!(stats["comments"], 2);

        let delete = authorized_write(
            Method::DELETE,
            &format!("/api/content/{note_id}"),
            Bytes::new(),
        );
        let deleted = handle_request(delete, Arc::clone(&state)).await;
        assert_eq!(deleted.status(), StatusCode::OK);
        let bytes = deleted.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            json!({"ok":true})
        );
        let snapshot = state
            .db
            .snapshot_section_for_account(None, "notes")
            .unwrap();
        assert!(snapshot.trash_notes.iter().any(|note| note.id == note_id));
        assert!(snapshot.notes.iter().all(|note| note.id != note_id));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn imports_multipart_images_with_legacy_fields_and_safe_file_storage() {
        let (state, root) = test_state();
        let boundary = "rn-http-fixture-boundary";
        let mut body = Vec::new();
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"../../椅子.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(&[0xff, 0xd8, 0xff, 0x10, 0x20]);
        body.extend_from_slice(
            format!(
                "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\n藤编椅\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"analyze\"\r\n\r\nfalse\r\n--{boundary}--\r\n"
            )
            .as_bytes(),
        );
        let response = handle_request(
            authorized_multipart_write("/api/library/", boundary, Bytes::from(body)),
            Arc::clone(&state),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let response_bytes = response.into_body().collect().await.unwrap().to_bytes();
        let imported: Value = serde_json::from_slice(&response_bytes).unwrap();
        assert_eq!(imported["title"], "藤编椅");
        assert!(imported["image_path"]
            .as_str()
            .unwrap()
            .starts_with("assets/1/"));
        assert_eq!(imported["analysis_raw"], Value::Null);

        let image = get(
            Arc::clone(&state),
            &format!("/api/library/{}/image", imported["id"].as_i64().unwrap()),
        )
        .await;
        assert_eq!(image.status(), StatusCode::OK);
        assert_eq!(
            image
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            &[0xff, 0xd8, 0xff, 0x10, 0x20]
        );
        let library = get(state, "/api/library/").await;
        let bytes = library.into_body().collect().await.unwrap().to_bytes();
        let library: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(library[0]["title"], "藤编椅");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn rejects_invalid_multipart_images_before_writing() {
        let (state, root) = test_state();
        let boundary = "rn-invalid-boundary";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"chair.jpg\"\r\nContent-Type: image/png\r\n\r\nnot-an-image\r\n--{boundary}--\r\n"
        );
        let response = handle_request(
            authorized_multipart_write("/api/library/", boundary, Bytes::from(body)),
            Arc::clone(&state),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let library = get(state, "/api/library/").await;
        let bytes = library.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), json!([]));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn library_tag_and_trash_routes_stay_account_scoped_and_guard_purge() {
        let (state, root) = test_state();
        let account_pool_id = state.db.current_active_account().unwrap().id;
        let item = state
            .db
            .import_local_image(LocalImageImport {
                account_pool_id,
                file_name: "fixture.png".to_string(),
                mime_type: Some("image/png".to_string()),
                data_base64:
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                        .to_string(),
                thumbnail_data_base64: None,
            })
            .unwrap();

        let add_tag = authorized_write(
            Method::PATCH,
            &format!("/api/library/{}/tags", item.id),
            Bytes::from(serde_json::to_vec(&json!({"tag":"warm", "action":"add"})).unwrap()),
        );
        let added = handle_request(add_tag, Arc::clone(&state)).await;
        assert_eq!(added.status(), StatusCode::OK);
        let bytes = added.into_body().collect().await.unwrap().to_bytes();
        let added: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(added["tags"], json!(["warm"]));

        let delete = authorized_write(
            Method::DELETE,
            &format!("/api/library/{}", item.id),
            Bytes::new(),
        );
        assert_eq!(
            handle_request(delete, Arc::clone(&state)).await.status(),
            StatusCode::OK
        );
        let restore = authorized_write(
            Method::POST,
            &format!("/api/library/trash/{}/restore", item.id),
            Bytes::new(),
        );
        assert_eq!(
            handle_request(restore, Arc::clone(&state)).await.status(),
            StatusCode::OK
        );
        assert!(state
            .db
            .snapshot_section_for_account(None, "library")
            .unwrap()
            .items
            .iter()
            .any(|restored| restored.id == item.id));
        let delete_again = authorized_write(
            Method::DELETE,
            &format!("/api/library/{}", item.id),
            Bytes::new(),
        );
        assert_eq!(
            handle_request(delete_again, Arc::clone(&state))
                .await
                .status(),
            StatusCode::OK
        );
        let purge = authorized_write(
            Method::DELETE,
            &format!("/api/library/trash/{}/purge", item.id),
            Bytes::new(),
        );
        let purged = handle_request(purge, Arc::clone(&state)).await;
        assert_eq!(purged.status(), StatusCode::OK);
        let bytes = purged.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            json!({"ok":true})
        );
        assert!(state
            .db
            .snapshot_section_for_account(None, "library")
            .unwrap()
            .trash_items
            .is_empty());

        let purge_all =
            authorized_write(Method::DELETE, "/api/library/trash/purge-all", Bytes::new());
        let purge_all = handle_request(purge_all, state).await;
        assert_eq!(purge_all.status(), StatusCode::OK);
        let bytes = purge_all.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            json!({"ok":true,"deleted":0})
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn account_pool_routes_create_update_activate_ban_and_retire_accounts() {
        let (state, root) = test_state();
        let list = get(Arc::clone(&state), "/api/account-pool").await;
        assert_eq!(list.status(), StatusCode::OK);
        let bytes = list.into_body().collect().await.unwrap().to_bytes();
        let list: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(list["items"][0]["is_active"], true);
        assert!(list["items"][0].get("user_data_dir").is_some());
        assert!(list["items"][0].get("ban_count").is_some());

        let create = authorized_write(
            Method::POST,
            "/api/account-pool",
            Bytes::from(
                serde_json::to_vec(&json!({
                    "alias":"第二运营账号",
                    "notes":"由 Rust HTTP 创建"
                }))
                .unwrap(),
            ),
        );
        let created = handle_request(create, Arc::clone(&state)).await;
        assert_eq!(created.status(), StatusCode::OK);
        let bytes = created.into_body().collect().await.unwrap().to_bytes();
        let created: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(created["alias"], "第二运营账号");
        assert_eq!(created["role"], "operation");
        assert_eq!(created["notes"], "由 Rust HTTP 创建");
        let second_id = created["id"].as_i64().unwrap();

        let patch = authorized_write(
            Method::PATCH,
            &format!("/api/account-pool/{second_id}"),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "display_name":"小红书名",
                    "xhs_user_id":"xhs-user-2",
                    "followers":42,
                    "notes":"更新备注"
                }))
                .unwrap(),
            ),
        );
        let updated = handle_request(patch, Arc::clone(&state)).await;
        assert_eq!(updated.status(), StatusCode::OK);
        let bytes = updated.into_body().collect().await.unwrap().to_bytes();
        let updated: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(updated["alias"], "第二运营账号");
        assert_eq!(updated["display_name"], "小红书名");
        assert_eq!(updated["xhs_user_id"], "xhs-user-2");
        assert_eq!(updated["followers"], 42);
        assert_eq!(updated["notes"], "更新备注");

        let activate = authorized_write(
            Method::POST,
            &format!("/api/account-pool/{second_id}/activate"),
            Bytes::new(),
        );
        let activated = handle_request(activate, Arc::clone(&state)).await;
        assert_eq!(activated.status(), StatusCode::OK);
        let bytes = activated.into_body().collect().await.unwrap().to_bytes();
        let activated: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(activated["is_active"], true);
        assert!(activated["last_used_at"].is_string());

        let original_id = state.db.account_pool().unwrap().items[0].id;
        let retire = authorized_write(
            Method::DELETE,
            &format!("/api/account-pool/{original_id}"),
            Bytes::new(),
        );
        assert_eq!(
            handle_request(retire, Arc::clone(&state)).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            state
                .db
                .account_pool()
                .unwrap()
                .items
                .into_iter()
                .find(|account| account.id == original_id)
                .unwrap()
                .status,
            "retired"
        );

        let create_assistant = authorized_write(
            Method::POST,
            "/api/account-pool",
            Bytes::from(
                serde_json::to_vec(&json!({
                    "alias":"辅助账号",
                    "role":"assistant"
                }))
                .unwrap(),
            ),
        );
        assert_eq!(
            handle_request(create_assistant, Arc::clone(&state))
                .await
                .status(),
            StatusCode::OK
        );
        let assistant_id = state.db.account_pool().unwrap().items.last().unwrap().id;
        let banned = authorized_write(
            Method::POST,
            &format!("/api/account-pool/{assistant_id}/mark-banned"),
            Bytes::new(),
        );
        let banned = handle_request(banned, Arc::clone(&state)).await;
        assert_eq!(banned.status(), StatusCode::OK);
        let bytes = banned.into_body().collect().await.unwrap().to_bytes();
        let banned: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(banned["status"], "banned");
        assert_eq!(banned["ban_count"], 1);

        let protection = get(Arc::clone(&state), "/api/account-pool/protection/status").await;
        assert_eq!(protection.status(), StatusCode::OK);
        let bytes = protection.into_body().collect().await.unwrap().to_bytes();
        let protection: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(protection["active"]["id"], second_id);
        assert_eq!(protection["policies"]["publish_auto"], "retired");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn profile_patch_preserves_fields_and_refresh_worker_reports_status() {
        let (state, root) = test_state();
        let patch = authorized_write(
            Method::PATCH,
            "/api/profile",
            Bytes::from(
                serde_json::to_vec(&json!({
                    "account_id":"profile-account-1",
                    "niche":"家居收纳",
                    "followers":1234,
                    "content_pillars":["租房改造", "收纳技巧"],
                    "avatar_url":"https://example.invalid/avatar.png",
                    "xhs_bio":"小户型收纳记录",
                    "xhs_follows":88,
                    "ip_location":"上海",
                    "xhs_tags":["家居","收纳"],
                    "risk_warning_ack":1,
                }))
                .unwrap(),
            ),
        );
        let response = handle_request(patch, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let profile: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(profile["niche"], "家居收纳");
        assert_eq!(profile["followers"], 1234);
        assert_eq!(profile["content_pillars"], json!(["租房改造", "收纳技巧"]));
        assert_eq!(profile["display_name"], "主号");
        assert_eq!(profile["avatar_url"], "https://example.invalid/avatar.png");
        assert_eq!(profile["xhs_bio"], "小户型收纳记录");
        assert_eq!(profile["xhs_follows"], 88);
        assert_eq!(profile["ip_location"], "上海");
        assert_eq!(profile["xhs_tags"], json!(["家居", "收纳"]));
        assert_eq!(profile["risk_warning_ack"], 1);
        assert!(profile["risk_warning_ack_at"].as_str().is_some());

        let empty = authorized_write(Method::PATCH, "/api/profile", Bytes::from_static(b"{}"));
        assert_eq!(
            handle_request(empty, Arc::clone(&state)).await.status(),
            StatusCode::BAD_REQUEST
        );
        let refresh = authorized_write(Method::POST, "/api/profile/refresh", Bytes::new());
        let refresh = handle_request(refresh, Arc::clone(&state)).await;
        assert_eq!(refresh.status(), StatusCode::OK);
        let bytes = refresh.into_body().collect().await.unwrap().to_bytes();
        let refresh: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(refresh["account_id"], "profile-account-1");
        let refresh_status = get(Arc::clone(&state), "/api/profile/refresh-status").await;
        assert_eq!(refresh_status.status(), StatusCode::OK);
        let mut status: Value = serde_json::from_slice(
            &refresh_status
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes(),
        )
        .unwrap();
        for _ in 0..20 {
            if status["running"] == false {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            let response = get(Arc::clone(&state), "/api/profile/refresh-status").await;
            status =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
        }
        assert_eq!(status["running"], false);
        assert!(status["last_error"]
            .as_str()
            .unwrap()
            .contains("Node runtime"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn settings_env_compatibility_stores_minimax_config_in_local_settings_and_masks_key() {
        let (state, root) = test_state();
        let patch = authorized_write(
            Method::PATCH,
            "/api/settings/env",
            Bytes::from(
                serde_json::to_vec(&json!({
                    "MINIMAX_API_KEY":"sk-cp-test-local-secret",
                    "MINIMAX_BASE_URL":"https://api.example.invalid/anthropic",
                    "MINIMAX_TEXT_MODEL":"text-fixture-v1",
                    "MINIMAX_VISION_MODEL":"vision-fixture-v1",
                }))
                .unwrap(),
            ),
        );
        let response = handle_request(patch, Arc::clone(&state)).await;
        assert_eq!(response.status(), StatusCode::OK);

        let stored: Value = serde_json::from_str(
            &state
                .db
                .get_app_setting("model_api_settings_v1")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let provider = &stored["providers"][0];
        assert_eq!(provider["apiKey"], "sk-cp-test-local-secret");
        assert_eq!(
            provider["endpoint"],
            "https://api.example.invalid/anthropic/v1/messages"
        );
        assert_eq!(provider["model"], "text-fixture-v1");
        assert_eq!(provider["visionModel"], "vision-fixture-v1");
        assert_eq!(
            state
                .db
                .get_app_setting("settings_env_migrated_v1")
                .unwrap()
                .as_deref(),
            Some("true")
        );

        let read = get(Arc::clone(&state), "/api/settings/env").await;
        assert_eq!(read.status(), StatusCode::OK);
        let bytes = read.into_body().collect().await.unwrap().to_bytes();
        let read: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(read["MINIMAX_API_KEY"], "sk-cp-te****");
        assert_eq!(
            read["MINIMAX_BASE_URL"],
            "https://api.example.invalid/anthropic"
        );
        assert_eq!(read["MINIMAX_TEXT_MODEL"], "text-fixture-v1");
        assert_eq!(read["MINIMAX_VISION_MODEL"], "vision-fixture-v1");

        let masked_key = authorized_write(
            Method::PATCH,
            "/api/settings/env",
            Bytes::from_static(
                br#"{"MINIMAX_API_KEY":"sk-cp-te****","MINIMAX_TEXT_MODEL":"changed"}"#,
            ),
        );
        assert_eq!(
            handle_request(masked_key, Arc::clone(&state))
                .await
                .status(),
            StatusCode::OK
        );
        let after_mask = state
            .db
            .get_app_setting("model_api_settings_v1")
            .unwrap()
            .unwrap();
        let after_mask: Value = serde_json::from_str(&after_mask).unwrap();
        assert_eq!(
            after_mask["providers"][0]["apiKey"],
            "sk-cp-test-local-secret"
        );
        assert_eq!(after_mask["providers"][0]["model"], "changed");

        let invalid = authorized_write(
            Method::PATCH,
            "/api/settings/env",
            Bytes::from_static(br#"{"MINIMAX_BASE_URL":"javascript:alert(1)"}"#),
        );
        assert_eq!(
            handle_request(invalid, state).await.status(),
            StatusCode::BAD_REQUEST
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn reference_account_routes_upsert_patch_sort_and_delete_in_active_scope() {
        let (state, root) = test_state();
        let create = authorized_write(
            Method::POST,
            "/api/accounts/",
            Bytes::from(
                serde_json::to_vec(&json!({
                    "account_id":"reference-a",
                    "name":"收纳榜样",
                    "followers":1200,
                    "note_count":8,
                    "avg_likes":52.5,
                    "avg_comments":4.5,
                    "avg_collects":12.0,
                    "content_style":"偏实用",
                    "top_notes":[{"title":"小户型收纳","likes":360,"url":"https://example.invalid/note"}]
                }))
                .unwrap(),
            ),
        );
        let created = handle_request(create, Arc::clone(&state)).await;
        assert_eq!(created.status(), StatusCode::OK);
        let bytes = created.into_body().collect().await.unwrap().to_bytes();
        let created: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(created["account_id"], "reference-a");
        assert_eq!(created["avg_likes"], 52.5);
        assert_eq!(created["top_notes"][0]["title"], "小户型收纳");

        let create_second = authorized_write(
            Method::POST,
            "/api/accounts",
            Bytes::from(
                serde_json::to_vec(&json!({
                    "account_id":"reference-b",
                    "name":"高赞榜样",
                    "avg_likes":100.0
                }))
                .unwrap(),
            ),
        );
        assert_eq!(
            handle_request(create_second, Arc::clone(&state))
                .await
                .status(),
            StatusCode::OK
        );
        let list = get(Arc::clone(&state), "/api/accounts/").await;
        let bytes = list.into_body().collect().await.unwrap().to_bytes();
        let list: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(list[0]["account_id"], "reference-b");

        let patch = authorized_write(
            Method::PATCH,
            "/api/accounts/reference-a",
            Bytes::from(
                serde_json::to_vec(&json!({
                    "name":"收纳榜样-更新",
                    "followers":2400,
                    "content_style":"实用清单",
                    "avg_likes":70.0
                }))
                .unwrap(),
            ),
        );
        let updated = handle_request(patch, Arc::clone(&state)).await;
        assert_eq!(updated.status(), StatusCode::OK);
        let bytes = updated.into_body().collect().await.unwrap().to_bytes();
        let updated: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(updated["name"], "收纳榜样-更新");
        assert_eq!(updated["followers"], 2400);
        assert_eq!(updated["avg_likes"], 70.0);
        assert_eq!(updated["note_count"], 8);
        assert_eq!(updated["top_notes"][0]["title"], "小户型收纳");

        let delete = authorized_write(Method::DELETE, "/api/accounts/reference-a", Bytes::new());
        assert_eq!(
            handle_request(delete, Arc::clone(&state)).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            get(state, "/api/accounts/reference-a").await.status(),
            StatusCode::NOT_FOUND
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn reference_imitate_route_checks_active_account_and_keeps_legacy_error_shape() {
        let (state, root) = test_state();
        state
            .db
            .set_app_setting(
                "model_api_settings_v1",
                &json!({
                    "providers":[{
                        "id":"minimax",
                        "kind":"anthropic-compatible",
                        "endpoint":"https://api.minimaxi.com/anthropic/v1/messages",
                        "apiKey":"",
                        "model":"fixture-model",
                    }],
                    "defaultProviderId":"minimax",
                    "defaultModel":"fixture-model",
                })
                .to_string(),
            )
            .unwrap();
        let active = state.db.current_active_account().unwrap();
        state
            .db
            .upsert_local_reference_account_api(LocalReferenceAccountApiUpsert {
                account_pool_id: active.id,
                account_id: "fixture-reference".to_string(),
                name: Some("收纳榜样".to_string()),
                followers: 8000,
                note_count: 20,
                avg_likes: 360.0,
                avg_comments: 12.0,
                avg_collects: 48.0,
                content_style: Some(
                    json!({"keywords":["实用","清晰"],"tone":"直接","hook":"数字清单"}).to_string(),
                ),
                top_notes: Vec::new(),
            })
            .unwrap();

        let missing_account = authorized_write(
            Method::POST,
            "/api/accounts/not-in-scope/imitate",
            Bytes::from(
                serde_json::to_vec(&json!({"note_title":"标题","note_likes":1234})).unwrap(),
            ),
        );
        assert_eq!(
            handle_request(missing_account, Arc::clone(&state))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );

        let request = authorized_write(
            Method::POST,
            "/api/accounts/fixture-reference/imitate",
            Bytes::from(
                serde_json::to_vec(&json!({
                    "note_title":"小户型三步做好收纳",
                    "note_likes":1234,
                    "item_title":"藤编柜",
                }))
                .unwrap(),
            ),
        );
        let response = handle_request(request, state).await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let error: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(error["detail"]
            .as_str()
            .unwrap()
            .starts_with("AI 生成失败："));
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(format_grouped_count(1_234_567), "1,234,567");
    }

    #[tokio::test]
    async fn reference_analysis_routes_stream_legacy_events_and_serve_cached_insights() {
        let (state, root) = test_state();
        state
            .db
            .set_app_setting(
                "model_api_settings_v1",
                &json!({
                    "providers":[{
                        "id":"minimax",
                        "kind":"anthropic-compatible",
                        "endpoint":"https://api.minimaxi.com/anthropic/v1/messages",
                        "apiKey":"",
                        "model":"fixture-model",
                    }],
                    "defaultProviderId":"minimax",
                    "defaultModel":"fixture-model",
                })
                .to_string(),
            )
            .unwrap();
        let active = state.db.current_active_account().unwrap();
        state
            .db
            .upsert_local_reference_account_api(LocalReferenceAccountApiUpsert {
                account_pool_id: active.id,
                account_id: "fixture-reference-analysis".to_string(),
                name: Some("榜样账号".to_string()),
                followers: 4321,
                note_count: 5,
                avg_likes: 321.0,
                avg_comments: 4.0,
                avg_collects: 8.0,
                content_style: None,
                top_notes: vec![],
            })
            .unwrap();
        state
            .db
            .store_local_reference_ai_result(
                active.id,
                "fixture-reference-analysis",
                "insights",
                "**[标题]**：给出具体收纳步骤",
            )
            .unwrap();

        let cached = get(
            Arc::clone(&state),
            "/api/accounts/fixture-reference-analysis/insights",
        )
        .await;
        assert_eq!(cached.status(), StatusCode::OK);
        let bytes = cached.into_body().collect().await.unwrap().to_bytes();
        let cached = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(cached.contains("\"cached\":true"));
        assert!(cached.contains("\"done\":true"));
        assert!(cached.contains("**[标题]**：给出具体收纳步骤"));

        let refresh = get(
            Arc::clone(&state),
            "/api/accounts/fixture-reference-analysis/insights?refresh=true",
        )
        .await;
        assert_eq!(refresh.status(), StatusCode::OK);
        let bytes = refresh.into_body().collect().await.unwrap().to_bytes();
        let refresh = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(refresh.contains("\"error\":\"该 Model API Provider 尚未配置 API Key\""));
        assert!(refresh.contains("data: [DONE]"));

        let analyze = authorized_write(
            Method::POST,
            "/api/accounts/fixture-reference-analysis/analyze",
            Bytes::new(),
        );
        let analyze = handle_request(analyze, state).await;
        assert_eq!(analyze.status(), StatusCode::OK);
        let bytes = analyze.into_body().collect().await.unwrap().to_bytes();
        let analyze = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(analyze.contains("\"error\":\"该 Model API Provider 尚未配置 API Key\""));
        assert!(analyze.contains("data: [DONE]"));
        assert_eq!(python_float_string(360.0), "360.0");
        assert_eq!(python_float_string(12.5), "12.5");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn analytics_routes_keep_legacy_shapes_for_published_notes() {
        let (state, root) = test_state();
        create_published_note(&state.db, "Fixture 标题测试", vec!["#家居".to_string()], 20);
        create_published_note(
            &state.db,
            "Fixture 第二条已发布笔记",
            vec!["#先行标签".to_string()],
            20,
        );
        let active_account_id = state.db.current_active_account().unwrap().id;
        state
            .db
            .record_local_crawl_log(active_account_id, "家居,收纳趋势,热门词", 3, None)
            .unwrap();
        let other_account_id = state
            .db
            .create_local_account(LocalAccountCreate {
                alias: "另一个运营账号".to_string(),
                role: "operation".to_string(),
                notes: None,
            })
            .unwrap();
        state.db.activate_account(other_account_id).unwrap();
        create_published_note(
            &state.db,
            "另一个账号的笔记",
            vec!["#不应串号标签".to_string()],
            1,
        );
        state
            .db
            .record_local_crawl_log(other_account_id, "不应串号", 1, None)
            .unwrap();
        state.db.activate_account(active_account_id).unwrap();

        let ranking = get(Arc::clone(&state), "/api/analytics/notes?sort=likes").await;
        let bytes = ranking.into_body().collect().await.unwrap().to_bytes();
        let ranking = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(ranking.as_array().unwrap().len(), 2);
        assert_eq!(ranking[0]["likes"], 20);
        assert_eq!(ranking[0]["engagement_rate"], 1.0);
        assert!(ranking[0].get("published_at").is_some());

        let summary = get(Arc::clone(&state), "/api/analytics/summary").await;
        let bytes = summary.into_body().collect().await.unwrap().to_bytes();
        let summary = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(summary["notes"]["total"], 2);
        assert_eq!(summary["notes"]["published_avg"]["likes"], 20.0);
        assert_eq!(summary["top_notes"].as_array().unwrap().len(), 2);

        let topics = get(Arc::clone(&state), "/api/analytics/topics").await;
        let bytes = topics.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            json!({"topics":[
                {"word":"家居","count":2},
                {"word":"先行标签","count":1},
                {"word":"收纳趋势","count":1},
                {"word":"热门词","count":1}
            ]})
        );

        let insights = get(Arc::clone(&state), "/api/analytics/insights").await;
        let bytes = insights.into_body().collect().await.unwrap().to_bytes();
        let insights = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(insights["comparison"]["mine"]["avg_likes"], 20.0);
        let insight_tags = insights["tag_freq"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["tag"].as_str())
            .collect::<Vec<_>>();
        assert!(insight_tags.contains(&"#家居"));
        assert!(insight_tags.contains(&"#先行标签"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn analytics_note_ranking_includes_rows_past_the_workspace_snapshot_limit() {
        let (state, root) = test_state();
        let account_id = state.db.current_active_account().unwrap().id;
        let mut conn = rusqlite::Connection::open(state.db.path()).unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO notes (id, title, status, likes, comments, collects, tags,
                                published_at, account_pool_id)
             VALUES (1, 'earliest published note', 'published', 10000, 100, 1,
                     '[\"共享标签\"]', datetime('now'), ?1)",
            [account_id],
        )
        .unwrap();
        {
            let mut insert = tx
                .prepare(
                    "INSERT INTO notes (title, status, likes, comments, collects, tags,
                                        published_at, account_pool_id)
                     VALUES (?1, 'published', 2, 2, 3, '[\"共享标签\"]', datetime('now'), ?2)",
                )
                .unwrap();
            for index in 0..5_000 {
                insert
                    .execute(rusqlite::params![
                        format!("published note {index}"),
                        account_id
                    ])
                    .unwrap();
            }
        }
        tx.commit().unwrap();

        let response = get(Arc::clone(&state), "/api/analytics/notes?sort=likes").await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let ranking = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(ranking.as_array().unwrap().len(), 5_001);
        assert_eq!(ranking[0]["id"], 1);
        assert_eq!(ranking[0]["likes"], 10000);

        let oldest_note = get(Arc::clone(&state), "/api/content/1").await;
        assert_eq!(oldest_note.status(), StatusCode::OK);
        let bytes = oldest_note.into_body().collect().await.unwrap().to_bytes();
        let oldest_note = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(oldest_note["title"], "earliest published note");

        let oldest_chat_context = build_legacy_chat_system(&state.db, Some(1), None, None).unwrap();
        assert!(oldest_chat_context.contains("earliest published note"));

        let (inspire_system, _) = build_legacy_inspire_prompt(
            &state.db,
            &LegacyInspireRequest {
                topic: "历史数据边界".to_string(),
                item_ids: Vec::new(),
                extra_image_desc: String::new(),
                account_ids: Vec::new(),
                extra_instruction: String::new(),
            },
        )
        .unwrap();
        assert!(inspire_system.contains("历史高赞帖常用标签：#共享标签"));

        let oldest_export = get(Arc::clone(&state), "/api/content/1/export").await;
        assert_eq!(oldest_export.status(), StatusCode::OK);
        let bytes = oldest_export
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let oldest_export = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert!(oldest_export["markdown"]
            .as_str()
            .unwrap()
            .contains("earliest published note"));

        let summary = get(Arc::clone(&state), "/api/analytics/summary").await;
        let bytes = summary.into_body().collect().await.unwrap().to_bytes();
        let summary = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(summary["notes"]["total"], 5_001);
        assert_eq!(summary["notes"]["published_avg"]["likes"], 4.0);
        assert_eq!(summary["top_notes"][0]["id"], 1);

        let insights = get(Arc::clone(&state), "/api/analytics/insights").await;
        let bytes = insights.into_body().collect().await.unwrap().to_bytes();
        let insights = serde_json::from_slice::<Value>(&bytes).unwrap();
        let title_count = insights["title_length_dist"]
            .as_array()
            .unwrap()
            .iter()
            .map(|bucket| bucket["count"].as_i64().unwrap())
            .sum::<i64>();
        assert_eq!(title_count, 5_001);
        assert_eq!(insights["comparison"]["mine"]["avg_likes"], 4.0);
        assert_eq!(insights["tag_freq"][0]["count"], 5_001);

        let trend = get(Arc::clone(&state), "/api/analytics/notes-trend").await;
        let bytes = trend.into_body().collect().await.unwrap().to_bytes();
        let trend = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(trend["items"][0]["count"], 5_001);
        assert_eq!(trend["items"][0]["total_likes"], 20_000);

        let rules = get(Arc::clone(&state), "/api/knowledge/rules").await;
        assert_eq!(rules.status(), StatusCode::OK);
        let bytes = rules.into_body().collect().await.unwrap().to_bytes();
        let rules = serde_json::from_slice::<Value>(&bytes).unwrap();
        let shared_tag = rules
            .as_array()
            .unwrap()
            .iter()
            .find(|rule| rule["key"] == "rule_tag_0")
            .unwrap();
        assert!(shared_tag["desc"]
            .as_str()
            .unwrap()
            .contains("出现 5001 次"));

        let comments_ranking = get(Arc::clone(&state), "/api/analytics/notes?sort=comments").await;
        let bytes = comments_ranking
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let comments_ranking = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_eq!(comments_ranking[0]["id"], 1);

        let collects_ranking = get(Arc::clone(&state), "/api/analytics/notes?sort=collects").await;
        let bytes = collects_ranking
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let collects_ranking = serde_json::from_slice::<Value>(&bytes).unwrap();
        assert_ne!(collects_ranking[0]["id"], 1);
        assert_eq!(collects_ranking[0]["collects"], 3);
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }
}
