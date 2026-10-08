use aichihongshu_db::{
    BrowserProfileNote, ItemSummary, LocalAccountUpdate, LocalDb, LocalImageImport,
    LocalItemAnalysisTitlePolicy, LocalItemMetadataUpdate, LocalNoteStatusUpdate, LocalNoteUpdate,
    LocalProfileUpdate, LocalReferenceAccountManualUpsert, NoteSummary, ProfileSummary,
    ReferenceNote, WorkspaceSnapshot,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use std::env;
use std::ffi::OsString;
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;

mod http;
mod mcp;
mod prompt;

struct Options {
    database: Option<PathBuf>,
    json: bool,
    command: Vec<String>,
}

const LEGACY_EXIT_ONE_PREFIX: &str = "\0rn-legacy-cli-exit-1\0";
const LEGACY_ABORT_PREFIX: &str = "\0rn-legacy-cli-abort\0";
const CLI_STDERR_PREFIX: &str = "\0rn-cli-stderr\0";

fn legacy_exit_one(message: impl AsRef<str>, json: bool) -> String {
    let format = if json { "json" } else { "text" };
    format!("{LEGACY_EXIT_ONE_PREFIX}{format}\0{}", message.as_ref())
}

fn click_command_error(command: &str, detail: &str, include_usage: bool) -> String {
    click_argument_error(command, "ITEM_ID", detail, include_usage)
}

fn click_argument_error(
    command: &str,
    argument_name: &str,
    detail: &str,
    include_usage: bool,
) -> String {
    let usage = if include_usage {
        format!("Usage: {command} [OPTIONS] {argument_name}\nTry '{command} --help' for help.\n\n")
    } else {
        String::new()
    };
    format!("{CLI_STDERR_PREFIX}{usage}Error: {detail}\n")
}

fn click_option_value_error(command: &str, option: &str, value: &str, expected: &str) -> String {
    format!(
        "{CLI_STDERR_PREFIX}Usage: {command} [OPTIONS]\nTry '{command} --help' for help.\n\nError: Invalid value for '{option}': '{value}' is not a valid {expected}.\n"
    )
}

fn click_missing_option_value_error(option: &str) -> String {
    format!("{CLI_STDERR_PREFIX}Error: Option '{option}' requires an argument.\n")
}

fn single_click_argument(
    args: &[String],
    command: &str,
    argument_name: &str,
) -> Result<String, String> {
    click_positional_argument(args, command, argument_name, &[], &[])
}

fn click_positional_argument(
    args: &[String],
    command: &str,
    argument_name: &str,
    value_options: &[&str],
    flag_options: &[&str],
) -> Result<String, String> {
    let mut positional = None;
    let mut positional_only = false;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if !positional_only && arg == "--" {
            positional_only = true;
            index += 1;
            continue;
        }
        if !positional_only && value_options.contains(&arg) {
            if args.get(index + 1).is_none() {
                return Err(click_argument_error(
                    command,
                    argument_name,
                    &format!("Option '{arg}' requires an argument."),
                    false,
                ));
            }
            index += 2;
            continue;
        }
        if !positional_only && flag_options.contains(&arg) {
            index += 1;
            continue;
        }
        if !positional_only && arg.starts_with('-') {
            return Err(click_argument_error(
                command,
                argument_name,
                &format!("No such option: {arg}"),
                true,
            ));
        }
        if positional.is_some() {
            return Err(click_argument_error(
                command,
                argument_name,
                &format!("Got unexpected extra argument ({arg})"),
                true,
            ));
        }
        positional = Some(arg.to_string());
        index += 1;
    }
    positional.ok_or_else(|| {
        click_argument_error(
            command,
            argument_name,
            &format!("Missing argument '{argument_name}'."),
            true,
        )
    })
}

fn single_click_integer_argument(
    args: &[String],
    command: &str,
    argument_name: &str,
) -> Result<i64, String> {
    let value = single_click_argument(args, command, argument_name)?;
    value.parse::<i64>().map_err(|_| {
        click_argument_error(
            command,
            argument_name,
            &format!("Invalid value for '{argument_name}': '{value}' is not a valid integer."),
            true,
        )
    })
}

fn click_integer_positional_argument(
    args: &[String],
    command: &str,
    argument_name: &str,
    value_options: &[&str],
    flag_options: &[&str],
) -> Result<i64, String> {
    let value =
        click_positional_argument(args, command, argument_name, value_options, flag_options)?;
    value.parse::<i64>().map_err(|_| {
        click_argument_error(
            command,
            argument_name,
            &format!("Invalid value for '{argument_name}': '{value}' is not a valid integer."),
            true,
        )
    })
}

fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<Options, String> {
    let mut database = None;
    let mut json = false;
    let mut command = Vec::new();
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let value = arg.to_string_lossy().into_owned();
        match value.as_str() {
            "--db" | "--database" => {
                let path = iter.next().ok_or("--db 后需要数据库路径")?;
                database = Some(PathBuf::from(path));
            }
            "--json" => json = true,
            "--help" | "-h" if command.is_empty() => {
                return Ok(Options {
                    database,
                    json,
                    command: vec!["help".into()],
                })
            }
            "--version" | "-V" if command.is_empty() => {
                return Ok(Options {
                    database,
                    json,
                    command: vec!["version".into()],
                })
            }
            _ => command.push(value),
        }
    }
    Ok(Options {
        database,
        json,
        command,
    })
}

fn default_database_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("AICHIHONGSHU_DB_PATH").or_else(|| env::var_os("DB_PATH")) {
        let path = PathBuf::from(path);
        return Ok(if path.is_absolute() {
            path
        } else {
            env::current_dir()
                .map_err(|error| error.to_string())?
                .join(path)
        });
    }

    let cwd = env::current_dir().map_err(|error| error.to_string())?;
    let dotenv_path = cwd.join(".env");
    if let Ok(contents) = std::fs::read_to_string(dotenv_path) {
        if let Some(value) = contents.lines().find_map(|line| {
            let line = line.trim();
            let (key, value) = line.split_once('=')?;
            if key.trim() == "DB_PATH" {
                Some(value.trim().trim_matches(['\'', '"']).to_string())
            } else {
                None
            }
        }) {
            let path = PathBuf::from(value);
            return Ok(if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            });
        }
    }
    Ok(cwd.join("data").join("app.db"))
}

fn help_text(command: &[String]) -> &'static str {
    match command
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ")
        .as_str()
    {
        "" => "rn — 爱吃红薯本地工作区命令\n用法：rn [--db PATH] [--json] <command>\n命令：\ndb init [--yes]\nserve [--port PORT]\nmcp [config]\nsearch [--keywords TEXT] [--count N] [--output-dir DIR] [--save-db]\ncrawl history [--limit N]\nanalyze --input JSON [--keywords TEXT] [--output-dir DIR] [--save-db]\nlibrary add|list|show|analyze|tag|delete|trash|restore|purge\ncontent list|draft|topic|show|edit|export\naccounts list|add|show|delete\nprofile init|show|edit\n示例：rn --db data/app.db library list --json",
        "db" => "数据库管理\n用法：rn db init [--yes]\n新数据库仅在终端确认后创建；非交互环境需显式传入 --yes。",
        "db init" => "初始化或迁移本地数据库\n用法：rn [--db PATH] db init [--yes]\n不传 --yes 时仅在交互终端询问确认。",
        "library" => "图库管理\n命令：\nadd IMAGE_PATH [--title TEXT|-t TEXT] [--analyze|--no-analyze]\nlist [--tag TAG|-g TAG] [--style STYLE|-s STYLE]\nshow ITEM_ID\nanalyze ITEM_ID\ntag ITEM_ID [--add TAG] [--remove TAG]\ndelete ITEM_ID [--delete-file] --yes\ntrash\nrestore ITEM_ID\npurge ITEM_ID --yes",
        "library add" => "添加图片到当前运营账号的素材库\n用法：rn [--db PATH] library add IMAGE_PATH [--title TEXT|-t TEXT] [--analyze|--no-analyze]\n选项：\n--title, -t TEXT  指定素材名称\n--analyze         调用已配置的图片分析服务（默认）\n--no-analyze      跳过图片分析",
        "library list" => "列出当前运营账号的素材\n用法：rn [--db PATH] [--json] library list [--tag TAG|-g TAG] [--style STYLE|-s STYLE]\n选项：--tag, -g TAG；--style, -s STYLE",
        "library show" => "显示素材详情\n用法：rn [--db PATH] [--json] library show ITEM_ID",
        "library analyze" => "重新分析素材图片\n用法：rn [--db PATH] [--json] library analyze ITEM_ID",
        "library tag" => "修改素材标签\n用法：rn [--db PATH] library tag ITEM_ID [--add TAG] [--remove TAG]",
        "library delete" => "将素材记录移入回收站\n用法：rn [--db PATH] [--json] library delete ITEM_ID [--delete-file] --yes\n--delete-file 为旧兼容参数；真正清理受管文件请使用 library purge。",
        "library trash" => "列出当前账号素材回收站\n用法：rn [--db PATH] [--json] library trash",
        "library restore" => "恢复当前账号回收站中的素材\n用法：rn [--db PATH] [--json] library restore ITEM_ID",
        "library purge" => "永久清理回收站素材\n用法：rn [--db PATH] [--json] library purge ITEM_ID --yes\n仍被笔记引用或路径不受管理的文件不会被清理。",
        "content" => "内容创作与笔记管理\n命令：\nlist [--status STATUS|-s STATUS] [--item-id ITEM_ID|-i ITEM_ID]\ndraft ITEM_ID [--account-id ID|-a ID] [--extra TEXT|-e TEXT] [--save]\ntopic [--account-id ID|-a ID] [--analysis-file PATH|-f PATH] [--extra TEXT|-e TEXT] [--item-ids CSV|-i CSV]\nshow NOTE_ID\nedit NOTE_ID [--title TEXT|-t TEXT] [--body TEXT|-b TEXT] [--cover TEXT|-c TEXT] [--tags CSV] [--status STATUS|-s STATUS]\nexport NOTE_ID [--output PATH|-o PATH]",
        "content list" => "列出当前账号笔记\n用法：rn [--db PATH] [--json] content list [--status STATUS|-s STATUS] [--item-id ITEM_ID|-i ITEM_ID]",
        "content draft" => "为素材构建笔记 Prompt，可选保存草稿\n用法：rn [--db PATH] [--json] content draft ITEM_ID [--account-id ID|-a ID] [--extra TEXT|-e TEXT] [--save]",
        "content topic" => "为图库素材构建议题 Prompt，可选使用分析报告\n用法：rn [--db PATH] [--json] content topic [--account-id ID|-a ID] [--analysis-file PATH|-f PATH] [--extra TEXT|-e TEXT] [--item-ids CSV|-i CSV]",
        "content show" => "显示当前账号笔记详情\n用法：rn [--db PATH] [--json] content show NOTE_ID",
        "content edit" => "编辑当前账号笔记\n用法：rn [--db PATH] [--json] content edit NOTE_ID [字段选项]\n--title, -t TEXT；--body, -b TEXT；--cover, -c TEXT；--tags CSV；--status, -s STATUS",
        "content export" => "导出笔记 Markdown\n用法：rn [--db PATH] content export NOTE_ID [--output PATH|-o PATH]",
        "accounts" => "榜样账号管理\n命令：list\nadd ACCOUNT_ID --name NAME [--note-count N] [--avg-likes N] [--avg-comments N] [--avg-collects N] [--style TEXT] [--top-notes CSV]\nshow ACCOUNT_ID\ndelete ACCOUNT_ID --yes",
        "accounts list" => "列出当前运营账号下的榜样账号\n用法：rn [--db PATH] [--json] accounts list",
        "accounts add" => "新增或更新榜样账号\n用法：rn [--db PATH] [--json] accounts add ACCOUNT_ID --name NAME [--followers N] [--note-count N] [--avg-likes N] [--avg-comments N] [--avg-collects N] [--style TEXT] [--top-notes CSV]\n--name 可简写为 -n。",
        "accounts show" => "显示榜样账号\n用法：rn [--db PATH] [--json] accounts show ACCOUNT_ID",
        "accounts delete" => "删除当前运营账号下的榜样账号\n用法：rn [--db PATH] accounts delete ACCOUNT_ID --yes",
        "profile" => "我的运营账号人设\n命令：init [--url URL] [人设和统计字段]\nshow\nedit [人设和统计字段]",
        "profile show" => "查看当前运营账号人设\n用法：rn [--db PATH] [--json] profile show",
        "profile init" => "初始化或更新当前运营账号人设；手动填写时需提供 --name 和 --niche\n用法：rn [--db PATH] [--json] profile init [--url URL] [选项]\n选项：--account-id、--name、--niche、--audience、--pillars、--persona-name、--persona-bio、--persona-tone、--taboos、--styles、--scenes、--hashtags、--rhythm、--followers、--total-notes、--avg-likes、--avg-comments、--avg-collects",
        "profile edit" => "更新当前运营账号人设的指定字段\n用法：rn [--db PATH] [--json] profile edit [选项]\n可编辑：--name、--niche、--audience、--pillars、--persona-name、--persona-bio、--persona-tone、--taboos、--styles、--scenes、--hashtags、--rhythm、--followers、--total-notes、--avg-likes、--avg-comments、--avg-collects",
        "serve" => "启动 loopback Rust HTTP adapter\n用法：rn [--db PATH] serve [--port PORT]\n默认端口为 8765。",
        "mcp" => "启动 stdio MCP server（stdout 保留给 JSON-RPC 协议）\n用法：rn [--db PATH] mcp\n生成配置片段：rn mcp config [--db PATH]",
        "mcp config" => "打印 MCP 客户端配置片段，不修改用户配置文件\n用法：rn mcp config [--db PATH]",
        "search" => "使用受控浏览器搜索小红书可见笔记\n用法：rn [--db PATH] [--json] search [--keywords TEXT] [--count N] [--output-dir DIR] [--save-db]",
        "analyze" => "分析搜索采集 JSON 并保存报告\n用法：rn [--db PATH] [--json] analyze --input JSON [--keywords TEXT] [--output-dir DIR] [--save-db]",
        "crawl" | "crawl history" => "列出当前运营账号的采集历史\n用法：rn [--db PATH] [--json] crawl history [--limit N]",
        _ => "rn — 爱吃红薯本地工作区命令\n运行 rn --help 查看命令列表。",
    }
}

