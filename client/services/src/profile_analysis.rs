use serde_json::{json, Map, Value};

const MAX_NOTES: usize = 40;
const MAX_PROMPT_BYTES: usize = 32 * 1024;
const PROFILE_FIELDS: &[(&str, usize)] = &[
    ("niche", 200),
    ("target_audience", 500),
    ("persona_tone", 300),
    ("posting_rhythm", 300),
    ("analysis_summary", 500),
];
const LIST_FIELDS: &[(&str, usize)] = &[
    ("content_pillars", 12),
    ("preferred_styles", 12),
    ("preferred_scenes", 12),
    ("hashtag_pool", 30),
    ("taboos", 30),
];

fn bounded_string(value: &Value, max_chars: usize) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(max_chars).collect())
}

fn bounded_list(value: &Value, max_items: usize) -> Vec<String> {
    let Some(values) = value.as_array() else {
        return Vec::new();
    };
    let mut output = Vec::new();
    for value in values {
        let Some(value) = bounded_string(value, 80) else {
            continue;
        };
        if !output.iter().any(|entry: &String| entry == &value) {
            output.push(value);
        }
        if output.len() >= max_items {
            break;
        }
    }
    output
}

pub fn parse_profile_inference(raw: &str) -> Result<Value, String> {
    let raw = raw.trim();
    let cleaned = if raw.starts_with("```") {
        let lines = raw.lines().collect::<Vec<_>>();
        if lines.len() < 3 {
            return Err("人设分析没有返回完整 JSON".into());
        }
        lines[1..if lines.last().is_some_and(|line| line.trim() == "```") {
            lines.len() - 1
        } else {
            lines.len()
        }]
            .join("\n")
    } else {
        raw.to_string()
    };
    let parsed = serde_json::from_str::<Value>(&cleaned)
        .map_err(|_| "人设分析返回的内容不是有效 JSON".to_string())?;
    let Some(source) = parsed.as_object() else {
        return Err("人设分析结果必须是 JSON 对象".into());
    };
    let mut output = Map::new();
    for (field, limit) in PROFILE_FIELDS {
        if let Some(value) = source
            .get(*field)
            .and_then(|value| bounded_string(value, *limit))
        {
            output.insert((*field).into(), Value::String(value));
        }
    }
    for (field, limit) in LIST_FIELDS {
        let values = source
            .get(*field)
            .map(|value| bounded_list(value, *limit))
            .unwrap_or_default();
        if !values.is_empty() {
            output.insert((*field).into(), json!(values));
        }
    }
    if output.is_empty() {
        return Err("人设分析没有返回可用字段".into());
    }
    Ok(Value::Object(output))
}

pub async fn infer_profile_from_notes(
    provider: &Value,
    model: &str,
    notes: &[Value],
    stats: &Value,
) -> Result<Value, String> {
    let mut lines = Vec::new();
    for note in notes.iter().take(MAX_NOTES) {
        let title = note
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| note.get("desc").and_then(Value::as_str))
            .unwrap_or_default()
            .trim()
            .chars()
            .take(60)
            .collect::<String>();
        if !title.is_empty() {
            lines.push(format!("{}. {title}", lines.len() + 1));
        }
    }
    if lines.is_empty() {
        return Err("没有可用于人设推断的主页笔记".into());
    }
    let prompt = format!(
        "你是一位小红书家居垂类运营专家。请根据这些数据推断账号的人设定位，用 JSON 格式返回。\n\n笔记数据（标题 + 描述摘要）：\n{}\n\n账号统计数据：\n- 笔记总数：{}\n- 平均点赞：{}\n- 平均评论：{}\n- 平均收藏：{}\n\n请推断并返回以下 JSON（所有字段都要填，不确定的给合理推测值）：\n{{\n  \"niche\": \"账号垂类定位，10-20字，如：出租屋软装改造/平价家居好物分享\",\n  \"target_audience\": \"目标受众描述，如：20-30岁租房女性，追求生活质感但预算有限\",\n  \"content_pillars\": [\"内容支柱1\", \"内容支柱2\", \"内容支柱3\"],\n  \"persona_tone\": \"语气风格描述，10-20字，如：嘴硬傲娇，短句换行，先吐槽再给结论\",\n  \"preferred_styles\": [\"家居风格1\", \"家居风格2\"],\n  \"preferred_scenes\": [\"场景1\", \"场景2\", \"场景3\"],\n  \"hashtag_pool\": [\"标签1\", \"标签2\", \"标签3\", \"标签4\", \"标签5\", \"标签6\", \"标签7\", \"标签8\"],\n  \"posting_rhythm\": \"发帖节奏推断，如：每周2-3篇\",\n  \"taboos\": [\"不适合这个账号的词汇或风格1\", \"不适合的2\"],\n  \"analysis_summary\": \"账号整体特点总结，50字以内\"\n}}\n\nhashtag_pool 只返回标签文字，不含 # 号。taboos 是与账号气质不符、不应在文案中出现的词。只返回 JSON，不要其他说明。",
        lines.join("\n"),
        stats.get("note_count").unwrap_or(&Value::Null),
        stats.get("avg_likes").unwrap_or(&Value::Null),
        stats.get("avg_comments").unwrap_or(&Value::Null),
        stats.get("avg_collects").unwrap_or(&Value::Null),
    );
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err("人设分析输入超过安全长度限制".into());
    }
    let text = super::text_api::complete_compatible_chat(
        provider,
        model,
        "",
        &[json!({"role":"user","content":prompt})],
        1_500,
    )
    .await?;
    parse_profile_inference(&text)
}

#[cfg(test)]
mod tests {
    use super::parse_profile_inference;
    use serde_json::json;

    #[test]
    fn parses_fenced_inference_and_discards_unknown_fields() {
        let parsed = parse_profile_inference(
            "```json\n{\"niche\":\"出租屋改造\",\"content_pillars\":[\"改造\",\"改造\"],\"extra\":\"ignored\"}\n```",
        )
        .unwrap();
        assert_eq!(parsed["niche"], "出租屋改造");
        assert_eq!(parsed["content_pillars"], json!(["改造"]));
        assert!(parsed.get("extra").is_none());
    }

    #[test]
    fn rejects_non_json_and_bounds_model_output() {
        assert!(parse_profile_inference("I think the account is about home decor").is_err());
        let parsed = parse_profile_inference(&format!(
            "{{\"persona_tone\":\"{}\",\"taboos\":[\"bad\"]}}",
            "语气".repeat(200)
        ))
        .unwrap();
        assert_eq!(
            parsed["persona_tone"].as_str().unwrap().chars().count(),
            300
        );
        assert_eq!(parsed["taboos"], json!(["bad"]));
    }
}
