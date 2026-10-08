use serde_json::Value;
use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ISOLATED_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

struct IsolatedDirectory(PathBuf);

impl IsolatedDirectory {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after unix epoch")
            .as_nanos();
        let sequence = NEXT_ISOLATED_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "rn-cli-process-{}-{sequence}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create isolated CLI test directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for IsolatedDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn invoke(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rn"))
        .args(args)
        .current_dir(root)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("PATH", root)
        .output()
        .expect("start Rust rn binary with an isolated, empty PATH")
}

fn invoke_db(root: &Path, database: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rn"))
        .arg("--db")
        .arg(database)
        .args(args)
        .current_dir(root)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("PATH", root)
        .output()
        .expect("start Rust rn command with an isolated, empty PATH")
}

fn exchange_mcp_message(
    stdin: &mut std::process::ChildStdin,
    stdout: &mut std::io::BufReader<std::process::ChildStdout>,
    message: &Value,
) -> Value {
    serde_json::to_writer(&mut *stdin, message).expect("serialize MCP request");
    stdin.write_all(b"\n").expect("write MCP request delimiter");
    stdin.flush().expect("flush MCP request");
    let mut line = String::new();
    let bytes_read = stdout.read_line(&mut line).expect("read MCP response line");
    assert_ne!(bytes_read, 0, "MCP process closed stdout before replying");
    serde_json::from_str(&line).expect("MCP response line is JSON")
}

fn mcp_text_result(reply: &Value) -> Value {
    serde_json::from_str(
        reply["result"]["content"][0]["text"]
            .as_str()
            .expect("MCP tool result text"),
    )
    .expect("MCP tool result text contains JSON")
}

fn mcp_text_results(reply: &Value) -> Vec<Value> {
    reply["result"]["content"]
        .as_array()
        .expect("MCP content array")
        .iter()
        .map(|block| {
            serde_json::from_str(block["text"].as_str().expect("MCP content block text"))
                .expect("MCP content block contains JSON")
        })
        .collect()
}

#[cfg(unix)]
fn invoke_db_with_terminal(root: &Path, database: &Path, args: &[&str], answer: &[u8]) -> Output {
    use std::fs::File;
    use std::os::fd::FromRawFd;

    let mut master_fd = -1;
    let mut slave_fd = -1;
    let result = unsafe {
        libc::openpty(
            &mut master_fd,
            &mut slave_fd,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    assert_eq!(result, 0, "create a pseudo-terminal");

    let mut master = unsafe { File::from_raw_fd(master_fd) };
    let slave = unsafe { File::from_raw_fd(slave_fd) };
    let stdin = slave.try_clone().expect("clone pseudo-terminal stdin");
    drop(slave);

    let child = Command::new(env!("CARGO_BIN_EXE_rn"))
        .arg("--db")
        .arg(database)
        .args(args)
        .current_dir(root)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("PATH", root)
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start rn with pseudo-terminal stdio");
    master
        .write_all(answer)
        .expect("send interactive answer through the pseudo-terminal");
    let output = child
        .wait_with_output()
        .expect("wait for interactive rn process");
    drop(master);
    output
}

#[cfg(unix)]
fn terminal_output_text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[cfg(unix)]
#[test]
fn interactive_terminal_confirmations_accept_and_cancel_database_and_delete_actions() {
    let isolated = IsolatedDirectory::new();
    let confirmed_database = isolated.path().join("data").join("confirmed.db");
    let output = invoke_db_with_terminal(
        isolated.path(),
        &confirmed_database,
        &["db", "init"],
        b"y\n",
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        terminal_output_text(&output)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("将创建新的本地数据库"));
    assert!(stderr.contains("确认在此路径创建数据库？[y/N]"));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "✓ 数据库初始化完成\n"
    );
    assert!(confirmed_database.is_file());

    let cancelled_database = isolated.path().join("data").join("cancelled.db");
    let output = invoke_db_with_terminal(
        isolated.path(),
        &cancelled_database,
        &["db", "init"],
        b"n\n",
    );
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        terminal_output_text(&output)
    );
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("确认在此路径创建数据库？[y/N]"));
    assert!(stderr.contains("错误：已取消数据库初始化"));
    assert!(!cancelled_database.exists());

    let database = isolated.path().join("data").join("delete-confirmation.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "initialize destructive-confirmation fixture",
    );
    for account_id in ["terminal-cancel", "terminal-confirm"] {
        successful_command(
            invoke_db(
                isolated.path(),
                &database,
                &["accounts", "add", account_id, "--name", account_id],
            ),
            "seed interactive-delete account",
        );
    }

    let output = invoke_db_with_terminal(
        isolated.path(),
        &database,
        &["accounts", "delete", "terminal-cancel"],
        b"n\n",
    );
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        terminal_output_text(&output)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("确认删除该账号吗？ [y/N]:"));
    assert_eq!(output.stderr, b"Aborted!\n");
    successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["accounts", "show", "terminal-cancel"],
        ),
        "cancelled terminal confirmation leaves account intact",
    );

    let output = invoke_db_with_terminal(
        isolated.path(),
        &database,
        &["accounts", "delete", "terminal-confirm"],
        b"y\n",
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        terminal_output_text(&output)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("确认删除该账号吗？ [y/N]:"));
    assert!(String::from_utf8_lossy(&output.stdout).contains("✓ 已删除账号 terminal-confirm"));
    assert!(output.stderr.is_empty());

    let image = isolated.path().join("terminal-delete.png");
    fs::write(
        &image,
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/J9sAAAAASUVORK5CYII=",
        )
        .expect("decode tiny terminal-delete PNG fixture"),
    )
    .expect("write terminal-delete PNG fixture");
    successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "library",
                "add",
                image.to_str().expect("image path UTF-8"),
                "--no-analyze",
                "--title",
                "终端确认素材",
            ],
        ),
        "seed terminal-delete material",
    );

    let output = invoke_db_with_terminal(
        isolated.path(),
        &database,
        &["library", "delete", "1"],
        b"n\n",
    );
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        terminal_output_text(&output)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("确认删除？ [y/N]:"));
    assert_eq!(output.stderr, b"Aborted!\n");
    successful_command(
        invoke_db(isolated.path(), &database, &["library", "show", "1"]),
        "cancelled terminal confirmation leaves material intact",
    );

    let output = invoke_db_with_terminal(
        isolated.path(),
        &database,
        &["library", "delete", "1"],
        b"y\n",
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        terminal_output_text(&output)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("确认删除？ [y/N]:"));
    assert!(stdout.contains("✓ 已删除物品 ID=1"));
    assert!(output.stderr.is_empty());
    let (trash_json, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "library", "trash"]),
        "confirmed terminal delete moves material into trash",
    );
    let trash: Value = serde_json::from_str(&trash_json).expect("terminal-delete trash JSON");
    assert!(trash
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["id"] == 1)));
    assert!(stderr.is_empty());
}

fn invoke_db_without_provider_credentials(root: &Path, database: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rn"))
        .arg("--db")
        .arg(database)
        .args(args)
        .current_dir(root)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("PATH", root)
        .env_remove("MINIMAX_API_KEY")
        .env_remove("AICHIHONGSHU_MINIMAX_API_KEY")
        .output()
        .expect("start rn with isolated database and no Model API credentials")
}

fn successful_command(output: Output, command: &str) -> (String, String) {
    assert_eq!(
        output.status.code(),
        Some(0),
        "{command} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    (
        String::from_utf8(output.stdout).expect("CLI stdout is UTF-8"),
        String::from_utf8(output.stderr).expect("CLI stderr is UTF-8"),
    )
}

#[cfg(unix)]
#[test]
fn profile_init_url_saves_a_worker_snapshot_and_closes_its_process_without_provider() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("profile-capture.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "profile capture database init",
    );

    let node = std::env::split_paths(&std::env::var_os("PATH").expect("test PATH"))
        .map(|directory| directory.join("node"))
        .find(|candidate| candidate.is_file())
        .expect("Node.js is installed for the isolated browser-worker contract");
    let worker_dir = isolated.path().join("browser-worker-fixture");
    fs::create_dir_all(&worker_dir).expect("create fake browser worker directory");
    let worker_script = r#"
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const actionsFile = process.env.AICHIHONGSHU_TEST_WORKER_ACTIONS;
const profile = {
  profileId: "captured-self",
  displayName: "采集主页",
  avatarUrl: "https://example.com/avatar.png",
  bio: "隔离主页简介",
  followers: 1234,
  follows: 56,
  totalNotes: 30,
  ipLocation: "杭州",
  tags: ["家居", "收纳"],
};
const notes = [{
  noteUrl: "https://www.xiaohongshu.com/explore/note-1",
  title: "房间整理",
  body: "把收纳分成三步",
  likes: 10,
  comments: 2,
  collects: 4,
  tags: ["收纳"],
  publishedAt: "2026-10-01",
}];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
send({ protocolVersion: 1, type: "ready" });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  appendFileSync(actionsFile, request.action + "\n");
  let result = { status: "running", accountId: request.accountId };
  if (request.action === "collect-profile") {
    const state = process.env.AICHIHONGSHU_TEST_PROFILE_STATE;
    result = state ? { state } : { state: "complete", profile, notes };
  }
  if (request.action === "shutdown") result = { status: "closed" };
  send({ protocolVersion: 1, type: "response", requestId: request.requestId, ok: true, result });
  if (request.action === "shutdown") break;
}
"#;
    fs::write(worker_dir.join("worker.mjs"), worker_script)
        .expect("write deterministic browser worker fixture");
    let worker_actions = isolated.path().join("worker-actions.txt");
    let profile_url = "https://www.xiaohongshu.com/user/profile/captured-self?source=fixture";
    let run_profile_init = |json_output: bool, worker_state: Option<&str>| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rn"));
        command.arg("--db").arg(&database);
        if json_output {
            command.arg("--json");
        }
        command
            .arg("profile")
            .arg("init")
            .arg("--url")
            .arg(profile_url)
            .arg("--niche")
            .arg("家居")
            .current_dir(isolated.path())
            .env_clear()
            .env("HOME", isolated.path())
            .env("PATH", isolated.path())
            .env("AICHIHONGSHU_NODE", &node)
            .env("AICHIHONGSHU_BROWSER_WORKER_DIR", &worker_dir)
            .env("AICHIHONGSHU_TEST_WORKER_ACTIONS", &worker_actions);
        if let Some(state) = worker_state {
            command.env("AICHIHONGSHU_TEST_PROFILE_STATE", state);
        }
        command
            .output()
            .expect("run profile init with an isolated Node worker and no provider credentials")
    };
    let output = run_profile_init(true, None);

    assert_eq!(output.status.code(), Some(0), "stderr={:?}", output.stderr);
    let profile: Value = serde_json::from_slice(&output.stdout).expect("profile JSON stays pure");
    assert_eq!(profile["accountId"], "captured-self");
    assert_eq!(profile["displayName"], "采集主页");
    assert_eq!(profile["niche"], "家居");
    assert_eq!(profile["followers"], 1234);
    assert_eq!(profile["xhsBio"], "隔离主页简介");
    assert_eq!(profile["xhsFollows"], 56);
    assert_eq!(profile["ipLocation"], "杭州");
    assert_eq!(profile["avgLikes"], 10.0);
    assert_eq!(profile["avgComments"], 2.0);
    assert_eq!(profile["avgCollects"], 4.0);
    let stderr = String::from_utf8(output.stderr).expect("profile capture stderr is UTF-8");
    assert!(stderr.contains("警告：AI 人设推断失败，将保留已有字段并继续同步主页"));
    assert!(stderr.contains("正在抓取账号数据..."));
    assert!(stderr.contains("✓ 抓取完成，共 1 条笔记"));
    assert!(!stderr.contains("API Key"));

    let text_output = run_profile_init(false, None);
    assert_eq!(
        text_output.status.code(),
        Some(0),
        "stderr={:?}",
        text_output.stderr
    );
    let stdout = String::from_utf8(text_output.stdout).expect("profile text output is UTF-8");
    let stderr = String::from_utf8(text_output.stderr).expect("profile text stderr is UTF-8");
    assert!(stdout
        .contains("正在抓取账号数据...\n首次运行需要扫码登录小红书，请在弹出的浏览器中完成\n"));
    assert!(stdout.contains("✓ 抓取完成，共 1 条笔记\n正在用 AI 分析笔记数据，推断账号人设...\n"));
    assert!(stdout.contains("AI 推断失败："));
    assert!(stdout.contains("将使用空人设写入数据库，请之后手动 profile edit 补充"));
    assert!(stdout.contains("── AI 推断结果（已写入数据库，可用 profile edit 修正）──"));
    assert!(stdout.contains("  垂类：家居\n  目标受众：\n  内容支柱：\n"));
    assert!(stdout.contains("✓ 账号人设已写入数据库：采集主页"));
    assert!(stderr.is_empty(), "stderr={stderr:?}");
    let (before_failed_capture, _) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "profile", "show"]),
        "read profile before failed capture",
    );
    let failed_capture = run_profile_init(true, Some("login-required"));
    assert_eq!(failed_capture.status.code(), Some(2));
    assert!(failed_capture.stdout.is_empty());
    let failed_stderr =
        String::from_utf8(failed_capture.stderr).expect("login-required error output is UTF-8");
    assert!(failed_stderr.contains("独立浏览器尚未登录"));
    let (after_failed_capture, _) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "profile", "show"]),
        "read profile after failed capture",
    );
    assert_eq!(after_failed_capture, before_failed_capture);
    assert_eq!(
        fs::read_to_string(worker_actions).expect("worker action log"),
        "open-session\ncollect-profile\nshutdown\nopen-session\ncollect-profile\nshutdown\nopen-session\ncollect-profile\nshutdown\n"
    );
}

