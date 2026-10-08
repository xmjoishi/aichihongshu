use crate::prompt::build_draft_prompt_with_knowledge;
use aichihongshu_db::{
    ExperiencePrompt, ExperiencePromptUpsert, LocalDb, LocalImageImport,
    LocalItemAnalysisTitlePolicy, LocalItemMetadataUpdate, LocalNoteStatusUpdate, LocalNoteUpdate,
    LocalProfileUpdate, MemoryEntry, MemoryEntryCreate, MemoryEntryFilter, MemoryEntryTransition,
    MemoryEntryUpdate, NoteSummary, ReferenceAccountSummary, WorkspaceSnapshot,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

const PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

fn property(title: &str, property_type: &str, default: Option<Value>) -> Value {
    let mut value = json!({"title":title,"type":property_type});
    if let Some(default) = default {
        value["default"] = default;
    }
    value
}

fn nullable_string_array(title: &str) -> Value {
    json!({
        "anyOf":[
            {"items":{"type":"string"},"type":"array"},
            {"type":"null"}
        ],
        "default":null,
        "title":title
    })
}

fn object_schema(name: &str, properties: Value, required: &[&str]) -> Value {
    let mut schema = json!({
        "properties":properties,
        "title":format!("{name}Arguments"),
        "type":"object"
    });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
}

fn no_args_schema(name: &str) -> Value {
    object_schema(name, json!({}), &[])
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name":name, "description":description, "inputSchema":input_schema})
}

fn tools() -> Vec<Value> {
    vec![
        tool(
            "get_profile",
            "获取我的账号人设（垂类/语气/禁忌词/标签池等）— 当前激活账号",
            no_args_schema("get_profile"),
        ),
        tool(
            "update_profile",
            "更新账号人设字段（语气/禁忌词/发帖节奏/标签池）",
            object_schema(
                "update_profile",
                json!({
                    "persona_tone":property("Persona Tone","string",Some(Value::Null)),
                    "persona_taboos":nullable_string_array("Persona Taboos"),
                    "posting_rhythm":property("Posting Rhythm","string",Some(Value::Null)),
                    "hashtag_pool":nullable_string_array("Hashtag Pool")
                }),
                &[],
            ),
        ),
        tool(
            "list_items",
            "列出图库物品。可按 tag（标签）或 style（风格）过滤 — 当前激活账号",
            object_schema(
                "list_items",
                json!({
                    "tag":property("Tag","string",Some(Value::Null)),
                    "style":property("Style","string",Some(Value::Null))
                }),
                &[],
            ),
        ),
        tool(
            "get_item",
            "获取图库物品详情，包含 MiniMax 图片分析结果 — 当前激活账号",
            object_schema(
                "get_item",
                json!({"item_id":property("Item Id","integer",None)}),
                &["item_id"],
            ),
        ),
        tool(
            "add_item_from_path",
            "从本地路径导入图片到图库，analyze=True 时自动触发 MiniMax 图片分析 — 当前激活账号",
            object_schema(
                "add_item_from_path",
                json!({
                    "image_path":property("Image Path","string",None),
                    "title":property("Title","string",Some(Value::Null)),
                    "analyze":property("Analyze","boolean",Some(json!(true)))
                }),
                &["image_path"],
            ),
        ),
        tool(
            "tag_item",
            "给图库物品添加或删除标签。action: 'add' 或 'remove' — 当前激活账号",
            object_schema(
                "tag_item",
                json!({
                    "item_id":property("Item Id","integer",None),
                    "tag":property("Tag","string",None),
                    "action":property("Action","string",Some(json!("add")))
                }),
                &["item_id", "tag"],
            ),
        ),
        tool(
            "draft_note_prompt",
            "\n    为图库物品生成笔记创作 Prompt。\n    返回 prompt 文本供 AI 直接使用，save=True 时同时创建草稿记录。\n    account_id: 可选的榜样账号 ID，用于风格参考\n    ",
            object_schema(
                "draft_note_prompt",
                json!({
                    "item_id":property("Item Id","integer",None),
                    "account_id":property("Account Id","string",Some(Value::Null)),
                    "save":property("Save","boolean",Some(json!(true)))
                }),
                &["item_id"],
            ),
        ),
        tool(
            "list_notes",
            "列出笔记草稿。status: draft/ready/published；item_id: 按物品过滤 — 当前激活账号",
            object_schema(
                "list_notes",
                json!({
                    "status":property("Status","string",Some(Value::Null)),
                    "item_id":property("Item Id","integer",Some(Value::Null))
                }),
                &[],
            ),
        ),
        tool(
            "get_note",
            "获取笔记草稿详情 — 当前激活账号",
            object_schema(
                "get_note",
                json!({"note_id":property("Note Id","integer",None)}),
                &["note_id"],
            ),
        ),
        tool(
            "save_note",
            "保存笔记内容（标题/正文/标签/封面文案）",
            object_schema(
                "save_note",
                json!({
                    "note_id":property("Note Id","integer",None),
                    "title":property("Title","string",Some(Value::Null)),
                    "body":property("Body","string",Some(Value::Null)),
                    "tags":nullable_string_array("Tags"),
                    "cover_desc":property("Cover Desc","string",Some(Value::Null))
                }),
                &["note_id"],
            ),
        ),
        tool(
            "publish_note",
            "将笔记标记为已发布，可同时记录发布链接",
            object_schema(
                "publish_note",
                json!({
                    "note_id":property("Note Id","integer",None),
                    "note_url":property("Note Url","string",Some(Value::Null))
                }),
                &["note_id"],
            ),
        ),
        tool(
            "export_note",
            "导出笔记为 Markdown 格式（可直接粘贴到小红书）",
            object_schema(
                "export_note",
                json!({"note_id":property("Note Id","integer",None)}),
                &["note_id"],
            ),
        ),
        tool(
            "list_accounts",
            "列出当前激活账号下的榜样账号（按均赞降序）",
            no_args_schema("list_accounts"),
        ),
        tool(
            "get_analytics",
            "获取运营数据汇总（图库数量/笔记状态/均赞评藏）",
            no_args_schema("get_analytics"),
        ),
        tool(
            "search_notes",
            "按关键词搜索当前激活账号的笔记标题、正文、标签和封面文案；最多返回 100 条",
            object_schema(
                "search_notes",
                json!({
                    "keyword":property("Keyword","string",None),
                    "status":property("Status","string",Some(Value::Null)),
                    "item_id":property("Item Id","integer",Some(Value::Null)),
                    "limit":property("Limit","integer",Some(json!(20)))
                }),
                &["keyword"],
            ),
        ),
        tool(
            "list_memory_entries",
            "列出当前激活账号的 PC 记忆，可按类型、确认状态和启用状态过滤；不读取手机记忆缓存",
            object_schema(
                "list_memory_entries",
                json!({
                    "kind":property("Kind","string",Some(Value::Null)),
                    "confirm_status":property("Confirm Status","string",Some(Value::Null)),
                    "enabled":property("Enabled","boolean",Some(Value::Null))
                }),
                &[],
            ),
        ),
        tool(
            "save_memory_entry",
            "新增或编辑当前激活账号的 PC 记忆。新条目默认为候选状态；手机记忆缓存不能通过 MCP 写入",
            object_schema(
                "save_memory_entry",
                json!({
                    "memory_id":property("Memory Id","integer",Some(Value::Null)),
                    "kind":property("Kind","string",None),
                    "content":property("Content","string",None),
                    "subject":property("Subject","string",Some(Value::Null)),
                    "scope":property("Scope","string",Some(Value::Null)),
                    "source":property("Source","string",Some(Value::Null)),
                    "source_type":property("Source Type","string",Some(Value::Null)),
                    "occurred_at":property("Occurred At","string",Some(Value::Null))
                }),
                &["kind", "content"],
            ),
        ),
        tool(
            "set_memory_entry_state",
            "设置 PC 记忆的启停状态或确认状态；每次只执行一种状态变更",
            object_schema(
                "set_memory_entry_state",
                json!({
                    "memory_id":property("Memory Id","integer",None),
                    "enabled":property("Enabled","boolean",Some(Value::Null)),
                    "confirm_status":property("Confirm Status","string",Some(Value::Null)),
                    "replaced_by":property("Replaced By","integer",Some(Value::Null))
                }),
                &["memory_id"],
            ),
        ),
        tool(
            "delete_memory_entry",
            "删除当前激活账号中的 PC 记忆；手机记忆缓存不能通过 MCP 删除",
            object_schema(
                "delete_memory_entry",
                json!({"memory_id":property("Memory Id","integer",None)}),
                &["memory_id"],
            ),
        ),
        tool(
            "list_experience_prompts",
            "列出当前激活账号的 PC 写作经验；不读取手机经验缓存",
            no_args_schema("list_experience_prompts"),
        ),
        tool(
            "save_experience_prompt",
            "新增或编辑当前激活账号的 PC 写作经验，可设置启用状态与适用范围；手机经验缓存不能通过 MCP 写入",
            object_schema(
                "save_experience_prompt",
                json!({
                    "experience_id":property("Experience Id","integer",Some(Value::Null)),
                    "title":property("Title","string",None),
                    "content":property("Content","string",None),
                    "enabled":property("Enabled","boolean",Some(json!(true))),
                    "apply_scope":property("Apply Scope","string",Some(Value::Null)),
                    "apply_target":property("Apply Target","string",Some(Value::Null)),
                    "source":property("Source","string",Some(Value::Null)),
                    "sort_order":property("Sort Order","integer",Some(Value::Null))
                }),
                &["title", "content"],
            ),
        ),
        tool(
            "delete_experience_prompt",
            "删除当前激活账号中的 PC 写作经验；手机经验缓存不能通过 MCP 删除",
            object_schema(
                "delete_experience_prompt",
                json!({"experience_id":property("Experience Id","integer",None)}),
                &["experience_id"],
            ),
        ),
    ]
}

fn required_i64(args: &Value, key: &str) -> Result<i64, String> {
    args.get(key)
        .and_then(json_i64)
        .ok_or_else(|| format!("参数 {key} 必须是整数"))
}

fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| {
            let value = value.as_f64()?;
            (value.is_finite()
                && value.fract() == 0.0
                && value >= i64::MIN as f64
                && value < -(i64::MIN as f64))
                .then_some(value as i64)
        })
}

fn optional_string(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(format!("参数 {key} 必须是字符串")),
    }
}

fn optional_string_array(args: &Value, key: &str) -> Result<Option<Vec<String>>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("参数 {key} 必须是字符串数组"))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        _ => Err(format!("参数 {key} 必须是字符串数组")),
    }
}

fn optional_i64(args: &Value, key: &str) -> Result<Option<i64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => json_i64(value)
            .map(Some)
            .ok_or_else(|| format!("参数 {key} 必须是整数")),
    }
}

fn optional_bool(args: &Value, key: &str, default: bool) -> Result<bool, String> {
    match args.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| format!("参数 {key} 必须是布尔值")),
    }
}

fn optional_bool_value(args: &Value, key: &str) -> Result<Option<bool>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        _ => Err(format!("参数 {key} 必须是布尔值")),
    }
}

/// Omitted values keep existing metadata; explicit null resets it to the field default.
fn string_with_default(
    args: &Value,
    key: &str,
    current: Option<String>,
    default: &str,
) -> Result<String, String> {
    match args.get(key) {
        None => Ok(current.unwrap_or_else(|| default.to_string())),
        Some(Value::Null) => Ok(default.to_string()),
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(format!("参数 {key} 必须是字符串或 null")),
    }
}

/// Omitted values keep existing optional metadata; explicit null clears it.
fn nullable_string_update(
    args: &Value,
    key: &str,
    current: Option<String>,
) -> Result<Option<String>, String> {
    match args.get(key) {
        None => Ok(current),
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(format!("参数 {key} 必须是字符串或 null")),
    }
}

fn integer_with_default(
    args: &Value,
    key: &str,
    current: Option<i64>,
    default: i64,
) -> Result<i64, String> {
    match args.get(key) {
        None => Ok(current.unwrap_or(default)),
        Some(Value::Null) => Ok(default),
        Some(value) => json_i64(value).ok_or_else(|| format!("参数 {key} 必须是整数或 null")),
    }
}

fn required_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("参数 {key} 必须是字符串"))
}

fn pc_memory_entry(db: &LocalDb, account_pool_id: i64, id: i64) -> Result<MemoryEntry, String> {
    db.list_memory_entries(MemoryEntryFilter {
        account_pool_id: Some(account_pool_id),
        origin: Some("pc".into()),
        kind: None,
        confirm_status: None,
        enabled: None,
    })?
    .into_iter()
    .find(|entry| entry.id == id)
    .ok_or_else(|| "PC 记忆不存在或不属于当前账号".to_string())
}

fn pc_experience_prompt(
    db: &LocalDb,
    account_pool_id: i64,
    id: i64,
) -> Result<ExperiencePrompt, String> {
    db.list_experience_prompts(Some(account_pool_id), Some("pc".into()))?
        .into_iter()
        .find(|prompt| prompt.id == id)
        .ok_or_else(|| "PC 写作经验不存在或不属于当前账号".to_string())
}

fn current_snapshot(db: &LocalDb, section: &str) -> Result<WorkspaceSnapshot, String> {
    db.snapshot_section_for_account(None, section)
        .map_err(|error| format!("读取当前账号数据失败：{error}"))
}

fn to_snake_case(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(to_snake_case).collect()),
        Value::Object(values) => {
            let mut output = Map::new();
            for (key, value) in values {
                let mut snake = String::new();
                for ch in key.chars() {
                    if ch.is_ascii_uppercase() {
                        snake.push('_');
                        snake.push(ch.to_ascii_lowercase());
                    } else {
                        snake.push(ch);
                    }
                }
                output.insert(snake, to_snake_case(value));
            }
            Value::Object(output)
        }
        other => other,
    }
}

fn serialized_snake<T: serde::Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value)
        .map(to_snake_case)
        .map_err(|error| error.to_string())
}

