//! Explicitly unavailable on platforms without the Unix capture transport.
use serde::Serialize;
#[cfg(debug_assertions)]
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const UNSUPPORTED: &str = "浏览器扩展采集暂不支持此操作系统";

#[derive(Serialize)]
pub struct BrowserCaptureStatus {}

pub fn status() -> Result<BrowserCaptureStatus, String> {
    Err(UNSUPPORTED.into())
}
pub fn install_for_browser(_: &str) -> Result<String, String> {
    Err(UNSUPPORTED.into())
}
pub fn copy_extension_dir() -> Result<String, String> {
    Err(UNSUPPORTED.into())
}
pub fn copy_extension_path() -> Result<String, String> {
    Err(UNSUPPORTED.into())
}
pub fn open_extension_dir() -> Result<String, String> {
    Err(UNSUPPORTED.into())
}
pub fn open_extensions_page(_: &str) -> Result<String, String> {
    Err(UNSUPPORTED.into())
}
pub fn test_link() -> Result<Vec<(String, bool, String)>, String> {
    Err(UNSUPPORTED.into())
}
pub fn detect_browsers() -> Vec<String> {
    Vec::new()
}
pub fn spawn(_: AppHandle) {}
#[cfg(debug_assertions)]
pub fn write_native_host_test_fixture(_: &Path) -> Result<PathBuf, String> {
    Err(UNSUPPORTED.into())
}