#[test]
fn cli_process_stdout_stderr_and_exit_codes_work_without_python_on_path() {
    let isolated = IsolatedDirectory::new();

    let help = invoke(isolated.path(), &["--help"]);
    assert_eq!(help.status.code(), Some(0));
    let help_stdout = String::from_utf8(help.stdout).expect("help is UTF-8");
    assert!(help_stdout.starts_with("rn — 爱吃红薯本地工作区命令\n用法：rn "));
    assert!(help_stdout.contains("示例：rn --db data/app.db library list --json"));
    assert!(help.stderr.is_empty());

    let version = invoke(isolated.path(), &["--version"]);
    assert_eq!(version.status.code(), Some(0));
    assert_eq!(version.stdout, b"rn 0.1.0\n");
    assert!(version.stderr.is_empty());

    let database = isolated.path().join("not-created.db");
    let database_arg = database.to_str().expect("test path is UTF-8");
    let config = invoke(isolated.path(), &["--db", database_arg, "mcp", "config"]);
    assert_eq!(config.status.code(), Some(0));
    assert!(config.stderr.is_empty());
    let config_json: Value = serde_json::from_slice(&config.stdout).expect("stdout is MCP JSON");
    assert_eq!(
        config_json.pointer("/mcpServers/aichihongshu/command"),
        Some(&Value::String(
            fs::canonicalize(env!("CARGO_BIN_EXE_rn"))
                .expect("canonical rn executable")
                .display()
                .to_string()
        ))
    );
    assert_eq!(
        config_json.pointer("/mcpServers/aichihongshu/args"),
        Some(&serde_json::json!(["--db", database_arg, "mcp"]))
    );
    assert!(
        !database.exists(),
        "printing config must not open or create DB"
    );

    let invalid = invoke(isolated.path(), &["mcp", "config", "unexpected"]);
    assert_eq!(invalid.status.code(), Some(2));
    assert!(invalid.stdout.is_empty());
    assert_eq!(
        invalid.stderr,
        "错误：用法：rn mcp config [--db PATH]\n".as_bytes()
    );
}

#[test]
fn cli_process_requires_explicit_confirmation_before_non_interactive_database_creation() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("must-confirm.db");
    let output = invoke_db(isolated.path(), &database, &["db", "init"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).expect("CLI stderr is UTF-8"),
        format!(
            "将创建新的本地数据库：{}\n错误：非交互终端拒绝静默创建数据库；确认该路径后加 --yes 重试\n",
            database.display()
        )
    );
    assert!(
        !database.exists(),
        "a non-interactive invocation without --yes must not create the database"
    );
}

#[test]
fn content_draft_argument_errors_keep_click_stdout_stderr_and_exit_contracts_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("draft-errors.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "content draft error fixture database init",
    );

    let usage = |detail: &str| {
        format!(
            "Usage: rn content draft [OPTIONS] ITEM_ID\nTry 'rn content draft --help' for help.\n\nError: {detail}\n"
        )
    };
    for (args, expected_stderr, name) in [
        (
            &[][..],
            usage("Missing argument 'ITEM_ID'."),
            "missing draft item id",
        ),
        (
            &["abc"][..],
            usage("Invalid value for 'ITEM_ID': 'abc' is not a valid integer."),
            "invalid draft item id",
        ),
        (
            &["1", "--unexpected"][..],
            usage("No such option: --unexpected"),
            "unknown draft option",
        ),
        (
            &["1", "extra"][..],
            usage("Got unexpected extra argument (extra)"),
            "unexpected draft positional argument",
        ),
        (
            &["1", "--extra"][..],
            "Error: Option '--extra' requires an argument.\n".to_string(),
            "missing draft option value",
        ),
    ] {
        let mut command = vec!["content", "draft"];
        command.extend_from_slice(args);
        let output = invoke_db(isolated.path(), &database, &command);
        assert_eq!(output.status.code(), Some(2), "{name} exit code");
        assert!(output.stdout.is_empty(), "{name} stdout");
        assert_eq!(
            String::from_utf8(output.stderr).expect("CLI stderr is UTF-8"),
            expected_stderr,
            "{name} stderr"
        );
    }
}

#[test]
fn single_record_commands_keep_click_argument_errors_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("argument-errors.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "initialize CLI argument-error fixture database",
    );

    let cases: &[(&[&str], &str, &str, &str)] = &[
        (
            &["library", "show"],
            "rn library show",
            "ITEM_ID",
            "Missing argument 'ITEM_ID'.",
        ),
        (
            &["library", "show", "abc"],
            "rn library show",
            "ITEM_ID",
            "Invalid value for 'ITEM_ID': 'abc' is not a valid integer.",
        ),
        (
            &["library", "show", "1", "extra"],
            "rn library show",
            "ITEM_ID",
            "Got unexpected extra argument (extra)",
        ),
        (
            &["content", "show", "--unknown"],
            "rn content show",
            "NOTE_ID",
            "No such option: --unknown",
        ),
        (
            &["accounts", "show", "qa-reference", "extra"],
            "rn accounts show",
            "ACCOUNT_ID",
            "Got unexpected extra argument (extra)",
        ),
        (
            &["library", "analyze"],
            "rn library analyze",
            "ITEM_ID",
            "Missing argument 'ITEM_ID'.",
        ),
        (
            &["library", "restore", "1", "extra"],
            "rn library restore",
            "ITEM_ID",
            "Got unexpected extra argument (extra)",
        ),
        (
            &["content", "edit", "abc"],
            "rn content edit",
            "NOTE_ID",
            "Invalid value for 'NOTE_ID': 'abc' is not a valid integer.",
        ),
        (
            &["content", "edit", "1", "--unknown"],
            "rn content edit",
            "NOTE_ID",
            "No such option: --unknown",
        ),
        (
            &["content", "export", "1", "extra"],
            "rn content export",
            "NOTE_ID",
            "Got unexpected extra argument (extra)",
        ),
        (
            &["library", "delete", "1", "extra"],
            "rn library delete",
            "ITEM_ID",
            "Got unexpected extra argument (extra)",
        ),
        (
            &["accounts", "delete"],
            "rn accounts delete",
            "ACCOUNT_ID",
            "Missing argument 'ACCOUNT_ID'.",
        ),
        (
            &["accounts", "add", "qa-reference"],
            "rn accounts add",
            "ACCOUNT_ID",
            "Missing option '--name' / '-n'.",
        ),
        (
            &[
                "accounts",
                "add",
                "qa-reference",
                "--name",
                "参考账号",
                "--note-count",
                "abc",
            ],
            "rn accounts add",
            "ACCOUNT_ID",
            "Invalid value for '--note-count': 'abc' is not a valid integer.",
        ),
        (
            &[
                "accounts",
                "add",
                "qa-reference",
                "--name",
                "参考账号",
                "--avg-likes",
                "abc",
            ],
            "rn accounts add",
            "ACCOUNT_ID",
            "Invalid value for '--avg-likes': 'abc' is not a valid float.",
        ),
    ];
    for (args, command_name, argument_name, detail) in cases {
        let output = invoke_db(isolated.path(), &database, args);
        assert_eq!(output.status.code(), Some(2), "{args:?} exit code");
        assert!(output.stdout.is_empty(), "{args:?} stdout");
        assert_eq!(
            String::from_utf8(output.stderr).expect("CLI stderr is UTF-8"),
            format!(
                "Usage: {command_name} [OPTIONS] {argument_name}\nTry '{command_name} --help' for help.\n\nError: {detail}\n"
            ),
            "{args:?} stderr"
        );
    }

    let missing_option_value = invoke_db(
        isolated.path(),
        &database,
        &["content", "export", "1", "--output"],
    );
    assert_eq!(missing_option_value.status.code(), Some(2));
    assert!(missing_option_value.stdout.is_empty());
    assert_eq!(
        missing_option_value.stderr,
        b"Error: Option '--output' requires an argument.\n"
    );
}

#[test]
fn every_legacy_numeric_cli_parameter_keeps_click_value_errors_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("numeric-errors.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "initialize CLI numeric error fixture database",
    );

    let fixture: Value = serde_json::from_str(include_str!("fixtures/python_cli_contract.json"))
        .expect("legacy Click command contract fixture");
    for entry in fixture.as_array().expect("command contract array") {
        let group = entry["group"].as_str().expect("command group");
        let command = entry["command"].as_str().expect("command name");
        let params = entry["params"].as_array().expect("command parameter list");
        let required_positionals = params
            .iter()
            .filter(|param| param["required"].as_bool() == Some(true))
            .filter(|param| {
                param["opts"]
                    .as_array()
                    .and_then(|options| options.first())
                    .and_then(Value::as_str)
                    .is_some_and(|option| !option.starts_with('-'))
            })
            .map(|param| {
                param["name"]
                    .as_str()
                    .expect("parameter name")
                    .to_uppercase()
            })
            .collect::<Vec<_>>();
        let usage_arguments = if required_positionals.is_empty() {
            String::new()
        } else {
            format!(" {}", required_positionals.join(" "))
        };
        let cli_command = format!("rn {group} {command}");

        for param in params
            .iter()
            .filter(|param| matches!(param["type"].as_str(), Some("INT" | "FLOAT")))
        {
            let parameter_name = param["name"].as_str().expect("typed parameter name");
            let value_type = param["type"].as_str().expect("numeric type");
            let error_type = if value_type == "INT" {
                "integer"
            } else {
                "float"
            };
            let positional = param["opts"]
                .as_array()
                .and_then(|options| options.first())
                .and_then(Value::as_str)
                .is_some_and(|option| !option.starts_with('-'));
            let mut args = vec![group, command];

            for candidate in params {
                let candidate_name = candidate["name"].as_str().expect("parameter name");
                let candidate_positional = candidate["opts"]
                    .as_array()
                    .and_then(|options| options.first())
                    .and_then(Value::as_str)
                    .is_some_and(|option| !option.starts_with('-'));
                if candidate_positional && candidate["required"].as_bool() == Some(true) {
                    args.push(if candidate_name == parameter_name {
                        "not-a-number"
                    } else {
                        "valid-id"
                    });
                } else if candidate["required"].as_bool() == Some(true)
                    && candidate_name != parameter_name
                {
                    let option = candidate["opts"]
                        .as_array()
                        .and_then(|options| options.first())
                        .and_then(Value::as_str)
                        .expect("required option");
                    args.extend([option, "有效值"]);
                }
            }

            if group == "profile" && command == "init" {
                args.extend(["--name", "验收账号", "--niche", "家居"]);
            }

            let error_parameter = if positional {
                parameter_name.to_uppercase()
            } else {
                let option = param["opts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .find(|option| option.starts_with("--"))
                    .expect("long option name");
                args.extend([option, "not-a-number"]);
                option.to_string()
            };

            let output = invoke_db(isolated.path(), &database, &args);
            assert_eq!(
                output.status.code(),
                Some(2),
                "{group} {command} {parameter_name} exit code"
            );
            assert!(
                output.stdout.is_empty(),
                "{group} {command} {parameter_name} stdout"
            );
            let expected = format!(
                "Usage: {cli_command} [OPTIONS]{usage_arguments}\nTry '{cli_command} --help' for help.\n\nError: Invalid value for '{error_parameter}': 'not-a-number' is not a valid {error_type}.\n"
            );
            assert_eq!(
                String::from_utf8(output.stderr).expect("CLI stderr is UTF-8"),
                expected,
                "{group} {command} {parameter_name} stderr"
            );
        }
    }
}

#[test]
fn every_legacy_cli_value_option_requires_a_value_with_click_error_streams_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("missing-values.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "initialize CLI option error fixture database",
    );
    let image = isolated.path().join("option-contract.png");
    fs::write(
        &image,
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        )
        .expect("decode option contract PNG"),
    )
    .expect("write option contract PNG");
    successful_command(
        invoke_db_without_provider_credentials(
            isolated.path(),
            &database,
            &[
                "library",
                "add",
                image.to_str().expect("image path UTF-8"),
                "--no-analyze",
                "--title",
                "验收素材",
            ],
        ),
        "seed CLI option contract asset",
    );
    successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["content", "draft", "1", "--save"],
        ),
        "seed CLI option contract note",
    );
    successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["accounts", "add", "qa-reference", "--name", "验收榜样"],
        ),
        "seed CLI option contract reference account",
    );
    successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["profile", "init", "--name", "验收账号", "--niche", "家居"],
        ),
        "seed CLI option contract profile",
    );

    let fixture: Value = serde_json::from_str(include_str!("fixtures/python_cli_contract.json"))
        .expect("legacy Click command contract fixture");
    for entry in fixture.as_array().expect("command contract array") {
        let group = entry["group"].as_str().expect("command group");
        let command = entry["command"].as_str().expect("command name");
        let params = entry["params"].as_array().expect("command parameter list");

        for param in params.iter().filter(|param| {
            param["is_flag"].as_bool() != Some(true)
                && param["opts"].as_array().is_some_and(|options| {
                    options.iter().any(|option| {
                        option
                            .as_str()
                            .is_some_and(|option| option.starts_with("--"))
                    })
                })
        }) {
            let parameter_name = param["name"].as_str().expect("option parameter name");
            let option = param["opts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .find(|option| option.starts_with("--"))
                .expect("long option name");
            let mut args = vec![group, command];

            for candidate in params {
                let candidate_name = candidate["name"].as_str().expect("parameter name");
                let candidate_positional = candidate["opts"]
                    .as_array()
                    .and_then(|options| options.first())
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.starts_with('-'));
                if candidate["required"].as_bool() == Some(true) && candidate_positional {
                    args.push(match candidate_name {
                        "image_path" => image.to_str().expect("image path UTF-8"),
                        "account_id" => "qa-reference",
                        _ => "1",
                    });
                } else if candidate["required"].as_bool() == Some(true)
                    && candidate_name != parameter_name
                {
                    let required_option = candidate["opts"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .find(|value| value.starts_with("--"))
                        .expect("required option name");
                    args.extend([required_option, "有效值"]);
                }
            }

            if group == "profile" && command == "init" {
                if option != "--name" {
                    args.extend(["--name", "验收账号"]);
                }
                if option != "--niche" {
                    args.extend(["--niche", "家居"]);
                }
            }
            if group == "library" && command == "add" {
                args.push("--no-analyze");
            }
            args.push(option);

            let output = invoke_db(isolated.path(), &database, &args);
            assert_eq!(
                output.status.code(),
                Some(2),
                "{group} {command} {parameter_name} exit code"
            );
            assert!(
                output.stdout.is_empty(),
                "{group} {command} {parameter_name} stdout"
            );
            assert_eq!(
                String::from_utf8(output.stderr).expect("CLI stderr is UTF-8"),
                format!("Error: Option '{option}' requires an argument.\n"),
                "{group} {command} {parameter_name} stderr"
            );
        }
    }
}

