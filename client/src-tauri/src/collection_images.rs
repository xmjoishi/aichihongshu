use crate::db::{BrowserCollectionImageSave, BrowserCollectionImageUpload, LocalDb};
use image::{ImageFormat, ImageReader, Limits};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_COLLECTION_BYTES: u64 = 32 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;

#[derive(Clone, Copy)]
enum ImageFetchPolicy {
    PublicHttps,
    #[cfg(test)]
    LoopbackFixture {
        port: u16,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionImageDownloadOutcome {
    pub position: i64,
    pub status: String,
    pub error: Option<String>,
}

/// Persist bytes received from the extension after verifying their declared
/// digest and decoding them through the same local thumbnail safety checks.
pub(crate) fn persist_extension_capture_image(
    db: &LocalDb,
    upload: &BrowserCollectionImageUpload,
) -> Result<(), String> {
    if upload.already_ready {
        return Ok(());
    }
    let bytes = db.read_browser_capture_image_upload(upload)?;
    let digest = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if digest != upload.sha256.to_ascii_lowercase() {
        return Err("原图摘要校验失败，未保存到剪藏".to_string());
    }
    let format = match upload.mime_type.as_str() {
        "image/jpeg" => ImageFormat::Jpeg,
        "image/png" => ImageFormat::Png,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::WebP,
        _ => return Err("原图格式不受支持，未保存到剪藏".to_string()),
    };
    let (thumbnail, width, height) = make_thumbnail(&bytes, format)?;
    db.save_browser_capture_image(BrowserCollectionImageSave {
        id: &upload.inspiration_id,
        account_pool_id: upload.account_pool_id,
        position: upload.position,
        expected_source_url: &upload.source_url,
        expected_request_id: Some(&upload.request_id),
        bytes: &bytes,
        mime_type: &upload.mime_type,
        thumbnail_bytes: &thumbnail,
        width,
        height,
    })
}

pub(crate) fn spawn_capture_downloads<R: tauri::Runtime + 'static>(
    app: AppHandle<R>,
    db: Arc<LocalDb>,
    inspiration_id: String,
    account_pool_id: i64,
    positions: Vec<i64>,
) {
    if positions.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        for position in positions {
            if let Err(error) = download_browser_collection_image_inner(
                Arc::clone(&db),
                inspiration_id.clone(),
                account_pool_id,
                position,
                Some(app.clone()),
                ImageFetchPolicy::PublicHttps,
            )
            .await
            {
                let retry_hint = "图片下载任务未完成初始化；可在收藏详情重试";
                eprintln!("[collection-images] capture download task failed at position {position}: {error}");
                let report_db = Arc::clone(&db);
                let report_id = inspiration_id.clone();
                let hint = retry_hint.to_string();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    report_db.report_browser_collection_image_prepare_error(
                        &report_id,
                        account_pool_id,
                        position,
                        &hint,
                    )
                })
                .await;
                let _ = app.emit(
                    "aichihongshu-collection-images-updated",
                    serde_json::json!({
                        "accountPoolId": account_pool_id,
                        "inspirationId": inspiration_id,
                        "position": position,
                        "status": "pending",
                        "error": retry_hint
                    }),
                );
            }
            let _ = app.emit(
                "aichihongshu-collection-images-updated",
                serde_json::json!({ "accountPoolId": account_pool_id, "inspirationId": inspiration_id }),
            );
        }
    });
}

pub(crate) async fn download_browser_collection_image(
    db: Arc<LocalDb>,
    inspiration_id: String,
    account_pool_id: i64,
    position: i64,
) -> Result<CollectionImageDownloadOutcome, String> {
    download_browser_collection_image_inner::<tauri::Wry>(
        db,
        inspiration_id,
        account_pool_id,
        position,
        None,
        ImageFetchPolicy::PublicHttps,
    )
    .await
}

#[cfg(test)]
async fn download_browser_collection_image_from_loopback_fixture(
    db: Arc<LocalDb>,
    inspiration_id: String,
    account_pool_id: i64,
    position: i64,
    port: u16,
) -> Result<CollectionImageDownloadOutcome, String> {
    download_browser_collection_image_inner::<tauri::Wry>(
        db,
        inspiration_id,
        account_pool_id,
        position,
        None,
        ImageFetchPolicy::LoopbackFixture { port },
    )
    .await
}

