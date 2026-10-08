//! Resolve the bundled Playwright worker paths for the Tauri application.

pub use aichihongshu_services::browser_worker::BrowserWorkerManager;
use aichihongshu_services::browser_worker::{BrowserWorkerConfig, WorkerCommand};
#[cfg(debug_assertions)]
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn create_for_app(app: &AppHandle) -> Result<BrowserWorkerManager, String> {
    #[cfg(not(debug_assertions))]
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("定位浏览器 worker 资源目录失败: {error}"))?;
    let app_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("定位浏览器会话目录失败: {error}"))?;
    let data_root = app_data_dir.join("browser-worker").join("sessions");

    #[cfg(debug_assertions)]
    let (node, worker_dir) = {
        let worker_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../browser-worker");
        let node = std::env::var_os("AICHIHONGSHU_NODE")
            .map(PathBuf::from)
            .map(WorkerCommand::ExactPath)
            .unwrap_or_else(|| WorkerCommand::SearchPath("node".into()));
        (node, worker_dir)
    };

    #[cfg(not(debug_assertions))]
    let (node, worker_dir) = {
        let worker_dir = resource_dir.join("browser-worker");
        #[cfg(target_os = "windows")]
        let node_path = worker_dir.join("runtime").join("node.exe");
        #[cfg(not(target_os = "windows"))]
        let node_path = worker_dir.join("runtime").join("node");
        (WorkerCommand::ExactPath(node_path), worker_dir)
    };

    BrowserWorkerManager::new(BrowserWorkerConfig {
        node,
        worker_dir,
        data_root,
    })
}
