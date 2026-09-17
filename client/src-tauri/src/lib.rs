mod db;

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    db: db::LocalDb,
    ai_processes: Arc<Mutex<HashMap<String, Child>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAIProviderStatus {
    id: String,
    label: String,
    kind: &'static str,
    state: String,
    version: Option<String>,
    text: bool,
    image: bool,
    tools: bool,
    cancel: bool,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAIEvent {
    run_id: String,
    text: Option<String>,
    error: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAIRunRequest {
    run_id: String,
    provider: String,
    prompt: String,
}

fn local_ai_specs() -> [(&'static str, &'static str); 3] {
    [
        ("claude", "Claude CLI"),
        ("codex", "Codex CLI"),
        ("opencode", "OpenCode CLI"),
    ]
}

fn extract_cli_version(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(output);
    text.split_whitespace()
        .find(|part| {
            let value = part.trim_start_matches('v');
            value.split('.').count() >= 2
                && value
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_digit())
        })
        .map(|part| {
            part.trim_start_matches('v')
                .trim_matches(|c: char| {
                    !c.is_ascii_alphanumeric() && c != '.' && c != '-' && c != '+'
                })
                .to_string()
        })
}

fn probe_local_ai_provider(id: &str, label: &str) -> LocalAIProviderStatus {
    let result = Command::new(id)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    match result {
        Ok(output) if output.status.success() => LocalAIProviderStatus {
            id: id.to_string(),
            label: label.to_string(),
            kind: "cli",
            state: "present".to_string(),
            version: extract_cli_version(&[output.stdout, output.stderr].concat()),
            // Installation is only a discovery signal. These become verified only
            // after a real prompt returns text; image/tools are never implied here.
            text: false,
            image: false,
            tools: false,
            cancel: false,
            reason: "已发现 CLI；尚未完成一次真实文本调用，能力保持未验证".to_string(),
        },
        Ok(output) => LocalAIProviderStatus {
            id: id.to_string(),
            label: label.to_string(),
            kind: "cli",
            state: "failed".to_string(),
            version: None,
            text: false,
            image: false,
            tools: false,
            cancel: false,
            reason: format!("--version 退出码 {}", output.status.code().unwrap_or(-1)),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => LocalAIProviderStatus {
            id: id.to_string(),
            label: label.to_string(),
            kind: "cli",
            state: "missing".to_string(),
            version: None,
            text: false,
            image: false,
            tools: false,
            cancel: false,
            reason: "未安装或不在当前桌面进程 PATH 中".to_string(),
        },
        Err(error) => LocalAIProviderStatus {
            id: id.to_string(),
            label: label.to_string(),
            kind: "cli",
            state: "failed".to_string(),
            version: None,
            text: false,
            image: false,
            tools: false,
            cancel: false,
            reason: format!("检测失败: {error}"),
        },
    }
}

#[tauri::command]
fn probe_local_ai_providers() -> Vec<LocalAIProviderStatus> {
    local_ai_specs()
        .into_iter()
        .map(|(id, label)| probe_local_ai_provider(id, label))
        .collect()
}

fn command_for_provider(provider: &str, prompt: &str) -> Result<Command, String> {
    let mut command = match provider {
        // All three invocations are non-interactive prompt modes. No shell is used,
        // so prompt text cannot become a second command.
        "claude" => {
            let mut command = Command::new("claude");
            command.args(["-p", prompt, "--output-format", "text"]);
            command
        }
        "codex" => {
            let mut command = Command::new("codex");
            command.args(["exec", "--color", "never", "--skip-git-repo-check", prompt]);
            command
        }
        "opencode" => {
            let mut command = Command::new("opencode");
            command.args(["run", prompt]);
            command
        }
        _ => return Err(format!("不支持的本地 AI Provider: {provider}")),
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(command)
}

#[tauri::command]
fn start_local_ai(
    app: AppHandle,
    state: State<'_, AppState>,
    request: LocalAIRunRequest,
) -> Result<(), String> {
    if request.run_id.trim().is_empty() || request.run_id.len() > 120 {
        return Err("本地 AI 运行 ID 无效".to_string());
    }
    if request.prompt.trim().is_empty() || request.prompt.len() > 64_000 {
        return Err("本地 AI 提示词为空或超过 64000 字符".to_string());
    }
    {
        let processes = state
            .ai_processes
            .lock()
            .map_err(|_| "本地 AI 进程锁不可用")?;
        if processes.contains_key(&request.run_id) {
            return Err("本地 AI 运行 ID 已存在".to_string());
        }
    }
    let mut child = command_for_provider(&request.provider, &request.prompt)?
        .spawn()
        .map_err(|error| format!("启动 {} CLI 失败: {error}", request.provider))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("本地 AI CLI 未提供 stdout".to_string());
        }
    };
    let stderr = child.stderr.take();
    let run_id = request.run_id.clone();
    {
        let mut processes = state
            .ai_processes
            .lock()
            .map_err(|_| "本地 AI 进程锁不可用")?;
        if processes.contains_key(&run_id) {
            drop(processes);
            let _ = child.kill();
            let _ = child.wait();
            return Err("本地 AI 运行 ID 已存在".to_string());
        }
        processes.insert(run_id.clone(), child);
    }
    let processes = app.state::<AppState>().ai_processes.clone();
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut sink = String::new();
            let _ = reader.read_to_string(&mut sink);
        });
    }
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut emitted = false;
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let text = line.trim_end_matches(['\r', '\n']).to_string();
                    if !text.is_empty() {
                        emitted = true;
                        let _ = app.emit(
                            "local-ai://chunk",
                            LocalAIEvent {
                                run_id: run_id.clone(),
                                text: Some(text),
                                error: None,
                            },
                        );
                    }
                }
                Err(error) => {
                    let _ = app.emit(
                        "local-ai://error",
                        LocalAIEvent {
                            run_id: run_id.clone(),
                            text: None,
                            error: Some(format!("读取本地 AI 输出失败: {error}")),
                        },
                    );
                    break;
                }
            }
        }
        let status = processes
            .lock()
            .ok()
            .and_then(|mut entries| entries.remove(&run_id))
            .and_then(|mut child| child.wait().ok());
        match status {
            Some(status) if status.success() && emitted => {
                let _ = app.emit(
                    "local-ai://done",
                    LocalAIEvent {
                        run_id,
                        text: None,
                        error: None,
                    },
                );
            }
            Some(status) if status.success() => {
                let _ = app.emit(
                    "local-ai://error",
                    LocalAIEvent {
                        run_id,
                        text: None,
                        error: Some("本地 AI CLI 成功退出但没有返回文本".to_string()),
                    },
                );
            }
            Some(status) => {
                let _ = app.emit(
                    "local-ai://error",
                    LocalAIEvent {
                        run_id,
                        text: None,
                        error: Some(format!(
                            "本地 AI CLI 退出码 {}",
                            status.code().unwrap_or(-1)
                        )),
                    },
                );
            }
            None => {}
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_local_ai(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    if let Some(mut child) = state
        .ai_processes
        .lock()
        .map_err(|_| "本地 AI 进程锁不可用")?
        .remove(&run_id)
    {
        child
            .kill()
            .map_err(|error| format!("停止本地 AI CLI 失败: {error}"))?;
        let _ = child.wait();
    }
    Ok(())
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
fn read_status(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
) -> Result<db::WorkspaceSnapshot, String> {
    state
        .db
        .snapshot_for_account(account_pool_id)
        .map_err(|error| format!("读取本地工作区失败: {error}"))
}

/// 读取当前运营账号隔离范围内的图片，避免桌面端依赖旧 Python HTTP 图片接口。
#[tauri::command]
fn read_local_image(
    state: State<'_, AppState>,
    item_id: i64,
    account_pool_id: Option<i64>,
    variant: Option<String>,
) -> Result<Option<String>, String> {
    state.db.image_data_url_for_account(
        item_id,
        account_pool_id,
        variant.as_deref().unwrap_or("original"),
    )
}

/// 创建一个属于当前运营账号的本地草稿，用于验证 Rust SQLite 写入和账号池边界。
#[tauri::command]
fn create_local_draft(
    state: State<'_, AppState>,
    title: String,
    account_pool_id: Option<i64>,
) -> Result<db::NoteSummary, String> {
    state
        .db
        .create_local_draft_for_account(&title, account_pool_id)
        .map_err(|error| format!("创建本地草稿失败: {error}"))
}

/// 保存当前账号的本地笔记编辑字段，并要求调用方带上内容版本。
#[tauri::command]
fn update_local_note(
    state: State<'_, AppState>,
    update: db::LocalNoteUpdate,
) -> Result<db::NoteSummary, String> {
    state.db.update_local_note(update)
}

/// 保存当前账号的本地笔记状态，并要求调用方带上内容版本。
#[tauri::command]
fn update_local_note_status(
    state: State<'_, AppState>,
    update: db::LocalNoteStatusUpdate,
) -> Result<db::NoteSummary, String> {
    state.db.update_local_note_status(update)
}

/// 保存当前账号笔记的素材关联顺序，并要求调用方带上内容版本。
#[tauri::command]
fn update_local_note_items(
    state: State<'_, AppState>,
    update: db::LocalNoteItemsUpdate,
) -> Result<db::NoteSummary, String> {
    state.db.update_local_note_items(update)
}

/// 将当前账号本地笔记移入回收站，关联素材继续保留。
#[tauri::command]
fn delete_local_note(
    state: State<'_, AppState>,
    note_id: i64,
    account_pool_id: i64,
) -> Result<db::NoteSummary, String> {
    state.db.delete_local_note(note_id, account_pool_id)
}

/// 从当前账号笔记回收站恢复笔记，关联素材不自动恢复。
#[tauri::command]
fn restore_local_note(
    state: State<'_, AppState>,
    note_id: i64,
    account_pool_id: i64,
) -> Result<db::NoteSummary, String> {
    state.db.restore_local_note(note_id, account_pool_id)
}

/// 导入前端读取的图片字节；文件落位与数据库写入由 Rust 负责并带失败补偿。
#[tauri::command]
fn import_local_image(
    state: State<'_, AppState>,
    import: db::LocalImageImport,
) -> Result<db::ItemSummary, String> {
    state.db.import_local_image(import)
}

/// 用用户选择的新图片修复本地素材断链或替换图片内容，并递增图片版本。
#[tauri::command]
fn repair_local_image(
    state: State<'_, AppState>,
    repair: db::LocalImageRepair,
) -> Result<db::ItemSummary, String> {
    state.db.repair_local_image(repair)
}

/// 软删除当前账号素材，记录进入回收站并保留磁盘文件。
#[tauri::command]
fn delete_local_item(
    state: State<'_, AppState>,
    item_id: i64,
    account_pool_id: i64,
) -> Result<(), String> {
    state.db.delete_local_item(item_id, account_pool_id)
}

/// 从当前账号回收站恢复素材。
#[tauri::command]
fn restore_local_item(
    state: State<'_, AppState>,
    item_id: i64,
    account_pool_id: i64,
) -> Result<db::ItemSummary, String> {
    state.db.restore_local_item(item_id, account_pool_id)
}

/// 永久清理当前账号回收站素材；仍被笔记引用或路径越界时整体拒绝。
#[tauri::command]
fn purge_local_items(
    state: State<'_, AppState>,
    item_ids: Vec<i64>,
    account_pool_id: i64,
) -> Result<db::PurgeItemsResult, String> {
    state.db.purge_local_items(&item_ids, account_pool_id)
}

/// 保存当前账号素材的标题、标签和分析维度元数据，不改变图片内容版本。
#[tauri::command]
fn update_local_item_metadata(
    state: State<'_, AppState>,
    update: db::LocalItemMetadataUpdate,
) -> Result<db::ItemSummary, String> {
    state.db.update_local_item_metadata(update)
}

/// 从当前账号素材创建带有有序关联的本地草稿。
#[tauri::command]
fn create_local_draft_from_items(
    state: State<'_, AppState>,
    item_ids: Vec<i64>,
    account_pool_id: Option<i64>,
) -> Result<db::NoteSummary, String> {
    state
        .db
        .create_local_draft_from_items(&item_ids, account_pool_id)
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

/// 创建本地账号池记录；只创建受管空目录，不复制浏览器登录态。
#[tauri::command]
fn create_local_account(
    state: State<'_, AppState>,
    account: db::LocalAccountCreate,
) -> Result<(), String> {
    state.db.create_local_account(account)
}

/// 更新本地账号池展示字段和状态。
#[tauri::command]
fn update_local_account(
    state: State<'_, AppState>,
    account: db::LocalAccountUpdate,
) -> Result<(), String> {
    state.db.update_local_account(account)
}

/// 退休非激活本地账号，保留业务数据和受管目录。
#[tauri::command]
fn retire_local_account(state: State<'_, AppState>, account_id: i64) -> Result<(), String> {
    state.db.retire_local_account(account_id)
}

/// 保存当前运营账号的本地人设和内容策略字段。
#[tauri::command]
fn update_local_profile(
    state: State<'_, AppState>,
    update: db::LocalProfileUpdate,
) -> Result<(), String> {
    state.db.update_local_profile(update)
}

/// 读取当前账号的本地灵感/浏览器剪藏。
#[tauri::command]
fn read_local_inspirations(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
) -> Result<Vec<db::InspirationSummary>, String> {
    state.db.local_inspirations(account_pool_id)
}

/// 保存当前账号的本地灵感/浏览器剪藏。
#[tauri::command]
fn save_local_inspiration(
    state: State<'_, AppState>,
    inspiration: db::LocalInspirationCreate,
) -> Result<(), String> {
    state.db.save_local_inspiration(inspiration)
}

/// 将当前账号的本地灵感显式关联到一条草稿。
#[tauri::command]
fn convert_local_inspiration(
    state: State<'_, AppState>,
    id: String,
    account_pool_id: i64,
    note_id: i64,
) -> Result<db::InspirationSummary, String> {
    state
        .db
        .convert_local_inspiration(&id, account_pool_id, note_id)
}

/// 在当前账号下保存手工榜样账号信息。
#[tauri::command]
fn create_local_reference_account(
    state: State<'_, AppState>,
    account: db::LocalReferenceAccountCreate,
) -> Result<(), String> {
    state.db.create_local_reference_account(account)
}

/// 更新当前账号下榜样账号的名称、粉丝数或风格描述。
#[tauri::command]
fn update_local_reference_account(
    state: State<'_, AppState>,
    account: db::LocalReferenceAccountUpdate,
) -> Result<(), String> {
    state.db.update_local_reference_account(account)
}

/// 删除当前账号下榜样账号记录。
#[tauri::command]
fn delete_local_reference_account(
    state: State<'_, AppState>,
    id: i64,
    account_pool_id: i64,
) -> Result<(), String> {
    state.db.delete_local_reference_account(id, account_pool_id)
}

/// 保存本地 AI 运行的脱敏元数据，不保存提示词或生成正文。
#[tauri::command]
fn save_local_ai_run(
    state: State<'_, AppState>,
    run: db::LocalAIRunUpsert,
) -> Result<db::AIRunSummary, String> {
    state.db.upsert_local_ai_run(run)
}

/// 更新本地 AI 运行状态，供完成、失败、取消和重启中断回写。
#[tauri::command]
fn update_local_ai_run(
    state: State<'_, AppState>,
    run: db::LocalAIRunUpdate,
) -> Result<db::AIRunSummary, String> {
    state.db.update_local_ai_run(run)
}

/// 读取当前账号和对象作用域下最近一次本地 AI 运行。
#[tauri::command]
fn read_local_ai_run(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
    note_id: Option<i64>,
    item_id: Option<i64>,
) -> Result<Option<db::AIRunSummary>, String> {
    state
        .db
        .latest_local_ai_run(account_pool_id, note_id, item_id)
}

/// 保存本地 AI 生成的限长文本产物，不保存完整提示词或凭据。
#[tauri::command]
fn save_local_ai_artifact(
    state: State<'_, AppState>,
    artifact: db::LocalAIRunArtifactCreate,
) -> Result<db::AIRunArtifactSummary, String> {
    state.db.save_local_ai_artifact(artifact)
}

/// 读取当前账号和对象作用域下最近的本地 AI 产物。
#[tauri::command]
fn read_local_ai_artifacts(
    state: State<'_, AppState>,
    account_pool_id: Option<i64>,
    note_id: Option<i64>,
    item_id: Option<i64>,
) -> Result<Vec<db::AIRunArtifactSummary>, String> {
    state
        .db
        .local_ai_artifacts(account_pool_id, note_id, item_id)
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
        if let Ok(qa_workspace) = std::env::var("AICHIHONGSHU_QA_WORKSPACE") {
            let qa_root = PathBuf::from(qa_workspace);
            if !qa_root.is_absolute() {
                return Err(setup_error("AICHIHONGSHU_QA_WORKSPACE 必须是绝对路径"));
            }
            let marker = qa_root.join(".aichihongshu-qa-workspace");
            if !marker.is_file() {
                return Err(setup_error(format!(
                    "拒绝使用未标记的 QA 工作区: {}",
                    qa_root.display()
                )));
            }
            return Ok(qa_root.join("data").join("app.db"));
        }

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
            app.manage(AppState {
                db,
                ai_processes: Arc::new(Mutex::new(HashMap::new())),
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            read_status,
            read_local_image,
            create_local_draft,
            update_local_note,
            update_local_note_status,
            update_local_note_items,
            delete_local_note,
            restore_local_note,
            import_local_image,
            repair_local_image,
            delete_local_item,
            restore_local_item,
            purge_local_items,
            update_local_item_metadata,
            create_local_draft_from_items,
            read_account_pool,
            activate_local_account,
            create_local_account,
            update_local_account,
            retire_local_account,
            update_local_profile,
            read_local_inspirations,
            save_local_inspiration,
            convert_local_inspiration,
            create_local_reference_account,
            update_local_reference_account,
            delete_local_reference_account,
            save_local_ai_run,
            update_local_ai_run,
            read_local_ai_run,
            save_local_ai_artifact,
            read_local_ai_artifacts,
            probe_local_ai_providers,
            start_local_ai,
            cancel_local_ai
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, _| {});
}

#[cfg(test)]
mod tests {
    use super::command_for_provider;

    #[test]
    fn local_cli_commands_are_non_interactive_and_keep_prompt_as_one_argument() {
        for (provider, expected) in [
            ("claude", vec!["-p", "prompt", "--output-format", "text"]),
            (
                "codex",
                vec![
                    "exec",
                    "--color",
                    "never",
                    "--skip-git-repo-check",
                    "prompt",
                ],
            ),
            ("opencode", vec!["run", "prompt"]),
        ] {
            let command =
                command_for_provider(provider, "prompt").expect("provider should be allowed");
            let args: Vec<String> = command
                .get_args()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect();
            assert_eq!(args, expected);
        }
    }

    #[test]
    fn local_cli_provider_is_allowlisted() {
        let error = command_for_provider("sh -c 'echo unsafe'", "prompt")
            .expect_err("shell text must be rejected");
        assert!(error.contains("不支持的本地 AI Provider"));
    }
}