async fn download_browser_collection_image_inner<R: tauri::Runtime + 'static>(
    db: Arc<LocalDb>,
    inspiration_id: String,
    account_pool_id: i64,
    position: i64,
    progress_app: Option<AppHandle<R>>,
    fetch_policy: ImageFetchPolicy,
) -> Result<CollectionImageDownloadOutcome, String> {
    let claim_db = Arc::clone(&db);
    let id = inspiration_id.clone();
    let claim = tauri::async_runtime::spawn_blocking(move || {
        claim_db.claim_browser_collection_image(&id, account_pool_id, position)
    })
    .await
    .map_err(|error| format!("准备收藏图片下载失败: {error}"))??;
    if let Some(app) = progress_app.as_ref() {
        let _ = app.emit(
            "aichihongshu-collection-images-updated",
            serde_json::json!({
                "accountPoolId": account_pool_id,
                "inspirationId": inspiration_id,
                "requestId": claim.request_id,
                "position": position,
                "status": "downloading"
            }),
        );
    }

    let download = fetch_image(&claim.source_url, claim.ready_bytes, fetch_policy).await;
    match download {
        Ok(image) => {
            let persist_db = Arc::clone(&db);
            let id = inspiration_id.clone();
            let source_url = claim.source_url.clone();
            let request_id = claim.request_id.clone();
            let persist_result = tauri::async_runtime::spawn_blocking(move || {
                persist_db.save_browser_collection_image(BrowserCollectionImageSave {
                    id: &id,
                    account_pool_id,
                    position,
                    expected_source_url: &source_url,
                    expected_request_id: request_id.as_deref(),
                    bytes: &image.bytes,
                    mime_type: &image.mime_type,
                    thumbnail_bytes: &image.thumbnail,
                    width: image.width,
                    height: image.height,
                })
            })
            .await
            .map_err(|error| format!("等待收藏图片保存失败: {error}"))?;
            if let Err(error) = persist_result {
                let message = error.chars().take(500).collect::<String>();
                let fail_db = Arc::clone(&db);
                let id = inspiration_id.clone();
                let failed_source_url = claim.source_url.clone();
                let failed_request_id = claim.request_id.clone();
                let persisted_message = message.clone();
                let mark_result = tauri::async_runtime::spawn_blocking(move || {
                    fail_db.fail_browser_collection_image(
                        &id,
                        account_pool_id,
                        position,
                        &failed_source_url,
                        failed_request_id.as_deref(),
                        &persisted_message,
                    )
                })
                .await
                .map_err(|error| format!("等待收藏图片失败状态保存失败: {error}"))?;
                mark_result?;
                if let Some(app) = progress_app.as_ref() {
                    let _ = app.emit(
                        "aichihongshu-collection-images-updated",
                        serde_json::json!({
                            "accountPoolId": account_pool_id,
                            "inspirationId": inspiration_id,
                            "requestId": claim.request_id,
                            "position": position,
                            "status": "failed"
                        }),
                    );
                }
                return Ok(CollectionImageDownloadOutcome {
                    position,
                    status: "failed".to_string(),
                    error: Some(message),
                });
            }
            if let Some(app) = progress_app.as_ref() {
                let _ = app.emit(
                    "aichihongshu-collection-images-updated",
                    serde_json::json!({
                        "accountPoolId": account_pool_id,
                        "inspirationId": inspiration_id,
                        "requestId": claim.request_id,
                        "position": position,
                        "status": "ready"
                    }),
                );
            }
            Ok(CollectionImageDownloadOutcome {
                position,
                status: "ready".to_string(),
                error: None,
            })
        }
        Err(error) => {
            let message = user_safe_download_error(&error);
            let fail_db = Arc::clone(&db);
            let id = inspiration_id.clone();
            let failed_source_url = claim.source_url.clone();
            let failed_request_id = claim.request_id.clone();
            let persisted_message = message.clone();
            let mark_result = tauri::async_runtime::spawn_blocking(move || {
                fail_db.fail_browser_collection_image(
                    &id,
                    account_pool_id,
                    position,
                    &failed_source_url,
                    failed_request_id.as_deref(),
                    &persisted_message,
                )
            })
            .await
            .map_err(|error| format!("等待收藏图片失败状态保存失败: {error}"))?;
            mark_result?;
            if let Some(app) = progress_app.as_ref() {
                let _ = app.emit(
                    "aichihongshu-collection-images-updated",
                    serde_json::json!({
                        "accountPoolId": account_pool_id,
                        "inspirationId": inspiration_id,
                        "requestId": claim.request_id,
                        "position": position,
                        "status": "failed"
                    }),
                );
            }
            Ok(CollectionImageDownloadOutcome {
                position,
                status: "failed".to_string(),
                error: Some(message),
            })
        }
    }
}

