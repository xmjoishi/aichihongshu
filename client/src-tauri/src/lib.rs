use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{App, Manager, RunEvent};

static BACKEND_CHILD: Lazy<Mutex<Option<Child>>> = Lazy::new(|| Mutex::new(None));

fn is_dev() -> bool {
    cfg!(debug_assertions)
}

fn candidate_uv_names() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        &["uv.exe", "uv"]
    } else {
        &["uv"]
    }
}

fn existing_path(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|path| path.exists()).cloned()
}

fn resource_roots(app: &App) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir.clone());
        if let Some(parent) = dir.parent() {
            roots.push(parent.to_path_buf());
            if let Some(grand) = parent.parent() {
                roots.push(grand.to_path_buf());
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
            if let Some(parent) = dir.parent() {
                roots.push(parent.to_path_buf());
            }
        }
    }
    roots
}

fn find_project_root(app: &App) -> Option<PathBuf> {
    resource_roots(app).into_iter().find(|root| root.join("app").exists() && root.join("crawler").exists())
}

fn find_uv(app: &App, project_root: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for name in candidate_uv_names() {
        candidates.push(project_root.join(".venv").join(if cfg!(target_os = "windows") { "Scripts" } else { "bin" }).join(name));
    }
    for root in resource_roots(app) {
        for name in candidate_uv_names() {
            candidates.push(root.join(name));
        }
    }
    existing_path(&candidates)
}

fn stop_backend() {
    let mut guard = BACKEND_CHILD.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *guard = None;
}

fn backend_log_path(app: &App) -> PathBuf {
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        return dir.join("backend.log");
    }
    std::env::temp_dir().join("aichihongshu-backend.log")
}

fn start_backend(app: &App) -> Result<(), String> {
    if is_dev() {
        return Ok(());
    }

    let project_root = find_project_root(app).ok_or_else(|| "未找到桌面版后端资源目录".to_string())?;
    let uv = find_uv(app, &project_root).ok_or_else(|| "未找到 uv，可执行文件未随应用打包".to_string())?;

    let mut cmd = Command::new(uv);
    let log_path = backend_log_path(app);
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("打开后端日志失败: {e}"))?;
    let err_file = log_file
        .try_clone()
        .map_err(|e| format!("复制后端日志句柄失败: {e}"))?;

    cmd.current_dir(&project_root)
        .env("RN_PROJECT_ROOT", &project_root)
        .args(["run", "python", "-m", "app.server", "--port", "8765"])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(err_file));

    let child = cmd.spawn().map_err(|e| format!("启动内置后端失败: {e}"))?;
    *BACKEND_CHILD.lock().unwrap() = Some(child);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Err(err) = start_backend(app) {
                eprintln!("[tauri] {err}");
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                stop_backend();
            }
        });
}
