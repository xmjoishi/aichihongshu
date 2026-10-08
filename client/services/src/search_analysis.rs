use serde::Serialize;
use serde_json::{Map, Value};

const HOOKS: &[&str] = &[
    "为什么",
    "我发现",
    "别再",
    "不要",
    "到底",
    "真的",
    "！",
    "？",
    "被",
    "惊",
    "太",
    "超",
    "千万",
    "必看",
    "分享",
    "攻略",
    "踩坑",
    "避坑",
    "好物",
    "种草",
    "测评",
    "合集",
    "干货",
    "教程",
    "改造",
    "装修",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchAnalysis {
    pub total: usize,
    pub avg_likes: i64,
    pub avg_comments: i64,
    pub avg_collects: i64,
    pub top_hooks: Vec<(String, usize)>,
    pub top_items: Vec<Value>,
}

impl SearchAnalysis {
    /// Match the JSON file written by the retired Python analyzer.
    pub fn legacy_report(&self) -> Result<Value, serde_json::Error> {
        let mut report = serde_json::to_value(self)?;
        if let Some(items) = report.get_mut("top_items").and_then(Value::as_array_mut) {
            for item in items {
                if let Some(fields) = item.as_object_mut() {
                    fields.retain(|key, _| {
                        !key.starts_with('_')
                            || matches!(
                                key.as_str(),
                                "_title" | "_likes" | "_comments" | "_collects" | "_score"
                            )
                    });
                }
            }
        }
        Ok(report)
    }
}

pub fn parse_count(value: Option<&Value>) -> i64 {
    let Some(value) = value else {
        return 0;
    };
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value.trunc() as i64))
            .unwrap_or_default(),
        Value::String(value) => {
            let value = value.replace(',', "");
            let value = value.trim();
            if let Some(number) = value.strip_suffix('万') {
                number
                    .trim()
                    .parse::<f64>()
                    .map(|number| (number * 10_000.0).trunc() as i64)
                    .unwrap_or_default()
            } else {
                value
                    .parse::<f64>()
                    .map(|number| number.trunc() as i64)
                    .unwrap_or_default()
            }
        }
        _ => 0,
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        _ => true,
    }
}

fn selected_metric<'a>(item: &'a Value, primary: &str, fallback: &str) -> Option<&'a Value> {
    let primary = item.get(primary);
    if truthy(primary) {
        primary
    } else {
        item.get(fallback)
    }
}

fn item_title(item: &Value) -> String {
    item.get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .or_else(|| item.get("desc").and_then(Value::as_str))
        .unwrap_or_default()
        .chars()
        .take(60)
        .collect()
}

pub fn analyze(items: &[Value]) -> Result<SearchAnalysis, String> {
    let mut enriched = Vec::with_capacity(items.len());
    let mut likes_sum = 0_i128;
    let mut comments_sum = 0_i128;
    let mut collects_sum = 0_i128;
    let mut hooks = Vec::<(String, usize)>::new();

    for item in items {
        let Some(object) = item.as_object() else {
            return Err("采集数据必须是 JSON 对象数组".into());
        };
        let likes = parse_count(selected_metric(item, "liked_count", "likes"));
        let comments = parse_count(selected_metric(item, "comment_count", "comments"));
        let collects = parse_count(selected_metric(item, "collected_count", "collects"));
        let score = likes
            .saturating_add(comments.saturating_mul(3))
            .saturating_add(collects.saturating_mul(2));
        likes_sum += i128::from(likes);
        comments_sum += i128::from(comments);
        collects_sum += i128::from(collects);

        let title = item_title(item);
        for hook in HOOKS {
            if title.contains(hook) {
                if let Some((_, count)) = hooks.iter_mut().find(|(word, _)| word == hook) {
                    *count += 1;
                } else {
                    hooks.push(((*hook).to_string(), 1));
                }
            }
        }

        let mut enriched_item: Map<String, Value> = object.clone();
        enriched_item.insert("_likes".into(), Value::from(likes));
        enriched_item.insert("_comments".into(), Value::from(comments));
        enriched_item.insert("_collects".into(), Value::from(collects));
        enriched_item.insert("_score".into(), Value::from(score));
        enriched_item.insert("_title".into(), Value::String(title));
        enriched.push((score, Value::Object(enriched_item)));
    }

    let average = |sum: i128| -> i64 {
        if items.is_empty() {
            0
        } else {
            ((sum as f64) / (items.len() as f64))
                .round_ties_even()
                .clamp(i64::MIN as f64, i64::MAX as f64) as i64
        }
    };
    hooks.sort_by(|left, right| right.1.cmp(&left.1));
    hooks.truncate(8);
    enriched.sort_by(|left, right| right.0.cmp(&left.0));
    let top_items = enriched
        .into_iter()
        .take(10)
        .map(|(_, item)| item)
        .collect();

    Ok(SearchAnalysis {
        total: items.len(),
        avg_likes: average(likes_sum),
        avg_comments: average(comments_sum),
        avg_collects: average(collects_sum),
        top_hooks: hooks,
        top_items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_chinese_counts_and_falls_back_to_legacy_metric_fields() {
        assert_eq!(parse_count(Some(&json!("1.23万"))), 12_300);
        assert_eq!(parse_count(Some(&json!("12,345"))), 12_345);
        assert_eq!(parse_count(Some(&json!("unknown"))), 0);
        assert_eq!(parse_count(Some(&json!(12.9))), 12);

        let result = analyze(&[
            json!({"title":"家居改造攻略","liked_count":0,"likes":"2万","comments":"7"}),
            json!({"desc":"别再踩坑！","liked_count":"1,000","comment_count":"1万","collects":10}),
        ])
        .unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.avg_likes, 10_500);
        assert_eq!(result.avg_comments, 5_004);
        assert_eq!(result.top_items[0]["_title"], "别再踩坑！");
        assert_eq!(result.top_items[0]["_score"], 31_020);
        assert_eq!(result.top_hooks[0], ("攻略".to_string(), 1));
        assert_eq!(result.top_hooks[1], ("改造".to_string(), 1));
        assert_eq!(result.top_hooks[2], ("别再".to_string(), 1));
    }

    #[test]
    fn keeps_input_order_for_equal_scores_and_rejects_non_object_rows() {
        let result = analyze(&[
            json!({"title":"first","liked_count":100}),
            json!({"title":"second","liked_count":100}),
        ])
        .unwrap();
        assert_eq!(result.top_items[0]["title"], "first");
        assert_eq!(result.top_items[1]["title"], "second");
        assert!(analyze(&[json!("bad row")]).is_err());
    }

    #[test]
    fn matches_legacy_python_saved_report_fixture() {
        let input: Vec<Value> = serde_json::from_str(include_str!(
            "../tests/fixtures/xhs_analyze_legacy_input.json"
        ))
        .unwrap();
        let expected: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/xhs_analyze_legacy_report.json"
        ))
        .unwrap();
        let report = analyze(&input).unwrap().legacy_report().unwrap();
        assert_eq!(report, expected);
        assert!(report["top_items"][0].get("_legacy_internal").is_none());
        assert!(report["top_items"][1].get("_private").is_none());
    }
}