struct DownloadedImage {
    bytes: Vec<u8>,
    mime_type: String,
    thumbnail: Vec<u8>,
    width: u32,
    height: u32,
}

async fn fetch_image(
    raw_url: &str,
    already_saved: u64,
    policy: ImageFetchPolicy,
) -> Result<DownloadedImage, String> {
    if already_saved >= MAX_COLLECTION_BYTES {
        return Err("单条收藏的本地图片总量已达到 32MB 限制".to_string());
    }
    let mut url = parse_image_url(raw_url, policy)?;
    for redirect_count in 0..=MAX_REDIRECTS {
        let host = url
            .host_str()
            .ok_or_else(|| "图片链接缺少主机名".to_string())?
            .to_string();
        let mut client_builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(6))
            .timeout(Duration::from_secs(20));
        let request_url = match policy {
            ImageFetchPolicy::PublicHttps => {
                let pinned_ip = resolve_public_host(host.clone()).await?;
                client_builder = client_builder.resolve(&host, SocketAddr::new(pinned_ip, 443));
                url.clone()
            }
            #[cfg(test)]
            ImageFetchPolicy::LoopbackFixture { port } => {
                parse_loopback_fixture_source_url(url.as_str())?;
                let mut local_url = url.clone();
                local_url
                    .set_scheme("http")
                    .map_err(|_| "本地图片测试地址无效".to_string())?;
                local_url
                    .set_host(Some("127.0.0.1"))
                    .map_err(|_| "本地图片测试地址无效".to_string())?;
                local_url
                    .set_port(Some(port))
                    .map_err(|_| "本地图片测试地址无效".to_string())?;
                local_url
            }
        };
        let client = client_builder
            .build()
            .map_err(|error| format!("创建图片下载连接失败: {error}"))?;
        let mut response = client
            .get(request_url)
            .header(
                reqwest::header::ACCEPT,
                "image/jpeg,image/png,image/gif,image/webp,*/*;q=0.5",
            )
            .header(
                reqwest::header::USER_AGENT,
                "AichiHongshu/1.0 collection-image",
            )
            .send()
            .await
            .map_err(|error| format!("图片请求失败: {error}"))?;
        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err("图片重定向次数过多".to_string());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "图片重定向缺少有效目标".to_string())?;
            url = parse_image_url(
                url.join(location)
                    .map_err(|_| "图片重定向地址无效".to_string())?
                    .as_str(),
                policy,
            )?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "图片服务器返回 HTTP {}",
                response.status().as_u16()
            ));
        }
        let content_length = response.content_length();
        let remaining = (MAX_COLLECTION_BYTES - already_saved).min(MAX_IMAGE_BYTES as u64);
        if content_length.is_some_and(|size| size == 0 || size > remaining) {
            return Err("图片响应大小超过本地收藏限制".to_string());
        }
        let mime_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .unwrap_or("")
            .to_ascii_lowercase();
        let format = match mime_type.as_str() {
            "image/jpeg" => ImageFormat::Jpeg,
            "image/png" => ImageFormat::Png,
            "image/gif" => ImageFormat::Gif,
            "image/webp" => ImageFormat::WebP,
            _ => return Err("图片响应类型不受支持，未保存到本地".to_string()),
        };
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("读取图片响应失败: {error}"))?
        {
            if bytes.len().saturating_add(chunk.len()) > remaining as usize {
                return Err("图片实际大小超过本地收藏限制".to_string());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() || content_length.is_some_and(|size| size != bytes.len() as u64) {
            return Err("图片响应长度无效或下载不完整".to_string());
        }
        let (thumbnail, width, height) = make_thumbnail(&bytes, format)?;
        return Ok(DownloadedImage {
            bytes,
            mime_type,
            thumbnail,
            width,
            height,
        });
    }
    Err("图片下载失败".to_string())
}

fn parse_image_url(raw: &str, policy: ImageFetchPolicy) -> Result<reqwest::Url, String> {
    match policy {
        ImageFetchPolicy::PublicHttps => parse_public_image_url(raw),
        #[cfg(test)]
        ImageFetchPolicy::LoopbackFixture { .. } => parse_loopback_fixture_source_url(raw),
    }
}