fn serialized_mcp_note(note: &NoteSummary, account_pool_id: i64) -> Result<Value, String> {
    let mut value = serialized_snake(note)?;
    let fields = value.as_object_mut().ok_or("笔记序列化结果不是对象")?;
    fields.remove("content_version");
    fields.remove("deleted_at");
    fields.insert("account_pool_id".into(), json!(account_pool_id));
    fields.insert("video_path".into(), Value::Null);
    Ok(value)
}

fn resolve_import_path(path: &str) -> Result<PathBuf, String> {
    let allow_root = std::env::var_os("AICHIHONGSHU_MCP_ALLOWED_IMPORT_DIR")
        .map(PathBuf::from)
        .ok_or("导入路径未授权；请为 MCP 子进程设置 AICHIHONGSHU_MCP_ALLOWED_IMPORT_DIR")?;
    let allow_root = allow_root
        .canonicalize()
        .map_err(|error| format!("MCP 导入目录不可用：{error}"))?;
    let file = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("图片路径无效：{error}"))?;
    if !file.starts_with(&allow_root) || !file.is_file() {
        return Err("图片必须是 MCP 授权目录中的普通文件".to_string());
    }
    Ok(file)
}

fn image_mime(path: &Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "png" => Ok("image/png"),
        "webp" => Ok("image/webp"),
        "gif" => Ok("image/gif"),
        "avif" => Ok("image/avif"),
        _ => Err("仅支持 JPEG、PNG、WebP、GIF 和 AVIF 图片".to_string()),
    }
}

fn reference<'a>(
    accounts: &'a [ReferenceAccountSummary],
    id: Option<&str>,
) -> Option<&'a ReferenceAccountSummary> {
    id.and_then(|id| accounts.iter().find(|account| account.account_id == id))
}