#[test]
fn every_legacy_required_cli_argument_keeps_click_missing_argument_errors_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated
        .path()
        .join("data")
        .join("missing-required-args.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "initialize CLI required argument fixture database",
    );

    let fixture: Value = serde_json::from_str(include_str!("fixtures/python_cli_contract.json"))
        .expect("legacy Click command contract fixture");
    for entry in fixture.as_array().expect("command contract array") {
        let group = entry["group"].as_str().expect("command group");
        let command = entry["command"].as_str().expect("command name");
        let params = entry["params"].as_array().expect("command parameter list");
        let required_positionals = params
            .iter()
            .filter(|param| param["required"].as_bool() == Some(true))
            .filter(|param| {
                param["opts"]
                    .as_array()
                    .and_then(|options| options.first())
                    .and_then(Value::as_str)
                    .is_some_and(|option| !option.starts_with('-'))
            })
            .map(|param| {
                param["name"]
                    .as_str()
                    .expect("parameter name")
                    .to_uppercase()
            })
            .collect::<Vec<_>>();
        let Some(first_missing) = required_positionals.first() else {
            continue;
        };
        let cli_command = format!("rn {group} {command}");
        let usage_arguments = format!(" {}", required_positionals.join(" "));
        let output = invoke_db(isolated.path(), &database, &[group, command]);
        assert_eq!(output.status.code(), Some(2), "{group} {command} exit code");
        assert!(output.stdout.is_empty(), "{group} {command} stdout");
        assert_eq!(
            String::from_utf8(output.stderr).expect("CLI stderr is UTF-8"),
            format!(
                "Usage: {cli_command} [OPTIONS]{usage_arguments}\nTry '{cli_command} --help' for help.\n\nError: Missing argument '{first_missing}'.\n"
            ),
            "{group} {command} stderr"
        );
    }
}

#[test]
fn click_option_values_starting_with_dashes_keep_their_meaning_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("option-values.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "initialize leading-hyphen option-value fixture database",
    );
    let image = isolated.path().join("leading-hyphen-title.png");
    fs::write(
        &image,
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        )
        .expect("decode title fixture PNG"),
    )
    .expect("write title fixture PNG");

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "library",
                "add",
                "--title",
                "--no-analyze",
                image.to_str().expect("image path UTF-8"),
                "--no-analyze",
            ],
        ),
        "library add consumes an option-looking title and honors the later analyze flag",
    );
    assert!(stdout.starts_with("✓ 已添加物品 ID=1：--no-analyze\n"));
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["library", "tag", "--add", "-quiet", "1"],
        ),
        "library tag consumes a leading-hyphen tag before its positional ID",
    );
    assert!(stdout.contains("已添加标签「-quiet」"));
    assert!(stderr.is_empty());
    let (items_json, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "library", "list"]),
        "read the leading-hyphen tag from the isolated database",
    );
    let items: Value = serde_json::from_str(&items_json).expect("library JSON");
    assert_eq!(items[0]["tags"], serde_json::json!(["-quiet"]));
    assert!(stderr.is_empty());
}

#[test]
fn db_init_keeps_legacy_success_and_json_output_contracts_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("db-init-contract.db");

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "initialize a new database with explicit confirmation",
    );
    assert_eq!(stdout, "✓ 数据库初始化完成\n");
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["db", "init"]),
        "reinitialize an existing database without confirmation",
    );
    assert_eq!(stdout, "✓ 数据库初始化完成\n");
    assert!(stderr.is_empty());

    let database_arg = database.to_str().expect("database path is UTF-8");
    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "db", "init"]),
        "initialize JSON output for an existing database",
    );
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).expect("db init JSON stdout"),
        serde_json::json!({"initialized": true, "databasePath": database_arg})
    );
    assert!(stderr.is_empty());
}

#[test]
fn library_add_keeps_legacy_analysis_output_streams_and_json_purity_without_credentials() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("analysis-output.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "analysis output fixture database init",
    );
    let png = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/J9sAAAAASUVORK5CYII=",
    )
    .expect("decode tiny PNG fixture");
    let text_image = isolated.path().join("text-mode-analysis.png");
    fs::write(&text_image, &png).expect("write isolated text-mode image");

    let text_output = invoke_db_without_provider_credentials(
        isolated.path(),
        &database,
        &[
            "library",
            "add",
            text_image.to_str().expect("image path UTF-8"),
        ],
    );
    assert_eq!(text_output.status.code(), Some(0));
    let text_stdout = String::from_utf8(text_output.stdout).expect("text stdout is UTF-8");
    let text_stderr = String::from_utf8(text_output.stderr).expect("text stderr is UTF-8");
    assert!(
        text_stderr.is_empty(),
        "legacy text diagnostics belong on stdout"
    );
    assert!(text_stdout.starts_with(&format!(
        "正在分析图片... {}\n⚠ MiniMax 分析失败（未配置 MiniMax Token Plan 密钥；请在模型设置中配置 MiniMax API Key，或临时设置 MINIMAX_API_KEY），将跳过分析直接入库\n✓ 已添加物品 ID=1：text-mode-analysis\n",
        text_image.display()
    )));

    let json_image = isolated.path().join("json-mode-analysis.png");
    let json_png = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    )
    .expect("decode a distinct tiny PNG fixture");
    fs::write(&json_image, json_png).expect("write isolated JSON-mode image");
    let json_output = invoke_db_without_provider_credentials(
        isolated.path(),
        &database,
        &[
            "--json",
            "library",
            "add",
            json_image.to_str().expect("image path UTF-8"),
        ],
    );
    assert_eq!(json_output.status.code(), Some(0));
    let json_stdout = String::from_utf8(json_output.stdout).expect("JSON stdout is UTF-8");
    let json_stderr = String::from_utf8(json_output.stderr).expect("JSON stderr is UTF-8");
    let item: Value = serde_json::from_str(&json_stdout).expect("pure item JSON stdout");
    assert_eq!(item["id"], 2);
    assert_eq!(item["title"], "json-mode-analysis");
    assert!(json_stderr.contains("正在分析图片... "));
    assert!(json_stderr.contains("MiniMax 分析失败"));
}

#[test]
fn library_analyze_failure_without_credentials_preserves_material_data_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("analyze-existing.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "initialize library analyze failure fixture",
    );

    let image = isolated.path().join("existing-material.png");
    fs::write(
        &image,
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/J9sAAAAASUVORK5CYII=",
        )
        .expect("decode existing material PNG fixture"),
    )
    .expect("write existing material PNG fixture");
    successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "library",
                "add",
                image.to_str().expect("image path UTF-8"),
                "--no-analyze",
                "--title",
                "既有素材",
            ],
        ),
        "seed material before analysis failure",
    );

    let (before_json, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["--json", "library", "show", "1"],
        ),
        "read material before analysis",
    );
    let before: Value = serde_json::from_str(&before_json).expect("material before JSON");
    assert!(stderr.is_empty());

    let failed = invoke_db_without_provider_credentials(
        isolated.path(),
        &database,
        &["--json", "library", "analyze", "1"],
    );
    assert_eq!(failed.status.code(), Some(2));
    assert!(failed.stdout.is_empty());
    let stderr = String::from_utf8(failed.stderr).expect("analysis failure stderr is UTF-8");
    assert!(stderr.contains("错误：未配置 MiniMax Token Plan 密钥"));
    assert!(stderr.contains("MINIMAX_API_KEY"));

    let (after_json, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["--json", "library", "show", "1"],
        ),
        "read material after analysis failure",
    );
    let after: Value = serde_json::from_str(&after_json).expect("material after JSON");
    assert_eq!(
        after, before,
        "failed analysis must not partially update item"
    );
    assert!(stderr.is_empty());
}

#[test]
fn profile_show_without_a_profile_is_a_successful_guidance_state() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("profile-show.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "profile show test database init",
    );

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["profile", "show"]),
        "profile show without a profile",
    );
    assert_eq!(
        stdout,
        "尚未初始化账号信息，运行：profile init --name ... --niche ...\n"
    );
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "profile", "show"]),
        "profile show without a profile as JSON",
    );
    assert_eq!(stdout, "null\n");
    assert!(stderr.is_empty());
}

#[test]
fn empty_cli_collections_keep_actionable_guidance_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("empty-collections.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "empty collections test database init",
    );

    for (args, expected_stdout, name) in [
        (&["library", "list"][..], "图库为空\n", "empty library list"),
        (
            &["accounts", "list"][..],
            "暂无榜样账号数据，可用 accounts add 手动录入\n",
            "empty accounts list",
        ),
        (&["content", "list"][..], "暂无笔记\n", "empty content list"),
    ] {
        let (stdout, stderr) =
            successful_command(invoke_db(isolated.path(), &database, args), name);
        assert_eq!(stdout, expected_stdout, "{name} stdout");
        assert!(stderr.is_empty(), "{name} should not write to stderr");
    }
}

#[test]
fn legacy_cli_missing_and_noop_states_keep_exit_contracts_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("legacy-contract.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "legacy CLI contract database init",
    );

    for (args, expected_stdout, name) in [
        (
            &["library", "show", "99999"][..],
            "物品 ID 99999 不存在\n",
            "missing library show",
        ),
        (
            &["content", "draft", "99999"][..],
            "物品 ID 99999 不存在\n",
            "missing content draft material",
        ),
        (
            &["content", "show", "99999"][..],
            "笔记 ID 99999 不存在\n",
            "missing content show",
        ),
        (
            &["content", "export", "99999"][..],
            "笔记 ID 99999 不存在\n",
            "missing content export",
        ),
        (
            &["content", "edit", "99999"][..],
            "笔记 ID 99999 不存在（或不属于当前账号）\n",
            "missing content edit",
        ),
    ] {
        let output = invoke_db(isolated.path(), &database, args);
        assert_eq!(output.status.code(), Some(1), "{name} exit code");
        assert_eq!(output.stdout, expected_stdout.as_bytes(), "{name} stdout");
        assert!(output.stderr.is_empty(), "{name} stderr");
    }

    let missing_json = invoke_db(
        isolated.path(),
        &database,
        &["--json", "library", "show", "99999"],
    );
    assert_eq!(missing_json.status.code(), Some(1));
    assert_eq!(
        serde_json::from_slice::<Value>(&missing_json.stdout).expect("JSON failure output"),
        serde_json::json!({"error":"物品 ID 99999 不存在"})
    );
    assert!(missing_json.stderr.is_empty());

    let missing_edit_json = invoke_db(
        isolated.path(),
        &database,
        &["--json", "content", "edit", "99999"],
    );
    assert_eq!(missing_edit_json.status.code(), Some(1));
    assert_eq!(
        serde_json::from_slice::<Value>(&missing_edit_json.stdout)
            .expect("JSON missing-edit output"),
        serde_json::json!({"error":"笔记 ID 99999 不存在（或不属于当前账号）"})
    );
    assert!(missing_edit_json.stderr.is_empty());

    for (args, expected_stdout, name) in [
        (
            &["accounts", "show", "missing-account"][..],
            "账号 missing-account 不存在\n",
            "missing accounts show",
        ),
        (
            &["accounts", "delete", "missing-account", "--yes"][..],
            "账号 missing-account 不存在\n",
            "missing accounts delete",
        ),
        (
            &["library", "delete", "99999", "--yes"][..],
            "物品 ID 99999 不存在\n",
            "missing library delete",
        ),
        (
            &["profile", "edit"][..],
            "未指定任何字段，无变更\n",
            "empty profile edit",
        ),
    ] {
        let (stdout, stderr) =
            successful_command(invoke_db(isolated.path(), &database, args), name);
        assert_eq!(stdout, expected_stdout, "{name} stdout");
        assert!(stderr.is_empty(), "{name} stderr");
    }

    for (args, expected_json, name) in [
        (
            &["--json", "accounts", "show", "missing-account"][..],
            serde_json::json!({"error":"账号 missing-account 不存在"}),
            "JSON missing accounts show",
        ),
        (
            &["--json", "accounts", "delete", "missing-account", "--yes"][..],
            serde_json::json!({"accountId":"missing-account","deleted":false}),
            "JSON missing accounts delete",
        ),
        (
            &["--json", "library", "delete", "99999", "--yes"][..],
            serde_json::json!({"id":99999,"deleted":false}),
            "JSON missing library delete",
        ),
        (
            &["--json", "profile", "edit"][..],
            serde_json::json!({"updated":false}),
            "JSON empty profile edit",
        ),
    ] {
        let output = invoke_db(isolated.path(), &database, args);
        assert_eq!(output.status.code(), Some(0), "{name} exit code");
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).expect("JSON no-op output"),
            expected_json,
            "{name} stdout"
        );
        assert!(output.stderr.is_empty(), "{name} stderr");
    }

    let image = isolated.path().join("sample.png");
    fs::write(
        &image,
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/J9sAAAAASUVORK5CYII=",
        )
        .expect("decode tiny PNG fixture"),
    )
    .expect("write isolated image fixture");
    successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "library",
                "add",
                image.to_str().expect("image path UTF-8"),
                "--no-analyze",
                "--title",
                "no-op edit fixture",
            ],
        ),
        "create no-op edit material fixture",
    );
    successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["content", "draft", "1", "--save"],
        ),
        "create no-op edit note fixture",
    );
    let (before, _) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["--json", "content", "show", "1"],
        ),
        "read note before no-op edit",
    );
    std::thread::sleep(std::time::Duration::from_secs(1));
    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["content", "edit", "1"]),
        "content edit without fields on an existing note",
    );
    assert_eq!(stdout, "✓ 笔记 ID=1 已更新（draft）\n");
    assert!(stderr.is_empty());
    let (after, _) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["--json", "content", "show", "1"],
        ),
        "read note after no-op edit",
    );
    let before = serde_json::from_str::<Value>(&before).expect("note before no-op edit JSON");
    let after = serde_json::from_str::<Value>(&after).expect("note after no-op edit JSON");
    assert_eq!(after["contentVersion"], before["contentVersion"]);
    assert_eq!(after["title"], before["title"]);
    assert_eq!(after["body"], before["body"]);
    assert_ne!(after["updatedAt"], before["updatedAt"]);
}

