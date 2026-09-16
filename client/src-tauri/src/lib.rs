mod db;

use serde::Serialize;
use std::path::PathBuf;
use tauri::{Manager, State};

struct AppState {
    db: db::LocalDb,
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
fn read_status(state: State<'_, AppState>) -> Result<db::WorkspaceSnapshot, String> {
    state
        .db
        .snapshot()
        .map_err(|error| format!("读取本地工作区失败: {error}"))
}

/// 读取当前运营账号隔离范围内的图片，避免桌面端依赖旧 Python HTTP 图片接口。
#[tauri::command]
fn read_local_image(state: State<'_, AppState>, item_id: i64) -> Result<Option<String>, String> {
    state.db.image_data_url(item_id)
}

/// 创建一个属于当前运营账号的本地草稿，用于验证 Rust SQLite 写入和账号池边界。
#[tauri::command]
fn create_local_draft(
    state: State<'_, AppState>,
    title: String,
) -> Result<db::NoteSummary, String> {
    state
        .db
        .create_local_draft(&title)
        .map_err(|error| format!("创建本地草稿失败: {error}"))
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
            app.manage(AppState { db });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            read_status,
            read_local_image,
            create_local_draft,
            read_account_pool,
            activate_local_account
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, _| {});
}