fn execute_tool(db: &LocalDb, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "get_profile" => {
            let Some(profile) = current_snapshot(db, "profile")?.profile else {
                return Ok(json!({"error":"当前账号尚未初始化人设，请先在 GUI「我的账号」页填写"}));
            };
            serialized_snake(&profile)
        }
        "update_profile" => {
            let has_update = [
                "persona_tone",
                "persona_taboos",
                "posting_rhythm",
                "hashtag_pool",
            ]
            .iter()
            .any(|key| args.get(*key).is_some_and(|value| !value.is_null()));
            if !has_update {
                return Ok(json!({"error":"没有可更新的字段"}));
            }
            let snapshot = current_snapshot(db, "profile")?;
            let Some(profile) = snapshot.profile else {
                return Ok(json!({"error":"当前账号尚未初始化人设，请先在 GUI「我的账号」页填写"}));
            };
            let persona_tone =
                optional_string(args, "persona_tone")?.or(profile.persona_tone.clone());
            let posting_rhythm =
                optional_string(args, "posting_rhythm")?.or(profile.posting_rhythm.clone());
            let taboos = optional_string_array(args, "persona_taboos")?
                .unwrap_or(profile.persona_taboos.clone());
            let hashtags = optional_string_array(args, "hashtag_pool")?
                .unwrap_or(profile.hashtag_pool.clone());
            db.update_local_profile(LocalProfileUpdate {
                account_pool_id: snapshot.active_account.id,
                account_id: profile.account_id,
                display_name: profile.display_name,
                niche: profile.niche,
                target_audience: profile.target_audience,
                content_pillars: profile.content_pillars,
                followers: None,
                persona_name: profile.persona_name,
                persona_bio: profile.persona_bio,
                persona_tone,
                persona_taboos: taboos,
                preferred_styles: profile.preferred_styles,
                preferred_scenes: profile.preferred_scenes,
                hashtag_pool: hashtags,
                posting_rhythm,
                avatar_url: None,
                xhs_bio: None,
                xhs_follows: None,
                ip_location: None,
                xhs_tags: None,
                risk_warning_ack: None,
            })?;
            let profile = current_snapshot(db, "profile")?
                .profile
                .ok_or("保存后未读取到人设")?;
            serialized_snake(&profile)
        }
        "list_items" => {
            let tag = optional_string(args, "tag")?.filter(|value| !value.is_empty());
            let style = optional_string(args, "style")?.filter(|value| !value.is_empty());
            let items = db.list_local_items_for_mcp(tag.as_deref(), style.as_deref())?;
            serialized_snake(&items)
        }
        "get_item" => {
            let id = required_i64(args, "item_id")?;
            let Some(item) = db.get_local_item_for_mcp(id)? else {
                return Ok(json!({"error":format!("物品 {id} 不存在")}));
            };
            let mut value = serialized_snake(&item)?;
            if let Some(raw) = item.analysis_raw.as_deref() {
                if let Ok(analysis) = serde_json::from_str::<Value>(raw) {
                    value["analysis"] = analysis;
                }
            }
            Ok(value)
        }
        "add_item_from_path" => {
            let analyze = optional_bool(args, "analyze", true)?;
            let image_path = args
                .get("image_path")
                .and_then(Value::as_str)
                .ok_or("参数 image_path 必须是字符串")?;
            let path = resolve_import_path(image_path)?;
            let mime = image_mime(&path)?;
            let bytes = std::fs::read(&path).map_err(|error| format!("读取图片失败：{error}"))?;
            let filename = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("图片文件名不是有效 UTF-8")?
                .to_string();
            let account_pool_id = db.current_active_account()?.id;
            let title = optional_string(args, "title")?.filter(|value| !value.is_empty());
            let analysis = if analyze {
                let analysis_mime = match path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .as_str()
                {
                    "png" => "image/png",
                    "webp" => "image/webp",
                    _ => "image/jpeg",
                };
                let data_url = format!("data:{analysis_mime};base64,{}", BASE64.encode(&bytes));
                Some(aichihongshu_services::analysis::analyze_data_url(
                    db, &data_url,
                )?)
            } else {
                None
            };
            let mut item = db.import_local_image(LocalImageImport {
                account_pool_id,
                file_name: filename,
                mime_type: Some(mime.to_string()),
                data_base64: BASE64.encode(bytes),
                thumbnail_data_base64: None,
            })?;
            if let Some(title) = title.as_deref() {
                item = db.update_local_item_metadata(LocalItemMetadataUpdate {
                    item_id: item.id,
                    account_pool_id,
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
                    account_pool_id,
                    item.image_version,
                    &analysis,
                    if title.is_none() {
                        LocalItemAnalysisTitlePolicy::Force
                    } else {
                        LocalItemAnalysisTitlePolicy::Preserve
                    },
                )?;
            }
            let item = db
                .get_local_item_for_mcp(item.id)?
                .ok_or("导入后素材不存在")?;
            serialized_snake(&item)
        }
        "tag_item" => {
            let id = required_i64(args, "item_id")?;
            let tag = args
                .get("tag")
                .and_then(Value::as_str)
                .ok_or("参数 tag 必须是字符串")?
                .to_string();
            let action = args.get("action").and_then(Value::as_str).unwrap_or("add");
            let (account_pool_id, item) = db.get_local_item_for_cli(id)?;
            let item = item.ok_or_else(|| format!("物品 ID {id} 不存在"))?;
            let mut tags = item.tags.clone();
            if action == "add" {
                if !tags.contains(&tag) {
                    tags.push(tag);
                }
            } else {
                tags.retain(|value| value != &tag);
            }
            db.update_local_item_metadata(LocalItemMetadataUpdate {
                item_id: id,
                account_pool_id,
                expected_metadata_version: item.metadata_version,
                title: item.title.clone(),
                tags,
                style: item.style.clone(),
                material: item.material.clone(),
                scene: item.scene.clone(),
                color: item.color.clone(),
            })?;
            let updated = db
                .get_local_item_for_mcp(id)?
                .ok_or_else(|| format!("物品 ID {id} 不存在"))?;
            serialized_snake(&updated)
        }
        "draft_note_prompt" => {
            let item_id = required_i64(args, "item_id")?;
            let account_id = optional_string(args, "account_id")?;
            let save = optional_bool(args, "save", true)?;
            let snapshot = current_snapshot(db, "references")?;
            let (account_pool_id, item) = db.get_local_item_for_cli(item_id)?;
            if account_pool_id != snapshot.active_account.id {
                return Err("账号上下文已变化".to_string());
            }
            let Some(item) = item else {
                return Ok(json!({"error":format!("物品 {item_id} 不存在")}));
            };
            let selected_reference = reference(&snapshot.reference_accounts, account_id.as_deref());
            let knowledge = db.local_content_knowledge_context(Some(snapshot.active_account.id))?;
            let prompt = build_draft_prompt_with_knowledge(
                &item,
                snapshot.profile.as_ref(),
                selected_reference,
                "",
                Some(&knowledge),
            );
            let note = if save {
                Some(db.create_local_prompt_draft(
                    item_id,
                    account_pool_id,
                    account_id.as_deref(),
                    &prompt,
                )?)
            } else {
                None
            };
            Ok(
                json!({"prompt":prompt,"note_id":note.as_ref().map(|value| value.id),"item_title":item.title}),
            )
        }
        "list_notes" => {
            let status = optional_string(args, "status")?.filter(|value| !value.is_empty());
            let item_id = optional_i64(args, "item_id")?.filter(|value| *value != 0);
            let (account_pool_id, notes) =
                db.list_local_notes_for_legacy(status.as_deref(), item_id)?;
            Ok(Value::Array(
                notes
                    .iter()
                    .map(|note| serialized_mcp_note(note, account_pool_id))
                    .collect::<Result<Vec<_>, _>>()?,
            ))
        }
        "search_notes" => {
            let keyword = required_string(args, "keyword")?.trim().to_lowercase();
            if keyword.is_empty() {
                return Err("搜索关键词不能为空".into());
            }
            let limit = optional_i64(args, "limit")?.unwrap_or(20);
            if !(1..=100).contains(&limit) {
                return Err("搜索结果 limit 必须在 1 到 100 之间".into());
            }
            let status = optional_string(args, "status")?.filter(|value| !value.is_empty());
            let item_id = optional_i64(args, "item_id")?.filter(|value| *value != 0);
            let (account_pool_id, notes) =
                db.list_local_notes_for_legacy(status.as_deref(), item_id)?;
            Ok(Value::Array(
                notes
                    .into_iter()
                    .filter(|note| {
                        note.title
                            .as_deref()
                            .is_some_and(|value| value.to_lowercase().contains(&keyword))
                            || note
                                .body
                                .as_deref()
                                .is_some_and(|value| value.to_lowercase().contains(&keyword))
                            || note
                                .cover_desc
                                .as_deref()
                                .is_some_and(|value| value.to_lowercase().contains(&keyword))
                            || note
                                .tags
                                .iter()
                                .any(|value| value.to_lowercase().contains(&keyword))
                    })
                    .take(limit as usize)
                    .map(|note| serialized_mcp_note(&note, account_pool_id))
                    .collect::<Result<Vec<_>, _>>()?,
            ))
        }
        "list_memory_entries" => {
            let active = db.current_active_account()?;
            let entries = db.list_memory_entries(MemoryEntryFilter {
                account_pool_id: Some(active.id),
                origin: Some("pc".into()),
                kind: optional_string(args, "kind")?.filter(|value| !value.is_empty()),
                confirm_status: optional_string(args, "confirm_status")?
                    .filter(|value| !value.is_empty()),
                enabled: optional_bool_value(args, "enabled")?,
            })?;
            Ok(Value::Array(
                entries
                    .iter()
                    .map(serialized_snake)
                    .collect::<Result<Vec<_>, _>>()?,
            ))
        }
        "save_memory_entry" => {
            let active = db.current_active_account()?;
            let kind = required_string(args, "kind")?;
            let content = required_string(args, "content")?;
            let subject = optional_string(args, "subject")?;
            let scope = optional_string(args, "scope")?;
            let source = optional_string(args, "source")?;
            let source_type = optional_string(args, "source_type")?;
            let occurred_at = optional_string(args, "occurred_at")?;
            let memory_id = optional_i64(args, "memory_id")?;
            let entry = if let Some(id) = memory_id {
                let current = pc_memory_entry(db, active.id, id)?;
                db.update_memory_entry(MemoryEntryUpdate {
                    id,
                    account_pool_id: active.id,
                    kind,
                    content,
                    subject: Some(string_with_default(
                        args,
                        "subject",
                        Some(current.subject),
                        "",
                    )?),
                    scope: Some(string_with_default(
                        args,
                        "scope",
                        Some(current.scope),
                        "account",
                    )?),
                    source: Some(string_with_default(
                        args,
                        "source",
                        Some(current.source),
                        "",
                    )?),
                    source_type: Some(string_with_default(
                        args,
                        "source_type",
                        Some(current.source_type),
                        "user",
                    )?),
                    occurred_at: nullable_string_update(args, "occurred_at", current.occurred_at)?,
                })?
            } else {
                db.create_memory_entry(MemoryEntryCreate {
                    account_pool_id: active.id,
                    origin: "pc".into(),
                    kind,
                    content,
                    subject: Some(subject.unwrap_or_default()),
                    scope: Some(scope.unwrap_or_else(|| "account".into())),
                    source: Some(source.unwrap_or_default()),
                    source_type: Some(source_type.unwrap_or_else(|| "user".into())),
                    occurred_at,
                    confirm_status: None,
                    enabled: None,
                })?
            };
            serialized_snake(&entry)
        }
        "set_memory_entry_state" => {
            let id = required_i64(args, "memory_id")?;
            let active = db.current_active_account()?;
            pc_memory_entry(db, active.id, id)?;
            let enabled = optional_bool_value(args, "enabled")?;
            let confirm_status = optional_string(args, "confirm_status")?;
            let replaced_by = optional_i64(args, "replaced_by")?;
            if replaced_by.is_some() && confirm_status.is_none() {
                return Err("replaced_by 仅可与 confirm_status 一起设置".into());
            }
            if let Some(replacement_id) = replaced_by {
                pc_memory_entry(db, active.id, replacement_id)?;
            }
            let entry = match (enabled, confirm_status) {
                (Some(enabled), None) if replaced_by.is_none() => {
                    db.set_memory_entry_enabled(id, active.id, enabled)?
                }
                (None, Some(next_status)) => {
                    db.transition_memory_entry_status(MemoryEntryTransition {
                        id,
                        account_pool_id: active.id,
                        next_status,
                        replaced_by,
                    })?
                }
                (None, None) => return Err("请提供 enabled 或 confirm_status".into()),
                _ => {
                    return Err(
                        "每次只能设置 enabled 或 confirm_status；replaced_by 仅用于状态迁移".into(),
                    );
                }
            };
            serialized_snake(&entry)
        }
        "delete_memory_entry" => {
            let id = required_i64(args, "memory_id")?;
            let active = db.current_active_account()?;
            pc_memory_entry(db, active.id, id)?;
            db.delete_memory_entry(id, active.id)?;
            Ok(json!({"memory_id":id,"deleted":true,"origin":"pc"}))
        }
        "list_experience_prompts" => {
            let active = db.current_active_account()?;
            let prompts = db.list_experience_prompts(Some(active.id), Some("pc".into()))?;
            Ok(Value::Array(
                prompts
                    .iter()
                    .map(serialized_snake)
                    .collect::<Result<Vec<_>, _>>()?,
            ))
        }
        "save_experience_prompt" => {
            let active = db.current_active_account()?;
            let id = optional_i64(args, "experience_id")?;
            let current = id
                .map(|id| pc_experience_prompt(db, active.id, id))
                .transpose()?;
            let title = required_string(args, "title")?;
            let content = required_string(args, "content")?;
            let enabled = if args.get("enabled").is_some() {
                optional_bool(args, "enabled", true)?
            } else {
                current
                    .as_ref()
                    .map(|prompt| prompt.enabled)
                    .unwrap_or(true)
            };
            let apply_scope = Some(string_with_default(
                args,
                "apply_scope",
                current.as_ref().map(|prompt| prompt.apply_scope.clone()),
                "account",
            )?);
            let apply_target = Some(string_with_default(
                args,
                "apply_target",
                current.as_ref().map(|prompt| prompt.apply_target.clone()),
                "all",
            )?);
            let source = Some(string_with_default(
                args,
                "source",
                current.as_ref().map(|prompt| prompt.source.clone()),
                "user",
            )?);
            let sort_order = Some(integer_with_default(
                args,
                "sort_order",
                current.as_ref().map(|prompt| prompt.sort_order),
                0,
            )?);
            let (id, prompts) = db.upsert_experience_prompt_with_id(ExperiencePromptUpsert {
                account_pool_id: active.id,
                origin: "pc".into(),
                id,
                title,
                content,
                enabled,
                apply_scope,
                apply_target,
                source,
                sort_order,
            })?;
            let prompt = prompts
                .into_iter()
                .find(|prompt| prompt.id == id)
                .ok_or_else(|| "保存后未找到 PC 写作经验".to_string())?;
            serialized_snake(&prompt)
        }
        "delete_experience_prompt" => {
            let id = required_i64(args, "experience_id")?;
            let active = db.current_active_account()?;
            pc_experience_prompt(db, active.id, id)?;
            db.delete_experience_prompt(id, active.id, "pc".into())?;
            Ok(json!({"experience_id":id,"deleted":true,"origin":"pc"}))
        }
        "get_note" => {
            let note_id = required_i64(args, "note_id")?;
            let (account_pool_id, note) = db.get_local_note_for_legacy(note_id)?;
            match note {
                Some(note) => serialized_mcp_note(&note, account_pool_id),
                None => Ok(json!({"error":format!("笔记 {note_id} 不存在")})),
            }
        }
        "save_note" => {
            let note_id = required_i64(args, "note_id")?;
            let (account_pool_id, note) = db.get_local_note_for_legacy(note_id)?;
            let mut note = note.ok_or_else(|| format!("笔记 ID {note_id} 不存在"))?;
            let title = optional_string(args, "title")?;
            let body = optional_string(args, "body")?;
            let cover = optional_string(args, "cover_desc")?;
            let tags = optional_string_array(args, "tags")?;
            if title.is_some() || body.is_some() || cover.is_some() || tags.is_some() {
                note = db.update_local_note_with_cover(
                    LocalNoteUpdate {
                        note_id,
                        account_pool_id,
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
                note = db.touch_local_note_for_account(note_id, account_pool_id)?;
            }
            serialized_mcp_note(&note, account_pool_id)
        }
        "publish_note" => {
            let note_id = required_i64(args, "note_id")?;
            let note_url = optional_string(args, "note_url")?;
            let (account_pool_id, note) = db.get_local_note_for_legacy(note_id)?;
            let note = note.ok_or_else(|| format!("笔记 ID {note_id} 不存在"))?;
            let note = db.update_local_note_status(LocalNoteStatusUpdate {
                note_id,
                account_pool_id,
                expected_version: note.content_version,
                status: "published".into(),
                note_url,
            })?;
            serialized_mcp_note(&note, account_pool_id)
        }
        "export_note" => {
            let note_id = required_i64(args, "note_id")?;
            let (account_pool_id, note) = db.get_local_note_for_legacy(note_id)?;
            let Some(note) = note else {
                return Ok(json!({"error":format!("笔记 {note_id} 不存在")}));
            };
            let item_title = if let Some(item_id) = note.item_id {
                let (item_account_id, item) = db.get_local_item_for_cli(item_id)?;
                if item_account_id != account_pool_id {
                    return Err("账号上下文已变化".to_string());
                }
                item.map(|item| item.title).unwrap_or_default()
            } else {
                String::new()
            };
            Ok(json!({
                "markdown":crate::export_markdown(&note, &item_title)
            }))
        }
        "list_accounts" => {
            let mut accounts = current_snapshot(db, "references")?.reference_accounts;
            accounts.sort_by(|left, right| right.avg_likes.total_cmp(&left.avg_likes));
            Ok(Value::Array(accounts.into_iter().map(|account| json!({
                "account_id":account.account_id,"name":account.name,"followers":account.followers,
                "note_count":account.note_count,"avg_likes":account.avg_likes,
                "avg_comments":account.avg_comments,"avg_collects":account.avg_collects,
                "top_notes":account.top_notes,
            })).collect()))
        }
        "get_analytics" => {
            let snapshot = current_snapshot(db, "analytics")?;
            Ok(
                json!({"items":snapshot.item_count,"notes":{"total":snapshot.note_count,"by_status":snapshot.note_status_counts}}),
            )
        }
        _ => Err(format!("Unknown tool: {name}")),
    }
}

fn response(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

fn protocol_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

fn append_legacy_content(value: &Value, content: &mut Vec<Value>) {
    match value {
        Value::Null => {}
        Value::Array(values) => {
            for value in values {
                append_legacy_content(value, content);
            }
        }
        Value::String(text) => content.push(json!({"type":"text","text":text})),
        _ => {
            let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into());
            content.push(json!({"type":"text","text":text}));
        }
    }
}

fn tool_result(value: Value, is_error: bool) -> Value {
    let mut content = Vec::new();
    append_legacy_content(&value, &mut content);
    json!({"content":content,"isError":is_error})
}

fn tool_error(message: &str) -> Value {
    json!({
        "content":[{"type":"text","text":message}],
        "isError":true
    })
}

fn matches_json_type(value: &Value, schema: &Value) -> bool {
    // FastMCP/Pydantic exposes these Optional[T] inputs as type T with a null default.
    if value.is_null() && schema.get("default").is_some_and(Value::is_null) {
        return true;
    }
    if let Some(alternatives) = schema.get("anyOf").and_then(Value::as_array) {
        return alternatives
            .iter()
            .any(|alternative| matches_json_type(value, alternative));
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("null") => value.is_null(),
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("integer") => {
            value.as_i64().is_some()
                || value.as_u64().is_some()
                || value
                    .as_f64()
                    .is_some_and(|number| number.is_finite() && number.fract() == 0.0)
        }
        Some("number") => value.as_f64().is_some(),
        Some("boolean") => value.is_boolean(),
        _ => true,
    }
}

fn input_validation_error(schema: &Value, arguments: &Value) -> Option<String> {
    let Some(arguments) = arguments.as_object() else {
        return Some(format!("{arguments} is not of type 'object'"));
    };
    let properties = schema.get("properties")?.as_object()?;
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for required in required.iter().filter_map(Value::as_str) {
            if !arguments.contains_key(required) {
                return Some(format!("'{required}' is a required property"));
            }
        }
    }
    for (name, value) in arguments {
        let Some(property_schema) = properties.get(name) else {
            continue;
        };
        if !matches_json_type(value, property_schema) {
            let expected = property_schema
                .get("type")
                .and_then(Value::as_str)
                .or_else(|| {
                    property_schema
                        .get("anyOf")
                        .and_then(Value::as_array)
                        .and_then(|types| {
                            types
                                .iter()
                                .find(|kind| {
                                    kind.get("type").and_then(Value::as_str) != Some("null")
                                })
                                .and_then(|kind| kind.get("type").and_then(Value::as_str))
                        })
                })
                .unwrap_or("valid value");
            return Some(format!("{} is not of type '{expected}'", value));
        }
        let array_schema = if property_schema.get("type").and_then(Value::as_str) == Some("array") {
            Some(property_schema)
        } else {
            property_schema
                .get("anyOf")
                .and_then(Value::as_array)
                .and_then(|alternatives| {
                    alternatives.iter().find(|alternative| {
                        alternative.get("type").and_then(Value::as_str) == Some("array")
                    })
                })
        };
        if let (Some(values), Some(item_schema)) = (
            value.as_array(),
            array_schema.and_then(|array| array.get("items")),
        ) {
            if let Some(item) = values
                .iter()
                .find(|item| !matches_json_type(item, item_schema))
            {
                let expected = item_schema
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("valid value");
                return Some(format!("{} is not of type '{expected}'", item));
            }
        }
    }
    None
}

fn handle(db: &LocalDb, message: &Value, ready: &mut bool) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str);
    let Some(method) = method else {
        return id.map(|id| protocol_error(id, -32600, "Invalid Request"));
    };
    let Some(id) = id else {
        if method == "notifications/initialized" {
            *ready = true;
        }
        return None;
    };
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(protocol_error(id, -32600, "jsonrpc must be 2.0"));
    }
    match method {
        "initialize" => {
            let requested = message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-11-25");
            let version = if PROTOCOL_VERSIONS.contains(&requested) {
                requested
            } else {
                "2025-11-25"
            };
            *ready = false;
            Some(response(
                id,
                json!({
                    "protocolVersion":version,
                    "capabilities":{"tools":{}},
                    "serverInfo":{"name":"rednote-home","version":env!("CARGO_PKG_VERSION")},
                    "instructions":"小红书家居/软装/出租屋改造垂类运营助手。可操作图库、笔记草稿、PC 写作经验和 PC 记忆，按关键词查找笔记，读取账号人设与榜样账号并生成内容创作 Prompt。所有写操作请先调用 get_profile 了解账号人设。所有记忆操作只针对当前激活账号的 PC 数据；手机记忆与经验仅为手机源数据缓存，本 MCP 不会修改。切换账号需在 GUI 顶栏完成。publish_note 只记录本地发布状态，不会向平台发帖。"
                }),
            ))
        }
        "ping" => Some(response(id, json!({}))),
        "tools/list" => {
            if !*ready {
                return Some(protocol_error(id, -32002, "Server not initialized"));
            }
            Some(response(id, json!({"tools":tools()})))
        }
        "tools/call" => {
            if !*ready {
                return Some(protocol_error(id, -32002, "Server not initialized"));
            }
            let params = message.get("params").unwrap_or(&Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let Some(tool) = tools()
                .into_iter()
                .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
            else {
                return Some(response(id, tool_error(&format!("Unknown tool: {name}"))));
            };
            if let Some(error) = input_validation_error(&tool["inputSchema"], &args) {
                return Some(response(
                    id,
                    tool_error(&format!("Input validation error: {error}")),
                ));
            }
            let result = match execute_tool(db, name, &args) {
                Ok(value) => tool_result(value, false),
                Err(error) => tool_error(&format!("Error executing tool {name}: {error}")),
            };
            Some(response(id, result))
        }
        "notifications/cancelled" | "notifications/progress" => None,
        other => Some(protocol_error(
            id,
            -32601,
            &format!("Method not found: {other}"),
        )),
    }
}