#[test]
fn profile_edit_persists_every_legacy_field_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("profile-edit.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "profile edit database init",
    );
    successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["profile", "init", "--name", "初始账号", "--niche", "家居"],
        ),
        "profile edit initial account",
    );

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "profile",
                "edit",
                "--name",
                "完整字段账号",
                "--niche",
                "软装",
                "--audience",
                "租房改造读者",
                "--pillars",
                "收纳,搭配,,预算",
                "--persona-name",
                "认真但不端着",
                "--persona-bio",
                "分享真实改造过程",
                "--persona-tone",
                "短句、具体",
                "--taboos",
                "#高级感,精致",
                "--styles",
                "奶油风,侘寂风",
                "--scenes",
                "客厅,卧室",
                "--hashtags",
                "#收纳,##软装",
                "--rhythm",
                "每周三篇",
                "--followers",
                "1234",
                "--total-notes",
                "56",
                "--avg-likes",
                "12.5",
                "--avg-comments",
                "2.25",
                "--avg-collects",
                "8.75",
            ],
        ),
        "profile edit all legacy fields",
    );
    assert_eq!(stdout, "✓ 已更新 17 个字段\n");
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "profile", "show"]),
        "read all updated profile fields as JSON",
    );
    let profile: Value = serde_json::from_str(&stdout).expect("profile show JSON");
    assert_eq!(profile["displayName"], "完整字段账号");
    assert_eq!(profile["niche"], "软装");
    assert_eq!(profile["targetAudience"], "租房改造读者");
    assert_eq!(
        profile["contentPillars"],
        serde_json::json!(["收纳", "搭配", "预算"])
    );
    assert_eq!(profile["personaName"], "认真但不端着");
    assert_eq!(profile["personaBio"], "分享真实改造过程");
    assert_eq!(profile["personaTone"], "短句、具体");
    assert_eq!(
        profile["personaTaboos"],
        serde_json::json!(["高级感", "精致"])
    );
    assert_eq!(
        profile["preferredStyles"],
        serde_json::json!(["奶油风", "侘寂风"])
    );
    assert_eq!(
        profile["preferredScenes"],
        serde_json::json!(["客厅", "卧室"])
    );
    assert_eq!(profile["hashtagPool"], serde_json::json!(["收纳", "软装"]));
    assert_eq!(profile["postingRhythm"], "每周三篇");
    assert_eq!(profile["followers"], 1234);
    assert_eq!(profile["totalNotes"], 56);
    assert_eq!(profile["avgLikes"], 12.5);
    assert_eq!(profile["avgComments"], 2.25);
    assert_eq!(profile["avgCollects"], 8.75);
    assert!(stderr.is_empty());

    let updated_at = profile["updatedAt"]
        .as_str()
        .expect("profile updated timestamp")
        .chars()
        .take(16)
        .collect::<String>();
    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["profile", "show"]),
        "profile show renders every populated legacy field",
    );
    assert_eq!(
        stdout,
        format!(
            "\n{}\n账号：完整字段账号\n{}\n\n【定位 & 容局】\n  垂类：软装\n  目标受众：租房改造读者\n  内容支柱：收纳、搭配、预算\n\n【人设】\n  名称：认真但不端着\n  简介：分享真实改造过程\n  语气：短句、具体\n  禁忌：高级感、精致\n\n【账号数据】\n  粉丝 1234  |  已发 56 篇  |  均赞 12.5  均评 2.25  均藏 8.75\n\n【创作偏好】\n  偏好风格：奶油风、侘寂风\n  偏好场景：客厅、卧室\n  标签池：#收纳  #软装\n  发帖节奏：每周三篇\n\n最后更新：{updated_at}\n\n",
            "═".repeat(50),
            "═".repeat(50)
        )
    );
    assert!(stderr.is_empty());
}

#[test]
fn crawl_history_process_is_account_scoped_and_preserves_text_json_and_limit_contracts() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("crawl-history.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "crawl history database init",
    );

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["crawl", "history"]),
        "empty crawl history",
    );
    assert_eq!(stdout, "当前账号暂无采集历史\n");
    assert!(stderr.is_empty());
    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "crawl", "history"]),
        "empty crawl history JSON",
    );
    assert_eq!(stdout, "[]\n");
    assert!(stderr.is_empty());

    let connection = rusqlite::Connection::open(&database).expect("open isolated crawl DB");
    let active_account_id: i64 = connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM app_settings WHERE key = 'active_account_id'",
            [],
            |row| row.get(0),
        )
        .expect("read active account ID");
    connection
        .execute(
            "INSERT INTO crawl_logs (keywords, count, source_file, created_at, account_pool_id)
             VALUES
                ('旧批次', 1, 'old.json', '2026-09-30 12:00:00', ?1),
                ('新批次', 3, 'new.json', '2026-10-01 12:00:00', ?1),
                ('其它账号私有记录', 8, 'other.json', '2026-10-02 12:00:00', ?2)",
            rusqlite::params![active_account_id, active_account_id + 999],
        )
        .expect("insert isolated account-scoped crawl history");
    drop(connection);

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["crawl", "history"]),
        "text crawl history",
    );
    assert_eq!(
        stdout,
        "ID\t时间\t笔记数\t关键词\t文件\n2\t2026-10-01 12:00:00\t3\t新批次\tnew.json\n1\t2026-09-30 12:00:00\t1\t旧批次\told.json\n"
    );
    assert!(!stdout.contains("其它账号私有记录"));
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["--json", "crawl", "history", "--limit", "1"],
        ),
        "limited crawl history JSON",
    );
    let history: Value = serde_json::from_str(&stdout).expect("crawl history JSON stdout");
    assert_eq!(history.as_array().map(Vec::len), Some(1));
    assert_eq!(history[0]["keywords"], "新批次");
    assert_eq!(history[0]["source_file"], "new.json");
    assert!(stderr.is_empty());

    for args in [
        &["crawl", "history", "--limit", "0"][..],
        &["crawl", "history", "--limit", "101"][..],
        &["crawl", "history", "--limit", "1", "--limit", "2"][..],
        &["crawl", "history", "--unexpected"][..],
    ] {
        let output = invoke_db(isolated.path(), &database, args);
        assert_eq!(output.status.code(), Some(2), "invalid args: {args:?}");
        assert!(output.stdout.is_empty(), "invalid args: {args:?}");
        assert!(!output.stderr.is_empty(), "invalid args: {args:?}");
    }
}

#[cfg(unix)]
#[test]
fn search_process_uses_the_browser_worker_and_preserves_file_and_history_contracts_without_python()
{
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("search-process.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "search process database init",
    );

    let node = std::env::split_paths(&std::env::var_os("PATH").expect("test PATH"))
        .map(|directory| directory.join("node"))
        .find(|candidate| candidate.is_file())
        .expect("Node.js is installed for the isolated browser-worker contract");
    let worker_dir = isolated.path().join("browser-worker-fixture");
    fs::create_dir_all(&worker_dir).expect("create fake browser worker directory");
    let worker_script = r#"
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const actionsFile = process.env.AICHIHONGSHU_TEST_WORKER_ACTIONS;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
send({ protocolVersion: 1, type: "ready" });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  appendFileSync(actionsFile, JSON.stringify(request) + "\n");
  let result = { status: "running", accountId: request.accountId };
  if (request.action === "search-notes") {
    const url = new URL(request.url);
    const keyword = url.searchParams.get("keyword");
    result = keyword === "未登录" ? { state: "login-required", items: [] } : {
      state: "complete",
      items: ["note-a", "note-b"].map((noteId, index) => ({
          note_id: noteId,
          note_url: `https://www.xiaohongshu.com/explore/${noteId}`,
          title: `${keyword}灵感 ${index + 1}`,
          desc: `${keyword}描述 ${index + 1}`,
          liked_count: String(12 + index),
          comment_count: String(2 + index),
          collected_count: String(4 + index),
          tags: [keyword],
        })),
      };
  }
  if (request.action === "shutdown") result = { status: "closed" };
  send({ protocolVersion: 1, type: "response", requestId: request.requestId, ok: true, result });
  if (request.action === "shutdown") break;
}
"#;
    fs::write(worker_dir.join("worker.mjs"), worker_script)
        .expect("write deterministic search worker fixture");
    let worker_actions = isolated.path().join("worker-actions.jsonl");
    let output_dir = isolated.path().join("search-results");
    let mut command = Command::new(env!("CARGO_BIN_EXE_rn"));
    command
        .arg("--db")
        .arg(&database)
        .arg("--json")
        .arg("search")
        .arg("--keywords")
        .arg("家居,软装")
        .arg("--count")
        .arg("2")
        .arg("--output-dir")
        .arg(&output_dir)
        .arg("--save-db")
        .current_dir(isolated.path())
        .env_clear()
        .env("HOME", isolated.path())
        .env("PATH", isolated.path())
        .env("AICHIHONGSHU_NODE", &node)
        .env("AICHIHONGSHU_BROWSER_WORKER_DIR", &worker_dir)
        .env("AICHIHONGSHU_TEST_WORKER_ACTIONS", &worker_actions);
    let output = command
        .output()
        .expect("run rn search with fake Node worker and no Python");
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr={:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).expect("search stdout stays JSON");
    assert_eq!(report["keywords"], serde_json::json!(["家居", "软装"]));
    assert_eq!(report["count"], 4);
    let items = report["items"].as_array().expect("search items array");
    assert_eq!(items.len(), 4);
    assert_eq!(items[0]["keyword"], "家居");
    assert_eq!(items[1]["title"], "家居灵感 2");
    assert_eq!(items[2]["keyword"], "软装");
    assert_eq!(items[2]["desc"], "软装描述 1");
    assert_eq!(items[3]["liked_count"], "13");
    assert!(items.iter().all(|item| item["tags"][0] == item["keyword"]));

    let source_file = report["source_file"]
        .as_str()
        .expect("search source file path");
    let source_file = PathBuf::from(source_file);
    assert!(source_file.starts_with(&output_dir));
    let saved_items: Value =
        serde_json::from_slice(&fs::read(&source_file).expect("read saved browser search results"))
            .expect("saved search JSON");
    assert_eq!(saved_items, report["items"]);

    let stderr = String::from_utf8(output.stderr).expect("search progress stderr is UTF-8");
    assert!(stderr.contains("正在搜索「家居」，最多读取 2 篇已渲染笔记"));
    assert!(stderr.contains("正在搜索「软装」，最多读取 2 篇已渲染笔记"));
    let actions = fs::read_to_string(&worker_actions).expect("browser worker action log");
    let actions = actions
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("worker action JSON"))
        .collect::<Vec<_>>();
    let search_requests = actions
        .iter()
        .filter(|request| request["action"] == "search-notes")
        .collect::<Vec<_>>();
    assert_eq!(search_requests.len(), 2);
    assert_eq!(
        search_requests[0]["accountId"],
        search_requests[1]["accountId"]
    );
    assert_eq!(
        search_requests[0]["url"],
        "https://www.xiaohongshu.com/search_result?keyword=%E5%AE%B6%E5%B1%85&max_count=2"
    );
    assert_eq!(
        search_requests[1]["url"],
        "https://www.xiaohongshu.com/search_result?keyword=%E8%BD%AF%E8%A3%85&max_count=2"
    );
    assert_eq!(
        actions.last().expect("worker shutdown action")["action"],
        "shutdown"
    );

    let mut login_required = Command::new(env!("CARGO_BIN_EXE_rn"));
    login_required
        .arg("--db")
        .arg(&database)
        .arg("--json")
        .arg("search")
        .arg("--keywords")
        .arg("未登录")
        .arg("--output-dir")
        .arg(&output_dir)
        .current_dir(isolated.path())
        .env_clear()
        .env("HOME", isolated.path())
        .env("PATH", isolated.path())
        .env("AICHIHONGSHU_NODE", &node)
        .env("AICHIHONGSHU_BROWSER_WORKER_DIR", &worker_dir)
        .env("AICHIHONGSHU_TEST_WORKER_ACTIONS", &worker_actions);
    let failed_search = login_required
        .output()
        .expect("run rn search against the deterministic login-required fixture");
    assert_eq!(failed_search.status.code(), Some(2));
    assert!(failed_search.stdout.is_empty());
    let failed_stderr = String::from_utf8(failed_search.stderr).expect("search error is UTF-8");
    assert!(failed_stderr.contains("独立浏览器尚未登录"));
    let actions = fs::read_to_string(&worker_actions).expect("browser worker action log");
    let last_action = actions
        .lines()
        .last()
        .expect("failed search worker shutdown");
    assert_eq!(
        serde_json::from_str::<Value>(last_action).expect("failed search shutdown JSON")["action"],
        "shutdown"
    );

    let mut plain_search = Command::new(env!("CARGO_BIN_EXE_rn"));
    plain_search
        .arg("--db")
        .arg(&database)
        .arg("search")
        .arg("--keywords")
        .arg("客厅")
        .arg("--count")
        .arg("1")
        .arg("--output-dir")
        .arg(&output_dir)
        .current_dir(isolated.path())
        .env_clear()
        .env("HOME", isolated.path())
        .env("PATH", isolated.path())
        .env("AICHIHONGSHU_NODE", &node)
        .env("AICHIHONGSHU_BROWSER_WORKER_DIR", &worker_dir)
        .env("AICHIHONGSHU_TEST_WORKER_ACTIONS", &worker_actions);
    let plain_output = plain_search
        .output()
        .expect("run rn search plain-text mode against the deterministic worker");
    assert_eq!(plain_output.status.code(), Some(0));
    let plain_stdout = String::from_utf8(plain_output.stdout).expect("plain search stdout UTF-8");
    let plain_lines = plain_stdout.lines().collect::<Vec<_>>();
    assert_eq!(plain_lines.len(), 2);
    assert_eq!(plain_lines[0], "搜索完成，共 2 条笔记");
    assert!(plain_lines[1].starts_with("结果已保存："));
    assert!(Path::new(plain_lines[1].trim_start_matches("结果已保存：")).is_file());
    assert_eq!(
        String::from_utf8(plain_output.stderr).expect("plain search stderr UTF-8"),
        "正在搜索「客厅」，最多读取 1 篇已渲染笔记……\n"
    );
    let actions = fs::read_to_string(&worker_actions).expect("browser worker action log");
    let last_action = actions
        .lines()
        .last()
        .expect("plain search worker shutdown");
    assert_eq!(
        serde_json::from_str::<Value>(last_action).expect("plain search shutdown JSON")["action"],
        "shutdown"
    );

    let (history_stdout, history_stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "crawl", "history"]),
        "crawl history after search --save-db",
    );
    let history: Value = serde_json::from_str(&history_stdout).expect("search crawl history JSON");
    assert_eq!(history.as_array().map(Vec::len), Some(1));
    assert_eq!(history[0]["keywords"], "家居,软装");
    assert_eq!(history[0]["count"], 4);
    assert_eq!(history[0]["source_file"], source_file.display().to_string());
    assert!(history_stderr.is_empty());
}