fn usage() {
    println!("{}", help_text(&[]));
}

fn print_json<T: Serialize>(value: &T) -> Result<(), String> {
    let output = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    println!("{output}");
    Ok(())
}

fn legacy_reference_style(style: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(style) else {
        return style.to_string();
    };
    let Some(object) = value.as_object() else {
        return style.to_string();
    };
    let Some(description) = object.get("description") else {
        return style.to_string();
    };
    let is_truthy = match description {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::Number(value) => value.as_f64().is_none_or(|number| number != 0.0),
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Array(value) => !value.is_empty(),
        serde_json::Value::Object(value) => !value.is_empty(),
    };
    if !is_truthy {
        return style.to_string();
    }
    description
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| description.to_string())
}

fn legacy_short_timestamp(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .chars()
        .take(16)
        .collect::<String>()
}

fn legacy_tags(tags: &[String]) -> String {
    if tags.is_empty() {
        "—".to_string()
    } else {
        tags.join("、")
    }
}

fn is_value_option(value: &str) -> bool {
    matches!(
        value,
        "--tag"
            | "-g"
            | "--style"
            | "-s"
            | "--status"
            | "--item-id"
            | "-i"
            | "--account-id"
            | "-a"
            | "--analysis-file"
            | "-f"
            | "--extra"
            | "-e"
            | "--title"
            | "-t"
            | "--body"
            | "-b"
            | "--cover"
            | "-c"
            | "--tags"
            | "--output"
            | "-o"
            | "--name"
            | "-n"
            | "--note-count"
            | "--avg-likes"
            | "--avg-comments"
            | "--avg-collects"
            | "--top-notes"
            | "--url"
            | "--niche"
            | "--audience"
            | "--pillars"
            | "--persona-name"
            | "--persona-bio"
            | "--persona-tone"
            | "--taboos"
            | "--styles"
            | "--scenes"
            | "--hashtags"
            | "--rhythm"
            | "--followers"
            | "--total-notes"
            | "--input"
            | "--keywords"
            | "--output-dir"
            | "--count"
            | "--limit"
            | "--port"
            | "--add"
            | "--remove"
    )
}

fn parse_option(command: &[String], name: &str) -> Result<Option<String>, String> {
    let mut found = None;
    let mut index = 0;
    while index < command.len() {
        if command[index] == name {
            let value = command
                .get(index + 1)
                .ok_or_else(|| click_missing_option_value_error(name))?;
            found = Some(value.clone());
            index += 2;
        } else if is_value_option(&command[index]) {
            index += if index + 1 < command.len() { 2 } else { 1 };
        } else {
            index += 1;
        }
    }
    Ok(found)
}

fn parse_option_aliases(command: &[String], names: &[&str]) -> Result<Option<String>, String> {
    let mut found = None;
    let mut index = 0;
    while index < command.len() {
        if names.contains(&command[index].as_str()) {
            let option = command[index].as_str();
            let value = command
                .get(index + 1)
                .ok_or_else(|| click_missing_option_value_error(option))?;
            found = Some(value.clone());
            index += 2;
        } else if is_value_option(&command[index]) {
            index += if index + 1 < command.len() { 2 } else { 1 };
        } else {
            index += 1;
        }
    }
    Ok(found)
}

fn reject_unknown_options(command: &[String], allowed: &[&str]) -> Result<(), String> {
    let mut index = 0;
    while index < command.len() {
        let arg = command[index].as_str();
        if arg.starts_with('-') {
            if !allowed.contains(&arg) {
                return Err(format!("未知参数：{arg}"));
            }
            index += 2;
        } else {
            index += 1;
        }
    }
    Ok(())
}

fn snapshot(db: &LocalDb, section: &str) -> Result<WorkspaceSnapshot, String> {
    db.snapshot_section_for_account(None, section)
        .map_err(|error| format!("读取工作区失败：{error}"))
}

fn output_items(items: impl Serialize, rows: &[ItemSummary], json: bool) -> Result<(), String> {
    if json {
        return print_json(&items);
    }
    if rows.is_empty() {
        println!("图库为空");
        return Ok(());
    }
    println!("ID\t名称\t风格\t材质\t场景\t标签\t笔记数");
    for item in rows {
        println!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}",
            item.id,
            item.title,
            item.style
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("—"),
            item.material
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("—"),
            item.scene
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("—"),
            if item.tags.is_empty() {
                "—".to_string()
            } else {
                item.tags.join("、")
            },
            item.note_count
        );
    }
    println!("共 {} 件", rows.len());
    Ok(())
}

fn output_item_detail(item: &ItemSummary) {
    println!();
    println!("#{} {}", item.id, item.title);
    println!("  图片：{}", item.image_path);
    println!(
        "  风格：{}  材质：{}  颜色：{}",
        item.style
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("—"),
        item.material
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("—"),
        item.color
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("—")
    );
    println!(
        "  场景：{}",
        item.scene
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("—")
    );
    println!(
        "  标签：{}",
        if item.tags.is_empty() {
            "—".to_string()
        } else {
            item.tags.join("、")
        }
    );

    if let Some(analysis) = item
        .analysis_raw
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
    {
        let selling_points = analysis
            .get("xhs_selling_points")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if !selling_points.is_empty() {
            println!("  卖点：{}", selling_points.join(" / "));
        }
        if let Some(pairing) = analysis
            .get("pairing_suggestions")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        {
            println!("  搭配：{pairing}");
        }
    }
    println!();
}

fn output_note_detail(note: &NoteSummary) {
    println!();
    println!("笔记 #{}  [{}]", note.id, note.status);
    println!(
        "  物品 ID：{}  参考账号：{}",
        note.item_id
            .filter(|item_id| *item_id != 0)
            .map(|item_id| item_id.to_string())
            .unwrap_or_else(|| "—".to_string()),
        note.account_ref
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("—")
    );
    if let Some(title) = note.title.as_deref().filter(|value| !value.is_empty()) {
        println!("\n  标题：{title}");
    }
    if let Some(cover) = note.cover_desc.as_deref().filter(|value| !value.is_empty()) {
        println!("  封面文案：{cover}");
    }
    if let Some(body) = note.body.as_deref().filter(|value| !value.is_empty()) {
        println!("\n  正文：\n{body}");
    }
    if !note.tags.is_empty() {
        let tags = note
            .tags
            .iter()
            .map(|tag| format!("#{}", tag.trim_start_matches('#')))
            .collect::<Vec<_>>()
            .join(" ");
        println!("\n  话题：{tags}");
    }
    println!();
}

fn output_profile_detail(profile: &ProfileSummary) {
    println!();
    println!("{}", "═".repeat(50));
    let mut account = format!(
        "账号：{}",
        profile.display_name.as_deref().unwrap_or("None")
    );
    if let Some(account_id) = profile
        .account_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        account.push_str(&format!("  ({account_id})"));
    }
    println!("{account}");
    println!("{}", "═".repeat(50));

    println!("\n【定位 & 容局】");
    println!(
        "  垂类：{}",
        profile
            .niche
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("—")
    );
    if let Some(audience) = profile
        .target_audience
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        println!("  目标受众：{audience}");
    }
    if !profile.content_pillars.is_empty() {
        println!("  内容支柱：{}", profile.content_pillars.join("、"));
    }

    println!("\n【人设】");
    println!(
        "  名称：{}",
        profile
            .persona_name
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("—")
    );
    if let Some(bio) = profile
        .persona_bio
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        println!("  简介：{bio}");
    }
    if let Some(tone) = profile
        .persona_tone
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        println!("  语气：{tone}");
    }
    if !profile.persona_taboos.is_empty() {
        println!("  禁忌：{}", profile.persona_taboos.join("、"));
    }

    println!("\n【账号数据】");
    println!(
        "  粉丝 {}  |  已发 {} 篇  |  均赞 {:?}  均评 {:?}  均藏 {:?}",
        profile.followers,
        profile.total_notes,
        profile.avg_likes,
        profile.avg_comments,
        profile.avg_collects
    );

    println!("\n【创作偏好】");
    if !profile.preferred_styles.is_empty() {
        println!("  偏好风格：{}", profile.preferred_styles.join("、"));
    }
    if !profile.preferred_scenes.is_empty() {
        println!("  偏好场景：{}", profile.preferred_scenes.join("、"));
    }
    if !profile.hashtag_pool.is_empty() {
        println!(
            "  标签池：{}",
            profile
                .hashtag_pool
                .iter()
                .map(|tag| format!("#{tag}"))
                .collect::<Vec<_>>()
                .join("  ")
        );
    }
    if let Some(rhythm) = profile
        .posting_rhythm
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        println!("  发帖节奏：{rhythm}");
    }
    println!(
        "\n最后更新：{}\n",
        legacy_short_timestamp(profile.updated_at.as_deref())
    );
}

fn image_mime_type(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn comma_list(value: Option<String>, previous: &[String]) -> Vec<String> {
    value.map_or_else(
        || previous.to_vec(),
        |value| {
            value
                .split(',')
                .map(|item| item.trim().trim_start_matches('#').to_string())
                .filter(|item| !item.is_empty())
                .collect()
        },
    )
}

fn output_notes(notes: &[NoteSummary], json: bool) -> Result<(), String> {
    if json {
        return print_json(&notes);
    }
    if notes.is_empty() {
        println!("暂无笔记");
        return Ok(());
    }
    println!("ID\t标题\t物品ID\t状态\t话题\t创建时间");
    for note in notes {
        let title = note
            .title
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("（未填标题）")
            .chars()
            .take(30)
            .collect::<String>();
        let tags = note
            .tags
            .iter()
            .map(|tag| format!("#{}", tag.trim_start_matches('#')))
            .collect::<Vec<_>>()
            .join(" ");
        println!(
            "{}\t{}\t{}\t{}\t{}\t{}",
            note.id,
            title,
            note.item_id
                .filter(|item_id| *item_id != 0)
                .map(|item_id| item_id.to_string())
                .unwrap_or_else(|| "—".to_string()),
            note.status,
            if tags.is_empty() { "—" } else { &tags },
            legacy_short_timestamp(note.created_at.as_deref())
        );
    }
    println!("共 {} 条", notes.len());
    Ok(())
}

fn run(args: impl IntoIterator<Item = OsString>) -> i32 {
    match run_inner(args) {
        Ok(()) => 0,
        Err(error) => {
            if error == LEGACY_ABORT_PREFIX {
                eprintln!("Aborted!");
                return 1;
            }
            if let Some(message) = error.strip_prefix(CLI_STDERR_PREFIX) {
                eprint!("{message}");
                return 2;
            }
            if let Some(payload) = error.strip_prefix(LEGACY_EXIT_ONE_PREFIX) {
                if let Some(message) = payload.strip_prefix("text\0") {
                    println!("{message}");
                } else if let Some(message) = payload.strip_prefix("json\0") {
                    println!("{}", serde_json::json!({"error": message}));
                } else {
                    eprintln!("错误：{error}");
                    return 2;
                }
                return 1;
            }
            eprintln!("错误：{error}");
            2
        }
    }
}

fn confirm_new_database(path: &std::path::Path, args: &[String]) -> Result<(), String> {
    if args.iter().any(|arg| arg != "--yes") {
        return Err(format!(
            "db init 不支持参数 {}",
            args.iter().find(|arg| arg.as_str() != "--yes").unwrap()
        ));
    }
    if args.iter().any(|arg| arg == "--yes") {
        return Ok(());
    }

    eprintln!("将创建新的本地数据库：{}", path.display());
    if !io::stdin().is_terminal() {
        return Err("非交互终端拒绝静默创建数据库；确认该路径后加 --yes 重试".to_string());
    }
    eprint!("确认在此路径创建数据库？[y/N] ");
    io::stderr()
        .flush()
        .map_err(|error| format!("显示数据库确认提示失败：{error}"))?;
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|error| format!("读取数据库确认失败：{error}"))?;
    if matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        Ok(())
    } else {
        Err("已取消数据库初始化".to_string())
    }
}