pub fn serve(db: &LocalDb) -> Result<(), String> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut ready = false;
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("读取 MCP stdin 失败：{error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(message) => handle(db, &message, &mut ready),
            Err(_) => Some(protocol_error(Value::Null, -32700, "Parse error")),
        };
        if let Some(reply) = reply {
            serde_json::to_writer(&mut output, &reply)
                .map_err(|error| format!("写入 MCP 响应失败：{error}"))?;
            output
                .write_all(b"\n")
                .map_err(|error| format!("写入 MCP 分隔符失败：{error}"))?;
            output
                .flush()
                .map_err(|error| format!("刷新 MCP stdout 失败：{error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aichihongshu_db::{
        ItemSummary, LocalAccountCreate, LocalAccountUpdate, LocalNoteCreate,
        LocalReferenceAccountManualUpsert, ReferenceNote,
    };
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_DATABASE_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDatabase {
        db: LocalDb,
        root: PathBuf,
    }

    struct ScopedEnvironmentVariable {
        name: &'static str,
        original: Option<std::ffi::OsString>,
    }

    impl ScopedEnvironmentVariable {
        fn set(name: &'static str, value: &Path) -> Self {
            let original = std::env::var_os(name);
            std::env::set_var(name, value);
            Self { name, original }
        }
    }

    impl Drop for ScopedEnvironmentVariable {
        fn drop(&mut self) {
            match self.original.take() {
                Some(value) => std::env::set_var(self.name, value),
                None => std::env::remove_var(self.name),
            }
        }
    }

    impl TestDatabase {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let sequence = NEXT_TEST_DATABASE_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("rn-mcp-{}-{nonce}-{sequence}", std::process::id()));
            std::fs::create_dir_all(&root).expect("create isolated test directory");
            let path = root.join("app.db");
            let db = LocalDb::open(path.clone()).expect("open isolated test database");
            Self { db, root }
        }
    }

    impl Drop for TestDatabase {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn call_tool(db: &LocalDb, ready: &mut bool, name: &str, arguments: Value) -> Value {
        let reply = handle(
            db,
            &json!({
                "jsonrpc":"2.0", "id":name, "method":"tools/call",
                "params":{"name":name,"arguments":arguments}
            }),
            ready,
        )
        .unwrap_or_else(|| panic!("{name} should return a tool result"));
        assert_eq!(
            reply.get("error"),
            None,
            "{name} should use tool result errors"
        );
        reply.get("result").cloned().expect("MCP tool result")
    }

    fn first_json_content(result: &Value) -> Value {
        let text = result
            .pointer("/content/0/text")
            .and_then(Value::as_str)
            .expect("first MCP content text");
        serde_json::from_str(text).expect("JSON-encoded MCP result")
    }

    fn import_fixture_item(db: &LocalDb, account_pool_id: i64, file_name: &str) -> ItemSummary {
        let mut image = BASE64
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .expect("decode fixture image");
        // PNG decoders allow trailing data; use a distinct hash for each database fixture item.
        image.extend_from_slice(file_name.as_bytes());
        db.import_local_image(LocalImageImport {
            account_pool_id,
            file_name: file_name.to_string(),
            mime_type: Some("image/png".into()),
            data_base64: BASE64.encode(image),
            thumbnail_data_base64: None,
        })
        .expect("import fixture image")
    }

    fn json_content_blocks(result: &Value) -> Vec<Value> {
        result
            .get("content")
            .and_then(Value::as_array)
            .expect("MCP text content blocks")
            .iter()
            .map(|block| {
                let text = block
                    .get("text")
                    .and_then(Value::as_str)
                    .expect("MCP text block");
                serde_json::from_str(text)
                    .unwrap_or_else(|error| panic!("JSON-encoded MCP item: {error}; text={text:?}"))
            })
            .collect()
    }

    fn assert_object_fields(value: &Value, expected: &[&str]) {
        let actual = value
            .as_object()
            .expect("serialized MCP object")
            .keys()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let expected = expected.iter().copied().collect::<HashSet<_>>();
        assert_eq!(actual, expected);
    }

    fn initialize(db: &LocalDb) -> bool {
        let mut ready = false;
        let init = handle(db, &json!({
            "jsonrpc":"2.0", "id":1, "method":"initialize",
            "params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}
        }), &mut ready).expect("initialize response");
        assert_eq!(
            init.pointer("/result/protocolVersion")
                .and_then(Value::as_str),
            Some("2025-11-25")
        );
        assert!(handle(
            db,
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            &mut ready
        )
        .is_none());
        ready
    }

    #[test]
    fn mcp_negotiates_and_lists_legacy_and_memory_tools() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);
        let list = handle(
            &test_db.db,
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            &mut ready,
        )
        .expect("tools/list response");
        let names = list
            .pointer("/result/tools")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "get_profile",
                "update_profile",
                "list_items",
                "get_item",
                "add_item_from_path",
                "tag_item",
                "draft_note_prompt",
                "list_notes",
                "get_note",
                "save_note",
                "publish_note",
                "export_note",
                "list_accounts",
                "get_analytics",
                "search_notes",
                "list_memory_entries",
                "save_memory_entry",
                "set_memory_entry_state",
                "delete_memory_entry",
                "list_experience_prompts",
                "save_experience_prompt",
                "delete_experience_prompt",
            ]
        );
        let analytics = handle(
            &test_db.db,
            &json!({
                "jsonrpc":"2.0","id":3,"method":"tools/call",
                "params":{"name":"get_analytics","arguments":{}}
            }),
            &mut ready,
        )
        .expect("analytics response");
        assert_eq!(
            analytics
                .pointer("/result/isError")
                .and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn tool_results_match_fastmcp_127_text_content_encoding() {
        assert_eq!(
            tool_result(json!({"name":"样例","count":2}), false),
            json!({
                "content":[{"type":"text","text":"{\n  \"count\": 2,\n  \"name\": \"样例\"\n}"}],
                "isError":false
            })
        );
        assert_eq!(
            tool_result(json!([{"id":1},{"id":2}]), false),
            json!({
                "content":[
                    {"type":"text","text":"{\n  \"id\": 1\n}"},
                    {"type":"text","text":"{\n  \"id\": 2\n}"}
                ],
                "isError":false
            })
        );
        assert_eq!(
            tool_result(json!({"error":"not found"}), false)["isError"],
            false
        );
        assert_eq!(
            tool_error("Error executing tool get_item: invalid id"),
            json!({
                "content":[{"type":"text","text":"Error executing tool get_item: invalid id"}],
                "isError":true
            })
        );
    }

    #[test]
    fn legacy_not_found_tools_return_successful_error_objects() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);
        for (name, arguments, expected) in [
            (
                "get_profile",
                json!({}),
                "当前账号尚未初始化人设，请先在 GUI「我的账号」页填写".to_string(),
            ),
            (
                "get_item",
                json!({"item_id":9999}),
                "物品 9999 不存在".to_string(),
            ),
            (
                "get_note",
                json!({"note_id":9999}),
                "笔记 9999 不存在".to_string(),
            ),
            (
                "export_note",
                json!({"note_id":9999}),
                "笔记 9999 不存在".to_string(),
            ),
        ] {
            let reply = handle(
                &test_db.db,
                &json!({
                    "jsonrpc":"2.0", "id":7, "method":"tools/call",
                    "params":{"name":name,"arguments":arguments}
                }),
                &mut ready,
            )
            .expect("tool result");
            let result = reply.get("result").expect("successful JSON-RPC result");
            assert_eq!(result.get("isError").and_then(Value::as_bool), Some(false));
            let text = result
                .pointer("/content/0/text")
                .and_then(Value::as_str)
                .unwrap();
            let value: Value = serde_json::from_str(text).expect("JSON-serialized dict result");
            assert_eq!(
                value.get("error").and_then(Value::as_str),
                Some(expected.as_str())
            );
        }
    }

    #[test]
    fn all_legacy_tools_keep_empty_and_missing_result_categories() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);

        for (name, arguments, expected) in [
            (
                "get_profile",
                json!({}),
                "当前账号尚未初始化人设，请先在 GUI「我的账号」页填写",
            ),
            ("update_profile", json!({}), "没有可更新的字段"),
            (
                "update_profile",
                json!({"persona_tone":"清晰"}),
                "当前账号尚未初始化人设，请先在 GUI「我的账号」页填写",
            ),
            ("get_item", json!({"item_id":9999}), "物品 9999 不存在"),
            (
                "draft_note_prompt",
                json!({"item_id":9999,"save":false}),
                "物品 9999 不存在",
            ),
            ("get_note", json!({"note_id":9999}), "笔记 9999 不存在"),
            ("export_note", json!({"note_id":9999}), "笔记 9999 不存在"),
        ] {
            let result = call_tool(&test_db.db, &mut ready, name, arguments);
            assert_eq!(result["isError"], false, "{name} must return a data object");
            assert_eq!(
                first_json_content(&result)["error"],
                expected,
                "{name} must retain its successful error-object result"
            );
        }

        for (name, arguments) in [
            ("list_items", json!({})),
            ("list_notes", json!({})),
            ("list_accounts", json!({})),
        ] {
            let result = call_tool(&test_db.db, &mut ready, name, arguments);
            assert_eq!(result["isError"], false, "{name} empty list is successful");
            assert_eq!(result["content"], json!([]), "{name} encodes an empty list");
        }

        let analytics = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_analytics",
            json!({}),
        ));
        assert_eq!(analytics["items"], 0);
        assert_eq!(analytics["notes"]["total"], 0);
        assert_eq!(analytics["notes"]["by_status"], json!({}));

        for (name, arguments) in [
            (
                "add_item_from_path",
                json!({"image_path":"/definitely-not-an-authorized-mcp-image.png","analyze":false}),
            ),
            ("tag_item", json!({"item_id":9999,"tag":"tag"})),
            ("save_note", json!({"note_id":9999,"title":"missing"})),
            ("publish_note", json!({"note_id":9999})),
        ] {
            let result = call_tool(&test_db.db, &mut ready, name, arguments);
            assert_eq!(
                result["isError"], true,
                "{name} must classify operational failures as tool errors"
            );
            assert!(result.pointer("/content/0/text").is_some());
        }
    }

    #[test]
    fn optional_filters_and_tag_operations_preserve_legacy_edge_semantics() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);
        let active = test_db.db.current_active_account().expect("active account");
        let imported = test_db
            .db
            .import_local_image(LocalImageImport {
                account_pool_id: active.id,
                file_name: "mcp-filter-fixture.png".into(),
                mime_type: Some("image/png".into()),
                data_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".into(),
                thumbnail_data_base64: None,
            })
            .expect("seed isolated image");
        let item = test_db
            .db
            .update_local_item_metadata(LocalItemMetadataUpdate {
                item_id: imported.id,
                account_pool_id: active.id,
                expected_metadata_version: imported.metadata_version,
                title: imported.title.clone(),
                tags: imported.tags.clone(),
                style: Some("奶油风客厅".into()),
                material: imported.material.clone(),
                scene: imported.scene.clone(),
                color: imported.color.clone(),
            })
            .expect("set image style fixture");

        for arguments in [json!({"tag":"","style":""}), json!({"style":"奶油"})] {
            let items =
                json_content_blocks(&call_tool(&test_db.db, &mut ready, "list_items", arguments));
            assert_eq!(items.len(), 1);
            assert_eq!(items[0]["id"], item.id);
            assert_object_fields(
                &items[0],
                &[
                    "id",
                    "title",
                    "image_path",
                    "style",
                    "material",
                    "scene",
                    "color",
                    "tags",
                    "analysis_raw",
                    "note_count",
                    "account_pool_id",
                    "created_at",
                    "updated_at",
                ],
            );
        }
        let wildcard_style = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_items",
            json!({"style":"奶油_客"}),
        ));
        assert_eq!(wildcard_style.len(), 1);
        assert_eq!(wildcard_style[0]["id"], item.id);

        for tag in ["", "Home", "home", "Home_tag", "Home"] {
            let result = call_tool(
                &test_db.db,
                &mut ready,
                "tag_item",
                json!({"item_id":item.id,"tag":tag}),
            );
            assert_eq!(result["isError"], false);
        }
        let tagged = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_item",
            json!({"item_id":item.id as f64}),
        ));
        assert_object_fields(
            &tagged,
            &[
                "id",
                "title",
                "image_path",
                "style",
                "material",
                "scene",
                "color",
                "tags",
                "analysis_raw",
                "note_count",
                "account_pool_id",
                "created_at",
                "updated_at",
            ],
        );
        assert_eq!(tagged["tags"], json!(["", "Home", "home", "Home_tag"]));
        let ascii_case_matches = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_items",
            json!({"tag":"HOME"}),
        ));
        assert_eq!(ascii_case_matches.len(), 1);
        let wildcard_tag_matches = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_items",
            json!({"tag":"Home_%"}),
        ));
        assert_eq!(wildcard_tag_matches.len(), 1);
        assert_eq!(wildcard_tag_matches[0]["id"], item.id);
        let removed = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "tag_item",
            json!({"item_id":item.id,"tag":"Home","action":"remove"}),
        ));
        assert_eq!(removed["tags"], json!(["", "home", "Home_tag"]));

        let legacy_unknown_action = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "tag_item",
            json!({"item_id":item.id,"tag":"home","action":"replace"}),
        ));
        assert_eq!(
            legacy_unknown_action["tags"],
            json!(["", "Home_tag"]),
            "the legacy MCP tool treats every non-add action as remove"
        );

        let conn = rusqlite::Connection::open(test_db.db.path()).unwrap();
        conn.execute(
            "UPDATE items SET analysis_raw = ?1 WHERE id = ?2",
            rusqlite::params![r#"{"title":"分析结果","tags":["收纳"]}"#, item.id],
        )
        .unwrap();
        let parsed_analysis = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_item",
            json!({"item_id":item.id}),
        ));
        assert_eq!(
            parsed_analysis["analysis"],
            json!({"title":"分析结果","tags":["收纳"]})
        );
        conn.execute(
            "UPDATE items SET analysis_raw = 'not-json' WHERE id = ?1",
            [item.id],
        )
        .unwrap();
        let malformed_analysis = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_item",
            json!({"item_id":item.id}),
        ));
        assert_eq!(malformed_analysis["analysis_raw"], "not-json");
        assert_eq!(malformed_analysis.get("analysis"), None);

        let missing_item = call_tool(
            &test_db.db,
            &mut ready,
            "tag_item",
            json!({"item_id":9999,"tag":"Home"}),
        );
        assert_eq!(missing_item["isError"], true);
        assert_eq!(
            missing_item
                .pointer("/content/0/text")
                .and_then(Value::as_str),
            Some("Error executing tool tag_item: 物品 ID 9999 不存在")
        );

        call_tool(
            &test_db.db,
            &mut ready,
            "draft_note_prompt",
            json!({"item_id":item.id}),
        );
        let notes = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_notes",
            json!({"status":"","item_id":0}),
        ));
        assert_eq!(notes.len(), 1);
        assert_object_fields(
            &notes[0],
            &[
                "id",
                "item_id",
                "item_ids",
                "account_ref",
                "account_pool_id",
                "title",
                "body",
                "tags",
                "cover_desc",
                "prompt_used",
                "status",
                "note_type",
                "video_path",
                "published_at",
                "note_url",
                "likes",
                "comments",
                "collects",
                "created_at",
                "updated_at",
            ],
        );
        assert_eq!(notes[0]["video_path"], Value::Null);

        let second_item = import_fixture_item(&test_db.db, active.id, "mcp-second-note-item.png");
        let multi_item_note = test_db
            .db
            .create_local_note(LocalNoteCreate {
                account_pool_id: active.id,
                item_ids: vec![item.id, second_item.id],
                account_ref: None,
                title: Some("多素材草稿".into()),
                body: None,
                tags: Vec::new(),
                cover_desc: None,
                prompt_used: None,
                note_type: "image".into(),
                video_path: None,
            })
            .expect("create isolated multi-item note");
        let primary_item_notes = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_notes",
            json!({"item_id":item.id}),
        ));
        assert_eq!(primary_item_notes.len(), 2);
        assert!(primary_item_notes
            .iter()
            .any(|note| note["id"] == multi_item_note.id));
        let floating_integer_filter = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_notes",
            json!({"item_id":item.id as f64}),
        ));
        assert_eq!(floating_integer_filter.len(), 2);
        let secondary_item_notes = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_notes",
            json!({"item_id":second_item.id}),
        ));
        assert!(secondary_item_notes.is_empty());

        let missing_note = call_tool(
            &test_db.db,
            &mut ready,
            "save_note",
            json!({"note_id":9999,"title":"不可保存"}),
        );
        assert_eq!(missing_note["isError"], true);
        assert_eq!(
            missing_note
                .pointer("/content/0/text")
                .and_then(Value::as_str),
            Some("Error executing tool save_note: 笔记 ID 9999 不存在")
        );
    }

    #[test]
    fn export_note_matches_the_legacy_markdown_contract() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);
        let active = test_db.db.current_active_account().expect("active account");
        let item = import_fixture_item(&test_db.db, active.id, "mcp-export-fixture.png");
        let note = test_db
            .db
            .create_local_note(LocalNoteCreate {
                account_pool_id: active.id,
                item_ids: vec![item.id],
                account_ref: None,
                title: Some("旧导出契约".into()),
                body: Some("正文第一行\n正文第二行".into()),
                tags: vec!["家居".into(), "#井号".into()],
                cover_desc: Some("封面文案".into()),
                prompt_used: None,
                note_type: "text".into(),
                video_path: None,
            })
            .expect("create export fixture note");
        test_db
            .db
            .update_local_note_status(aichihongshu_db::LocalNoteStatusUpdate {
                note_id: note.id,
                account_pool_id: active.id,
                expected_version: note.content_version,
                status: "published".into(),
                note_url: Some("https://example.invalid/published".into()),
            })
            .expect("publish export fixture note");
        let created_at = test_db
            .db
            .get_local_note_for_legacy(note.id)
            .expect("read export note")
            .1
            .expect("export note exists")
            .created_at
            .expect("created timestamp exists");

        let exported = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "export_note",
            json!({"note_id":note.id}),
        ));
        assert_eq!(
            exported["markdown"],
            format!(
                "# 旧导出契约\n\n> 物品：{}\n\n**封面文案**：封面文案\n\n正文第一行\n正文第二行\n\n#家居 ##井号\n\n---\n*状态：published | 创建：{created_at}*",
                item.title
            )
        );
    }

    #[test]
    fn list_items_preserves_legacy_filter_before_default_limit() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);
        let active = test_db.db.current_active_account().expect("active account");
        let oldest = import_fixture_item(&test_db.db, active.id, "mcp-oldest-item.png");
        test_db
            .db
            .update_local_item_metadata(LocalItemMetadataUpdate {
                item_id: oldest.id,
                account_pool_id: active.id,
                expected_metadata_version: oldest.metadata_version,
                title: oldest.title.clone(),
                tags: vec!["contract_marker".into()],
                style: Some("奶油风客厅".into()),
                material: oldest.material.clone(),
                scene: oldest.scene.clone(),
                color: oldest.color.clone(),
            })
            .expect("mark oldest item");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        for index in 0..50 {
            import_fixture_item(
                &test_db.db,
                active.id,
                &format!("mcp-recent-item-{index}.png"),
            );
        }

        let recent_items =
            json_content_blocks(&call_tool(&test_db.db, &mut ready, "list_items", json!({})));
        assert_eq!(recent_items.len(), 50);
        assert!(recent_items.iter().all(|value| value["id"] != oldest.id));

        let filtered = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_items",
            json!({"tag":"contract_%"}),
        ));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["id"], oldest.id);
    }

    #[test]
    fn input_validation_and_profile_noop_keep_fastmcp_error_categories() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);
        let missing_required = handle(
            &test_db.db,
            &json!({
                "jsonrpc":"2.0", "id":9, "method":"tools/call",
                "params":{"name":"get_item","arguments":{}}
            }),
            &mut ready,
        )
        .expect("validation result");
        assert_eq!(
            missing_required
                .pointer("/result/isError")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            missing_required
                .pointer("/result/content/0/text")
                .and_then(Value::as_str),
            Some("Input validation error: 'item_id' is a required property")
        );

        let no_op = handle(
            &test_db.db,
            &json!({
                "jsonrpc":"2.0", "id":10, "method":"tools/call",
                "params":{"name":"update_profile","arguments":{"persona_tone":null,"persona_taboos":null,"posting_rhythm":null,"hashtag_pool":null}}
            }),
            &mut ready,
        )
        .expect("no-op profile result");
        assert_eq!(
            no_op.pointer("/result/isError").and_then(Value::as_bool),
            Some(false)
        );
        let text = no_op
            .pointer("/result/content/0/text")
            .and_then(Value::as_str)
            .unwrap();
        let value: Value = serde_json::from_str(text).unwrap();
        assert_eq!(
            value.get("error").and_then(Value::as_str),
            Some("没有可更新的字段")
        );
    }

    #[test]
    fn mcp_hides_soft_deleted_records_while_analytics_keeps_legacy_counts() {
        let test_db = TestDatabase::new();
        let active = test_db.db.current_active_account().expect("active account");
        let live_item = import_fixture_item(&test_db.db, active.id, "analytics-live.png");
        let trashed_item = import_fixture_item(&test_db.db, active.id, "analytics-trashed.png");
        test_db
            .db
            .delete_local_item(trashed_item.id, active.id)
            .expect("trash fixture item");

        let live_note = test_db
            .db
            .create_local_prompt_draft(live_item.id, active.id, None, "")
            .expect("create live analytics note");
        let trashed_note = test_db
            .db
            .create_local_prompt_draft(live_item.id, active.id, None, "")
            .expect("create analytics note to trash");
        let trashed_note = test_db
            .db
            .update_local_note_status(LocalNoteStatusUpdate {
                note_id: trashed_note.id,
                account_pool_id: active.id,
                expected_version: trashed_note.content_version,
                status: "ready".into(),
                note_url: None,
            })
            .expect("mark analytics note ready");
        test_db
            .db
            .delete_local_note(trashed_note.id, active.id)
            .expect("trash fixture note");

        let mut ready = initialize(&test_db.db);
        let analytics = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_analytics",
            json!({}),
        ));
        assert_eq!(analytics["items"], 2);
        assert_eq!(analytics["notes"]["total"], 2);
        assert_eq!(
            analytics["notes"]["by_status"],
            json!({"draft":1,"ready":1})
        );

        let visible_items =
            json_content_blocks(&call_tool(&test_db.db, &mut ready, "list_items", json!({})));
        assert_eq!(visible_items.len(), 1);
        assert_eq!(visible_items[0]["id"], live_item.id);
        let hidden_item = call_tool(
            &test_db.db,
            &mut ready,
            "get_item",
            json!({"item_id":trashed_item.id}),
        );
        assert_eq!(hidden_item["isError"], false);
        assert_eq!(
            first_json_content(&hidden_item)["error"],
            format!("物品 {} 不存在", trashed_item.id)
        );
        let denied_tag = call_tool(
            &test_db.db,
            &mut ready,
            "tag_item",
            json!({"item_id":trashed_item.id,"tag":"不应写入"}),
        );
        assert_eq!(denied_tag["isError"], true);
        assert!(denied_tag["content"][0]["text"]
            .as_str()
            .is_some_and(|text| text.contains("物品 ID") && text.contains("不存在")));
        let hidden_prompt = call_tool(
            &test_db.db,
            &mut ready,
            "draft_note_prompt",
            json!({"item_id":trashed_item.id,"save":false}),
        );
        assert_eq!(hidden_prompt["isError"], false);
        assert_eq!(
            first_json_content(&hidden_prompt)["error"],
            format!("物品 {} 不存在", trashed_item.id)
        );

        let visible_notes =
            json_content_blocks(&call_tool(&test_db.db, &mut ready, "list_notes", json!({})));
        assert_eq!(visible_notes.len(), 1);
        assert_eq!(visible_notes[0]["id"], live_note.id);
        let hidden_note = call_tool(
            &test_db.db,
            &mut ready,
            "get_note",
            json!({"note_id":trashed_note.id}),
        );
        assert_eq!(hidden_note["isError"], false);
        assert_eq!(
            first_json_content(&hidden_note)["error"],
            format!("笔记 {} 不存在", trashed_note.id)
        );
        for (name, arguments) in [
            (
                "save_note",
                json!({"note_id":trashed_note.id,"title":"不应写入"}),
            ),
            ("publish_note", json!({"note_id":trashed_note.id})),
        ] {
            let denied = call_tool(&test_db.db, &mut ready, name, arguments);
            assert_eq!(denied["isError"], true, "{name} must reject trashed notes");
        }
        let hidden_export = call_tool(
            &test_db.db,
            &mut ready,
            "export_note",
            json!({"note_id":trashed_note.id}),
        );
        assert_eq!(hidden_export["isError"], false);
        assert_eq!(
            first_json_content(&hidden_export)["error"],
            format!("笔记 {} 不存在", trashed_note.id)
        );
    }

    #[test]
    fn all_mcp_required_arguments_and_invalid_root_types_are_schema_errors() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);

        for (name, arguments, expected) in [
            ("get_item", json!({}), "'item_id' is a required property"),
            (
                "add_item_from_path",
                json!({}),
                "'image_path' is a required property",
            ),
            ("tag_item", json!({}), "'item_id' is a required property"),
            (
                "tag_item",
                json!({"item_id":1}),
                "'tag' is a required property",
            ),
            (
                "draft_note_prompt",
                json!({}),
                "'item_id' is a required property",
            ),
            ("get_note", json!({}), "'note_id' is a required property"),
            ("save_note", json!({}), "'note_id' is a required property"),
            (
                "publish_note",
                json!({}),
                "'note_id' is a required property",
            ),
            ("export_note", json!({}), "'note_id' is a required property"),
        ] {
            let result = call_tool(&test_db.db, &mut ready, name, arguments);
            assert_eq!(result["isError"], true, "{name} must reject missing input");
            assert_eq!(
                result.pointer("/content/0/text").and_then(Value::as_str),
                Some(format!("Input validation error: {expected}").as_str()),
                "{name} must preserve its required-field validation message"
            );
        }

        for arguments in [Value::Null, json!([]), json!(7), json!("not an object")] {
            let expected = format!("Input validation error: {arguments} is not of type 'object'");
            let result = call_tool(&test_db.db, &mut ready, "get_item", arguments);
            assert_eq!(result["isError"], true);
            assert_eq!(
                result.pointer("/content/0/text").and_then(Value::as_str),
                Some(expected.as_str())
            );
        }

        for (name, arguments, expected) in [
            (
                "get_item",
                json!({"item_id":"not an integer"}),
                "Input validation error: \"not an integer\" is not of type 'integer'",
            ),
            (
                "get_item",
                json!({"item_id":1.5}),
                "Input validation error: 1.5 is not of type 'integer'",
            ),
            (
                "update_profile",
                json!({"persona_tone":42}),
                "Input validation error: 42 is not of type 'string'",
            ),
            (
                "tag_item",
                json!({"item_id":1,"tag":"valid","action":false}),
                "Input validation error: false is not of type 'string'",
            ),
            (
                "save_note",
                json!({"note_id":1,"tags":["valid",2]}),
                "Input validation error: 2 is not of type 'string'",
            ),
        ] {
            let result = call_tool(&test_db.db, &mut ready, name, arguments);
            assert_eq!(result["isError"], true, "{name} must reject invalid types");
            assert_eq!(
                result.pointer("/content/0/text").and_then(Value::as_str),
                Some(expected)
            );
        }
    }

    #[test]
    fn all_default_null_optional_arguments_accept_explicit_null() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);

        for tool in tools() {
            let name = tool["name"].as_str().expect("tool name");
            let schema = &tool["inputSchema"];
            let properties = schema["properties"].as_object().expect("properties");
            let mut arguments = Map::new();
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for key in required.iter().filter_map(Value::as_str) {
                    let required_schema = &properties[key];
                    let value = match required_schema["type"].as_str() {
                        Some("integer") => json!(1),
                        Some("string") => json!("contract-fixture"),
                        Some("boolean") => json!(true),
                        Some(other) => panic!("unsupported required schema type {other}"),
                        None => panic!("required property {key} has no type"),
                    };
                    arguments.insert(key.to_string(), value);
                }
            }

            for (key, property_schema) in properties {
                if property_schema.get("default") != Some(&Value::Null) {
                    continue;
                }
                arguments.insert(key.clone(), Value::Null);
                let reply = handle(
                    &test_db.db,
                    &json!({
                        "jsonrpc":"2.0", "id":name, "method":"tools/call",
                        "params":{"name":name,"arguments":arguments.clone()}
                    }),
                    &mut ready,
                )
                .unwrap_or_else(|| panic!("{name}.{key} should return a result"));
                let validation_error = reply
                    .pointer("/result/content/0/text")
                    .and_then(Value::as_str)
                    .is_some_and(|text| text.starts_with("Input validation error:"));
                assert!(
                    !validation_error,
                    "{name}.{key} declares default null and must accept explicit null: {reply}"
                );
                arguments.remove(key);
            }
        }
    }

    #[test]
    fn every_mcp_declared_argument_type_is_enforced() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);

        for tool in tools() {
            let name = tool["name"].as_str().expect("tool name");
            let schema = &tool["inputSchema"];
            let properties = schema["properties"].as_object().expect("properties");
            let mut arguments = Map::new();
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for key in required.iter().filter_map(Value::as_str) {
                    let required_schema = &properties[key];
                    let value = match required_schema["type"].as_str() {
                        Some("integer") => json!(1),
                        Some("string") => json!("contract-fixture"),
                        Some("boolean") => json!(true),
                        Some(other) => panic!("unsupported required schema type {other}"),
                        None => panic!("required property {key} has no type"),
                    };
                    arguments.insert(key.to_string(), value);
                }
            }

            for (key, property_schema) in properties {
                let invalid_value = match property_schema["type"].as_str() {
                    Some("string" | "integer" | "number" | "boolean") => json!({"invalid":true}),
                    Some("array") | None => json!({"invalid":true}),
                    Some("object") => json!(false),
                    Some("null") => json!(false),
                    Some(other) => panic!("unsupported MCP schema type {other}"),
                };
                arguments.insert(key.clone(), invalid_value);
                let reply = handle(
                    &test_db.db,
                    &json!({
                        "jsonrpc":"2.0", "id":name, "method":"tools/call",
                        "params":{"name":name,"arguments":arguments.clone()}
                    }),
                    &mut ready,
                )
                .unwrap_or_else(|| panic!("{name}.{key} should return a result"));
                let text = reply
                    .pointer("/result/content/0/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                assert!(
                    text.starts_with("Input validation error:"),
                    "{name}.{key} accepted a value outside its schema: {reply}"
                );

                let array_schema = if property_schema["type"].as_str() == Some("array") {
                    Some(property_schema)
                } else {
                    property_schema
                        .get("anyOf")
                        .and_then(Value::as_array)
                        .and_then(|alternatives| {
                            alternatives
                                .iter()
                                .find(|alternative| alternative["type"].as_str() == Some("array"))
                        })
                };
                if array_schema
                    .and_then(|array| array.pointer("/items/type"))
                    .and_then(Value::as_str)
                    == Some("string")
                {
                    arguments.insert(key.clone(), json!([false]));
                    let reply = handle(
                        &test_db.db,
                        &json!({
                            "jsonrpc":"2.0", "id":name, "method":"tools/call",
                            "params":{"name":name,"arguments":arguments.clone()}
                        }),
                        &mut ready,
                    )
                    .unwrap_or_else(|| panic!("{name}.{key} should return a result"));
                    let text = reply
                        .pointer("/result/content/0/text")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    assert!(
                        text.starts_with("Input validation error:"),
                        "{name}.{key} accepted an invalid array item: {reply}"
                    );
                }
                arguments.remove(key);
            }
        }
    }

    #[test]
    fn unknown_tool_uses_fastmcp_tool_error_result() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);
        let reply = handle(
            &test_db.db,
            &json!({
                "jsonrpc":"2.0", "id":8, "method":"tools/call",
                "params":{"name":"unknown_tool","arguments":{}}
            }),
            &mut ready,
        )
        .expect("tool error result");
        assert_eq!(reply.get("error"), None);
        assert_eq!(
            reply.pointer("/result/isError").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            reply
                .pointer("/result/content/0/text")
                .and_then(Value::as_str),
            Some("Unknown tool: unknown_tool")
        );
    }

    #[test]
    fn tool_schemas_match_the_legacy_python_mcp_contract() {
        let legacy: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/python_mcp_tool_schemas.json"
        ))
        .unwrap();
        let current_tools = tools();
        assert_eq!(current_tools.len(), 22);
        assert_eq!(
            Value::Array(current_tools[..14].to_vec()),
            legacy,
            "the original Python MCP tools must keep their names, descriptions and schemas"
        );
        assert_eq!(
            current_tools[14..]
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            [
                "search_notes",
                "list_memory_entries",
                "save_memory_entry",
                "set_memory_entry_state",
                "delete_memory_entry",
                "list_experience_prompts",
                "save_experience_prompt",
                "delete_experience_prompt",
            ]
        );
    }

    #[test]
    fn memory_mcp_tools_are_account_scoped_and_write_only_pc_origin() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);
        let first = test_db.db.current_active_account().expect("first account");
        let create_memory = |account_pool_id: i64, origin: &str, content: &str| {
            test_db
                .db
                .create_memory_entry(MemoryEntryCreate {
                    account_pool_id,
                    origin: origin.into(),
                    kind: "fact".into(),
                    content: content.into(),
                    subject: Some("浴室".into()),
                    scope: Some("account".into()),
                    source: Some("test".into()),
                    source_type: Some("user".into()),
                    occurred_at: None,
                    confirm_status: None,
                    enabled: None,
                })
                .expect("seed isolated memory entry")
        };
        let pc_memory = create_memory(first.id, "pc", "PC 记忆：浴室收纳偏好");
        let mobile_memory = create_memory(first.id, "mobile", "手机缓存：不应被 MCP 修改");
        test_db
            .db
            .transition_memory_entry_status(MemoryEntryTransition {
                id: mobile_memory.id,
                account_pool_id: first.id,
                next_status: "confirmed".into(),
                replaced_by: None,
            })
            .expect("seed confirmed mobile memory for replacement boundary");
        let add_experience = |account_pool_id: i64, origin: &str, title: &str| {
            test_db
                .db
                .upsert_experience_prompt_with_id(ExperiencePromptUpsert {
                    account_pool_id,
                    origin: origin.into(),
                    id: None,
                    title: title.into(),
                    content: "保留真实细节".into(),
                    enabled: true,
                    apply_scope: None,
                    apply_target: None,
                    source: None,
                    sort_order: None,
                })
                .expect("seed isolated experience prompt")
        };
        let (pc_experience_id, _) = add_experience(first.id, "pc", "PC 写作经验");
        let (mobile_experience_id, _) = add_experience(first.id, "mobile", "手机写作经验");
        let first_note = test_db
            .db
            .create_local_draft_for_account("浴室收纳灵感", Some(first.id))
            .expect("seed first-account note");

        let second_id = test_db
            .db
            .create_local_account(LocalAccountCreate {
                alias: "MCP 记忆隔离账号".into(),
                role: "operation".into(),
                notes: None,
            })
            .expect("create second account");
        test_db
            .db
            .activate_account(second_id)
            .expect("activate second account");
        let second_memory = create_memory(second_id, "pc", "第二账号私有记忆");
        let (second_experience_id, _) = add_experience(second_id, "pc", "第二账号私有经验");
        test_db
            .db
            .create_local_draft_for_account("另一账号私有收纳笔记", Some(second_id))
            .expect("seed second-account note");
        test_db
            .db
            .activate_account(first.id)
            .expect("restore first account");

        let listed_memories = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_memory_entries",
            json!({}),
        ));
        assert_eq!(listed_memories.len(), 1);
        assert_eq!(listed_memories[0]["id"], pc_memory.id);
        assert_eq!(listed_memories[0]["origin"], "pc");
        let listed_experiences = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_experience_prompts",
            json!({}),
        ));
        assert_eq!(listed_experiences.len(), 1);
        assert_eq!(listed_experiences[0]["id"], pc_experience_id);
        assert_eq!(listed_experiences[0]["origin"], "pc");

        let created = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "save_memory_entry",
            json!({
                "kind":"fact",
                "content":"厨房收纳偏好",
                "subject":"厨房",
                "source":"MCP 用户输入",
                "occurred_at":"2026-10-04"
            }),
        ));
        assert_eq!(created["origin"], "pc");
        assert_eq!(created["confirm_status"], "candidate");
        let created_id = created["id"].as_i64().expect("created memory ID");
        let updated = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "save_memory_entry",
            json!({"memory_id":created_id,"kind":"fact","content":"抽屉式厨房收纳偏好"}),
        ));
        assert_eq!(updated["content"], "抽屉式厨房收纳偏好");
        assert_eq!(updated["subject"], "厨房", "omitted fields are preserved");
        assert_eq!(updated["occurred_at"], "2026-10-04");
        let cleared = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "save_memory_entry",
            json!({
                "memory_id":created_id,
                "kind":"fact",
                "content":"抽屉式厨房收纳偏好",
                "subject":null,
                "scope":null,
                "source":null,
                "source_type":null,
                "occurred_at":null
            }),
        ));
        assert_eq!(cleared["subject"], "");
        assert_eq!(cleared["scope"], "account");
        assert_eq!(cleared["source"], "");
        assert_eq!(cleared["source_type"], "user");
        assert!(cleared["occurred_at"].is_null());
        let confirmed = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "set_memory_entry_state",
            json!({"memory_id":created_id,"confirm_status":"confirmed"}),
        ));
        assert_eq!(confirmed["confirm_status"], "confirmed");
        let cross_origin_replacement = call_tool(
            &test_db.db,
            &mut ready,
            "set_memory_entry_state",
            json!({
                "memory_id":created_id,
                "confirm_status":"outdated",
                "replaced_by":mobile_memory.id
            }),
        );
        assert_eq!(cross_origin_replacement["isError"], true);
        let after_denied_replacement = test_db
            .db
            .list_memory_entries(MemoryEntryFilter {
                account_pool_id: Some(first.id),
                origin: Some("pc".into()),
                kind: None,
                confirm_status: None,
                enabled: None,
            })
            .expect("read PC state after denied cross-origin replacement");
        assert_eq!(
            after_denied_replacement
                .iter()
                .find(|entry| entry.id == created_id)
                .expect("PC entry remains")
                .confirm_status,
            "confirmed"
        );
        let disabled = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "set_memory_entry_state",
            json!({"memory_id":created_id,"enabled":false}),
        ));
        assert_eq!(disabled["enabled"], false);

        let saved_experience = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "save_experience_prompt",
            json!({
                "title":"标题偏好",
                "content":"标题简洁，不夸大",
                "apply_scope":"global",
                "source":"from_memory",
                "sort_order":3
            }),
        ));
        assert_eq!(saved_experience["origin"], "pc");
        let saved_experience_id = saved_experience["id"]
            .as_i64()
            .expect("saved experience ID");
        let updated_experience = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "save_experience_prompt",
            json!({
                "experience_id":saved_experience_id,
                "title":"标题偏好更新",
                "content":"标题尽量接近 20 字且不超过",
                "enabled":false,
                "apply_target":"compose"
            }),
        ));
        assert_eq!(updated_experience["title"], "标题偏好更新");
        assert_eq!(updated_experience["enabled"], false);
        assert_eq!(updated_experience["apply_target"], "compose");
        assert_eq!(updated_experience["apply_scope"], "global");
        assert_eq!(updated_experience["source"], "from_memory");
        assert_eq!(updated_experience["sort_order"], 3);
        let cleared_experience_metadata = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "save_experience_prompt",
            json!({
                "experience_id":saved_experience_id,
                "title":"标题偏好更新",
                "content":"标题尽量接近 20 字且不超过",
                "apply_scope":null,
                "apply_target":null,
                "source":null,
                "sort_order":null
            }),
        ));
        assert_eq!(cleared_experience_metadata["apply_scope"], "account");
        assert_eq!(cleared_experience_metadata["apply_target"], "all");
        assert_eq!(cleared_experience_metadata["source"], "user");
        assert_eq!(cleared_experience_metadata["sort_order"], 0);

        let mobile_memory_write = call_tool(
            &test_db.db,
            &mut ready,
            "save_memory_entry",
            json!({
                "memory_id":mobile_memory.id,
                "kind":"fact",
                "content":"不允许覆盖手机缓存"
            }),
        );
        assert_eq!(mobile_memory_write["isError"], true);
        let mobile_memory_state = call_tool(
            &test_db.db,
            &mut ready,
            "set_memory_entry_state",
            json!({"memory_id":mobile_memory.id,"enabled":false}),
        );
        assert_eq!(mobile_memory_state["isError"], true);
        let mobile_memory_delete = call_tool(
            &test_db.db,
            &mut ready,
            "delete_memory_entry",
            json!({"memory_id":mobile_memory.id}),
        );
        assert_eq!(mobile_memory_delete["isError"], true);
        let remaining_mobile_memory = test_db
            .db
            .list_memory_entries(MemoryEntryFilter {
                account_pool_id: Some(first.id),
                origin: Some("mobile".into()),
                kind: None,
                confirm_status: None,
                enabled: None,
            })
            .expect("read mobile memory after denied MCP writes");
        assert_eq!(remaining_mobile_memory.len(), 1);
        assert_eq!(
            remaining_mobile_memory[0].content,
            "手机缓存：不应被 MCP 修改"
        );

        let mobile_experience_write = call_tool(
            &test_db.db,
            &mut ready,
            "save_experience_prompt",
            json!({
                "experience_id":mobile_experience_id,
                "title":"不允许覆盖手机经验",
                "content":"不得写入"
            }),
        );
        assert_eq!(mobile_experience_write["isError"], true);
        let mobile_experience_delete = call_tool(
            &test_db.db,
            &mut ready,
            "delete_experience_prompt",
            json!({"experience_id":mobile_experience_id}),
        );
        assert_eq!(mobile_experience_delete["isError"], true);
        let remaining_mobile_experience = test_db
            .db
            .list_experience_prompts(Some(first.id), Some("mobile".into()))
            .expect("read mobile experience after denied MCP writes");
        assert_eq!(remaining_mobile_experience.len(), 1);
        assert_eq!(remaining_mobile_experience[0].title, "手机写作经验");

        let cross_account_memory = call_tool(
            &test_db.db,
            &mut ready,
            "delete_memory_entry",
            json!({"memory_id":second_memory.id}),
        );
        assert_eq!(cross_account_memory["isError"], true);
        let cross_account_experience = call_tool(
            &test_db.db,
            &mut ready,
            "delete_experience_prompt",
            json!({"experience_id":second_experience_id}),
        );
        assert_eq!(cross_account_experience["isError"], true);

        let matching_notes = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "search_notes",
            json!({"keyword":"浴室收纳","limit":10}),
        ));
        assert_eq!(matching_notes.len(), 1);
        assert_eq!(matching_notes[0]["id"], first_note.id);
        let hidden_notes = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "search_notes",
            json!({"keyword":"另一账号私有收纳笔记"}),
        ));
        assert!(hidden_notes.is_empty());

        let deleted = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "delete_memory_entry",
            json!({"memory_id":created_id}),
        ));
        assert_eq!(deleted["deleted"], true);
        let deleted_experience = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "delete_experience_prompt",
            json!({"experience_id":saved_experience_id}),
        ));
        assert_eq!(deleted_experience["deleted"], true);
    }

    #[test]
    fn publish_tool_only_records_local_status_and_url() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);
        let active = test_db.db.current_active_account().expect("active account");
        let note = test_db
            .db
            .create_local_draft_for_account("MCP test note", Some(active.id))
            .expect("create local draft");
        let reply = handle(&test_db.db, &json!({
            "jsonrpc":"2.0","id":4,"method":"tools/call",
            "params":{"name":"publish_note","arguments":{"note_id":note.id,"note_url":"https://example.invalid/local-only"}}
        }), &mut ready).expect("publish tool response");
        let result = reply
            .pointer("/result/content/0/text")
            .and_then(Value::as_str)
            .unwrap();
        let payload: Value = serde_json::from_str(result).expect("serialized note result");
        assert_eq!(
            payload.get("status").and_then(Value::as_str),
            Some("published")
        );
        assert_eq!(
            payload.get("note_url").and_then(Value::as_str),
            Some("https://example.invalid/local-only")
        );
        assert_eq!(
            test_db
                .db
                .snapshot_section_for_account(Some(active.id), "notes")
                .unwrap()
                .notes[0]
                .status,
            "published"
        );
    }

    #[test]
    fn mcp_tools_keep_reads_and_writes_within_the_active_account() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);
        let first_account = test_db
            .db
            .current_active_account()
            .expect("initial active account");
        let seed_profile = |account_pool_id, account_id: &str, display_name: &str, tone: &str| {
            test_db
                .db
                .update_local_profile(LocalProfileUpdate {
                    account_pool_id,
                    account_id: Some(account_id.to_string()),
                    display_name: Some(display_name.to_string()),
                    niche: Some("家居".into()),
                    target_audience: None,
                    content_pillars: vec![],
                    followers: None,
                    persona_name: None,
                    persona_bio: None,
                    persona_tone: Some(tone.to_string()),
                    persona_taboos: vec![],
                    preferred_styles: vec![],
                    preferred_scenes: vec![],
                    hashtag_pool: vec![],
                    posting_rhythm: None,
                    avatar_url: None,
                    xhs_bio: None,
                    xhs_follows: None,
                    ip_location: None,
                    xhs_tags: None,
                    risk_warning_ack: None,
                })
                .expect("seed account-scoped MCP profile");
        };
        let seed_reference = |account_pool_id, account_id: &str, name: &str| {
            test_db
                .db
                .upsert_local_reference_account_manual(LocalReferenceAccountManualUpsert {
                    account_pool_id,
                    account_id: account_id.into(),
                    name: name.into(),
                    followers: 0,
                    note_count: 0,
                    avg_likes: 0.0,
                    avg_comments: 0.0,
                    avg_collects: 0.0,
                    content_style: None,
                    top_notes: vec![],
                })
                .expect("seed account-scoped MCP reference account");
        };
        seed_profile(first_account.id, "first-xhs", "一号运营账号", "一号语气");
        seed_reference(first_account.id, "first-reference", "一号榜样");
        let second_account = test_db
            .db
            .create_local_account(LocalAccountCreate {
                alias: "MCP 隔离账号".into(),
                role: "operation".into(),
                notes: None,
            })
            .expect("create second operation account");
        test_db
            .db
            .activate_account(second_account)
            .expect("activate second account");
        seed_profile(second_account, "second-xhs", "二号运营账号", "二号语气");
        seed_reference(second_account, "second-reference", "二号榜样");
        let second_item = test_db
            .db
            .import_local_image(LocalImageImport {
                account_pool_id: second_account,
                file_name: "private-mcp-fixture.png".into(),
                mime_type: Some("image/png".into()),
                data_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".into(),
                thumbnail_data_base64: None,
            })
            .expect("import image for second account");
        let second_note = test_db
            .db
            .create_local_draft_for_account("第二账号私有草稿", Some(second_account))
            .expect("create note for second account");
        test_db
            .db
            .activate_account(first_account.id)
            .expect("restore first account");

        let first_profile = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_profile",
            json!({}),
        ));
        assert_eq!(first_profile["display_name"], "一号运营账号");
        assert_eq!(first_profile["persona_tone"], "一号语气");
        let first_references = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_accounts",
            json!({}),
        ));
        assert_eq!(first_references.len(), 1);
        assert_eq!(first_references[0]["account_id"], "first-reference");

        let listed_items =
            json_content_blocks(&call_tool(&test_db.db, &mut ready, "list_items", json!({})));
        assert!(listed_items.is_empty());
        let hidden_item = call_tool(
            &test_db.db,
            &mut ready,
            "get_item",
            json!({"item_id":second_item.id}),
        );
        assert_eq!(hidden_item["isError"], false);
        assert_eq!(
            first_json_content(&hidden_item)["error"],
            format!("物品 {} 不存在", second_item.id)
        );
        let denied_tag = call_tool(
            &test_db.db,
            &mut ready,
            "tag_item",
            json!({"item_id":second_item.id,"tag":"越权","action":"add"}),
        );
        assert_eq!(denied_tag["isError"], true);
        assert_eq!(
            denied_tag
                .pointer("/content/0/text")
                .and_then(Value::as_str),
            Some(
                format!(
                    "Error executing tool tag_item: 物品 ID {} 不存在",
                    second_item.id
                )
                .as_str()
            )
        );

        let listed_notes =
            json_content_blocks(&call_tool(&test_db.db, &mut ready, "list_notes", json!({})));
        assert!(listed_notes.is_empty());
        let private_analytics = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_analytics",
            json!({}),
        ));
        assert_eq!(private_analytics["items"], 0);
        assert_eq!(private_analytics["notes"]["total"], 0);
        let hidden_note = call_tool(
            &test_db.db,
            &mut ready,
            "get_note",
            json!({"note_id":second_note.id}),
        );
        assert_eq!(hidden_note["isError"], false);
        assert_eq!(
            first_json_content(&hidden_note)["error"],
            format!("笔记 {} 不存在", second_note.id)
        );
        let denied_save = call_tool(
            &test_db.db,
            &mut ready,
            "save_note",
            json!({"note_id":second_note.id,"title":"越权修改"}),
        );
        assert_eq!(denied_save["isError"], true);
        let denied_draft = call_tool(
            &test_db.db,
            &mut ready,
            "draft_note_prompt",
            json!({"item_id":second_item.id,"save":true}),
        );
        assert_eq!(denied_draft["isError"], false);
        assert_eq!(
            first_json_content(&denied_draft)["error"],
            format!("物品 {} 不存在", second_item.id)
        );
        assert!(
            json_content_blocks(&call_tool(&test_db.db, &mut ready, "list_notes", json!({}),))
                .is_empty()
        );
        let denied_publish = call_tool(
            &test_db.db,
            &mut ready,
            "publish_note",
            json!({"note_id":second_note.id,"note_url":"https://example.invalid/foreign"}),
        );
        assert_eq!(denied_publish["isError"], true);
        let hidden_export = call_tool(
            &test_db.db,
            &mut ready,
            "export_note",
            json!({"note_id":second_note.id}),
        );
        assert_eq!(hidden_export["isError"], false);
        assert_eq!(
            first_json_content(&hidden_export)["error"],
            format!("笔记 {} 不存在", second_note.id)
        );

        test_db
            .db
            .activate_account(second_account)
            .expect("restore second account to verify no mutation");
        let preserved_note = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_note",
            json!({"note_id":second_note.id}),
        ));
        assert_eq!(preserved_note["title"], "第二账号私有草稿");
        let preserved_item = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_item",
            json!({"item_id":second_item.id}),
        ));
        assert!(preserved_item["tags"].as_array().unwrap().is_empty());
        let second_account_analytics = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_analytics",
            json!({}),
        ));
        assert_eq!(second_account_analytics["items"], 1);
        assert_eq!(second_account_analytics["notes"]["total"], 1);
        let second_profile = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_profile",
            json!({}),
        ));
        assert_eq!(second_profile["display_name"], "二号运营账号");
        assert_eq!(second_profile["persona_tone"], "二号语气");
        let updated_second_profile = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "update_profile",
            json!({"persona_tone":"仅二号更新"}),
        ));
        assert_eq!(updated_second_profile["persona_tone"], "仅二号更新");
        let second_references = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_accounts",
            json!({}),
        ));
        assert_eq!(second_references.len(), 1);
        assert_eq!(second_references[0]["account_id"], "second-reference");

        test_db
            .db
            .activate_account(first_account.id)
            .expect("restore first account after profile mutation");
        let still_first_profile = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_profile",
            json!({}),
        ));
        assert_eq!(still_first_profile["persona_tone"], "一号语气");
    }

    #[test]
    fn mcp_tools_fail_closed_when_the_active_account_context_is_invalid() {
        let test_db = TestDatabase::new();
        let active = test_db.db.current_active_account().expect("active account");
        let item = import_fixture_item(&test_db.db, active.id, "invalid-active-mcp-item.png");
        let note = test_db
            .db
            .create_local_prompt_draft(item.id, active.id, None, "隔离测试")
            .expect("create account-scoped note");
        let assistant_id = test_db
            .db
            .create_local_account(LocalAccountCreate {
                alias: "MCP 辅助账号".into(),
                role: "assistant".into(),
                notes: None,
            })
            .expect("create non-operation account");
        let mut ineligible_accounts = Vec::new();
        for (alias, status) in [
            ("MCP 封禁账号", "banned"),
            ("MCP 停用账号", "suspended"),
            ("MCP 退休账号", "retired"),
        ] {
            let account_id = test_db
                .db
                .create_local_account(LocalAccountCreate {
                    alias: alias.into(),
                    role: "operation".into(),
                    notes: None,
                })
                .expect("create non-active operation account");
            test_db
                .db
                .update_local_account(LocalAccountUpdate {
                    account_id,
                    alias: alias.into(),
                    role: "operation".into(),
                    xhs_user_id: None,
                    display_name: None,
                    status: status.into(),
                    followers: None,
                    notes: None,
                })
                .expect("set non-active operation account status");
            ineligible_accounts.push(account_id);
        }
        let mut ready = initialize(&test_db.db);

        let import_root = test_db.root.join("allowed-imports");
        std::fs::create_dir_all(&import_root).expect("create isolated MCP import root");
        let import_path = import_root.join("valid-image.png");
        std::fs::write(
            &import_path,
            BASE64
                .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
                .expect("decode PNG fixture"),
        )
        .expect("write isolated PNG fixture");
        let _import_root_env =
            ScopedEnvironmentVariable::set("AICHIHONGSHU_MCP_ALLOWED_IMPORT_DIR", &import_root);

        let calls = [
            ("get_profile", json!({})),
            ("update_profile", json!({"persona_tone":"不应写入"})),
            ("list_items", json!({})),
            ("get_item", json!({"item_id":item.id})),
            (
                "add_item_from_path",
                json!({"image_path":import_path,"analyze":false}),
            ),
            ("tag_item", json!({"item_id":item.id,"tag":"不应写入"})),
            ("draft_note_prompt", json!({"item_id":item.id,"save":false})),
            ("list_notes", json!({})),
            ("get_note", json!({"note_id":note.id})),
            ("save_note", json!({"note_id":note.id,"title":"不应写入"})),
            ("publish_note", json!({"note_id":note.id})),
            ("export_note", json!({"note_id":note.id})),
            ("list_accounts", json!({})),
            ("get_analytics", json!({})),
        ];
        let assert_seed_counts = || {
            let conn = rusqlite::Connection::open(test_db.db.path())
                .expect("open isolated database to verify fail-closed writes");
            let item_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
                .expect("count isolated items");
            let note_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
                .expect("count isolated notes");
            assert_eq!(item_count, 1, "invalid account context must not import");
            assert_eq!(
                note_count, 1,
                "invalid account context must not mutate notes"
            );
        };

        let mut invalid_references = vec![
            ("-1".to_string(), "active_account_id".to_string()),
            ("corrupt-value".to_string(), "active_account_id".to_string()),
            ("".to_string(), "active_account_id".to_string()),
            (
                assistant_id.to_string(),
                "active account must be an active operation account".to_string(),
            ),
        ];
        invalid_references.extend(ineligible_accounts.into_iter().map(|account_id| {
            (
                account_id.to_string(),
                "active account must be an active operation account".to_string(),
            )
        }));

        for (active_reference, expected_error) in invalid_references {
            test_db
                .db
                .set_app_setting("active_account_id", &active_reference)
                .expect("set invalid active account reference");

            for (name, arguments) in calls.clone() {
                let result = call_tool(&test_db.db, &mut ready, name, arguments);
                assert_eq!(
                    result["isError"], true,
                    "{name} must reject active account reference {active_reference}"
                );
                assert!(
                    result
                        .pointer("/content/0/text")
                        .and_then(Value::as_str)
                        .is_some_and(|message| message.contains(&expected_error)),
                    "{name} must explain that account context cannot be resolved: {result}"
                );
            }
            assert_seed_counts();
        }

        rusqlite::Connection::open(test_db.db.path())
            .expect("reopen isolated database")
            .execute(
                "UPDATE app_settings SET value = NULL WHERE key = 'active_account_id'",
                [],
            )
            .expect("corrupt active account setting to null");
        for (name, arguments) in calls {
            let result = call_tool(&test_db.db, &mut ready, name, arguments);
            assert_eq!(
                result["isError"], true,
                "{name} must reject a null active account reference"
            );
            assert!(
                result
                    .pointer("/content/0/text")
                    .and_then(Value::as_str)
                    .is_some_and(|message| message.contains("active_account_id")),
                "{name} must explain that the account ID setting is null: {result}"
            );
        }
        assert_seed_counts();
    }

    #[test]
    fn every_legacy_tool_runs_against_an_isolated_local_workspace() {
        let test_db = TestDatabase::new();
        let mut ready = initialize(&test_db.db);
        let active = test_db.db.current_active_account().expect("active account");

        test_db
            .db
            .update_local_profile(LocalProfileUpdate {
                account_pool_id: active.id,
                account_id: Some("mcp-test-account".into()),
                display_name: Some("MCP 测试账号".into()),
                niche: Some("家居".into()),
                target_audience: Some("租房人群".into()),
                content_pillars: vec!["收纳".into()],
                followers: None,
                persona_name: Some("测试人设".into()),
                persona_bio: Some("隔离 MCP 契约测试".into()),
                persona_tone: Some("清晰".into()),
                persona_taboos: vec![],
                preferred_styles: vec!["实用".into()],
                preferred_scenes: vec!["客厅".into()],
                hashtag_pool: vec!["家居".into()],
                posting_rhythm: Some("每周三篇".into()),
                avatar_url: None,
                xhs_bio: None,
                xhs_follows: None,
                ip_location: None,
                xhs_tags: None,
                risk_warning_ack: None,
            })
            .expect("seed isolated profile");

        let profile = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_profile",
            json!({}),
        ));
        assert_object_fields(
            &profile,
            &[
                "id",
                "account_pool_id",
                "account_id",
                "display_name",
                "niche",
                "target_audience",
                "content_pillars",
                "persona_name",
                "persona_bio",
                "persona_tone",
                "persona_taboos",
                "followers",
                "total_notes",
                "total_likes",
                "total_collects",
                "avg_likes",
                "avg_comments",
                "avg_collects",
                "preferred_styles",
                "preferred_scenes",
                "hashtag_pool",
                "posting_rhythm",
                "avatar_url",
                "xhs_bio",
                "xhs_follows",
                "ip_location",
                "xhs_tags",
                "risk_warning_ack",
                "risk_warning_ack_at",
                "crawled_at",
                "created_at",
                "updated_at",
            ],
        );
        assert_eq!(profile["display_name"], "MCP 测试账号");
        assert!(profile["created_at"].as_str().is_some());
        let updated_profile = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "update_profile",
            json!({"persona_tone":"轻松","persona_taboos":["夸大"]}),
        ));
        assert_eq!(updated_profile["persona_tone"], "轻松");
        assert_eq!(updated_profile["persona_taboos"], json!(["夸大"]));
        assert_eq!(updated_profile["posting_rhythm"], "每周三篇");
        assert_eq!(updated_profile["hashtag_pool"], json!(["家居"]));
        let cleared_profile = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "update_profile",
            json!({"persona_tone":"","persona_taboos":[],"hashtag_pool":[]}),
        ));
        assert_eq!(cleared_profile["persona_tone"], "");
        assert_eq!(cleared_profile["persona_taboos"], json!([]));
        assert_eq!(cleared_profile["hashtag_pool"], json!([]));
        assert_eq!(cleared_profile["posting_rhythm"], "每周三篇");

        let image = test_db
            .db
            .import_local_image(LocalImageImport {
                account_pool_id: active.id,
                file_name: "mcp-fixture.png".into(),
                mime_type: Some("image/png".into()),
                data_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".into(),
                thumbnail_data_base64: None,
            })
            .expect("seed isolated image");
        let listed =
            json_content_blocks(&call_tool(&test_db.db, &mut ready, "list_items", json!({})));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["id"], image.id);
        let fetched_item = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_item",
            json!({"item_id":image.id}),
        ));
        assert_eq!(fetched_item["id"], image.id);
        assert_object_fields(
            &fetched_item,
            &[
                "id",
                "title",
                "image_path",
                "style",
                "material",
                "scene",
                "color",
                "tags",
                "analysis_raw",
                "note_count",
                "account_pool_id",
                "created_at",
                "updated_at",
            ],
        );

        let tagged = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "tag_item",
            json!({"item_id":image.id,"tag":"小户型","action":"add"}),
        ));
        assert_object_fields(
            &tagged,
            &[
                "id",
                "title",
                "image_path",
                "style",
                "material",
                "scene",
                "color",
                "tags",
                "analysis_raw",
                "note_count",
                "account_pool_id",
                "created_at",
                "updated_at",
            ],
        );
        assert_eq!(tagged["tags"], json!(["小户型"]));
        assert_eq!(
            json_content_blocks(&call_tool(
                &test_db.db,
                &mut ready,
                "list_items",
                json!({"tag":"小户型"}),
            ))
            .len(),
            1
        );

        let unsaved_prompt = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "draft_note_prompt",
            json!({"item_id":image.id,"save":false}),
        ));
        assert_object_fields(&unsaved_prompt, &["prompt", "note_id", "item_title"]);
        assert!(unsaved_prompt["prompt"]
            .as_str()
            .is_some_and(|prompt| !prompt.is_empty()));
        assert!(unsaved_prompt["note_id"].is_null());
        let draft = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "draft_note_prompt",
            json!({"item_id":image.id,"save":true}),
        ));
        let note_id = draft["note_id"].as_i64().expect("saved draft id");
        let notes = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_notes",
            json!({"item_id":image.id,"status":"draft"}),
        ));
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0]["id"], note_id);
        assert_object_fields(
            &notes[0],
            &[
                "id",
                "item_id",
                "item_ids",
                "account_ref",
                "account_pool_id",
                "title",
                "body",
                "tags",
                "cover_desc",
                "prompt_used",
                "status",
                "note_type",
                "video_path",
                "published_at",
                "note_url",
                "likes",
                "comments",
                "collects",
                "created_at",
                "updated_at",
            ],
        );
        let fetched_note = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_note",
            json!({"note_id":note_id}),
        ));
        assert_object_fields(
            &fetched_note,
            &[
                "id",
                "item_id",
                "item_ids",
                "account_ref",
                "account_pool_id",
                "title",
                "body",
                "tags",
                "cover_desc",
                "prompt_used",
                "status",
                "note_type",
                "video_path",
                "published_at",
                "note_url",
                "likes",
                "comments",
                "collects",
                "created_at",
                "updated_at",
            ],
        );

        let saved_note = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "save_note",
            json!({"note_id":note_id,"title":"小户型收纳","body":"先做好分区，再利用墙面。","tags":["收纳","租房"],"cover_desc":"奶油风客厅改造前后对比"}),
        ));
        assert_eq!(saved_note["title"], "小户型收纳");
        assert_eq!(saved_note["cover_desc"], "奶油风客厅改造前后对比");
        assert_eq!(saved_note.get("content_version"), None);
        assert_eq!(saved_note.get("account_pool_id"), Some(&json!(active.id)));
        let cleared_note_fields = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "save_note",
            json!({"note_id":note_id,"title":"","tags":[]}),
        ));
        assert_eq!(cleared_note_fields["title"], "");
        assert_eq!(cleared_note_fields["tags"], json!([]));
        assert_eq!(
            cleared_note_fields["body"], "先做好分区，再利用墙面。",
            "omitted save_note fields must retain their previous values"
        );
        assert_eq!(cleared_note_fields["cover_desc"], "奶油风客厅改造前后对比");
        let previous_updated_at = cleared_note_fields["updated_at"].clone();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let touched_note = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "save_note",
            json!({"note_id":note_id}),
        ));
        assert_ne!(touched_note["updated_at"], previous_updated_at);
        let exported = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "export_note",
            json!({"note_id":note_id}),
        ));
        assert_object_fields(&exported, &["markdown"]);
        assert!(exported["markdown"]
            .as_str()
            .unwrap()
            .contains("先做好分区"));
        let published = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "publish_note",
            json!({"note_id":note_id,"note_url":"https://example.invalid/mcp-test"}),
        ));
        assert_object_fields(
            &published,
            &[
                "id",
                "item_id",
                "item_ids",
                "account_ref",
                "account_pool_id",
                "title",
                "body",
                "tags",
                "cover_desc",
                "prompt_used",
                "status",
                "note_type",
                "video_path",
                "published_at",
                "note_url",
                "likes",
                "comments",
                "collects",
                "created_at",
                "updated_at",
            ],
        );
        assert_eq!(published["status"], "published");

        assert_eq!(published.get("deleted_at"), None);
        assert_eq!(published.get("video_path"), Some(&Value::Null));
        let republished = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "publish_note",
            json!({"note_id":note_id}),
        ));
        assert_eq!(republished["status"], "published");
        assert_eq!(
            republished["note_url"], "https://example.invalid/mcp-test",
            "omitting note_url retains the previously saved URL like the legacy COALESCE update"
        );

        for (account_id, name, avg_likes, top_notes) in [
            (
                "mcp-reference-popular",
                "较受欢迎账号",
                12.5,
                vec![ReferenceNote {
                    title: "收纳前后对比".into(),
                    likes: 88,
                    url: Some("https://example.invalid/reference".into()),
                }],
            ),
            ("mcp-reference-other", "普通账号", 3.0, Vec::new()),
        ] {
            test_db
                .db
                .upsert_local_reference_account_manual(LocalReferenceAccountManualUpsert {
                    account_pool_id: active.id,
                    account_id: account_id.into(),
                    name: name.into(),
                    followers: 1200,
                    note_count: 4,
                    avg_likes,
                    avg_comments: 2.0,
                    avg_collects: 7.0,
                    content_style: None,
                    top_notes,
                })
                .expect("seed isolated reference account");
        }
        let accounts = json_content_blocks(&call_tool(
            &test_db.db,
            &mut ready,
            "list_accounts",
            json!({}),
        ));
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0]["account_id"], "mcp-reference-popular");
        assert_eq!(accounts[1]["account_id"], "mcp-reference-other");
        assert_object_fields(
            &accounts[0],
            &[
                "account_id",
                "name",
                "followers",
                "note_count",
                "avg_likes",
                "avg_comments",
                "avg_collects",
                "top_notes",
            ],
        );
        assert_eq!(
            accounts[0]["top_notes"][0],
            json!({
                "title":"收纳前后对比",
                "likes":88,
                "url":"https://example.invalid/reference"
            })
        );
        let analytics = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_analytics",
            json!({}),
        ));
        assert_object_fields(&analytics, &["items", "notes"]);
        assert_object_fields(&analytics["notes"], &["total", "by_status"]);
        assert_eq!(analytics["items"], 1);
        assert_eq!(analytics["notes"]["total"], 1);

        let denied_import = call_tool(
            &test_db.db,
            &mut ready,
            "add_item_from_path",
            json!({"image_path":"/definitely-not-an-authorized-mcp-image.png","analyze":false}),
        );
        assert_eq!(denied_import["isError"], true);
        assert!(denied_import.pointer("/content/0/text").is_some());
    }

    #[test]
    fn mcp_single_record_tools_bypass_workspace_snapshot_limit() {
        let test_db = TestDatabase::new();
        let mut conn = rusqlite::Connection::open(test_db.root.join("app.db"))
            .expect("connect isolated MCP database");
        let tx = conn
            .transaction()
            .expect("begin large MCP fixture transaction");
        tx.execute(
            "INSERT INTO items (id, title, image_path, account_pool_id)
             VALUES (1, 'earliest MCP item', 'mcp-earliest.png', 1)",
            [],
        )
        .expect("insert earliest MCP item");
        tx.execute(
            "INSERT INTO notes (item_id, item_ids, title, body, status, account_pool_id)
             VALUES (1, '[1]', 'earliest MCP note', 'earliest note body', 'draft', 1)",
            [],
        )
        .expect("insert earliest MCP note");
        {
            let mut statement = tx
                .prepare(
                    "INSERT INTO items (title, image_path, account_pool_id)
                     VALUES (?1, ?2, 1)",
                )
                .expect("prepare additional MCP items");
            for index in 0..5_000 {
                let title = format!("MCP item {index}");
                let path = format!("mcp-item-{index}.png");
                statement
                    .execute([title.as_str(), path.as_str()])
                    .expect("insert additional MCP item");
            }
        }
        {
            let mut statement = tx
                .prepare("INSERT INTO notes (title, account_pool_id) VALUES (?1, 1)")
                .expect("prepare additional MCP notes");
            for index in 0..5_000 {
                let title = format!("MCP note {index}");
                statement
                    .execute([title.as_str()])
                    .expect("insert additional MCP note");
            }
        }
        tx.commit().expect("commit large MCP fixture transaction");
        drop(conn);

        let mut ready = initialize(&test_db.db);
        let prompt = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "draft_note_prompt",
            json!({"item_id":1,"save":false}),
        ));
        assert_eq!(prompt["item_title"], "earliest MCP item");

        let tagged = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "tag_item",
            json!({"item_id":1,"tag":"legacy"}),
        ));
        assert_eq!(tagged["tags"], json!(["legacy"]));

        let fetched = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_note",
            json!({"note_id":1}),
        ));
        assert_eq!(fetched["title"], "earliest MCP note");

        let exported = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "export_note",
            json!({"note_id":1}),
        ));
        assert!(exported["markdown"]
            .as_str()
            .expect("exported markdown")
            .contains("earliest MCP item"));

        let saved = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "save_note",
            json!({"note_id":1,"title":"saved old MCP note"}),
        ));
        assert_eq!(saved["title"], "saved old MCP note");
        let published = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "publish_note",
            json!({"note_id":1,"note_url":"https://example.invalid/old-note"}),
        ));
        assert_eq!(published["status"], "published");

        let analytics = first_json_content(&call_tool(
            &test_db.db,
            &mut ready,
            "get_analytics",
            json!({}),
        ));
        assert_eq!(analytics["items"], 5_001);
        assert_eq!(analytics["notes"]["total"], 5_001);
    }
}