#[test]
fn analyze_process_preserves_legacy_json_console_file_and_history_contracts_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("analyze-process.db");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "analyze process database init",
    );

    let input = isolated.path().join("crawl.json");
    fs::write(
        &input,
        include_str!("../../services/tests/fixtures/xhs_analyze_legacy_input.json"),
    )
    .expect("write anonymous legacy crawl fixture");
    let json_output_dir = isolated.path().join("json-analysis");
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "--json",
                "analyze",
                "--input",
                input.to_str().expect("fixture input path UTF-8"),
                "--keywords",
                "家居/软装",
                "--output-dir",
                json_output_dir
                    .to_str()
                    .expect("JSON output directory UTF-8"),
                "--save-db",
            ],
        ),
        "analyze JSON process contract",
    );
    let report: Value = serde_json::from_str(&stdout).expect("analyze JSON stdout");
    let expected: Value = serde_json::from_str(include_str!(
        "../../services/tests/fixtures/xhs_analyze_legacy_report.json"
    ))
    .expect("legacy analysis report fixture");
    assert_eq!(report, expected);
    assert!(stderr.is_empty());

    let json_reports = fs::read_dir(&json_output_dir)
        .expect("read isolated JSON report directory")
        .map(|entry| entry.expect("JSON report entry").path())
        .collect::<Vec<_>>();
    assert_eq!(json_reports.len(), 1);
    let saved_report: Value =
        serde_json::from_slice(&fs::read(&json_reports[0]).expect("read saved JSON report"))
            .expect("saved analysis JSON");
    assert_eq!(saved_report, expected);

    let input_arg = input.to_str().expect("fixture input path UTF-8");
    let text_output_dir = isolated.path().join("text-analysis");
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "analyze",
                "--input",
                input_arg,
                "--keywords",
                "家居,软装",
                "--output-dir",
                text_output_dir
                    .to_str()
                    .expect("text output directory UTF-8"),
            ],
        ),
        "analyze console process contract",
    );
    assert!(
        stdout.starts_with(
            "\n============================================================\n  小红书首页推荐流分析报告\n  关键词：家居,软装  |  生成时间："
        ),
        "stdout={stdout}"
    );
    assert!(stdout.contains("【数据概览】共 3 条笔记"));
    assert!(stdout.contains("【高频钩子词 TOP8】"));
    assert!(stdout.contains("【高互动样本 TOP10】"));
    assert!(stdout.contains("【可复用模式推断】"));
    assert!(stdout.contains("[xhs_analyze] 分析结果已保存到："));
    assert!(stderr.is_empty());

    let history = invoke_db(isolated.path(), &database, &["--json", "crawl", "history"]);
    let (history_stdout, stderr) = successful_command(history, "history after analyze --save-db");
    let history: Value = serde_json::from_str(&history_stdout).expect("crawl history JSON");
    assert_eq!(history.as_array().map(Vec::len), Some(1));
    assert_eq!(history[0]["keywords"], "家居/软装");
    assert_eq!(history[0]["count"], 3);
    assert_eq!(history[0]["source_file"], input_arg);
    assert!(stderr.is_empty());
}

#[test]
fn mcp_stdio_process_keeps_stdout_as_jsonrpc_without_python_on_path() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("mcp.db");
    fs::create_dir_all(database.parent().expect("database parent"))
        .expect("create isolated MCP data directory");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "MCP test database init",
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_rn"))
        .arg("--db")
        .arg(&database)
        .arg("mcp")
        .current_dir(isolated.path())
        .env("HOME", isolated.path())
        .env("USERPROFILE", isolated.path())
        .env("PATH", isolated.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start Rust MCP process with an isolated, empty PATH");

    {
        let stdin = child.stdin.as_mut().expect("MCP stdin");
        let mut send = |message: &[u8]| {
            stdin
                .write_all(message)
                .and_then(|()| stdin.write_all(b"\n"))
        };
        send(br#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
            .expect("write pre-initialize MCP request");
        send(br#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}"#)
            .expect("write MCP initialize request");
        send(br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .expect("write MCP initialized notification");
        send(br#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#)
            .expect("write MCP tools/list request");
        send(br#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_item","arguments":null}}"#)
            .expect("write MCP call with non-object arguments");
        send(br#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_item","arguments":{}}}"#)
            .expect("write MCP call with missing required arguments");
        send(br#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_item","arguments":{"item_id":999999}}}"#)
            .expect("write MCP call for missing item");
    }
    drop(child.stdin.take());

    let output = child
        .wait_with_output()
        .expect("collect MCP process output after EOF");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    let replies = String::from_utf8(output.stdout)
        .expect("MCP stdout is UTF-8")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("each MCP stdout line is JSON"))
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 6);
    assert_eq!(replies[0]["error"]["code"], -32002);
    assert_eq!(replies[1]["result"]["serverInfo"]["name"], "rednote-home");
    assert_eq!(replies[2]["result"]["tools"].as_array().unwrap().len(), 22);
    assert_eq!(replies[3]["id"], 4);
    assert_eq!(replies[3]["result"]["isError"], true);
    assert!(replies[3]["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Input validation error:"));
    assert_eq!(replies[4]["id"], 5);
    assert_eq!(replies[4]["result"]["isError"], true);
    assert_eq!(
        replies[4]["result"]["content"][0]["text"],
        "Input validation error: 'item_id' is a required property"
    );
    assert_eq!(replies[5]["id"], 6);
    assert_eq!(replies[5]["result"]["isError"], false);
    let missing_item: Value = serde_json::from_str(
        replies[5]["result"]["content"][0]["text"]
            .as_str()
            .expect("missing item result text"),
    )
    .expect("business result is JSON text");
    assert_eq!(missing_item["error"], "物品 999999 不存在");
}

#[test]
fn mcp_stdio_process_runs_pc_memory_experience_and_search_lifecycle_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("mcp-lifecycle.db");
    fs::create_dir_all(database.parent().expect("database parent"))
        .expect("create isolated MCP data directory");
    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "MCP lifecycle test database init",
    );

    let mut child = Command::new(env!("CARGO_BIN_EXE_rn"))
        .arg("--db")
        .arg(&database)
        .arg("mcp")
        .current_dir(isolated.path())
        .env("HOME", isolated.path())
        .env("USERPROFILE", isolated.path())
        .env("PATH", isolated.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start Rust MCP lifecycle process with an isolated, empty PATH");
    let mut stdin = child.stdin.take().expect("MCP stdin");
    let mut stdout = std::io::BufReader::new(child.stdout.take().expect("MCP stdout"));

    let initialized = exchange_mcp_message(
        &mut stdin,
        &mut stdout,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":1, "method":"initialize",
            "params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"contract-test","version":"1"}}
        }),
    );
    assert_eq!(initialized["result"]["serverInfo"]["name"], "rednote-home");
    serde_json::to_writer(
        &mut stdin,
        &serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .expect("serialize MCP initialized notification");
    stdin
        .write_all(b"\n")
        .expect("write MCP initialized delimiter");
    stdin.flush().expect("flush MCP initialized notification");

    let tools = exchange_mcp_message(
        &mut stdin,
        &mut stdout,
        &serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    );
    assert_eq!(tools["result"]["tools"].as_array().map(Vec::len), Some(22));

    let created_memory = exchange_mcp_message(
        &mut stdin,
        &mut stdout,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":3, "method":"tools/call",
            "params":{"name":"save_memory_entry","arguments":{"kind":"fact","content":"stdio lifecycle memory","source":"user"}}
        }),
    );
    assert_eq!(created_memory["result"]["isError"], false);
    let created_memory = mcp_text_result(&created_memory);
    assert_eq!(created_memory["origin"], "pc");
    assert_eq!(created_memory["confirm_status"], "candidate");
    let memory_id = created_memory["id"].as_i64().expect("created memory ID");

    let listed_memory = exchange_mcp_message(
        &mut stdin,
        &mut stdout,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":4, "method":"tools/call",
            "params":{"name":"list_memory_entries","arguments":{}}
        }),
    );
    assert_eq!(mcp_text_results(&listed_memory)[0]["id"], memory_id);

    let disabled_memory = exchange_mcp_message(
        &mut stdin,
        &mut stdout,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":5, "method":"tools/call",
            "params":{"name":"set_memory_entry_state","arguments":{"memory_id":memory_id,"enabled":false}}
        }),
    );
    assert_eq!(mcp_text_result(&disabled_memory)["enabled"], false);
    let deleted_memory = exchange_mcp_message(
        &mut stdin,
        &mut stdout,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":6, "method":"tools/call",
            "params":{"name":"delete_memory_entry","arguments":{"memory_id":memory_id}}
        }),
    );
    assert_eq!(mcp_text_result(&deleted_memory)["deleted"], true);

    let rejected_source = exchange_mcp_message(
        &mut stdin,
        &mut stdout,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":7, "method":"tools/call",
            "params":{"name":"save_experience_prompt","arguments":{"title":"invalid source","content":"must reject","source":"release-smoke"}}
        }),
    );
    assert_eq!(rejected_source["result"]["isError"], true);

    let created_experience = exchange_mcp_message(
        &mut stdin,
        &mut stdout,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":8, "method":"tools/call",
            "params":{"name":"save_experience_prompt","arguments":{"title":"stdio lifecycle","content":"Keep it concise.","source":"from_memory"}}
        }),
    );
    assert_eq!(created_experience["result"]["isError"], false);
    let created_experience = mcp_text_result(&created_experience);
    assert_eq!(created_experience["origin"], "pc");
    let experience_id = created_experience["id"]
        .as_i64()
        .expect("created experience ID");

    let listed_experience = exchange_mcp_message(
        &mut stdin,
        &mut stdout,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":9, "method":"tools/call",
            "params":{"name":"list_experience_prompts","arguments":{}}
        }),
    );
    assert_eq!(mcp_text_results(&listed_experience)[0]["id"], experience_id);

    let updated_experience = exchange_mcp_message(
        &mut stdin,
        &mut stdout,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":10, "method":"tools/call",
            "params":{"name":"save_experience_prompt","arguments":{"experience_id":experience_id,"title":"stdio lifecycle updated","content":"Still concise.","enabled":false}}
        }),
    );
    let updated_experience = mcp_text_result(&updated_experience);
    assert_eq!(updated_experience["enabled"], false);
    assert_eq!(updated_experience["source"], "from_memory");

    let deleted_experience = exchange_mcp_message(
        &mut stdin,
        &mut stdout,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":11, "method":"tools/call",
            "params":{"name":"delete_experience_prompt","arguments":{"experience_id":experience_id}}
        }),
    );
    assert_eq!(mcp_text_result(&deleted_experience)["deleted"], true);

    let empty_search = exchange_mcp_message(
        &mut stdin,
        &mut stdout,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":12, "method":"tools/call",
            "params":{"name":"search_notes","arguments":{"keyword":"no-match"}}
        }),
    );
    assert_eq!(empty_search["result"]["isError"], false);
    assert!(mcp_text_results(&empty_search).is_empty());

    drop(stdin);
    let output = child
        .wait_with_output()
        .expect("wait for MCP lifecycle process after EOF");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    let mut remaining = String::new();
    stdout
        .read_to_string(&mut remaining)
        .expect("read trailing MCP stdout");
    assert!(
        remaining.is_empty(),
        "unexpected trailing stdout: {remaining}"
    );
}