#[cfg(test)]
fn parse_loopback_fixture_source_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "本地图片测试地址无效".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("cdn.fixture.invalid")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("本地图片 fixture 仅接受 cdn.fixture.invalid 的标准 HTTPS 地址".to_string());
    }
    Ok(url)
}

fn parse_public_image_url(raw: &str) -> Result<reqwest::Url, String> {
    if raw.len() > 2_000 || raw.chars().any(char::is_control) {
        return Err("图片链接无效".to_string());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "图片链接无效".to_string())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("只允许标准 HTTPS 图片链接".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "图片链接缺少主机名".to_string())?;
    if host.is_empty()
        || host.ends_with('.')
        || host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host.to_ascii_lowercase().ends_with(".local")
        || host.to_ascii_lowercase().ends_with(".internal")
    {
        return Err("图片链接主机名不允许访问".to_string());
    }
    if let Ok(address) = host.parse::<IpAddr>() {
        if !is_public_ip(address) {
            return Err("图片链接指向非公开网络地址".to_string());
        }
    }
    Ok(url)
}

async fn resolve_public_host(host: String) -> Result<IpAddr, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(ip) = host.parse::<IpAddr>() {
            return is_public_ip(ip)
                .then_some(ip)
                .ok_or_else(|| "图片链接指向非公开网络地址".to_string());
        }
        let addresses = (host.as_str(), 443)
            .to_socket_addrs()
            .map_err(|_| "图片链接主机无法解析".to_string())?
            .map(|address| address.ip())
            .collect::<Vec<_>>();
        if addresses.is_empty() || addresses.iter().any(|ip| !is_public_ip(*ip)) {
            return Err("图片链接主机解析到非公开网络地址，已拒绝".to_string());
        }
        addresses
            .into_iter()
            .next()
            .ok_or_else(|| "图片链接主机无法解析".to_string())
    })
    .await
    .map_err(|error| format!("等待图片主机校验失败: {error}"))?
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, d] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224
                || (a == 255 && b == 255 && c == 255 && d == 255))
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            // Global unicast only; exclude documentation prefix 2001:db8::/32.
            (segments[0] & 0xe000) == 0x2000 && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        }
    }
}

fn make_thumbnail(bytes: &[u8], expected: ImageFormat) -> Result<(Vec<u8>, u32, u32), String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "图片文件头无效".to_string())?;
    if reader.format() != Some(expected) {
        return Err("图片内容与响应 MIME 类型不匹配".to_string());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| "图片无法解码，未保存到本地".to_string())?;
    let (width, height) = (image.width(), image.height());
    if width == 0 || height == 0 || width > 20_000 || height > 20_000 {
        return Err("图片像素尺寸超出收藏限制".to_string());
    }
    let thumb = image.thumbnail(640, 960).to_rgb8();
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(thumb)
        .write_to(&mut output, ImageFormat::Jpeg)
        .map_err(|_| "生成收藏缩略图失败".to_string())?;
    let thumbnail = output.into_inner();
    if thumbnail.is_empty() || thumbnail.len() > 4 * 1024 * 1024 {
        return Err("收藏缩略图大小无效".to_string());
    }
    Ok((thumbnail, width, height))
}