fn confirm_destructive_action(
    prompt: &str,
    confirmed: bool,
    json_mode: bool,
) -> Result<(), String> {
    if confirmed {
        return Ok(());
    }
    if json_mode {
        return Err("JSON 模式下请显式添加 --yes 确认".into());
    }
    print!("{prompt} [y/N]: ");
    io::stdout()
        .flush()
        .map_err(|error| format!("写入确认提示失败：{error}"))?;
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|error| format!("读取确认输入失败：{error}"))?;
    if answer.trim().eq_ignore_ascii_case("y") {
        Ok(())
    } else {
        Err(LEGACY_ABORT_PREFIX.to_string())
    }
}

fn run_inner(args: impl IntoIterator<Item = OsString>) -> Result<(), String> {
    let options = parse_args(args)?;
    let command = options.command;
    if let Some(help_index) = command
        .iter()
        .position(|argument| matches!(argument.as_str(), "--help" | "-h"))
    {
        println!("{}", help_text(&command[..help_index]));
        return Ok(());
    }
    match command.first().map(String::as_str) {
        None | Some("help") => {
            usage();
            return Ok(());
        }
        Some("version") => {
            println!("rn {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some("mcp") if command.get(1).map(String::as_str) == Some("config") => {
            if command.len() != 2 {
                return Err("用法：rn mcp config [--db PATH]".to_string());
            }
            let database = absolute_path(options.database.unwrap_or(default_database_path()?))?;
            let executable = env::current_exe()
                .map_err(|error| format!("读取 rn 可执行文件路径失败：{error}"))?;
            let config = mcp_config_json(&executable, &database);
            println!(
                "{}",
                serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?
            );
            return Ok(());
        }
        Some("mcp") => {}
        _ => {}
    }

    if command.first().map(String::as_str) == Some("analyze") {
        let needs_database = command.iter().any(|argument| argument == "--save-db");
        let database = if needs_database {
            let path = options.database.clone().unwrap_or(default_database_path()?);
            if !path.exists() {
                return Err(format!(
                    "数据库不存在：{}；不会为分析命令静默创建数据库",
                    path.display()
                ));
            }
            Some(LocalDb::open(path).map_err(|error| format!("打开本地数据库失败：{error}"))?)
        } else {
            None
        };
        run_search_analysis(database.as_ref(), &command[1..], options.json)?;
        return Ok(());
    }

    let database = options.database.unwrap_or(default_database_path()?);
    let init = command.first().map(String::as_str) == Some("db")
        && command.get(1).map(String::as_str) == Some("init");
    if !database.exists() && !init {
        return Err(format!(
            "数据库不存在：{}。指定 --db PATH；仅在确认要初始化新库时运行 `rn db init --db PATH`。",
            database.display()
        ));
    }
    if init && !database.exists() {
        confirm_new_database(&database, &command[2..])?;
    } else if init && command[2..].iter().any(|arg| arg != "--yes") {
        return Err("db init 只接受 --yes 参数".to_string());
    }
    let db = LocalDb::open(database.clone())
        .map_err(|error| format!("打开数据库 {} 失败：{error}", database.display()))?;

    match command.first().map(String::as_str) {
        Some("db") if command.get(1).map(String::as_str) == Some("init") => {
            if options.json {
                print_json(&serde_json::json!({"initialized": true, "databasePath": database}))?;
            } else {
                println!("✓ 数据库初始化完成");
            }
        }
        Some("mcp") if command.len() == 1 => {
            mcp::serve(&db)?;
        }
        Some("serve") => {
            let args = &command[1..];
            let port = match args {
                [] => http::DEFAULT_PORT,
                [flag, value] if flag == "--port" => value
                    .parse::<u16>()
                    .ok()
                    .filter(|port| *port > 0)
                    .ok_or("--port 必须是 1 到 65535 之间的端口")?,
                _ => return Err("用法：rn serve [--port PORT]".to_string()),
            };
            eprintln!("Rust HTTP adapter uses database {}", db.path().display());
            http::serve(db, port)?;
        }
        Some("search") => {
            run_browser_search(&db, &command[1..], options.json)?;
        }
        Some("crawl") if command.get(1).map(String::as_str) == Some("history") => {
            run_crawl_history(&db, &command[2..], options.json)?;
        }
        Some("library") if command.get(1).map(String::as_str) == Some("add") => {
            let args = &command[2..];
            let mut image_path = None;
            let mut explicit_title = None;
            let mut analyze = true;
            let mut index = 0;
            while index < args.len() {
                match args[index].as_str() {
                    "--analyze" => {
                        analyze = true;
                        index += 1;
                    }
                    "--no-analyze" => {
                        analyze = false;
                        index += 1;
                    }
                    "--title" | "-t" => {
                        let Some(value) = args.get(index + 1) else {
                            return Err(click_missing_option_value_error(args[index].as_str()));
                        };
                        explicit_title = Some(value.clone());
                        index += 2;
                    }
                    value if value.starts_with('-') => return Err(format!("未知参数：{value}")),
                    value if image_path.is_none() => {
                        image_path = Some(value.to_string());
                        index += 1;
                    }
                    value => return Err(format!("意外的位置参数：{value}")),
                }
            }
            let image_path = image_path.ok_or_else(|| {
                click_argument_error(
                    "rn library add",
                    "IMAGE_PATH",
                    "Missing argument 'IMAGE_PATH'.",
                    true,
                )
            })?;
            let path = PathBuf::from(image_path);
            if !path.is_file() {
                return Err(format!("图片文件不存在：{}", path.display()));
            }
            let mime_type =
                image_mime_type(&path).ok_or("仅支持 JPEG、PNG、WebP、GIF 和 AVIF 图片")?;
            let bytes = std::fs::read(&path).map_err(|error| format!("读取图片失败：{error}"))?;
            let explicit_title = explicit_title.filter(|value| !value.is_empty());
            let analysis = if analyze {
                if options.json {
                    eprintln!("正在分析图片... {}", path.display());
                } else {
                    println!("正在分析图片... {}", path.display());
                }
                match aichihongshu_services::analysis::analyze_file(&db, &path) {
                    Ok(analysis) => {
                        let message = format!(
                            "✓ 分析完成：{} / {}",
                            analysis
                                .get("title")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            analysis
                                .get("style")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                        );
                        if options.json {
                            eprintln!("{message}");
                        } else {
                            println!("{message}");
                        }
                        Some(analysis)
                    }
                    Err(error) => {
                        let message = format!("⚠ MiniMax 分析失败（{error}），将跳过分析直接入库");
                        if options.json {
                            eprintln!("{message}");
                        } else {
                            println!("{message}");
                        }
                        None
                    }
                }
            } else {
                None
            };
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("图片文件名不是有效 UTF-8")?
                .to_string();
            let active_id = db
                .current_active_account()
                .map_err(|error| format!("读取当前账号失败：{error}"))?
                .id;
            let mut item = db.import_local_image(LocalImageImport {
                account_pool_id: active_id,
                file_name,
                mime_type: Some(mime_type.to_string()),
                data_base64: BASE64.encode(bytes),
                thumbnail_data_base64: None,
            })?;
            if let Some(title) = explicit_title.as_deref() {
                item = db.update_local_item_metadata(LocalItemMetadataUpdate {
                    item_id: item.id,
                    account_pool_id: active_id,
                    expected_metadata_version: item.metadata_version,
                    title: title.to_string(),
                    tags: item.tags.clone(),
                    style: item.style.clone(),
                    material: item.material.clone(),
                    scene: item.scene.clone(),
                    color: item.color.clone(),
                })?;
            }
            if let Some(analysis) = analysis {
                item = db.update_local_item_analysis(
                    item.id,
                    active_id,
                    item.image_version,
                    &analysis,
                    if explicit_title.is_none() {
                        LocalItemAnalysisTitlePolicy::Force
                    } else {
                        LocalItemAnalysisTitlePolicy::Preserve
                    },
                )?;
            }
            if options.json {
                print_json(&item)?;
            } else {
                println!("✓ 已添加物品 ID={}：{}", item.id, item.title);
                output_item_detail(&item);
            }
        }
        Some("library") if command.get(1).map(String::as_str) == Some("list") => {
            let args = &command[2..];
            reject_unknown_options(args, &["--tag", "-g", "--style", "-s"])?;
            let tag = parse_option_aliases(args, &["--tag", "-g"])?;
            let style = parse_option_aliases(args, &["--style", "-s"])?;
            let items = db.list_local_items_for_cli(tag.as_deref(), style.as_deref())?;
            output_items(&items, &items, options.json)?;
        }
        Some("library") if command.get(1).map(String::as_str) == Some("show") => {
            let id = single_click_integer_argument(&command[2..], "rn library show", "ITEM_ID")?;
            let (_, item) = db.get_local_item_for_cli(id)?;
            let item =
                item.ok_or_else(|| legacy_exit_one(format!("物品 ID {id} 不存在"), options.json))?;
            if options.json {
                print_json(&item)?;
            } else {
                output_item_detail(&item);
            }
        }
        Some("library") if command.get(1).map(String::as_str) == Some("analyze") => {
            let id = single_click_integer_argument(&command[2..], "rn library analyze", "ITEM_ID")?;
            let (account_id, item) = db.get_local_item_for_cli(id)?;
            let item = item.ok_or_else(|| format!("素材 {id} 不存在或不属于当前账号"))?;
            let data_url = db
                .image_data_url_for_account(id, Some(account_id), "original")?
                .ok_or_else(|| format!("素材 {id} 的图片不可用"))?;
            let analysis = aichihongshu_services::analysis::analyze_data_url(&db, &data_url)?;
            let updated = db.update_local_item_analysis(
                id,
                account_id,
                item.image_version,
                &analysis,
                LocalItemAnalysisTitlePolicy::IfDefault,
            )?;
            if options.json {
                print_json(&updated)?;
            } else {
                println!(
                    "素材 {} 分析完成：{} / {}",
                    updated.id,
                    updated.title,
                    updated.style.as_deref().unwrap_or("")
                );
            }
        }
        Some("library") if command.get(1).map(String::as_str) == Some("tag") => {
            let mut item_id = None;
            let mut add = None;
            let mut remove = None;
            let mut index = 2;
            while index < command.len() {
                match command[index].as_str() {
                    "--add" | "--remove" => {
                        let option = command[index].as_str();
                        let value = command
                            .get(index + 1)
                            .ok_or_else(|| click_missing_option_value_error(option))?
                            .clone();
                        if option == "--add" {
                            add = Some(value);
                        } else {
                            remove = Some(value);
                        }
                        index += 2;
                    }
                    value if value.starts_with('-') => {
                        return Err(format!("未知参数：{value}"));
                    }
                    value => {
                        if item_id.is_some() {
                            return Err(format!("多余的位置参数：{value}"));
                        }
                        item_id = Some(value.parse::<i64>().map_err(|_| {
                            click_argument_error(
                                "rn library tag",
                                "ITEM_ID",
                                &format!(
                                    "Invalid value for 'ITEM_ID': '{value}' is not a valid integer."
                                ),
                                true,
                            )
                        })?);
                        index += 1;
                    }
                }
            }
            let id = item_id.ok_or_else(|| {
                click_argument_error(
                    "rn library tag",
                    "ITEM_ID",
                    "Missing argument 'ITEM_ID'.",
                    true,
                )
            })?;
            let add = add.filter(|tag| !tag.is_empty());
            let remove = remove.filter(|tag| !tag.is_empty());
            if add.is_none() && remove.is_none() && !options.json {
                return Ok(());
            }
            let (account_id, item) = db.get_local_item_for_cli(id)?;
            let item = item.ok_or_else(|| format!("素材 {id} 不存在或不属于当前账号"))?;
            if add.is_none() && remove.is_none() {
                return print_json(&item);
            }
            let mut tags = item.tags.clone();
            let mut messages = Vec::new();
            if let Some(tag) = add {
                if !tags.contains(&tag) {
                    tags.push(tag.clone());
                }
                messages.push(format!("✓ 已添加标签「{}」→ {}", tag, legacy_tags(&tags)));
            }
            if let Some(tag) = remove {
                tags.retain(|value| value != &tag);
                messages.push(format!("✓ 已删除标签「{}」→ {}", tag, legacy_tags(&tags)));
            }
            let updated = db.update_local_item_metadata(LocalItemMetadataUpdate {
                item_id: id,
                account_pool_id: account_id,
                expected_metadata_version: item.metadata_version,
                title: item.title.clone(),
                tags,
                style: item.style.clone(),
                material: item.material.clone(),
                scene: item.scene.clone(),
                color: item.color.clone(),
            })?;
            if options.json {
                print_json(&updated)?;
            } else {
                for message in messages {
                    println!("{message}");
                }
            }
        }
        Some("library") if command.get(1).map(String::as_str) == Some("trash") => {
            if command.len() != 2 {
                return Err("用法：rn library trash".into());
            }
            let trash = db.list_local_trashed_items_for_cli()?;
            output_items(&trash, &trash, options.json)?;
        }
        Some("library") if command.get(1).map(String::as_str) == Some("restore") => {
            let id = single_click_integer_argument(&command[2..], "rn library restore", "ITEM_ID")?;
            let account_id = db
                .current_active_account()
                .map_err(|error| format!("读取当前账号失败：{error}"))?
                .id;
            let item = db.restore_local_item(id, account_id)?;
            if options.json {
                print_json(&item)?;
            } else {
                println!("素材 {id} 已从回收站恢复");
            }
        }
        Some("library") if command.get(1).map(String::as_str) == Some("purge") => {
            let id = command
                .get(2)
                .ok_or("用法：rn library purge ITEM_ID --yes")?
                .parse::<i64>()
                .map_err(|_| "素材 ID 必须是整数")?;
            let args = &command[3..];
            if args.iter().any(|arg| arg != "--yes") {
                return Err(format!(
                    "未知参数：{}",
                    args.iter().find(|arg| arg != &"--yes").unwrap()
                ));
            }
            if !args.iter().any(|arg| arg == "--yes") {
                return Err("永久清理会删除图库记录及受管理的图片文件；请添加 --yes 确认".into());
            }
            let account_id = db
                .current_active_account()
                .map_err(|error| format!("读取当前账号失败：{error}"))?
                .id;
            let result = db.purge_local_items(&[id], account_id)?;
            if options.json {
                print_json(&result)?;
            } else {
                println!("素材 {id} 已永久清理");
                for warning in result.cleanup_warnings {
                    eprintln!("清理提示：{warning}");
                }
            }
        }
        Some("library") if command.get(1).map(String::as_str) == Some("delete") => {
            let args = &command[2..];
            let id = click_integer_positional_argument(
                args,
                "rn library delete",
                "ITEM_ID",
                &[],
                &["--yes", "--delete-file"],
            )?;
            confirm_destructive_action(
                "确认删除？",
                args.iter().any(|arg| arg == "--yes"),
                options.json,
            )?;
            if args.iter().any(|arg| arg == "--delete-file") {
                eprintln!("兼容旧选项 --delete-file：旧版实际仍只软删除；如需真正删除受管理的图片文件，请先移入回收站，再运行 library purge ITEM_ID --yes。");
            }
            let (account_id, item) = db.get_local_item_for_cli(id)?;
            if item.is_none() {
                if options.json {
                    print_json(&serde_json::json!({"id": id, "deleted": false}))?;
                } else {
                    println!("物品 ID {id} 不存在");
                }
                return Ok(());
            }
            db.delete_local_item(id, account_id)?;
            if options.json {
                print_json(&serde_json::json!({"id": id, "deleted": true}))?;
            } else {
                println!("✓ 已删除物品 ID={id}");
            }
        }
        Some("content") if command.get(1).map(String::as_str) == Some("list") => {
            let args = &command[2..];
            reject_unknown_options(args, &["--status", "-s", "--item-id", "-i"])?;
            let status = parse_option_aliases(args, &["--status", "-s"])?;
            let item_id = parse_option_aliases(args, &["--item-id", "-i"])?
                .map(|value| {
                    value.parse::<i64>().map_err(|_| {
                        click_option_value_error("rn content list", "--item-id", &value, "integer")
                    })
                })
                .transpose()?;
            let (_, notes) = db.list_local_notes_for_legacy(status.as_deref(), item_id)?;
            output_notes(&notes, options.json)?;
        }
        Some("content") if command.get(1).map(String::as_str) == Some("draft") => {
            const COMMAND: &str = "rn content draft";
            let args = &command[2..];
            let mut index = 0;
            let mut item_id = None;
            let mut reference_id = None;
            let mut extra = String::new();
            let mut save = false;
            while index < args.len() {
                match args[index].as_str() {
                    "--save" => {
                        save = true;
                        index += 1;
                    }
                    option @ ("--account-id" | "-a" | "--extra" | "-e") => {
                        let Some(value) = args.get(index + 1) else {
                            return Err(click_command_error(
                                COMMAND,
                                &format!("Option '{option}' requires an argument."),
                                false,
                            ));
                        };
                        match option {
                            "--account-id" | "-a" => reference_id = Some(value.clone()),
                            "--extra" | "-e" => extra.clone_from(value),
                            _ => unreachable!("matched content draft option"),
                        }
                        index += 2;
                    }
                    value if item_id.is_none() && value.parse::<i64>().is_ok() => {
                        item_id = Some(value);
                        index += 1;
                    }
                    value if value.starts_with('-') => {
                        return Err(click_command_error(
                            COMMAND,
                            &format!("No such option: {value}"),
                            true,
                        ));
                    }
                    value if item_id.is_none() => {
                        item_id = Some(value);
                        index += 1;
                    }
                    value => {
                        return Err(click_command_error(
                            COMMAND,
                            &format!("Got unexpected extra argument ({value})"),
                            true,
                        ));
                    }
                }
            }
            let item_id = item_id
                .ok_or_else(|| click_command_error(COMMAND, "Missing argument 'ITEM_ID'.", true))?;
            let item_id = item_id.parse::<i64>().map_err(|_| {
                click_command_error(
                    COMMAND,
                    &format!("Invalid value for 'ITEM_ID': '{item_id}' is not a valid integer."),
                    true,
                )
            })?;
            let data = snapshot(&db, "workspace")?;
            let item = data
                .items
                .iter()
                .find(|item| item.id == item_id)
                .ok_or_else(|| {
                    legacy_exit_one(format!("物品 ID {item_id} 不存在"), options.json)
                })?;
            let reference = reference_id.as_deref().and_then(|id| {
                data.reference_accounts
                    .iter()
                    .find(|account| account.account_id == id)
            });
            let knowledge = db.local_content_knowledge_context(Some(data.active_account.id))?;
            let prompt = prompt::build_draft_prompt_with_knowledge(
                item,
                data.profile.as_ref(),
                reference,
                &extra,
                Some(&knowledge),
            );
            let note = if save {
                Some(db.create_local_prompt_draft(
                    item_id,
                    data.active_account.id,
                    reference.map(|account| account.account_id.as_str()),
                    &prompt,
                )?)
            } else {
                None
            };
            if options.json {
                print_json(&serde_json::json!({
                    "prompt": prompt,
                    "noteId": note.as_ref().map(|value| value.id),
                    "itemTitle": item.title,
                }))?;
            } else {
                if let Some(profile) = data.profile.as_ref() {
                    let persona_name = profile
                        .persona_name
                        .as_deref()
                        .filter(|value| !value.is_empty())
                        .or_else(|| {
                            profile
                                .display_name
                                .as_deref()
                                .filter(|value| !value.is_empty())
                        })
                        .unwrap_or("虾薯");
                    println!(
                        "人设：{}（{}）",
                        persona_name,
                        profile.niche.as_deref().unwrap_or("None")
                    );
                } else {
                    println!("⚠ 未初始化账号人设，使用默认风格。运行 rn profile init 先设定人设。");
                }
                if let Some(reference_id) = reference_id.as_deref() {
                    if let Some(reference) = reference {
                        println!(
                            "参考账号：{}",
                            reference
                                .name
                                .as_deref()
                                .filter(|value| !value.is_empty())
                                .unwrap_or(reference_id)
                        );
                    } else {
                        println!("⚠ 账号 {reference_id} 不在数据库中，将使用默认风格");
                    }
                }
                println!("\n{}", "─".repeat(60));
                println!("📝 笔记创作 Prompt（复制给 Agent 生成内容）");
                println!("{}", "─".repeat(60));
                println!("{prompt}");
                println!("{}\n", "─".repeat(60));
                if let Some(note) = note {
                    println!(
                        "✓ 草稿记录已创建 ID={}（status=draft，等待填入内容）",
                        note.id
                    );
                    println!("填入内容后执行：rn content edit {}", note.id);
                }
            }
        }
        Some("content") if command.get(1).map(String::as_str) == Some("topic") => {
            let args = &command[2..];
            reject_unknown_options(
                args,
                &[
                    "--account-id",
                    "-a",
                    "--analysis-file",
                    "-f",
                    "--extra",
                    "-e",
                    "--item-ids",
                    "-i",
                ],
            )?;
            let reference_id = parse_option_aliases(args, &["--account-id", "-a"])?;
            let analysis_file = parse_option_aliases(args, &["--analysis-file", "-f"])?
                .filter(|value| !value.is_empty());
            let extra = parse_option_aliases(args, &["--extra", "-e"])?.unwrap_or_default();
            let item_ids = parse_option_aliases(args, &["--item-ids", "-i"])?
                .filter(|value| !value.is_empty())
                .map(|value| {
                    value
                        .split(',')
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| value.parse::<i64>().map_err(|_| "素材 ID 必须是整数"))
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?;
            let data = snapshot(&db, "workspace")?;
            let mut items = data.items.iter().collect::<Vec<_>>();
            if let Some(ids) = item_ids {
                items = ids
                    .iter()
                    .filter_map(|id| data.items.iter().find(|item| item.id == *id))
                    .collect();
            }
            if items.is_empty() {
                if options.json {
                    print_json(&serde_json::json!({"prompt":null,"itemCount":0}))?;
                } else {
                    println!("⚠ 图库为空，先用 library add 导入物品");
                }
                return Ok(());
            }
            let item_titles = items
                .iter()
                .map(|item| {
                    format!(
                        "{}（{}·{}）",
                        item.title,
                        item.style.as_deref().unwrap_or(""),
                        item.scene.as_deref().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>();
            let mut crawl_summary = String::new();
            if let Some(path) = analysis_file {
                match std::fs::read_to_string(&path)
                    .map_err(|error| error.to_string())
                    .and_then(|text| {
                        serde_json::from_str::<serde_json::Value>(&text)
                            .map_err(|error| error.to_string())
                    }) {
                    Ok(value) => {
                        crawl_summary.push_str("高频钩子词：");
                        let hooks = value
                            .get("top_hooks")
                            .and_then(serde_json::Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let hook_text = hooks
                            .iter()
                            .take(5)
                            .filter_map(|hook| {
                                let pair = hook.as_array()?;
                                let word = pair.first()?.as_str()?;
                                let count = match pair.get(1)? {
                                    serde_json::Value::String(value) => value.clone(),
                                    serde_json::Value::Bool(value) => {
                                        if *value { "True" } else { "False" }.to_string()
                                    }
                                    serde_json::Value::Null => "None".to_string(),
                                    value => value.to_string(),
                                };
                                Some(format!("{word}({count})"))
                            })
                            .collect::<Vec<_>>()
                            .join("  ");
                        crawl_summary.push_str(&hook_text);
                        let top = value
                            .get("top_items")
                            .and_then(serde_json::Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let titles = top
                            .iter()
                            .take(3)
                            .map(|item| {
                                item.get("_title")
                                    .and_then(serde_json::Value::as_str)
                                    .filter(|title| !title.is_empty())
                                    .or_else(|| {
                                        item.get("title").and_then(serde_json::Value::as_str)
                                    })
                                    .unwrap_or("")
                                    .to_string()
                            })
                            .collect::<Vec<_>>();
                        if !top.is_empty() {
                            crawl_summary.push('\n');
                            crawl_summary.push_str("TOP笔记标题：\n");
                            crawl_summary.push_str(
                                &titles
                                    .iter()
                                    .map(|title| format!("  - {title}"))
                                    .collect::<Vec<_>>()
                                    .join("\n"),
                            );
                        }
                    }
                    Err(error) => {
                        if options.json {
                            eprintln!("读取分析文件失败，忽略该文件：{error}");
                        } else {
                            println!("⚠ 读取分析文件失败：{error}");
                        }
                    }
                }
            }
            let reference = reference_id.as_deref().and_then(|id| {
                data.reference_accounts
                    .iter()
                    .find(|account| account.account_id == id)
            });
            let prompt =
                prompt::build_topic_prompt(&item_titles, reference, &crawl_summary, &extra);
            if options.json {
                print_json(&serde_json::json!({"prompt":prompt,"itemCount":items.len()}))?;
            } else {
                println!("\n{}", "─".repeat(60));
                println!("🗂  选题生成 Prompt（复制给 Agent 生成选题清单）");
                println!("{}", "─".repeat(60));
                println!("{prompt}");
                println!("{}\n", "─".repeat(60));
            }
        }
        Some("content") if command.get(1).map(String::as_str) == Some("show") => {
            let id = single_click_integer_argument(&command[2..], "rn content show", "NOTE_ID")?;
            let (_, note) = db.get_local_note_for_legacy(id)?;
            let note =
                note.ok_or_else(|| legacy_exit_one(format!("笔记 ID {id} 不存在"), options.json))?;
            if options.json {
                print_json(&note)?;
            } else {
                output_note_detail(&note);
            }
        }
        Some("content") if command.get(1).map(String::as_str) == Some("edit") => {
            let args = &command[2..];
            let id = click_integer_positional_argument(
                args,
                "rn content edit",
                "NOTE_ID",
                &[
                    "--title", "-t", "--body", "-b", "--cover", "-c", "--tags", "--status", "-s",
                ],
                &[],
            )?;
            let title = parse_option_aliases(args, &["--title", "-t"])?;
            let body = parse_option_aliases(args, &["--body", "-b"])?;
            let cover = parse_option_aliases(args, &["--cover", "-c"])?;
            let tags = parse_option(args, "--tags")?
                .filter(|value| !value.is_empty())
                .map(|value| {
                    value
                        .split(',')
                        .map(|tag| tag.trim().trim_start_matches('#').to_string())
                        .filter(|tag| !tag.is_empty())
                        .collect::<Vec<_>>()
                });
            let status =
                parse_option_aliases(args, &["--status", "-s"])?.filter(|value| !value.is_empty());
            let (account_id, note) = db.get_local_note_for_legacy(id)?;
            let mut note = note.ok_or_else(|| {
                legacy_exit_one(
                    format!("笔记 ID {id} 不存在（或不属于当前账号）"),
                    options.json,
                )
            })?;
            let has_content_fields =
                title.is_some() || body.is_some() || cover.is_some() || tags.is_some();
            if has_content_fields {
                note = db.update_local_note_with_cover(
                    LocalNoteUpdate {
                        note_id: id,
                        account_pool_id: account_id,
                        expected_version: note.content_version,
                        title: title.unwrap_or_else(|| note.title.clone().unwrap_or_default()),
                        body: body.unwrap_or_else(|| note.body.clone().unwrap_or_default()),
                        tags: tags.unwrap_or_else(|| note.tags.clone()),
                        note_type: note.note_type.clone(),
                        item_ids: note.item_ids.clone(),
                        video_path: None,
                    },
                    cover,
                )?;
            } else {
                note = db.touch_local_note_for_account(id, account_id)?;
            }
            if let Some(status) = status {
                note = db.update_local_note_status(LocalNoteStatusUpdate {
                    note_id: id,
                    account_pool_id: account_id,
                    expected_version: note.content_version,
                    status,
                    note_url: None,
                })?;
            }
            if options.json {
                print_json(&note)?;
            } else {
                println!("✓ 笔记 ID={id} 已更新（{}）", note.status);
            }
        }
        Some("content") if command.get(1).map(String::as_str) == Some("export") => {
            let args = &command[2..];
            let id = click_integer_positional_argument(
                args,
                "rn content export",
                "NOTE_ID",
                &["--output", "-o"],
                &[],
            )?;
            let output =
                parse_option_aliases(args, &["--output", "-o"])?.filter(|value| !value.is_empty());
            let (_, note) = db.get_local_note_for_legacy(id)?;
            let note =
                note.ok_or_else(|| legacy_exit_one(format!("笔记 ID {id} 不存在"), options.json))?;
            let item_title = note
                .item_id
                .and_then(|item_id| {
                    db.get_local_item_for_cli(item_id)
                        .ok()?
                        .1
                        .map(|item| item.title)
                })
                .unwrap_or_default();
            let markdown = export_markdown(&note, &item_title);
            if let Some(path) = output {
                std::fs::write(&path, &markdown)
                    .map_err(|error| format!("写入导出文件失败：{error}"))?;
                if options.json {
                    print_json(&serde_json::json!({"output": path, "markdown": markdown}))?;
                } else {
                    println!("✓ 已导出到：{path}");
                }
            } else {
                print!("\n{markdown}\n");
            }
        }
        Some("accounts") if command.get(1).map(String::as_str) == Some("list") => {
            let mut accounts = snapshot(&db, "references")?.reference_accounts;
            accounts.sort_by(|left, right| right.crawled_at.cmp(&left.crawled_at));
            if options.json {
                print_json(&accounts)?;
            } else {
                if accounts.is_empty() {
                    println!("暂无榜样账号数据，可用 accounts add 手动录入");
                } else {
                    println!("account_id\t名称\t笔记数\t均赞\t均评\t均藏\t抓取时间");
                    for account in accounts {
                        println!(
                            "{}\t{}\t{}\t{:?}\t{:?}\t{:?}\t{}",
                            account.account_id.chars().take(24).collect::<String>(),
                            account
                                .name
                                .as_deref()
                                .filter(|value| !value.is_empty())
                                .unwrap_or("—"),
                            account.note_count,
                            account.avg_likes,
                            account.avg_comments,
                            account.avg_collects,
                            legacy_short_timestamp(account.crawled_at.as_deref())
                        );
                    }
                }
            }
        }
        Some("accounts") if command.get(1).map(String::as_str) == Some("add") => {
            let args = &command[2..];
            let platform_id = click_positional_argument(
                args,
                "rn accounts add",
                "ACCOUNT_ID",
                &[
                    "--name",
                    "-n",
                    "--followers",
                    "--note-count",
                    "--avg-likes",
                    "--avg-comments",
                    "--avg-collects",
                    "--style",
                    "--top-notes",
                ],
                &[],
            )?;
            let name = parse_option_aliases(args, &["--name", "-n"])?.ok_or_else(|| {
                click_argument_error(
                    "rn accounts add",
                    "ACCOUNT_ID",
                    "Missing option '--name' / '-n'.",
                    true,
                )
            })?;
            let parse_i64 = |option: &str| -> Result<i64, String> {
                parse_option(args, option)?
                    .map(|value| {
                        value
                            .parse::<i64>()
                            .map_err(|_| {
                                click_argument_error(
                                    "rn accounts add",
                                    "ACCOUNT_ID",
                                    &format!(
                                        "Invalid value for '{option}': '{value}' is not a valid integer."
                                    ),
                                    true,
                                )
                            })
                    })
                    .transpose()
                    .map(|value| value.unwrap_or_default())
            };
            let parse_f64 = |option: &str| -> Result<f64, String> {
                parse_option(args, option)?
                    .map(|value| {
                        value.parse::<f64>().map_err(|_| {
                            click_argument_error(
                                "rn accounts add",
                                "ACCOUNT_ID",
                                &format!(
                                    "Invalid value for '{option}': '{value}' is not a valid float."
                                ),
                                true,
                            )
                        })
                    })
                    .transpose()
                    .map(|value| value.unwrap_or_default())
            };
            let top_notes = parse_option(args, "--top-notes")?
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(|title| ReferenceNote {
                    title: title.to_string(),
                    likes: 0,
                    url: Some(String::new()),
                })
                .collect::<Vec<_>>();
            let active_id = db
                .current_active_account()
                .map_err(|error| format!("读取当前账号失败：{error}"))?
                .id;
            db.upsert_local_reference_account_manual(LocalReferenceAccountManualUpsert {
                account_pool_id: active_id,
                account_id: platform_id.clone(),
                name,
                followers: parse_i64("--followers")?,
                note_count: parse_i64("--note-count")?,
                avg_likes: parse_f64("--avg-likes")?,
                avg_comments: parse_f64("--avg-comments")?,
                avg_collects: parse_f64("--avg-collects")?,
                content_style: parse_option(args, "--style")?.filter(|value| !value.is_empty()),
                top_notes,
            })?;
            let accounts = snapshot(&db, "references")?.reference_accounts;
            let account = accounts
                .iter()
                .find(|account| account.account_id == platform_id)
                .ok_or("保存后未读取到榜样账号")?;
            if options.json {
                print_json(account)?;
            } else {
                println!(
                    "✓ 已录入账号 {}（{}）",
                    account.name.as_deref().unwrap_or(""),
                    account.account_id
                );
                for note in &account.top_notes {
                    println!("  · {}", note.title);
                }
            }
        }
        Some("accounts") if command.get(1).map(String::as_str) == Some("show") => {
            let platform_id =
                single_click_argument(&command[2..], "rn accounts show", "ACCOUNT_ID")?;
            let accounts = snapshot(&db, "references")?.reference_accounts;
            let Some(account) = accounts
                .iter()
                .find(|account| account.account_id == *platform_id)
            else {
                if options.json {
                    print_json(&serde_json::json!({"error":format!("账号 {platform_id} 不存在")}))?;
                } else {
                    println!("账号 {platform_id} 不存在");
                }
                return Ok(());
            };
            if options.json {
                print_json(account)?;
            } else {
                println!();
                println!(
                    "{}  ({})",
                    account.name.as_deref().unwrap_or(""),
                    account.account_id
                );
                println!(
                    "  笔记数：{}  均赞：{:?}  均评：{:?}  均藏：{:?}",
                    account.note_count,
                    account.avg_likes,
                    account.avg_comments,
                    account.avg_collects
                );
                if let Some(style) = account
                    .content_style
                    .as_deref()
                    .filter(|value| !value.is_empty())
                {
                    println!("  风格：{}", legacy_reference_style(style));
                }
                if !account.top_notes.is_empty() {
                    println!("  高赞笔记：");
                    for note in &account.top_notes {
                        let likes = if note.likes == 0 {
                            String::new()
                        } else {
                            format!("  赞 {}", note.likes)
                        };
                        println!("    · {}{likes}", note.title);
                    }
                }
                println!(
                    "  录入时间：{}",
                    legacy_short_timestamp(account.crawled_at.as_deref())
                );
                println!();
            }
        }
        Some("accounts") if command.get(1).map(String::as_str) == Some("delete") => {
            let args = &command[2..];
            let platform_id = click_positional_argument(
                args,
                "rn accounts delete",
                "ACCOUNT_ID",
                &[],
                &["--yes"],
            )?;
            confirm_destructive_action(
                "确认删除该账号吗？",
                args.iter().any(|arg| arg == "--yes"),
                options.json,
            )?;
            let active_id = db
                .current_active_account()
                .map_err(|error| format!("读取当前账号失败：{error}"))?
                .id;
            let exists = snapshot(&db, "references")?
                .reference_accounts
                .iter()
                .any(|account| account.account_id == platform_id);
            if !exists {
                if options.json {
                    print_json(&serde_json::json!({"accountId":platform_id,"deleted":false}))?;
                } else {
                    println!("账号 {platform_id} 不存在");
                }
                return Ok(());
            }
            db.delete_local_reference_account_by_platform_id(&platform_id, active_id)?;
            if options.json {
                print_json(&serde_json::json!({"accountId":platform_id,"deleted":true}))?;
            } else {
                println!("✓ 已删除账号 {platform_id}");
            }
        }
        Some("profile") if command.get(1).map(String::as_str) == Some("show") => {
            let Some(profile) = snapshot(&db, "profile")?.profile else {
                if options.json {
                    print_json(&serde_json::Value::Null)?;
                } else {
                    println!("尚未初始化账号信息，运行：profile init --name ... --niche ...");
                }
                return Ok(());
            };
            if options.json {
                print_json(&profile)?;
            } else {
                output_profile_detail(&profile);
            }
        }
        Some("profile") if matches!(command.get(1).map(String::as_str), Some("edit" | "init")) => {
            let args = &command[2..];
            let is_init = command.get(1).map(String::as_str) == Some("init");
            let command_name = if is_init {
                "rn profile init"
            } else {
                "rn profile edit"
            };
            let mut text_fields = vec![
                "--name",
                "--niche",
                "--audience",
                "--persona-name",
                "--persona-bio",
                "--persona-tone",
                "--rhythm",
            ];
            if is_init {
                text_fields.extend(["--url", "--account-id"]);
            }
            let list_fields = [
                "--pillars",
                "--taboos",
                "--styles",
                "--scenes",
                "--hashtags",
            ];
            let stats_fields = [
                "--followers",
                "--total-notes",
                "--avg-likes",
                "--avg-comments",
                "--avg-collects",
            ];
            let allowed = text_fields
                .iter()
                .chain(list_fields.iter())
                .chain(stats_fields.iter())
                .copied()
                .collect::<Vec<_>>();
            reject_unknown_options(args, &allowed)?;
            let profile_url = parse_option(args, "--url")?.filter(|value| !value.is_empty());
            if is_init && profile_url.is_none() {
                if parse_option(args, "--name")?
                    .as_deref()
                    .unwrap_or_default()
                    .is_empty()
                {
                    return Err(legacy_exit_one(
                        "请提供 --name（账号显示名）或 --url（账号主页URL，自动推断）",
                        options.json,
                    ));
                }
                if parse_option(args, "--niche")?
                    .as_deref()
                    .unwrap_or_default()
                    .is_empty()
                {
                    return Err(legacy_exit_one(
                        "请提供 --niche（垂类定位）或 --url（账号主页URL，自动推断）",
                        options.json,
                    ));
                }
            }
            let mut profile_supplied = false;
            let mut stats_supplied = false;
            let mut update_field_count = 0;
            for option in &allowed {
                let value = parse_option(args, option)?;
                let present = value.as_ref().is_some_and(|value| {
                    !list_fields.contains(option)
                        || value.split(',').any(|part| !part.trim().is_empty())
                });
                if *option == "--url" {
                    continue;
                }
                update_field_count += usize::from(present);
                if stats_fields.contains(option) {
                    stats_supplied |= present;
                } else {
                    profile_supplied |= present;
                }
            }
            if !profile_supplied && !stats_supplied && profile_url.is_none() {
                if !is_init {
                    if options.json {
                        print_json(&serde_json::json!({"updated": false}))?;
                    } else {
                        println!("未指定任何字段，无变更");
                    }
                    return Ok(());
                }
                return Err("请至少指定一个人设字段或账号统计字段".into());
            }
            let profile = snapshot(&db, "profile")?.profile;
            let current = profile.clone();
            let active_id = db
                .current_active_account()
                .map_err(|error| format!("读取当前账号失败：{error}"))?
                .id;
            let profile_progress = |message: &str| {
                if options.json {
                    eprintln!("{message}");
                } else {
                    println!("{message}");
                }
            };
            if profile_url.is_some() {
                profile_progress("正在抓取账号数据...");
                profile_progress("首次运行需要扫码登录小红书，请在弹出的浏览器中完成");
            }
            let capture = if let Some(url) = profile_url.as_deref() {
                Some(capture_own_profile(&db, active_id, url)?)
            } else {
                None
            };
            let mut inference = serde_json::Value::Null;
            let mut capture_stats = serde_json::Value::Null;
            if let Some((captured_id, captured_profile, notes, complete)) = capture.as_ref() {
                if parse_option(args, "--account-id")?
                    .as_deref()
                    .is_some_and(|requested| requested != captured_id)
                {
                    return Err("--account-id 与主页账号 ID 不一致，已停止写入".into());
                }
                if current
                    .as_ref()
                    .and_then(|value| value.account_id.as_deref())
                    .is_some_and(|bound| !bound.is_empty() && bound != captured_id)
                {
                    return Err("主页账号与当前人设绑定账号不一致，已停止写入".into());
                }
                let pool_account = db
                    .account_pool()
                    .map_err(|error| format!("读取运营账号绑定失败：{error}"))?
                    .items
                    .into_iter()
                    .find(|account| account.id == active_id)
                    .ok_or("当前运营账号不存在")?;
                if pool_account
                    .xhs_user_id
                    .as_deref()
                    .is_some_and(|bound| !bound.is_empty() && bound != captured_id)
                {
                    return Err("主页账号与账号池绑定 ID 不一致，已停止写入".into());
                }
                capture_stats = profile_inference_stats(captured_profile, notes, *complete);
                profile_progress(&format!("✓ 抓取完成，共 {} 条笔记", notes.len()));
                profile_progress("正在用 AI 分析笔记数据，推断账号人设...");
                let note_values = serde_json::to_value(notes)
                    .map_err(|error| format!("编码主页笔记失败：{error}"))?;
                match http::default_model_provider(&db).and_then(|(provider, model)| {
                    let runtime = tokio::runtime::Builder::new_multi_thread()
                        .enable_all()
                        .build()
                        .map_err(|error| format!("启动人设分析运行时失败：{error}"))?;
                    runtime.block_on(
                        aichihongshu_services::profile_analysis::infer_profile_from_notes(
                            &provider,
                            &model,
                            note_values
                                .as_array()
                                .map(Vec::as_slice)
                                .unwrap_or_default(),
                            &capture_stats,
                        ),
                    )
                }) {
                    Ok(value) => inference = value,
                    Err(error) => {
                        if options.json {
                            eprintln!(
                                "警告：AI 人设推断失败，将保留已有字段并继续同步主页：{error}"
                            );
                        } else {
                            println!("AI 推断失败：{error}");
                            println!("将使用空人设写入数据库，请之后手动 profile edit 补充");
                        }
                    }
                }
            }

            let get_text = |option: &str,
                            explicit: Option<String>,
                            inferred_field: Option<&str>,
                            captured_value: Option<String>|
             -> Option<String> {
                let explicit = explicit.filter(|value| {
                    profile_url.is_none()
                        || !matches!(
                            option,
                            "--account-id"
                                | "--name"
                                | "--niche"
                                | "--audience"
                                | "--persona-tone"
                                | "--rhythm"
                        )
                        || !value.is_empty()
                });
                explicit
                    .or(captured_value)
                    .or_else(|| inferred_field.and_then(|field| inferred_text(&inference, field)))
                    .or_else(|| {
                        current.as_ref().and_then(|p| match option {
                            "--account-id" => p.account_id.clone(),
                            "--name" => p.display_name.clone(),
                            "--niche" => p.niche.clone(),
                            "--audience" => p.target_audience.clone(),
                            "--persona-name" => p.persona_name.clone(),
                            "--persona-bio" => p.persona_bio.clone(),
                            "--persona-tone" => p.persona_tone.clone(),
                            "--rhythm" => p.posting_rhythm.clone(),
                            _ => None,
                        })
                    })
            };
            let list_value = |option: &str,
                              inferred_field: &str,
                              previous: &[String]|
             -> Result<Vec<String>, String> {
                let manual = parse_option(args, option)?;
                Ok(if manual.is_some() {
                    comma_list(manual, &[])
                } else {
                    inferred_list(&inference, inferred_field).unwrap_or_else(|| previous.to_vec())
                })
            };
            let p = current.as_ref();
            if profile_supplied || (is_init && current.is_none()) || capture.is_some() {
                let captured_profile = capture.as_ref().map(|(_, profile, _, _)| profile);
                let captured_id = capture.as_ref().map(|(id, _, _, _)| id.clone());
                let captured_text = |field: &str| {
                    captured_profile
                        .and_then(|profile| profile.get(field))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                };
                let captured_followers = captured_profile
                    .and_then(|profile| profile.get("followers"))
                    .and_then(serde_json::Value::as_i64);
                db.update_local_profile(LocalProfileUpdate {
                    account_pool_id: active_id,
                    account_id: get_text(
                        "--account-id",
                        parse_option(args, "--account-id")?,
                        None,
                        captured_id,
                    ),
                    display_name: get_text(
                        "--name",
                        parse_option(args, "--name")?,
                        None,
                        captured_text("displayName"),
                    )
                    .or_else(|| capture.as_ref().map(|(id, _, _, _)| id.clone()))
                    .or_else(|| is_init.then(|| "我的账号".to_string())),
                    niche: get_text(
                        "--niche",
                        parse_option(args, "--niche")?,
                        Some("niche"),
                        None,
                    ),
                    target_audience: get_text(
                        "--audience",
                        parse_option(args, "--audience")?,
                        Some("target_audience"),
                        None,
                    ),
                    content_pillars: list_value(
                        "--pillars",
                        "content_pillars",
                        p.map(|p| p.content_pillars.as_slice()).unwrap_or_default(),
                    )?,
                    followers: captured_followers,
                    persona_name: get_text(
                        "--persona-name",
                        parse_option(args, "--persona-name")?,
                        None,
                        None,
                    ),
                    persona_bio: get_text(
                        "--persona-bio",
                        parse_option(args, "--persona-bio")?,
                        None,
                        None,
                    ),
                    persona_tone: get_text(
                        "--persona-tone",
                        parse_option(args, "--persona-tone")?,
                        Some("persona_tone"),
                        None,
                    ),
                    persona_taboos: list_value(
                        "--taboos",
                        "taboos",
                        p.map(|p| p.persona_taboos.as_slice()).unwrap_or_default(),
                    )?,
                    preferred_styles: list_value(
                        "--styles",
                        "preferred_styles",
                        p.map(|p| p.preferred_styles.as_slice()).unwrap_or_default(),
                    )?,
                    preferred_scenes: list_value(
                        "--scenes",
                        "preferred_scenes",
                        p.map(|p| p.preferred_scenes.as_slice()).unwrap_or_default(),
                    )?,
                    hashtag_pool: list_value(
                        "--hashtags",
                        "hashtag_pool",
                        p.map(|p| p.hashtag_pool.as_slice()).unwrap_or_default(),
                    )?,
                    avatar_url: captured_text("avatarUrl"),
                    xhs_bio: captured_text("bio"),
                    xhs_follows: captured_profile
                        .and_then(|profile| profile.get("follows"))
                        .and_then(serde_json::Value::as_i64),
                    ip_location: captured_text("ipLocation"),
                    xhs_tags: captured_profile
                        .and_then(|profile| profile.get("tags"))
                        .and_then(serde_json::Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(serde_json::Value::as_str)
                                .map(str::to_string)
                                .collect()
                        }),
                    risk_warning_ack: None,
                    posting_rhythm: get_text(
                        "--rhythm",
                        parse_option(args, "--rhythm")?,
                        Some("posting_rhythm"),
                        None,
                    ),
                })?;
            }
            if let Some((captured_id, captured_profile, _, _)) = capture.as_ref() {
                let account = db
                    .account_pool()
                    .map_err(|error| format!("读取运营账号资料失败：{error}"))?
                    .items
                    .into_iter()
                    .find(|account| account.id == active_id)
                    .ok_or("当前运营账号不存在")?;
                db.update_local_account(LocalAccountUpdate {
                    account_id: active_id,
                    alias: account.alias,
                    role: account.role,
                    xhs_user_id: Some(captured_id.clone()),
                    display_name: captured_profile
                        .get("displayName")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                        .or(account.display_name),
                    status: account.status,
                    followers: captured_profile
                        .get("followers")
                        .and_then(serde_json::Value::as_i64)
                        .or(Some(account.followers)),
                    notes: account.notes,
                })?;
            }
            if let Some((captured_id, _, notes, complete)) = capture.as_ref() {
                db.sync_profile_notes_from_browser_snapshot(
                    active_id,
                    captured_id,
                    None,
                    *complete,
                    notes,
                )?;
            }
            let parse_i64 = |option: &str| -> Result<Option<i64>, String> {
                parse_option(args, option)?
                    .map(|value| {
                        value.parse::<i64>().map_err(|_| {
                            click_option_value_error(command_name, option, &value, "integer")
                        })
                    })
                    .transpose()
            };
            let parse_f64 = |option: &str| -> Result<Option<f64>, String> {
                parse_option(args, option)?
                    .map(|value| {
                        value.parse::<f64>().map_err(|_| {
                            click_option_value_error(command_name, option, &value, "float")
                        })
                    })
                    .transpose()
            };
            let use_manual_or_captured_i64 =
                |option: &str, key: &str| -> Result<Option<i64>, String> {
                    let manual = parse_i64(option)?;
                    let captured = capture_stats.get(key).and_then(serde_json::Value::as_i64);
                    Ok(if is_init && profile_url.is_some() {
                        manual.filter(|value| *value != 0).or(captured)
                    } else {
                        manual
                    })
                };
            let use_manual_or_captured_f64 =
                |option: &str, key: &str| -> Result<Option<f64>, String> {
                    let manual = parse_f64(option)?;
                    let captured = capture_stats.get(key).and_then(serde_json::Value::as_f64);
                    Ok(if is_init && profile_url.is_some() {
                        manual.filter(|value| *value != 0.0).or(captured)
                    } else {
                        manual
                    })
                };
            let stats = (
                use_manual_or_captured_i64("--followers", "followers")?,
                use_manual_or_captured_i64("--total-notes", "note_count")?,
                use_manual_or_captured_f64("--avg-likes", "avg_likes")?,
                use_manual_or_captured_f64("--avg-comments", "avg_comments")?,
                use_manual_or_captured_f64("--avg-collects", "avg_collects")?,
            );
            if (stats_supplied || capture.is_some())
                && (stats.0.is_some()
                    || stats.1.is_some()
                    || stats.2.is_some()
                    || stats.3.is_some()
                    || stats.4.is_some())
            {
                db.update_local_profile_stats(
                    active_id, stats.0, stats.1, stats.2, stats.3, stats.4,
                )?;
            }
            let updated = snapshot(&db, "profile")?
                .profile
                .ok_or("保存后未读取到人设")?;
            if options.json {
                print_json(&updated)?;
            } else if is_init {
                if profile_url.is_some() {
                    println!("\n── AI 推断结果（已写入数据库，可用 profile edit 修正）──");
                    println!("  垂类：{}", updated.niche.as_deref().unwrap_or(""));
                    println!(
                        "  目标受众：{}",
                        updated.target_audience.as_deref().unwrap_or("")
                    );
                    println!("  内容支柱：{}", updated.content_pillars.join("、"));
                    println!(
                        "  语气风格：{}",
                        updated.persona_tone.as_deref().unwrap_or("")
                    );
                    println!("  偏好风格：{}", updated.preferred_styles.join("、"));
                    println!("  偏好场景：{}", updated.preferred_scenes.join("、"));
                    println!(
                        "  标签池：{}",
                        updated
                            .hashtag_pool
                            .iter()
                            .take(6)
                            .map(|tag| format!("#{tag}"))
                            .collect::<Vec<_>>()
                            .join("  ")
                    );
                    println!("  禁忌词：{}", updated.persona_taboos.join("、"));
                    if let Some(summary) = inference
                        .get("analysis_summary")
                        .and_then(serde_json::Value::as_str)
                        .filter(|summary| !summary.is_empty())
                    {
                        println!("  总结：{summary}");
                    }
                }
                println!(
                    "\n✓ 账号人设已写入数据库：{}",
                    updated.display_name.as_deref().unwrap_or("")
                );
                if let Some(niche) = updated.niche.as_deref().filter(|value| !value.is_empty()) {
                    println!("  垂类：{niche}");
                }
                if let Some(persona_name) = updated
                    .persona_name
                    .as_deref()
                    .filter(|value| !value.is_empty())
                {
                    println!(
                        "  人设：{persona_name}  {}",
                        updated.persona_bio.as_deref().unwrap_or("")
                    );
                }
                println!("运行 profile show 查看完整信息 | profile edit 修正字段");
            } else {
                println!("✓ 已更新 {update_field_count} 个字段");
            }
        }
        _ => {
            usage();
            return Err(format!(
                "未知命令：{}；运行 rn --help 查看当前支持的命令",
                command.join(" ")
            ));
        }
    }
    Ok(())
}

fn render_search_analysis_report(
    report: &aichihongshu_services::search_analysis::SearchAnalysis,
    keywords: &str,
    generated_at: &str,
) -> String {
    let separator = "=".repeat(60);
    let mut output = format!(
        "\n{separator}\n  小红书首页推荐流分析报告\n  关键词：{keywords}  |  生成时间：{generated_at}\n{separator}\n\n【数据概览】共 {} 条笔记\n  平均点赞：{}  平均评论：{}  平均收藏：{}\n\n【高频钩子词 TOP8】（出现在标题中的停留触发词）",
        report.total, report.avg_likes, report.avg_comments, report.avg_collects
    );
    for (word, count) in &report.top_hooks {
        output.push_str(&format!("\n  {word:<8}  {} ({count})", "▇".repeat(*count)));
    }
    output.push_str("\n\n【高互动样本 TOP10】（综合得分 = 点赞 + 评论×3 + 收藏×2）");
    for (index, item) in report.top_items.iter().enumerate() {
        output.push_str(&format!(
            "\n\n  {:>2}. {}\n      点赞 {:>6}  评论 {:>5}  收藏 {:>6}  得分 {:>7}",
            index + 1,
            item["_title"].as_str().unwrap_or_default(),
            item["_likes"].as_i64().unwrap_or_default(),
            item["_comments"].as_i64().unwrap_or_default(),
            item["_collects"].as_i64().unwrap_or_default(),
            item["_score"].as_i64().unwrap_or_default(),
        ));
        let tags = item["tag_list"].as_str().unwrap_or_default();
        if !tags.is_empty() {
            let tags = tags.chars().take(70).collect::<String>();
            output.push_str(&format!("\n      话题：{tags}"));
        }
    }
    output.push_str(&format!("\n\n{separator}\n【可复用模式推断】\n"));
    let hooks = report
        .top_hooks
        .iter()
        .take(5)
        .map(|(hook, _)| hook.as_str())
        .collect::<Vec<_>>();
    if !hooks.is_empty() {
        output.push_str(&format!("  高频钩子：{}\n", hooks.join("  ")));
    }
    output.push_str(
        "  建议优先复用：情绪词 + 具体场景的标题结构\n  下步动作：从 TOP10 中选 3 条，提炼标题句式做 A/B 测试\n",
    );
    output.push_str(&separator);
    output
}

fn run_search_analysis(
    db: Option<&LocalDb>,
    args: &[String],
    json_output: bool,
) -> Result<(), String> {
    let mut input = None;
    let mut keywords = "家居,软装,装修".to_string();
    let mut output_dir = PathBuf::from("data/analysis");
    let mut save_db = false;
    let mut seen = std::collections::HashSet::new();
    let mut index = 0;
    while index < args.len() {
        let option = args[index].as_str();
        if !seen.insert(option.to_string()) {
            return Err(format!("参数 {option} 只能指定一次"));
        }
        match option {
            "--input" | "--keywords" | "--output-dir" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("参数 {option} 缺少值"))?;
                match option {
                    "--input" => input = Some(PathBuf::from(value)),
                    "--keywords" => keywords = value.clone(),
                    "--output-dir" => output_dir = PathBuf::from(value),
                    _ => unreachable!(),
                }
                index += 2;
            }
            "--save-db" => {
                save_db = true;
                index += 1;
            }
            value if value.starts_with('-') => return Err(format!("未知参数：{value}")),
            _ => return Err("analyze 不接受位置参数".into()),
        }
    }
    let input = input
        .ok_or("用法：rn analyze --input JSON [--keywords TEXT] [--output-dir DIR] [--save-db]")?;
    if keywords.trim().is_empty() || keywords.chars().count() > 500 {
        return Err("关键词不能为空且不能超过 500 个字符".into());
    }
    let metadata =
        std::fs::metadata(&input).map_err(|error| format!("读取采集文件信息失败：{error}"))?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Err("采集 JSON 超过 10 MiB 限制".into());
    }
    let source =
        std::fs::read_to_string(&input).map_err(|error| format!("读取采集文件失败：{error}"))?;
    let items = serde_json::from_str::<Vec<serde_json::Value>>(&source)
        .map_err(|error| format!("采集 JSON 格式无效：{error}"))?;
    if items.is_empty() {
        return Err("采集数据为空，请检查输入文件".into());
    }
    let report = aichihongshu_services::search_analysis::analyze(&items)?;
    let legacy_report = report
        .legacy_report()
        .map_err(|error| format!("序列化分析报告失败：{error}"))?;
    std::fs::create_dir_all(&output_dir)
        .map_err(|error| format!("创建分析报告目录失败：{error}"))?;
    let safe_keywords = keywords
        .replace(',', "_")
        .replace(' ', "")
        .chars()
        .filter(|character| character.is_alphanumeric() || matches!(character, '_' | '-'))
        .take(30)
        .collect::<String>();
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let report_path = output_dir.join(format!("analysis_{safe_keywords}_{timestamp}.json"));
    let report_bytes = serde_json::to_vec_pretty(&legacy_report)
        .map_err(|error| format!("序列化分析报告失败：{error}"))?;
    std::fs::write(&report_path, report_bytes)
        .map_err(|error| format!("写入分析报告失败：{error}"))?;

    if save_db {
        let db = db.ok_or("--save-db 需要可用的本地数据库")?;
        let account_pool_id = db
            .current_active_account()
            .map_err(|error| format!("读取当前账号失败：{error}"))?
            .id;
        db.record_local_crawl_log(
            account_pool_id,
            &keywords,
            report.total as i64,
            Some(&input.display().to_string()),
        )?;
    }

    if json_output {
        print_json(&legacy_report)?;
    } else {
        let generated_at = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
        let rendered = render_search_analysis_report(&report, &keywords, &generated_at);
        println!(
            "{rendered}\n\n[xhs_analyze] 分析结果已保存到：{}",
            report_path.display()
        );
    }
    Ok(())
}

fn run_browser_search(db: &LocalDb, args: &[String], json_output: bool) -> Result<(), String> {
    let mut keywords = "家居,软装,装修".to_string();
    let mut count = 20usize;
    let mut output_dir = PathBuf::from("data/crawl");
    let mut save_db = false;
    let mut seen = std::collections::HashSet::new();
    let mut index = 0;
    while index < args.len() {
        let option = args[index].as_str();
        if !seen.insert(option.to_string()) {
            return Err(format!("参数 {option} 只能指定一次"));
        }
        match option {
            "--keywords" | "--count" | "--output-dir" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("参数 {option} 缺少值"))?;
                match option {
                    "--keywords" => keywords = value.clone(),
                    "--count" => {
                        count = value
                            .parse::<usize>()
                            .ok()
                            .filter(|value| (1..=50).contains(value))
                            .ok_or("--count 必须在 1 到 50 之间")?;
                    }
                    "--output-dir" => output_dir = PathBuf::from(value),
                    _ => unreachable!(),
                }
                index += 2;
            }
            "--save-db" => {
                save_db = true;
                index += 1;
            }
            value if value.starts_with('-') => return Err(format!("未知参数：{value}")),
            _ => return Err("search 不接受位置参数".into()),
        }
    }
    if keywords.trim().is_empty() || keywords.chars().count() > 500 {
        return Err("关键词不能为空且不能超过 500 个字符".into());
    }
    let keywords = keywords
        .split(',')
        .map(str::trim)
        .filter(|keyword| !keyword.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if keywords.is_empty()
        || keywords.len() > 5
        || keywords.iter().any(|value| value.chars().count() > 80)
    {
        return Err("请提供 1 到 5 个关键词，每个关键词不超过 80 个字符".into());
    }

    let account_id = db
        .current_active_account()
        .map_err(|error| format!("读取当前账号失败：{error}"))?
        .id;
    let worker =
        aichihongshu_services::browser_worker::BrowserWorkerManager::for_runtime(db.path())?;
    let result = (|| -> Result<(), String> {
        let mut results = Vec::new();
        for keyword in &keywords {
            eprintln!("正在搜索「{keyword}」，最多读取 {count} 篇已渲染笔记……");
            let mut snapshot = worker.search_notes(account_id, keyword, count)?;
            for retry in 0..2 {
                let state = snapshot
                    .get("state")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("empty");
                if !matches!(state, "login-required" | "verification-required") {
                    break;
                }
                if !io::stdin().is_terminal() {
                    return Err(if state == "login-required" {
                        "独立浏览器尚未登录；请先在桌面「账号池」打开此账号的浏览器并完成登录，再重试 rn search".into()
                    } else {
                        "小红书要求人工验证；请在桌面「账号池」打开此账号浏览器处理验证，再重试 rn search".into()
                    });
                }
                if retry == 1 {
                    return Err("登录/验证状态仍未解除；已停止采集，请稍后重试".into());
                }
                if state == "login-required" {
                    eprintln!(
                        "请在新打开的独立浏览器中手动登录，然后按 Enter 继续；不支持自动处理验证。 "
                    );
                } else {
                    eprintln!(
                        "请在独立浏览器中手动完成页面验证，然后按 Enter 继续；不支持自动处理验证。 "
                    );
                }
                io::stderr()
                    .flush()
                    .map_err(|error| format!("显示浏览器提示失败：{error}"))?;
                let mut answer = String::new();
                io::stdin()
                    .read_line(&mut answer)
                    .map_err(|error| format!("读取继续指令失败：{error}"))?;
                if answer.is_empty() {
                    return Err("已取消搜索".into());
                }
                snapshot = worker.search_notes(account_id, keyword, count)?;
            }
            let items = snapshot
                .get_mut("items")
                .and_then(serde_json::Value::as_array_mut)
                .ok_or("浏览器 worker 返回的搜索结果无效")?;
            for item in items.iter_mut() {
                if let Some(object) = item.as_object_mut() {
                    object.insert("keyword".into(), serde_json::Value::String(keyword.clone()));
                    results.push(serde_json::Value::Object(object.clone()));
                }
            }
        }
        if results.is_empty() {
            return Err("未获取到已渲染的搜索笔记；页面结构可能已变化，或登录状态尚未就绪".into());
        }

        std::fs::create_dir_all(&output_dir)
            .map_err(|error| format!("创建采集结果目录失败：{error}"))?;
        let safe_keywords = keywords
            .join("_")
            .chars()
            .filter(|character| character.is_alphanumeric() || matches!(character, '_' | '-'))
            .take(30)
            .collect::<String>();
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let output_path = output_dir.join(format!("xhs_search_{safe_keywords}_{timestamp}.json"));
        let output = serde_json::to_vec_pretty(&results).map_err(|error| error.to_string())?;
        std::fs::write(&output_path, output)
            .map_err(|error| format!("写入采集结果失败：{error}"))?;

        if save_db {
            db.record_local_crawl_log(
                account_id,
                &keywords.join(","),
                results.len() as i64,
                Some(&output_path.display().to_string()),
            )?;
        }
        if json_output {
            print_json(&serde_json::json!({
                "keywords": keywords,
                "count": results.len(),
                "source_file": output_path,
                "items": results,
            }))?;
        } else {
            println!("搜索完成，共 {} 条笔记", results.len());
            println!("结果已保存：{}", output_path.display());
        }
        Ok(())
    })();
    worker.shutdown();
    result
}

fn run_crawl_history(db: &LocalDb, args: &[String], json_output: bool) -> Result<(), String> {
    let mut limit = 20usize;
    let mut seen = false;
    let mut index = 0;
    while index < args.len() {
        if args[index] != "--limit" {
            return Err(format!("未知参数：{}", args[index]));
        }
        if seen {
            return Err("参数 --limit 只能指定一次".into());
        }
        seen = true;
        let value = args.get(index + 1).ok_or("参数 --limit 缺少值")?;
        limit = value
            .parse::<usize>()
            .ok()
            .filter(|value| (1..=100).contains(value))
            .ok_or("--limit 必须在 1 到 100 之间")?;
        index += 2;
    }
    let account_id = db
        .current_active_account()
        .map_err(|error| format!("读取当前账号失败：{error}"))?
        .id;
    let history = db.list_local_crawl_logs(account_id, limit)?;
    if json_output {
        return print_json(&history);
    }
    if history.is_empty() {
        println!("当前账号暂无采集历史");
        return Ok(());
    }
    println!("ID\t时间\t笔记数\t关键词\t文件");
    for entry in history {
        println!(
            "{}\t{}\t{}\t{}\t{}",
            entry.id,
            entry.created_at.as_deref().unwrap_or(""),
            entry.count,
            entry.keywords,
            entry.source_file.as_deref().unwrap_or("")
        );
    }
    Ok(())
}

fn capture_own_profile(
    db: &LocalDb,
    account_pool_id: i64,
    profile_url: &str,
) -> Result<(String, serde_json::Value, Vec<BrowserProfileNote>, bool), String> {
    let worker =
        aichihongshu_services::browser_worker::BrowserWorkerManager::for_runtime(db.path())?;
    let result = (|| {
        let mut result = worker.collect_profile(account_pool_id, profile_url.to_string())?;
        for retry in 0..2 {
            let state = result
                .get("state")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("partial");
            if !matches!(state, "login-required" | "verification-required") {
                break;
            }
            if !io::stdin().is_terminal() {
                return Err(if state == "login-required" {
                    "独立浏览器尚未登录；请先在桌面「账号池」打开此账号的浏览器并完成登录，再重试 profile init --url".into()
                } else {
                    "小红书要求人工验证；请先在桌面「账号池」打开此账号浏览器处理验证，再重试 profile init --url".into()
                });
            }
            if retry == 1 {
                return Err("登录/验证状态仍未解除；已停止主页同步，请稍后重试".into());
            }
            eprintln!(
                "请在独立浏览器中手动完成登录或验证，然后按 Enter 重试；程序不会自动处理验证。 "
            );
            io::stderr()
                .flush()
                .map_err(|error| format!("显示主页同步提示失败：{error}"))?;
            let mut answer = String::new();
            io::stdin()
                .read_line(&mut answer)
                .map_err(|error| format!("读取继续指令失败：{error}"))?;
            if answer.is_empty() {
                return Err("已取消主页同步".into());
            }
            result = worker.collect_profile(account_pool_id, profile_url.to_string())?;
        }
        let state = result
            .get("state")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("partial");
        if !matches!(state, "complete" | "partial") {
            return Err("没有读取到有效的小红书本人主页；请检查主页 URL 和浏览器登录状态".into());
        }
        let profile = result
            .get("profile")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or("浏览器 worker 未返回主页资料")?;
        let profile_id = profile
            .get("profileId")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or("主页缺少小红书账号 ID")?
            .to_string();
        let notes = serde_json::from_value::<Vec<BrowserProfileNote>>(
            result
                .get("notes")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([])),
        )
        .map_err(|_| "主页笔记回执格式无效".to_string())?;
        Ok((profile_id, profile, notes, state == "complete"))
    })();
    worker.shutdown();
    result
}

fn profile_inference_stats(
    profile: &serde_json::Value,
    notes: &[BrowserProfileNote],
    complete: bool,
) -> serde_json::Value {
    let average = |read: fn(&BrowserProfileNote) -> Option<i64>| -> Option<f64> {
        if !complete || notes.is_empty() {
            return None;
        }
        let values = notes.iter().map(read).collect::<Option<Vec<_>>>()?;
        let mean = values.iter().map(|value| *value as f64).sum::<f64>() / values.len() as f64;
        Some((mean * 10.0).round() / 10.0)
    };
    serde_json::json!({
        "followers": profile.get("followers").and_then(serde_json::Value::as_i64),
        "note_count": profile.get("totalNotes").and_then(serde_json::Value::as_i64).unwrap_or(notes.len() as i64),
        "avg_likes": average(|note| note.likes),
        "avg_comments": average(|note| note.comments),
        "avg_collects": average(|note| note.collects),
    })
}

fn inferred_text(inference: &serde_json::Value, field: &str) -> Option<String> {
    inference
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn inferred_list(inference: &serde_json::Value, field: &str) -> Option<Vec<String>> {
    let values = inference.get(field)?.as_array()?;
    let values = values
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    (!values.is_empty()).then_some(values)
}

#[cfg(test)]
mod profile_capture_tests {
    use super::{profile_inference_stats, BrowserProfileNote};
    use serde_json::json;

    fn note(
        likes: Option<i64>,
        comments: Option<i64>,
        collects: Option<i64>,
    ) -> BrowserProfileNote {
        BrowserProfileNote {
            note_url: "https://www.xiaohongshu.com/explore/note-1".into(),
            title: "主页笔记".into(),
            body: String::new(),
            likes,
            comments,
            collects,
            tags: Vec::new(),
            published_at: None,
        }
    }

    #[test]
    fn only_complete_profile_capture_provides_inference_averages() {
        let profile = json!({"followers": 123, "totalNotes": 80});
        let notes = vec![
            note(Some(10), Some(2), Some(4)),
            note(Some(20), Some(4), Some(8)),
        ];
        let complete = profile_inference_stats(&profile, &notes, true);
        assert_eq!(complete["followers"], 123);
        assert_eq!(complete["note_count"], 80);
        assert_eq!(complete["avg_likes"], 15.0);
        assert_eq!(complete["avg_comments"], 3.0);
        assert_eq!(complete["avg_collects"], 6.0);

        let partial = profile_inference_stats(&profile, &notes, false);
        assert_eq!(partial["followers"], 123);
        assert!(partial["avg_likes"].is_null());
    }

    #[test]
    fn incomplete_interaction_metrics_are_not_sent_as_zero_averages() {
        let notes = vec![note(Some(10), None, Some(4))];
        let stats = profile_inference_stats(&json!({}), &notes, true);
        assert!(stats["avg_comments"].is_null());
        assert_eq!(stats["note_count"], 1);
    }
}

#[cfg(test)]
mod search_analysis_command_tests {
    use super::*;
    use serde_json::Value;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn analyzes_fixture_and_writes_report_without_database() {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "rn-analyze-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let input = root.join("crawl.json");
        let items = include_str!("../../services/tests/fixtures/xhs_analyze_legacy_input.json");
        std::fs::write(&input, items).unwrap();
        let output_dir = root.join("analysis");
        run_search_analysis(
            None,
            &[
                "--input".into(),
                input.display().to_string(),
                "--keywords".into(),
                "家居/软装".into(),
                "--output-dir".into(),
                output_dir.display().to_string(),
            ],
            true,
        )
        .unwrap();
        let report_path = std::fs::read_dir(&output_dir)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let report: Value = serde_json::from_slice(&std::fs::read(report_path).unwrap()).unwrap();
        let expected: Value = serde_json::from_str(include_str!(
            "../../services/tests/fixtures/xhs_analyze_legacy_report.json"
        ))
        .unwrap();
        assert_eq!(report, expected);
        assert!(run_search_analysis(
            None,
            &[
                "--input".into(),
                input.display().to_string(),
                "--save-db".into()
            ],
            true
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod cli_smoke_tests {
    use super::run_inner;
    use base64::Engine;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT_ID: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "rn-cli-smoke-{}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn run(database: &Path, command: &[&str]) -> Result<(), String> {
        let args = std::iter::once("--db".to_string())
            .chain(std::iter::once(database.display().to_string()))
            .chain(command.iter().map(|value| (*value).to_string()))
            .map(OsString::from);
        run_inner(args)
    }

    #[test]
    fn rust_cli_runs_the_legacy_local_workflow_on_an_isolated_database() {
        let qa = TestDirectory::new();
        let database = qa.path().join("app.db");
        let image = qa.path().join("sample.png");
        let export = qa.path().join("note.md");
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/J9sAAAAASUVORK5CYII=")
            .unwrap();
        std::fs::write(&image, png).unwrap();

        run(&database, &["db", "init", "--yes"]).unwrap();
        run(
            &database,
            &[
                "profile",
                "init",
                "--name",
                "CLI 测试账号",
                "--niche",
                "家居",
            ],
        )
        .unwrap();
        run(
            &database,
            &[
                "library",
                "add",
                image.to_str().unwrap(),
                "--no-analyze",
                "--title",
                "CLI 测试素材",
            ],
        )
        .unwrap();
        run(&database, &["library", "tag", "1", "--add", "CLI测试"]).unwrap();
        run(
            &database,
            &["content", "draft", "1", "--extra", "临时验收", "--save"],
        )
        .unwrap();
        run(
            &database,
            &[
                "content",
                "edit",
                "1",
                "--title",
                "CLI 测试笔记",
                "--body",
                "仅保存在临时数据库。",
                "--tags",
                "QA,家居",
                "--status",
                "ready",
            ],
        )
        .unwrap();
        run(
            &database,
            &[
                "content",
                "export",
                "1",
                "--output",
                export.to_str().unwrap(),
            ],
        )
        .unwrap();
        let markdown = std::fs::read_to_string(&export).unwrap();
        assert!(markdown.contains("CLI 测试笔记"));
        assert!(markdown.contains("#QA #家居"));

        run(
            &database,
            &[
                "accounts",
                "add",
                "qa-reference",
                "--name",
                "隔离榜样",
                "--note-count",
                "3",
                "--avg-likes",
                "20",
            ],
        )
        .unwrap();
        run(&database, &["accounts", "show", "qa-reference"]).unwrap();
        run(&database, &["accounts", "delete", "qa-reference", "--yes"]).unwrap();

        run(&database, &["library", "delete", "1", "--yes"]).unwrap();
        assert!(run(&database, &["library", "purge", "1", "--yes"])
            .unwrap_err()
            .contains("笔记"));
        run(&database, &["library", "restore", "1"]).unwrap();
    }
}

fn mcp_config_json(executable: &std::path::Path, database: &std::path::Path) -> serde_json::Value {
    serde_json::json!({
        "mcpServers": {
            "aichihongshu": {
                "command": executable,
                "args": ["--db", database, "mcp"]
            }
        }
    })
}

fn absolute_path(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path)
    } else {
        env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| format!("读取当前目录失败：{error}"))
    }
}

fn main() {
    std::process::exit(run(std::env::args_os().skip(1)));
}

pub(crate) fn export_markdown(note: &NoteSummary, item_title: &str) -> String {
    let mut lines = Vec::new();
    if let Some(title) = note.title.as_deref().filter(|value| !value.is_empty()) {
        lines.push(format!("# {title}"));
    }
    if !item_title.is_empty() {
        lines.push(format!("\n> 物品：{item_title}\n"));
    }
    if let Some(cover) = note.cover_desc.as_deref().filter(|value| !value.is_empty()) {
        lines.push(format!("**封面文案**：{cover}\n"));
    }
    if let Some(body) = note.body.as_deref().filter(|value| !value.is_empty()) {
        lines.push(body.to_string());
    }
    if !note.tags.is_empty() {
        let tags = note
            .tags
            .iter()
            .map(|tag| format!("#{tag}"))
            .collect::<Vec<_>>()
            .join(" ");
        lines.push(format!("\n{tags}"));
    }
    lines.push(format!(
        "\n---\n*状态：{} | 创建：{}*",
        note.status,
        note.created_at.as_deref().unwrap_or("")
    ));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::{help_text, mcp_config_json, render_search_analysis_report, run_inner};
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn prints_a_python_free_mcp_server_configuration() {
        let config = mcp_config_json(
            Path::new("/opt/aichihongshu/bin/rn"),
            Path::new("/data/app.db"),
        );
        assert_eq!(
            config,
            serde_json::json!({
                "mcpServers": {
                    "aichihongshu": {
                        "command": "/opt/aichihongshu/bin/rn",
                        "args": ["--db", "/data/app.db", "mcp"]
                    }
                }
            })
        );
        let rendered = serde_json::to_string(&config).unwrap();
        assert!(!rendered.contains("python"));
        assert!(!rendered.contains("uv"));
    }

    #[test]
    fn resolves_relative_mcp_database_paths_before_printing() {
        let path = super::absolute_path(Path::new("data/app.db").to_path_buf()).unwrap();
        assert!(path.is_absolute());
        assert!(path.ends_with("data/app.db"));
    }

    #[test]
    fn nested_help_documents_legacy_flags_without_opening_a_database() {
        let add_help = help_text(&["library".into(), "add".into()]);
        assert!(add_help.contains("--title TEXT|-t TEXT"));
        assert!(add_help.contains("--no-analyze"));

        let profile_help = help_text(&["profile".into(), "init".into()]);
        assert!(profile_help.contains("--persona-tone"));
        assert!(profile_help.contains("--avg-collects"));

        let args = [
            "--db",
            "/tmp/rn-help-must-not-open.db",
            "library",
            "add",
            "--help",
        ]
        .into_iter()
        .map(OsString::from);
        assert!(run_inner(args).is_ok());
    }

    #[test]
    fn command_help_preserves_all_legacy_click_options_and_aliases() {
        let legacy: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/python_cli_contract.json"))
                .expect("legacy Click command contract fixture");
        for command in legacy.as_array().expect("command list") {
            let group = command["group"].as_str().expect("command group");
            let name = command["command"].as_str().expect("subcommand");
            let help = help_text(&[group.to_string(), name.to_string()]);
            for parameter in command["params"].as_array().expect("parameters") {
                for option in parameter["opts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .chain(parameter["secondary_opts"].as_array().into_iter().flatten())
                    .filter_map(serde_json::Value::as_str)
                    .filter(|option| option.starts_with('-'))
                {
                    assert!(
                        help.contains(option),
                        "{group} {name} help omits legacy option {option}"
                    );
                }
            }
        }
    }

    #[test]
    fn search_analysis_console_report_matches_legacy_python_fixture() {
        let items: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../services/tests/fixtures/xhs_analyze_legacy_input.json"
        ))
        .unwrap();
        let report = aichihongshu_services::search_analysis::analyze(&items).unwrap();
        let rendered = render_search_analysis_report(&report, "家居,软装", "2026-09-30 11:40");
        let expected = include_str!("../tests/fixtures/xhs_analyze_legacy_console.txt");
        assert_eq!(rendered, expected.trim_end());
    }
}