#[test]
fn mcp_process_imports_authorized_images_and_rejects_paths_outside_the_allowlist() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("mcp-import.db");
    let allowed_dir = isolated.path().join("allowed-imports");
    fs::create_dir_all(database.parent().expect("database parent"))
        .expect("create isolated data directory");
    fs::create_dir_all(&allowed_dir).expect("create MCP import allowlist");

    let image_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    )
    .expect("decode tiny PNG fixture");
    let allowed_image = allowed_dir.join("authorized.png");
    fs::write(&allowed_image, &image_bytes).expect("write authorized PNG fixture");
    let blank_title_image = allowed_dir.join("blank-title.png");
    fs::write(
        &blank_title_image,
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        )
        .expect("decode distinct PNG fixture"),
    )
    .expect("write blank-title PNG fixture");
    let default_analyze_image = allowed_dir.join("default-analyze.png");
    fs::write(&default_analyze_image, &image_bytes).expect("write default-analyze PNG fixture");
    let outside_image = isolated.path().join("outside.png");
    fs::write(&outside_image, image_bytes).expect("write outside PNG fixture");

    successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "MCP import test database init",
    );

    let mut child = Command::new(env!("CARGO_BIN_EXE_rn"))
        .arg("--db")
        .arg(&database)
        .arg("mcp")
        .current_dir(isolated.path())
        .env("HOME", isolated.path())
        .env("USERPROFILE", isolated.path())
        .env("PATH", isolated.path())
        .env_remove("MINIMAX_API_KEY")
        .env_remove("AICHIHONGSHU_MINIMAX_API_KEY")
        .env("AICHIHONGSHU_MCP_ALLOWED_IMPORT_DIR", &allowed_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start isolated MCP process with an explicit image allowlist");

    {
        let stdin = child.stdin.as_mut().expect("MCP stdin");
        let mut send = |message: Value| {
            serde_json::to_writer(&mut *stdin, &message)
                .and_then(|()| stdin.write_all(b"\n").map_err(serde_json::Error::io))
        };
        send(serde_json::json!({
            "jsonrpc":"2.0", "id":1, "method":"initialize",
            "params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"contract-test","version":"1"}}
        }))
        .expect("send MCP initialize");
        send(serde_json::json!({
            "jsonrpc":"2.0", "method":"notifications/initialized"
        }))
        .expect("send MCP initialized notification");
        send(serde_json::json!({
            "jsonrpc":"2.0", "id":2, "method":"tools/call",
            "params":{"name":"add_item_from_path","arguments":{"image_path":allowed_image,"title":"授权目录素材","analyze":false}}
        }))
        .expect("send authorized image import");
        send(serde_json::json!({
            "jsonrpc":"2.0", "id":3, "method":"tools/call",
            "params":{"name":"add_item_from_path","arguments":{"image_path":blank_title_image,"title":"","analyze":false}}
        }))
        .expect("send authorized import with an empty title");
        send(serde_json::json!({
            "jsonrpc":"2.0", "id":4, "method":"tools/call",
            "params":{"name":"add_item_from_path","arguments":{"image_path":default_analyze_image}}
        }))
        .expect("send authorized default-analysis import without provider credentials");
        send(serde_json::json!({
            "jsonrpc":"2.0", "id":5, "method":"tools/call",
            "params":{"name":"list_items","arguments":{}}
        }))
        .expect("send MCP list items");
        send(serde_json::json!({
            "jsonrpc":"2.0", "id":6, "method":"tools/call",
            "params":{"name":"add_item_from_path","arguments":{"image_path":outside_image,"analyze":false}}
        }))
        .expect("send outside-allowlist import");
    }
    drop(child.stdin.take());

    let output = child
        .wait_with_output()
        .expect("collect MCP process output after EOF");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    let replies = String::from_utf8(output.stdout)
        .expect("MCP stdout is UTF-8")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("each MCP stdout line is JSON"))
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 6);
    assert_eq!(replies[1]["id"], 2);
    assert_eq!(replies[1]["result"]["isError"], false);
    let imported: Value = serde_json::from_str(
        replies[1]["result"]["content"][0]["text"]
            .as_str()
            .expect("authorized import result text"),
    )
    .expect("authorized import result is serialized JSON");
    assert_eq!(imported["title"], "授权目录素材");
    assert_eq!(imported["analysis_raw"], Value::Null);

    assert_eq!(replies[2]["id"], 3);
    assert_eq!(replies[2]["result"]["isError"], false);
    let empty_title_import: Value = serde_json::from_str(
        replies[2]["result"]["content"][0]["text"]
            .as_str()
            .expect("empty-title import result text"),
    )
    .expect("empty-title import result is serialized JSON");
    assert_eq!(empty_title_import["title"], "blank-title");

    assert_eq!(replies[3]["id"], 4);
    assert_eq!(replies[3]["result"]["isError"], true);
    assert!(replies[3]["result"]["content"][0]["text"]
        .as_str()
        .expect("default analysis error text")
        .contains("未配置 MiniMax Token Plan 密钥"));

    assert_eq!(replies[4]["id"], 5);
    assert_eq!(replies[4]["result"]["isError"], false);
    let listed_items = replies[4]["result"]["content"]
        .as_array()
        .expect("list_items returns one content block per item")
        .iter()
        .map(|block| {
            serde_json::from_str::<Value>(block["text"].as_str().expect("listed item result text"))
                .expect("listed item is serialized JSON")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        listed_items.len(),
        2,
        "failed analysis must not import an image"
    );
    assert!(!listed_items
        .iter()
        .any(|item| item["title"] == "default-analyze"));

    let listed_authorized = listed_items
        .iter()
        .find(|item| item["title"] == "授权目录素材")
        .expect("authorized image is visible in list_items");
    assert_eq!(listed_authorized["id"], imported["id"]);
    let listed_empty_title = listed_items
        .iter()
        .find(|item| item["title"] == "blank-title")
        .expect("empty-title image is visible in list_items");
    assert_eq!(listed_empty_title["id"], empty_title_import["id"]);

    assert_eq!(replies[5]["id"], 6);
    assert_eq!(replies[5]["result"]["isError"], true);
    assert_eq!(
        replies[5]["result"]["content"][0]["text"],
        "Error executing tool add_item_from_path: 图片必须是 MCP 授权目录中的普通文件"
    );
}