fn user_safe_download_error(error: &str) -> String {
    if error.contains("HTTP 401") || error.contains("HTTP 403") || error.contains("HTTP 404") {
        return "图片链接已失效或站点拒绝直接下载；请回到原文重新采集后重试".to_string();
    }
    if error.to_ascii_lowercase().contains("timeout") || error.contains("超时") {
        return "图片下载超时；正文已保存，可以只重试这张图片".to_string();
    }
    error.chars().take(500).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        BrowserCaptureImageUploadStart, LocalAccountCreate, LocalDb, LocalInspirationCreate,
    };
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread::{self, JoinHandle};
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    #[test]
    fn decodes_supported_images_and_builds_independent_jpeg_thumbnails() {
        let image = image::DynamicImage::new_rgb8(12, 20);
        let mut png = Cursor::new(Vec::new());
        image
            .write_to(&mut png, ImageFormat::Png)
            .expect("encode PNG fixture");
        let (thumbnail, width, height) =
            make_thumbnail(png.get_ref(), ImageFormat::Png).expect("decode PNG fixture");
        assert_eq!((width, height), (12, 20));
        assert!(thumbnail.starts_with(&[0xff, 0xd8, 0xff]));
        assert!(make_thumbnail(png.get_ref(), ImageFormat::Jpeg).is_err());
        assert!(make_thumbnail(b"not an image", ImageFormat::Png).is_err());
    }

    #[test]
    fn extension_transfers_selected_original_bytes_into_offline_local_images() {
        let directory = std::env::temp_dir().join(format!(
            "aichihongshu-extension-image-e2e-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("create isolated fixture directory");
        let database_path = directory.join("isolated.db");
        let db = LocalDb::open(database_path.clone()).expect("open isolated database");
        let account_id = db
            .create_local_account(LocalAccountCreate {
                alias: "扩展原图直传隔离账号".to_string(),
                role: "operation".to_string(),
                notes: Some("temporary extension byte transfer fixture".to_string()),
            })
            .expect("create isolated local account");
        db.set_app_setting("active_account_id", &account_id.to_string())
            .expect("activate isolated local account");

        for selected_count in [1_usize, 4] {
            let request_id = format!("extension-offline-{selected_count}-images");
            let inspiration_id = format!("bc:{account_id}:{request_id}");
            db.save_browser_capture_inspiration(LocalInspirationCreate {
                id: inspiration_id.clone(),
                account_pool_id: account_id,
                title: format!("{selected_count} 张图片的隔离剪藏"),
                source_url: "https://www.xiaohongshu.com/explore/offline-fixture".to_string(),
                body: "原图字节直接从扩展传入，不依赖在线 URL。".to_string(),
                observed_at: "2026-10-04T10:00:00Z".to_string(),
                reason: String::new(),
                dedupe_key: None,
                material_type: Some("note_material".to_string()),
                author: Some("isolated fixture author".to_string()),
                capture_modules: Some(vec!["images".to_string()]),
            })
            .expect("save fixture clipping text");
            let selected_images = (0..selected_count)
                .map(|position| {
                    serde_json::json!({
                        "url": format!("https://cdn.fixture.invalid/{request_id}-{position}.png"),
                        "order": position
                    })
                })
                .collect::<Vec<_>>();
            let payload =
                serde_json::json!({"images": selected_images, "comments": []}).to_string();
            db.save_browser_capture_payload(&inspiration_id, account_id, &payload)
                .expect("save selected image metadata");
            db.register_browser_capture_request(account_id, &request_id, &inspiration_id, true)
                .expect("register original capture request id");
            assert_eq!(
                db.browser_collection_image_positions(&inspiration_id, account_id)
                    .expect("hydrate selected image positions"),
                (0..selected_count as i64).collect::<Vec<_>>()
            );

            for position in 0..selected_count {
                let image = image::RgbImage::from_fn(40, 48, |x, y| {
                    image::Rgb([
                        ((x + position as u32 * 31) % 256) as u8,
                        ((y + position as u32 * 47) % 256) as u8,
                        ((x + y + position as u32 * 61) % 256) as u8,
                    ])
                });
                let mut encoded = Cursor::new(Vec::new());
                image::DynamicImage::ImageRgb8(image)
                    .write_to(&mut encoded, ImageFormat::Png)
                    .expect("encode selected original image bytes");
                let original = encoded.into_inner();
                let digest = format!("{:x}", Sha256::digest(&original));
                let begun = db
                    .begin_browser_capture_image_upload(BrowserCaptureImageUploadStart {
                        id: &inspiration_id,
                        account_pool_id: account_id,
                        position: position as i64,
                        request_id: &request_id,
                        total_bytes: original.len(),
                        sha256: &digest,
                        mime_type: "image/png",
                    })
                    .expect("begin direct byte transfer");
                assert_eq!(begun.next_offset, 0);
                assert!(!begun.already_ready);

                let split = (original.len() / 2).max(1);
                let first_ack = db
                    .append_browser_capture_image_upload_chunk(
                        &inspiration_id,
                        account_id,
                        position as i64,
                        &request_id,
                        0,
                        &original[..split],
                    )
                    .expect("durably write first ordered chunk");
                assert_eq!(first_ack.next_offset, split);
                if selected_count == 4 && position == 2 {
                    db.fail_browser_capture_image_upload(
                        &inspiration_id,
                        account_id,
                        position as i64,
                        &request_id,
                        "fixture interrupted after the first acknowledged chunk",
                    )
                    .expect("record only this image as failed");
                    let partial = db
                        .lookup_browser_capture_request(account_id, &request_id)
                        .expect("read the original request after partial transfer");
                    assert_eq!(partial.images_total, 4);
                    assert_eq!(partial.images_ready, 2);
                    assert_eq!(partial.images_failed, 1);
                    let retry = db
                        .begin_browser_capture_image_upload(BrowserCaptureImageUploadStart {
                            id: &inspiration_id,
                            account_pool_id: account_id,
                            position: position as i64,
                            request_id: &request_id,
                            total_bytes: original.len(),
                            sha256: &digest,
                            mime_type: "image/png",
                        })
                        .expect("retry the failed image under its original identity");
                    assert_eq!(retry.next_offset, 0);
                    let retry_first = db
                        .append_browser_capture_image_upload_chunk(
                            &inspiration_id,
                            account_id,
                            position as i64,
                            &request_id,
                            0,
                            &original[..split],
                        )
                        .expect("retry the first chunk from offset zero");
                    assert_eq!(retry_first.next_offset, split);
                }
                let final_ack = db
                    .append_browser_capture_image_upload_chunk(
                        &inspiration_id,
                        account_id,
                        position as i64,
                        &request_id,
                        split,
                        &original[split..],
                    )
                    .expect("durably write final ordered chunk");
                assert_eq!(final_ack.next_offset, original.len());

                let upload = db
                    .complete_browser_capture_image_upload(
                        &inspiration_id,
                        account_id,
                        position as i64,
                        &request_id,
                    )
                    .expect("verify complete upload state");
                persist_extension_capture_image(&db, &upload)
                    .expect("verify digest and safely persist original plus thumbnail");
                db.finish_browser_capture_image_upload(
                    &inspiration_id,
                    account_id,
                    position as i64,
                    &request_id,
                )
                .expect("finish original upload after local persistence");

                let original_data_url = db
                    .read_browser_collection_image(
                        &inspiration_id,
                        account_id,
                        position as i64,
                        false,
                    )
                    .expect("read image from local managed storage");
                assert!(original_data_url.starts_with("data:image/png;base64,"));
                let local_bytes = STANDARD
                    .decode(
                        original_data_url
                            .split_once(',')
                            .expect("data URL payload")
                            .1,
                    )
                    .expect("decode local original");
                assert_eq!(local_bytes, original, "selected order position {position}");
            }

            let status = db
                .lookup_browser_capture_request(account_id, &request_id)
                .expect("read completed image counts by original request id");
            assert_eq!(status.images_total, selected_count);
            assert_eq!(status.images_ready, selected_count);
            assert_eq!(status.images_failed, 0);
        }

        drop(db);
        let reopened = LocalDb::open(database_path).expect("reopen local clipping DB offline");
        reopened
            .set_app_setting("active_account_id", &account_id.to_string())
            .expect("restore isolated account context");
        let clippings = reopened
            .local_inspirations(Some(account_id))
            .expect("read clippings after offline reopen");
        assert_eq!(clippings.len(), 2);
        for clipping in &clippings {
            assert!(clipping
                .collection_images
                .iter()
                .all(|image| image.status == "ready"
                    && image.source_kind == "extension_bytes"
                    && image.original_available
                    && image.thumbnail_available));
            for image in &clipping.collection_images {
                assert!(reopened
                    .read_browser_collection_image(&clipping.id, account_id, image.position, true,)
                    .expect("read local thumbnail without network")
                    .starts_with("data:image/jpeg;base64,"));
            }
        }
        drop(reopened);
        std::fs::remove_dir_all(&directory).expect("remove isolated fixture database and assets");
    }

    #[test]
    fn public_address_filter_rejects_private_and_reserved_ranges() {
        for address in [
            "127.0.0.1",
            "10.2.3.4",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.2",
            "100.64.0.1",
            "198.51.100.4",
            "203.0.113.9",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            let ip = address.parse().unwrap();
            assert!(!is_public_ip(ip), "{address} should not be public");
        }
        for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            let ip = address.parse().unwrap();
            assert!(is_public_ip(ip), "{address} should be public");
        }
    }

    #[test]
    fn image_url_gate_requires_standard_public_https() {
        for url in [
            "http://example.com/image.jpg",
            "https://127.0.0.1/image.jpg",
            "https://example.local/image.jpg",
            "https://example.com:444/image.jpg",
            "https://user:pass@example.com/image.jpg",
        ] {
            assert!(parse_public_image_url(url).is_err(), "{url}");
        }
        assert!(parse_public_image_url("https://example.com/image.jpg").is_ok());
    }

    #[test]
    fn downloads_four_selected_images_handles_redirect_chunks_retry_and_offline_reopen() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut image_buffer = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(18, 26)
            .write_to(&mut image_buffer, ImageFormat::Png)
            .expect("encode PNG fixture");
        let png_bytes = image_buffer.into_inner();
        let (port, requests, failures, server) = spawn_loopback_image_fixture(png_bytes.clone());
        let fixture = "https://cdn.fixture.invalid/";
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "aichihongshu-collection-http-fixture-{}-{now}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).expect("create isolated fixture directory");
        let database_path = directory.join("isolated.db");
        let db = Arc::new(LocalDb::open(database_path.clone()).expect("open isolated database"));
        let account_id = db
            .create_local_account(LocalAccountCreate {
                alias: "隔离图片下载验收".to_string(),
                role: "operation".to_string(),
                notes: Some("temporary local HTTP fixture".to_string()),
            })
            .expect("create isolated test account");
        db.set_app_setting("active_account_id", &account_id.to_string())
            .expect("activate isolated test account");
        let request_id = "four-image-loopback-fixture";
        let inspiration_id = format!("bc:{account_id}:{request_id}");
        db.save_browser_capture_inspiration(LocalInspirationCreate {
            id: inspiration_id.clone(),
            account_pool_id: account_id,
            title: "本地图片端到端 fixture".to_string(),
            source_url: "https://www.xiaohongshu.com/explore/local-http-fixture".to_string(),
            body: "临时数据库内的隔离正文".to_string(),
            observed_at: "2026-10-04T10:00:00Z".to_string(),
            reason: String::new(),
            dedupe_key: None,
            material_type: Some("note_material".to_string()),
            author: Some("fixture author".to_string()),
            capture_modules: Some(vec!["images".to_string()]),
        })
        .expect("save fixture collection text first");
        let image_urls = [
            format!("{fixture}redirect"),
            format!("{fixture}chunked-one"),
            format!("{fixture}fail-once"),
            format!("{fixture}chunked-four"),
        ];
        let payload = serde_json::json!({
            "images": image_urls.iter().enumerate().map(|(order, url)| {
                serde_json::json!({"url": url, "order": order})
            }).collect::<Vec<_>>(),
            "comments": []
        })
        .to_string();
        db.save_browser_capture_payload(&inspiration_id, account_id, &payload)
            .expect("persist four selected fixture image references");
        assert_eq!(
            db.local_inspirations(Some(account_id))
                .expect("read pending fixture collection")[0]
                .collection_images
                .len(),
            4
        );

        let db_for_downloads = Arc::clone(&db);
        let first_pass = tauri::async_runtime::block_on(async {
            let mut results = Vec::new();
            for position in 0..4 {
                results.push(
                    download_browser_collection_image_from_loopback_fixture(
                        Arc::clone(&db_for_downloads),
                        inspiration_id.clone(),
                        account_id,
                        position,
                        port,
                    )
                    .await
                    .expect("run fixture download"),
                );
            }
            results
        });
        assert!(
            first_pass.iter().all(|result| {
                if result.position == 2 {
                    result.status == "failed"
                } else {
                    result.status == "ready"
                }
            }),
            "unexpected first-pass local fixture outcomes: {first_pass:?}"
        );
        let partial = db
            .local_inspirations(Some(account_id))
            .expect("read partial fixture result");
        assert_eq!(
            partial[0]
                .collection_images
                .iter()
                .filter(|image| image.status == "ready")
                .count(),
            3
        );
        assert_eq!(
            partial[0]
                .collection_images
                .iter()
                .filter(|image| image.status == "failed")
                .count(),
            1
        );
        let retry = tauri::async_runtime::block_on(
            download_browser_collection_image_from_loopback_fixture(
                Arc::clone(&db),
                inspiration_id.clone(),
                account_id,
                2,
                port,
            ),
        )
        .expect("retry failed image using the same collection and requestId");
        assert_eq!(retry.status, "ready");
        let complete = db
            .local_inspirations(Some(account_id))
            .expect("read all fixture images");
        assert!(complete[0]
            .collection_images
            .iter()
            .all(|image| image.status == "ready"
                && image.original_available
                && image.thumbnail_available));
        assert_eq!(
            complete[0]
                .collection_images
                .iter()
                .map(|image| image.position)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
        assert_eq!(failures.load(Ordering::SeqCst), 2);
        assert_eq!(requests.load(Ordering::SeqCst), 6);
        server
            .join()
            .expect("fixture server completed its six local requests");

        let request_count_before_reopen = requests.load(Ordering::SeqCst);
        drop(db);
        let reopened = LocalDb::open(database_path).expect("reopen isolated database offline");
        let after_reopen = reopened
            .local_inspirations(Some(account_id))
            .expect("read localized images after database reopen");
        assert_eq!(after_reopen[0].collection_images.len(), 4);
        for position in 0..4 {
            assert_eq!(
                after_reopen[0].collection_images[position].position,
                position as i64
            );
            let original = reopened
                .read_browser_collection_image(&inspiration_id, account_id, position as i64, false)
                .expect("read locally stored original");
            let thumbnail = reopened
                .read_browser_collection_image(&inspiration_id, account_id, position as i64, true)
                .expect("read locally stored thumbnail");
            assert!(original.starts_with("data:image/png;base64,"));
            assert!(thumbnail.starts_with("data:image/jpeg;base64,"));
            let original_bytes = STANDARD
                .decode(original.split_once(',').expect("original data URL").1)
                .expect("decode stored original");
            let thumbnail_bytes = STANDARD
                .decode(thumbnail.split_once(',').expect("thumbnail data URL").1)
                .expect("decode stored thumbnail");
            assert_eq!(original_bytes, png_bytes);
            let decoded_thumbnail = image::load_from_memory(&thumbnail_bytes)
                .expect("decode independently stored JPEG thumbnail");
            assert!(decoded_thumbnail.width() <= 640 && decoded_thumbnail.height() <= 960);
            let thumbnail_ratio =
                decoded_thumbnail.width() as f32 / decoded_thumbnail.height() as f32;
            let original_ratio = 18.0_f32 / 26.0_f32;
            assert!((thumbnail_ratio - original_ratio).abs() < 0.01);
        }
        assert_eq!(requests.load(Ordering::SeqCst), request_count_before_reopen);
        drop(reopened);
        std::fs::remove_dir_all(&directory).expect("remove isolated fixture database and assets");
    }

    fn spawn_loopback_image_fixture(
        png_bytes: Vec<u8>,
    ) -> (u16, Arc<AtomicUsize>, Arc<AtomicUsize>, JoinHandle<()>) {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback-only HTTP fixture");
        listener
            .set_nonblocking(true)
            .expect("set bounded fixture listener");
        let port = listener.local_addr().expect("fixture address").port();
        let requests = Arc::new(AtomicUsize::new(0));
        let failures = Arc::new(AtomicUsize::new(0));
        let request_count = Arc::clone(&requests);
        let failed_image_count = Arc::clone(&failures);
        let server = thread::spawn(move || {
            for _ in 0..6 {
                let deadline = Instant::now() + Duration::from_secs(15);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                Instant::now() < deadline,
                                "timed out waiting for local fixture request"
                            );
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("accept local fixture request: {error}"),
                    }
                };
                stream
                    .set_nonblocking(false)
                    .expect("set accepted fixture stream to blocking mode");
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .expect("set fixture request timeout");
                let path =
                    read_fixture_request_path(&mut stream).expect("read local fixture request");
                request_count.fetch_add(1, Ordering::SeqCst);
                if path == "/redirect" {
                    stream
                        .write_all(b"HTTP/1.1 302 Found\r\nLocation: /redirect-target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .expect("write local redirect response");
                } else if path == "/fail-once"
                    && failed_image_count.fetch_add(1, Ordering::SeqCst) == 0
                {
                    stream
                        .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .expect("write local retryable error response");
                } else {
                    write_chunked_png(&mut stream, &png_bytes).expect("write chunked PNG response");
                }
            }
        });
        (port, requests, failures, server)
    }

    fn read_fixture_request_path(stream: &mut TcpStream) -> std::io::Result<String> {
        let mut request = Vec::new();
        let mut buffer = [0u8; 512];
        loop {
            let read = stream.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") || request.len() > 16 * 1024 {
                break;
            }
        }
        let first_line = String::from_utf8_lossy(&request)
            .lines()
            .next()
            .unwrap_or_default()
            .to_string();
        Ok(first_line
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_string())
    }

    fn write_chunked_png(stream: &mut TcpStream, png_bytes: &[u8]) -> std::io::Result<()> {
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")?;
        for chunk in png_bytes.chunks(19) {
            write!(stream, "{:X}\r\n", chunk.len())?;
            stream.write_all(chunk)?;
            stream.write_all(b"\r\n")?;
        }
        stream.write_all(b"0\r\n\r\n")
    }
}