#[test]
fn closed_gui_local_workflow_runs_through_the_cli_process_without_python() {
    let isolated = IsolatedDirectory::new();
    let database = isolated.path().join("data").join("app.db");
    let image = isolated.path().join("sample.png");
    let export = isolated.path().join("exports").join("note.md");
    fs::create_dir_all(database.parent().expect("database parent"))
        .expect("create isolated data directory");
    fs::create_dir_all(export.parent().expect("export parent"))
        .expect("create isolated export directory");
    fs::write(
        &image,
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/J9sAAAAASUVORK5CYII=",
        )
        .expect("decode tiny PNG fixture"),
    )
    .expect("write isolated image fixture");

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["db", "init", "--yes"]),
        "db init",
    );
    assert_eq!(stdout, "✓ 数据库初始化完成\n");
    assert!(stderr.is_empty());

    for (args, expected_stdout, description) in [
        (
            &[][..],
            "请提供 --name（账号显示名）或 --url（账号主页URL，自动推断）\n",
            "profile init missing name",
        ),
        (
            &["--name", "", "--niche", "家居"][..],
            "请提供 --name（账号显示名）或 --url（账号主页URL，自动推断）\n",
            "profile init empty name",
        ),
        (
            &["--name", "家居账号", "--niche", ""][..],
            "请提供 --niche（垂类定位）或 --url（账号主页URL，自动推断）\n",
            "profile init empty niche",
        ),
    ] {
        let mut command = vec!["profile", "init"];
        command.extend_from_slice(args);
        let invalid_profile = invoke_db(isolated.path(), &database, &command);
        assert_eq!(invalid_profile.status.code(), Some(1), "{description}");
        assert_eq!(
            invalid_profile.stdout,
            expected_stdout.as_bytes(),
            "{description}"
        );
        assert!(invalid_profile.stderr.is_empty(), "{description}");
    }

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "content", "topic"]),
        "content topic on an empty library",
    );
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).expect("empty topic JSON stdout"),
        serde_json::json!({"prompt":null,"itemCount":0})
    );
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "profile",
                "init",
                "--name",
                "CLI 测试账号",
                "--niche",
                "家居",
            ],
        ),
        "profile init",
    );
    assert_eq!(
        stdout,
        "\n✓ 账号人设已写入数据库：CLI 测试账号\n  垂类：家居\n运行 profile show 查看完整信息 | profile edit 修正字段\n"
    );
    assert!(stderr.is_empty());

    let (profile_json, _) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "profile", "show"]),
        "profile show JSON fixture",
    );
    let profile: Value = serde_json::from_str(&profile_json).expect("profile JSON fixture");
    let updated_at = profile["updatedAt"]
        .as_str()
        .expect("profile update timestamp")
        .chars()
        .take(16)
        .collect::<String>();
    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["profile", "show"]),
        "profile show detail",
    );
    assert_eq!(
        stdout,
        format!(
            "\n{}\n账号：CLI 测试账号\n{}\n\n【定位 & 容局】\n  垂类：家居\n\n【人设】\n  名称：—\n\n【账号数据】\n  粉丝 0  |  已发 0 篇  |  均赞 0.0  均评 0.0  均藏 0.0\n\n【创作偏好】\n\n最后更新：{updated_at}\n\n",
            "═".repeat(50),
            "═".repeat(50)
        )
    );
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["profile", "edit", "--audience", "租房改造读者"],
        ),
        "profile edit",
    );
    assert_eq!(stdout, "✓ 已更新 1 个字段\n");
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["profile", "edit", "--persona-tone", "-短句换行"],
        ),
        "profile edit accepts a leading-hyphen option value",
    );
    assert_eq!(stdout, "✓ 已更新 1 个字段\n");
    assert!(stderr.is_empty());
    let (profile_json, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "profile", "show"]),
        "profile show after a leading-hyphen option value",
    );
    let profile: Value = serde_json::from_str(&profile_json).expect("profile JSON");
    assert_eq!(profile["personaTone"], "-短句换行");
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "library",
                "add",
                image.to_str().expect("image path UTF-8"),
                "--no-analyze",
                "--title",
                "CLI 测试素材",
            ],
        ),
        "library add",
    );
    assert!(stdout.starts_with("✓ 已添加物品 ID=1：CLI 测试素材\n\n#1 CLI 测试素材\n"));
    assert!(stdout.contains("  图片："));
    assert!(stderr.is_empty());

    let second_image = isolated.path().join("sample-second.png");
    fs::write(
        &second_image,
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        )
        .expect("decode distinct PNG fixture"),
    )
    .expect("write second isolated image fixture");
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "library",
                "add",
                second_image.to_str().expect("second image path UTF-8"),
                "--no-analyze",
                "--title",
                "CLI 第二素材",
            ],
        ),
        "library add second topic fixture",
    );
    assert!(
        stdout.starts_with("✓ 已添加物品 ID=2：CLI 第二素材\n\n#2 CLI 第二素材\n"),
        "second fixture import stdout={stdout:?}, stderr={stderr:?}"
    );
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["library", "list"]),
        "library list text contract",
    );
    assert!(stdout.starts_with("ID\t名称\t风格\t材质\t场景\t标签\t笔记数\n"));
    assert!(stdout.contains("1\tCLI 测试素材\t—\t—\t—\t—\t0\n"));
    assert!(stdout.contains("2\tCLI 第二素材\t—\t—\t—\t—\t0\n"));
    assert!(stdout.ends_with("共 2 件\n"));
    assert!(stderr.is_empty());

    let analysis_file = isolated.path().join("analysis.json");
    fs::write(
        &analysis_file,
        serde_json::to_vec(&serde_json::json!({
            "top_hooks": [["收纳", 12], ["改造", 3], ["预算", 2], ["清洁", 1], ["布局", 1], ["ignored", 99]],
            "top_items": [
                {"_title": "高赞标题一"},
                {"_title": "", "title": "高赞标题二"},
                {"title": "高赞标题三"},
                {"title": "不应显示的第四条"}
            ]
        }))
        .expect("serialize legacy analysis report fixture"),
    )
    .expect("write topic analysis report fixture");
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "accounts",
                "add",
                "qa-reference",
                "--name",
                "隔离榜样",
                "--avg-likes",
                "20",
                "--avg-comments",
                "4",
                "--style",
                "{\"标题风格\":\"数字清单\",\"情绪调性\":\"务实\"}",
            ],
        ),
        "create topic reference account fixture",
    );
    assert_eq!(stdout, "✓ 已录入账号 隔离榜样（qa-reference）\n");
    assert!(stderr.is_empty());
    successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "accounts",
                "add",
                "second-reference-account-id-is-long",
                "--name",
                "第二榜样",
                "--note-count",
                "5",
                "--avg-likes",
                "10.5",
                "--avg-comments",
                "1.25",
                "--avg-collects",
                "4",
            ],
        ),
        "create second reference account fixture",
    );
    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "accounts", "list"]),
        "accounts list JSON timestamp source",
    );
    let accounts: Value = serde_json::from_str(&stdout).expect("accounts list JSON");
    let accounts = accounts.as_array().expect("reference account array");
    assert_eq!(accounts.len(), 2);
    assert_eq!(
        accounts[0]["accountId"],
        "second-reference-account-id-is-long"
    );
    assert_eq!(accounts[1]["accountId"], "qa-reference");
    let newest_crawled_at = accounts[0]["crawledAt"]
        .as_str()
        .expect("newest reference crawl timestamp")
        .chars()
        .take(16)
        .collect::<String>();
    let oldest_crawled_at = accounts[1]["crawledAt"]
        .as_str()
        .expect("oldest reference crawl timestamp")
        .chars()
        .take(16)
        .collect::<String>();
    assert!(stderr.is_empty());
    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["accounts", "list"]),
        "accounts list text contract",
    );
    assert_eq!(
        stdout,
        format!(
            "account_id\t名称\t笔记数\t均赞\t均评\t均藏\t抓取时间\nsecond-reference-account\t第二榜样\t5\t10.5\t1.25\t4.0\t{newest_crawled_at}\nqa-reference\t隔离榜样\t0\t20.0\t4.0\t0.0\t{oldest_crawled_at}\n"
        )
    );
    assert!(stderr.is_empty());
    let topic = invoke_db(
        isolated.path(),
        &database,
        &[
            "--json",
            "content",
            "topic",
            "--account-id",
            "qa-reference",
            "--item-ids",
            "2,1,999999,2",
            "--analysis-file",
            analysis_file.to_str().expect("analysis path UTF-8"),
            "--extra",
            "只用真实热信号",
        ],
    );
    let (stdout, stderr) = successful_command(topic, "content topic JSON contract");
    let topic_json: Value = serde_json::from_str(&stdout).expect("topic JSON stdout");
    assert_eq!(topic_json["itemCount"], 3);
    let topic_prompt = topic_json["prompt"].as_str().expect("topic prompt string");
    let second_title_position = topic_prompt
        .find("CLI 第二素材（·）")
        .expect("requested first item occurs in generated prompt");
    let first_title_position = topic_prompt
        .find("CLI 测试素材（·）")
        .expect("requested second item occurs in generated prompt");
    let repeated_second_title_position = topic_prompt
        .rfind("CLI 第二素材（·）")
        .expect("duplicate requested item is preserved");
    assert!(second_title_position < first_title_position);
    assert!(first_title_position < repeated_second_title_position);
    assert!(topic_prompt.contains("高频钩子词：收纳(12)  改造(3)  预算(2)  清洁(1)  布局(1)"));
    assert!(topic_prompt.contains("TOP笔记标题：\n  - 高赞标题一\n  - 高赞标题二\n  - 高赞标题三"));
    assert!(
        topic_prompt.contains("## 参考账号（隔离榜样）\n- 风格： / \n- 平均点赞：20.0  评论：4.0")
    );
    assert!(!topic_prompt.contains("ignored(99)"));
    assert!(!topic_prompt.contains("不应显示的第四条"));
    assert!(topic_prompt.ends_with("## 补充要求\n只用真实热信号\n"));
    assert!(stderr.is_empty());

    let empty_option_values = invoke_db(
        isolated.path(),
        &database,
        &[
            "--json",
            "content",
            "topic",
            "--item-ids",
            "",
            "--analysis-file",
            "",
        ],
    );
    let (stdout, stderr) = successful_command(
        empty_option_values,
        "content topic with empty optional values",
    );
    let topic_json: Value = serde_json::from_str(&stdout).expect("empty option values JSON");
    assert_eq!(topic_json["itemCount"], 2);
    assert!(!topic_json["prompt"]
        .as_str()
        .expect("empty option values prompt")
        .contains("近期爬虫分析摘要"));
    assert!(stderr.is_empty());

    let missing_analysis = isolated.path().join("missing-analysis.json");
    let plain_topic = invoke_db(
        isolated.path(),
        &database,
        &[
            "content",
            "topic",
            "--analysis-file",
            missing_analysis
                .to_str()
                .expect("missing analysis path UTF-8"),
        ],
    );
    let (stdout, stderr) = successful_command(plain_topic, "content topic with missing analysis");
    assert!(stdout.starts_with("⚠ 读取分析文件失败："));
    assert!(stdout.contains("🗂  选题生成 Prompt（复制给 Agent 生成选题清单）"));
    assert!(stdout.contains("## 图库物品清单（待出内容的原材料）"));
    assert!(stdout.ends_with(&format!("{}\n\n", "─".repeat(60))));
    assert!(stderr.is_empty());

    let missing_analysis_json = invoke_db(
        isolated.path(),
        &database,
        &[
            "--json",
            "content",
            "topic",
            "--analysis-file",
            missing_analysis
                .to_str()
                .expect("missing JSON analysis path UTF-8"),
        ],
    );
    let (stdout, stderr) = successful_command(
        missing_analysis_json,
        "JSON content topic with missing analysis",
    );
    let topic_json: Value =
        serde_json::from_str(&stdout).expect("missing-analysis topic stdout stays JSON");
    assert_eq!(topic_json["itemCount"], 2);
    assert!(topic_json["prompt"].is_string());
    assert!(!topic_json["prompt"]
        .as_str()
        .expect("missing-analysis topic prompt")
        .contains("近期爬虫分析摘要"));
    assert!(stderr.starts_with("读取分析文件失败，忽略该文件："));

    let listed = invoke_db(isolated.path(), &database, &["--json", "library", "list"]);
    let (stdout, stderr) = successful_command(listed, "library list --json");
    let items: Value = serde_json::from_str(&stdout).expect("library list JSON stdout");
    let first_item = items
        .as_array()
        .and_then(|items| items.iter().find(|item| item["id"] == 1))
        .expect("first fixture remains in the library");
    assert_eq!(first_item["title"], "CLI 测试素材");
    assert!(stderr.is_empty());

    let image_path = first_item["imagePath"].as_str().expect("item image path");
    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["library", "show", "1"]),
        "library show detail",
    );
    assert_eq!(
        stdout,
        format!(
            "\n#1 CLI 测试素材\n  图片：{image_path}\n  风格：—  材质：—  颜色：—\n  场景：—\n  标签：—\n\n"
        )
    );
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["library", "tag", "1", "--add", "隔离测试"],
        ),
        "library tag",
    );
    assert_eq!(stdout, "✓ 已添加标签「隔离测试」→ 隔离测试\n");
    assert!(stderr.is_empty());
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "library",
                "tag",
                "1",
                "--add",
                "隔离测试2",
                "--remove",
                "隔离测试",
            ],
        ),
        "library tag add and remove",
    );
    assert_eq!(
        stdout,
        "✓ 已添加标签「隔离测试2」→ 隔离测试、隔离测试2\n✓ 已删除标签「隔离测试」→ 隔离测试2\n"
    );
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "library",
                "tag",
                "--add",
                "被覆盖",
                "--add",
                "最终标签",
                "1",
            ],
        ),
        "library tag duplicate option takes last value and allows options before item id",
    );
    assert_eq!(stdout, "✓ 已添加标签「最终标签」→ 隔离测试2、最终标签\n");
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["library", "tag", "--add", "", "--remove", "隔离测试2", "1"],
        ),
        "library tag ignores an empty add while applying a non-empty remove",
    );
    assert_eq!(stdout, "✓ 已删除标签「隔离测试2」→ 最终标签\n");
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["library", "tag", "1", "--add", ""],
        ),
        "library tag empty value is a no-op",
    );
    assert!(stdout.is_empty());
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["library", "tag", "999"]),
        "library tag without an operation is a no-op",
    );
    assert!(stdout.is_empty());
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "library", "list"]),
        "library list confirms tag no-ops did not mutate tags",
    );
    let rows: Value = serde_json::from_str(&stdout).expect("library rows JSON");
    let item = rows
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == 1))
        .expect("tag fixture exists");
    assert_eq!(item["tags"], serde_json::json!(["最终标签"]));
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "--json",
                "library",
                "list",
                "--tag",
                "无匹配项",
                "-g",
                "最终标签",
                "--style",
                "",
            ],
        ),
        "library list uses the last value across aliases and ignores an empty filter",
    );
    let filtered_rows: Value = serde_json::from_str(&stdout).expect("filtered library JSON");
    assert_eq!(filtered_rows.as_array().map(Vec::len), Some(1));
    assert_eq!(filtered_rows[0]["title"], "CLI 测试素材");
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "--json",
                "library",
                "list",
                "--tag",
                "无匹配项",
                "--tag",
                "最终标签",
            ],
        ),
        "library list repeated option uses the last value",
    );
    let filtered_rows: Value = serde_json::from_str(&stdout).expect("repeated filter JSON");
    assert_eq!(filtered_rows.as_array().map(Vec::len), Some(1));
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["--json", "library", "list", "--tag", "--style"],
        ),
        "library list treats an option-looking token as the preceding option value",
    );
    let filtered_rows: Value = serde_json::from_str(&stdout).expect("hyphenated filter JSON");
    assert!(filtered_rows.as_array().expect("library rows").is_empty());
    assert!(stderr.is_empty());

    let (draft_json, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["--json", "content", "draft", "1", "--extra", "--save"],
        ),
        "content draft treats an option-looking token as the extra value",
    );
    let draft: Value = serde_json::from_str(&draft_json).expect("draft JSON");
    assert!(draft["prompt"]
        .as_str()
        .expect("draft prompt")
        .contains("## 补充要求\n--save\n"));
    assert!(
        draft["noteId"].is_null(),
        "--save was consumed as the extra value"
    );
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["content", "draft", "1", "--extra", "临时验收", "--save"],
        ),
        "content draft --save",
    );
    assert!(stdout.starts_with("人设：CLI 测试账号（家居）\n\n"));
    assert!(stdout.contains("📝 笔记创作 Prompt（复制给 Agent 生成内容）"));
    assert!(stdout.contains("临时验收"));
    assert!(stdout.contains("✓ 草稿记录已创建 ID=1（status=draft，等待填入内容）"));
    assert!(stdout.contains("填入内容后执行：rn content edit 1"));
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "content",
                "draft",
                "-a",
                "qa-reference",
                "-e",
                "丢弃的约束",
                "--extra",
                "-最终约束",
                "1",
            ],
        ),
        "content draft aliases, repeated value, and leading hyphen",
    );
    assert!(stdout.contains("参考账号：隔离榜样\n"));
    assert!(stdout.contains("## 参考账号风格（隔离榜样）"));
    assert!(stdout.contains("## 补充要求\n-最终约束\n"));
    assert!(!stdout.contains("丢弃的约束"));
    assert!(stderr.is_empty());

    let listed = invoke_db(
        isolated.path(),
        &database,
        &["--json", "content", "list", "--item-id", "1"],
    );
    let (stdout, stderr) = successful_command(listed, "content list --json");
    let notes: Value = serde_json::from_str(&stdout).expect("content list JSON stdout");
    assert_eq!(notes[0]["id"], 1);
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["content", "edit", "1", "--tags", "", "--status", ""],
        ),
        "content edit ignores empty optional tags and status",
    );
    assert_eq!(stdout, "✓ 笔记 ID=1 已更新（draft）\n");
    assert!(stderr.is_empty());
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["--json", "content", "show", "1"],
        ),
        "content edit empty options keep the draft unchanged",
    );
    let unchanged_note: Value = serde_json::from_str(&stdout).expect("unchanged note JSON");
    assert_eq!(unchanged_note["status"], "draft");
    assert_eq!(unchanged_note["tags"], serde_json::json!([]));
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "content",
                "edit",
                "--title",
                "CLI 测试笔记",
                "1",
                "--body",
                "隔离进程写入。",
                "--cover",
                "奶油风客厅改造前后对比",
                "--tags",
                "#QA, 家居",
                "--status",
                "ready",
            ],
        ),
        "content edit updates every legacy field",
    );
    assert!(stdout.contains("笔记 ID=1 已更新"));
    assert!(stderr.is_empty());

    let (edited_note_json, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["--json", "content", "show", "1"],
        ),
        "content edit persists every legacy field",
    );
    let edited_note: Value = serde_json::from_str(&edited_note_json).expect("edited note JSON");
    assert_eq!(edited_note["title"], "CLI 测试笔记");
    assert_eq!(edited_note["body"], "隔离进程写入。");
    assert_eq!(edited_note["coverDesc"], "奶油风客厅改造前后对比");
    assert_eq!(edited_note["tags"], serde_json::json!(["QA", "家居"]));
    assert_eq!(edited_note["status"], "ready");
    assert!(stderr.is_empty());

    let (listed_json, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["--json", "content", "list", "--item-id", "1"],
        ),
        "content list JSON timestamp source",
    );
    let listed_notes: Value = serde_json::from_str(&listed_json).expect("listed notes JSON");
    let created_at = listed_notes[0]["createdAt"]
        .as_str()
        .expect("note created timestamp")
        .chars()
        .take(16)
        .collect::<String>();
    assert!(stderr.is_empty());
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["content", "list", "--item-id", "1"],
        ),
        "content list text contract",
    );
    assert_eq!(
        stdout,
        format!(
            "ID\t标题\t物品ID\t状态\t话题\t创建时间\n1\tCLI 测试笔记\t1\tready\t#QA #家居\t{created_at}\n共 1 条\n"
        )
    );
    assert!(stderr.is_empty());

    successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["content", "draft", "2", "--save"],
        ),
        "create a second draft for status-filter coverage",
    );
    for (status, item_id, expected_id) in [
        ("ready", "1", Some(1)),
        ("draft", "2", Some(2)),
        ("ready", "2", None),
        ("draft", "1", None),
    ] {
        let (stdout, stderr) = successful_command(
            invoke_db(
                isolated.path(),
                &database,
                &[
                    "--json",
                    "content",
                    "list",
                    "--status",
                    status,
                    "--item-id",
                    item_id,
                ],
            ),
            "content list filters by status and source item",
        );
        let filtered_notes: Value =
            serde_json::from_str(&stdout).expect("status-filtered notes JSON");
        let filtered_notes = filtered_notes.as_array().expect("note array");
        assert_eq!(
            filtered_notes.len(),
            if expected_id.is_some() { 1 } else { 0 },
            "status={status}, item_id={item_id}"
        );
        if let Some(expected_id) = expected_id {
            assert_eq!(
                filtered_notes[0]["id"], expected_id,
                "status={status}, item_id={item_id}"
            );
        }
        assert!(stderr.is_empty());
    }

    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["content", "show", "1"]),
        "content show detail",
    );
    assert_eq!(
        stdout,
        "\n笔记 #1  [ready]\n  物品 ID：1  参考账号：—\n\n  标题：CLI 测试笔记\n  封面文案：奶油风客厅改造前后对比\n\n  正文：\n隔离进程写入。\n\n  话题：#QA #家居\n\n"
    );
    assert!(stderr.is_empty());

    let export_arg = export.to_str().expect("export path UTF-8");
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "content",
                "export",
                "--output",
                "ignored-export.md",
                "-o",
                export_arg,
                "1",
            ],
        ),
        "content export",
    );
    assert_eq!(stdout, format!("✓ 已导出到：{}\n", export.display()));
    assert!(stderr.is_empty());
    let markdown = fs::read_to_string(export).expect("read isolated note export");
    assert!(markdown.contains("CLI 测试笔记"));
    assert!(markdown.contains("**封面文案**：奶油风客厅改造前后对比"));
    assert!(markdown.contains("#QA #家居"));

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["content", "export", "1", "--output", ""],
        ),
        "content export treats an empty output path as stdout",
    );
    assert!(stdout.contains("# CLI 测试笔记"));
    assert!(stdout.contains("**封面文案**：奶油风客厅改造前后对比"));
    assert!(stderr.is_empty());

    let cancelled = invoke_db(isolated.path(), &database, &["library", "delete", "1"]);
    assert_eq!(cancelled.status.code(), Some(1));
    assert_eq!(cancelled.stdout, "确认删除？ [y/N]: ".as_bytes());
    assert_eq!(cancelled.stderr, b"Aborted!\n");
    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["library", "show", "1"]),
        "item remains after cancelled confirmation",
    );
    assert!(stdout.contains("#1 CLI 测试素材"));
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "accounts",
                "add",
                "--name",
                "隔离榜样",
                "qa-reference",
                "--note-count",
                "3",
                "--avg-likes",
                "20",
                "--avg-comments",
                "2.5",
                "--avg-collects",
                "7.75",
                "--style",
                "居家整理",
                "--top-notes",
                "标题一,标题二",
            ],
        ),
        "accounts add",
    );
    assert_eq!(
        stdout,
        "✓ 已录入账号 隔离榜样（qa-reference）\n  · 标题一\n  · 标题二\n"
    );
    assert!(stderr.is_empty());
    let (empty_style_json, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "--json",
                "accounts",
                "add",
                "--name",
                "空风格账号",
                "qa-empty-style",
                "--style",
                "",
            ],
        ),
        "accounts add treats an empty style as unset",
    );
    let empty_style_account: Value =
        serde_json::from_str(&empty_style_json).expect("empty style account JSON");
    assert!(empty_style_account["contentStyle"].is_null());
    assert!(stderr.is_empty());
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["accounts", "delete", "--yes", "qa-empty-style"],
        ),
        "accounts delete accepts confirmation before the positional ID",
    );
    assert_eq!(stdout, "✓ 已删除账号 qa-empty-style\n");
    assert!(stderr.is_empty());
    let (account_json, _) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["--json", "accounts", "show", "qa-reference"],
        ),
        "accounts show JSON fixture",
    );
    let account: Value = serde_json::from_str(&account_json).expect("account JSON fixture");
    assert_eq!(account["noteCount"], 3);
    assert_eq!(account["avgLikes"], 20.0);
    assert_eq!(account["avgComments"], 2.5);
    assert_eq!(account["avgCollects"], 7.75);
    assert_eq!(account["contentStyle"], "{\"description\":\"居家整理\"}");
    assert_eq!(account["topNotes"][0]["title"], "标题一");
    let crawled_at = account["crawledAt"]
        .as_str()
        .expect("account crawl timestamp")
        .chars()
        .take(16)
        .collect::<String>();
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["accounts", "show", "qa-reference"],
        ),
        "accounts show",
    );
    assert_eq!(
        stdout,
        format!(
            "\n隔离榜样  (qa-reference)\n  笔记数：3  均赞：20.0  均评：2.5  均藏：7.75\n  风格：居家整理\n  高赞笔记：\n    · 标题一\n    · 标题二\n  录入时间：{crawled_at}\n\n"
        )
    );
    assert!(stderr.is_empty());

    let (updated_account_json, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "--json",
                "accounts",
                "add",
                "qa-reference",
                "--name",
                "更新后的榜样",
                "--note-count",
                "4",
                "--avg-likes",
                "11.5",
                "--avg-comments",
                "5.25",
                "--avg-collects",
                "6.5",
                "--style",
                "收纳改造",
                "--top-notes",
                "更新标题",
            ],
        ),
        "accounts add updates an existing account in the active pool",
    );
    let updated_account: Value =
        serde_json::from_str(&updated_account_json).expect("updated account JSON");
    assert_eq!(updated_account["name"], "更新后的榜样");
    assert_eq!(updated_account["noteCount"], 4);
    assert_eq!(updated_account["avgLikes"], 11.5);
    assert_eq!(updated_account["avgComments"], 5.25);
    assert_eq!(updated_account["avgCollects"], 6.5);
    assert_eq!(updated_account["topNotes"][0]["title"], "更新标题");
    assert!(stderr.is_empty());
    let (account_list_json, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "accounts", "list"]),
        "accounts list contains one updated account instead of a duplicate",
    );
    let account_list: Value = serde_json::from_str(&account_list_json).expect("account list JSON");
    let matching_accounts: Vec<_> = account_list
        .as_array()
        .expect("account list array")
        .iter()
        .filter(|account| account["accountId"] == "qa-reference")
        .collect();
    assert_eq!(
        matching_accounts.len(),
        1,
        "upsert must not create duplicates"
    );
    assert_eq!(matching_accounts[0]["name"], "更新后的榜样");
    assert!(stderr.is_empty());
    let json_confirmation_required = invoke_db(
        isolated.path(),
        &database,
        &["--json", "accounts", "delete", "qa-reference"],
    );
    assert_eq!(json_confirmation_required.status.code(), Some(2));
    assert!(json_confirmation_required.stdout.is_empty());
    assert_eq!(
        json_confirmation_required.stderr,
        "错误：JSON 模式下请显式添加 --yes 确认\n".as_bytes()
    );
    let cancelled = invoke_db(
        isolated.path(),
        &database,
        &["accounts", "delete", "qa-reference"],
    );
    assert_eq!(cancelled.status.code(), Some(1));
    assert_eq!(cancelled.stdout, "确认删除该账号吗？ [y/N]: ".as_bytes());
    assert_eq!(cancelled.stderr, b"Aborted!\n");
    let (_, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["accounts", "show", "qa-reference"],
        ),
        "account remains after cancelled confirmation",
    );
    assert!(stderr.is_empty());
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["accounts", "delete", "--yes", "qa-reference"],
        ),
        "accounts delete",
    );
    assert_eq!(stdout, "✓ 已删除账号 qa-reference\n");
    assert!(stderr.is_empty());

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["library", "delete", "--yes", "1"],
        ),
        "library delete",
    );
    assert_eq!(stdout, "✓ 已删除物品 ID=1\n");
    assert!(stderr.is_empty());
    let (trash_json, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "library", "trash"]),
        "library trash returns the account's deleted materials",
    );
    let trash: Value = serde_json::from_str(&trash_json).expect("trash rows JSON");
    assert!(trash.as_array().is_some_and(|rows| {
        rows.iter()
            .any(|row| row["id"] == 1 && row["title"] == "CLI 测试素材")
    }));
    assert!(stderr.is_empty());
    let blocked_purge = invoke_db(
        isolated.path(),
        &database,
        &["library", "purge", "1", "--yes"],
    );
    assert_eq!(blocked_purge.status.code(), Some(2));
    assert!(blocked_purge.stdout.is_empty());
    assert!(String::from_utf8_lossy(&blocked_purge.stderr).contains("笔记"));
    let (stdout, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["library", "restore", "1"]),
        "library restore",
    );
    assert_eq!(stdout, "素材 1 已从回收站恢复\n");
    assert!(stderr.is_empty());

    let fallback_title_image = isolated.path().join("untitled-library-import.png");
    fs::write(
        &fallback_title_image,
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        )
        .expect("decode fallback-title PNG fixture"),
    )
    .expect("write fallback-title PNG fixture");
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "library",
                "add",
                "--title",
                "",
                "--no-analyze",
                fallback_title_image.to_str().expect("image path UTF-8"),
            ],
        ),
        "library add uses the filename stem for an empty title",
    );
    assert!(stdout
        .starts_with("✓ 已添加物品 ID=3：untitled-library-import\n\n#3 untitled-library-import\n"));
    assert!(stderr.is_empty());

    let legacy_delete_file_source = isolated.path().join("legacy-delete-file.png");
    fs::write(
        &legacy_delete_file_source,
        fs::read(&image).expect("read image fixture for legacy delete-file contract"),
    )
    .expect("write legacy delete-file image fixture");
    let (added_json, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &[
                "--json",
                "library",
                "add",
                legacy_delete_file_source
                    .to_str()
                    .expect("legacy image source path UTF-8"),
                "--no-analyze",
            ],
        ),
        "import image for legacy --delete-file compatibility contract",
    );
    let added_item: Value = serde_json::from_str(&added_json).expect("added item JSON");
    let added_id = added_item["id"]
        .as_i64()
        .expect("added item ID")
        .to_string();
    let managed_image = database.parent().expect("database data directory").join(
        added_item["imagePath"]
            .as_str()
            .expect("managed image path"),
    );
    assert!(stderr.is_empty());
    assert!(
        managed_image.is_file(),
        "fixture must be managed before delete: {} ({added_json})",
        managed_image.display()
    );

    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &database,
            &["library", "delete", &added_id, "--delete-file", "--yes"],
        ),
        "legacy --delete-file remains a soft delete",
    );
    assert_eq!(stdout, format!("✓ 已删除物品 ID={added_id}\n"));
    assert_eq!(
        stderr,
        "兼容旧选项 --delete-file：旧版实际仍只软删除；如需真正删除受管理的图片文件，请先移入回收站，再运行 library purge ITEM_ID --yes。\n"
    );
    assert!(
        managed_image.is_file(),
        "the legacy Python implementation never deleted the managed file"
    );
    let (trash_json, stderr) = successful_command(
        invoke_db(isolated.path(), &database, &["--json", "library", "trash"]),
        "legacy delete-file item is still recoverable from trash",
    );
    let trash: Value = serde_json::from_str(&trash_json).expect("trash JSON");
    assert!(trash
        .as_array()
        .is_some_and(|rows| rows.iter().any(|row| row["id"] == added_item["id"])));
    assert!(stderr.is_empty());

    let purge_image = isolated.path().join("purge-fixture.png");
    fs::write(
        &purge_image,
        fs::read(&image).expect("read isolated image fixture"),
    )
    .expect("write isolated purge image");
    let purge_database = isolated.path().join("data").join("purge-only.db");
    successful_command(
        invoke_db(isolated.path(), &purge_database, &["db", "init", "--yes"]),
        "initialize independent purge fixture database",
    );
    let (purge_add_json, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &purge_database,
            &[
                "--json",
                "library",
                "add",
                purge_image
                    .to_str()
                    .expect("purge fixture image path UTF-8"),
                "--no-analyze",
            ],
        ),
        "import isolated unreferenced purge fixture",
    );
    let purge_item: Value = serde_json::from_str(&purge_add_json).expect("purge item JSON");
    let purge_id = purge_item["id"]
        .as_i64()
        .expect("purge item id")
        .to_string();
    assert!(stderr.is_empty());
    successful_command(
        invoke_db(
            isolated.path(),
            &purge_database,
            &["library", "delete", &purge_id, "--yes"],
        ),
        "move unreferenced purge fixture to trash",
    );
    let (stdout, stderr) = successful_command(
        invoke_db(
            isolated.path(),
            &purge_database,
            &["library", "purge", &purge_id, "--yes"],
        ),
        "permanently purge isolated unreferenced material",
    );
    assert_eq!(stdout, format!("素材 {purge_id} 已永久清理\n"));
    assert!(stderr.is_empty());

    let unknown = invoke_db(isolated.path(), &database, &["unavailable-command"]);
    assert_eq!(unknown.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&unknown.stdout).starts_with("rn — 爱吃红薯本地工作区命令\n"));
    assert_eq!(
        unknown.stderr,
        "错误：未知命令：unavailable-command；运行 rn --help 查看当前支持的命令\n".as_bytes()
    );
}
