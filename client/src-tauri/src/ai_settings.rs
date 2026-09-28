//! AI 运行时设置：新会话默认目标与本地 CLI 配置（应用级，即时保存）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::db::LocalDb;

pub const AI_RUNTIME_SETTINGS_KEY: &str = "ai_runtime_settings_v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiDefaultTargetKind {
    ModelApi,
    AgentCli,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDefaultTarget {
    pub kind: AiDefaultTargetKind,
    pub provider: String,
    pub model: String,
}

/// 扫描得到的 CLI 模型缓存项；持久化后下次进入无需重扫。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliModelCacheEntry {
    pub value: String,
    pub label: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentCliSettings {
    pub enabled: bool,
    /// claude | codex | opencode；空表示自动选择。
    pub provider: String,
    pub working_directory: String,
    /// 按 CLI 隔离的启用模型清单：key 为 claude/codex/opencode。
    #[serde(default)]
    pub enabled_models: HashMap<String, Vec<String>>,
    /// 按 CLI 隔离的扫描结果缓存；只有点「刷新模型」才会更新。
    #[serde(default)]
    pub model_pool: HashMap<String, Vec<CliModelCacheEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRuntimeSettings {
    pub default_target: AiDefaultTarget,
    pub agent_cli: AiAgentCliSettings,
}

fn default_settings() -> AiRuntimeSettings {
    AiRuntimeSettings {
        default_target: AiDefaultTarget {
            kind: AiDefaultTargetKind::AgentCli,
            provider: String::new(),
            model: String::new(),
        },
        agent_cli: AiAgentCliSettings {
            enabled: true,
            provider: String::new(),
            working_directory: String::new(),
            enabled_models: HashMap::new(),
            model_pool: HashMap::new(),
        },
    }
}

fn normalize(raw: AiRuntimeSettings) -> AiRuntimeSettings {
    let mut settings = raw;
    settings.default_target.provider = settings.default_target.provider.trim().to_string();
    settings.default_target.model = settings.default_target.model.trim().to_string();
    settings.agent_cli.provider = settings.agent_cli.provider.trim().to_string();
    settings.agent_cli.working_directory = settings.agent_cli.working_directory.trim().to_string();
    let mut normalized_models: HashMap<String, Vec<String>> = HashMap::new();
    for (cli, models) in settings.agent_cli.enabled_models {
        let key = cli.trim().to_string();
        if key.is_empty() {
            continue;
        }
        let list: Vec<String> = models
            .into_iter()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect();
        normalized_models.insert(key, list);
    }
    settings.agent_cli.enabled_models = normalized_models;
    let mut normalized_pool: HashMap<String, Vec<CliModelCacheEntry>> = HashMap::new();
    for (cli, entries) in settings.agent_cli.model_pool {
        let key = cli.trim().to_string();
        if key.is_empty() {
            continue;
        }
        let list: Vec<CliModelCacheEntry> = entries
            .into_iter()
            .filter(|item| !item.value.trim().is_empty())
            .map(|item| CliModelCacheEntry {
                value: item.value.trim().to_string(),
                label: item.label.trim().to_string(),
                source: item.source.trim().to_string(),
            })
            .collect();
        normalized_pool.insert(key, list);
    }
    settings.agent_cli.model_pool = normalized_pool;
    match settings.default_target.kind {
        AiDefaultTargetKind::AgentCli => {
            if settings.default_target.provider.is_empty() {
                settings.default_target.model = String::new();
            }
        }
        AiDefaultTargetKind::ModelApi => {
            if settings.default_target.provider.is_empty() {
                settings.default_target.model = String::new();
            }
        }
    }
    settings
}

/// 旧版 `enabledModels` 是数组（三个 CLI 共用）；迁移到按 CLI 分桶，避免模型串到别的 CLI。
fn migrate_legacy_enabled_models(value: &mut serde_json::Value) {
    let fallback_cli = value
        .get("agentCli")
        .and_then(|v| v.get("provider"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("claude")
        .to_string();
    let Some(agent_cli) = value.get_mut("agentCli").and_then(|v| v.as_object_mut()) else {
        return;
    };
    let Some(enabled) = agent_cli.get("enabledModels").cloned() else {
        return;
    };
    if enabled.is_object() {
        return;
    }
    let list: Vec<String> = enabled
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let mut map = serde_json::Map::new();
    map.insert(fallback_cli, serde_json::Value::from(list));
    agent_cli.insert("enabledModels".to_string(), serde_json::Value::Object(map));
}

pub fn read_settings(db: &LocalDb) -> Result<AiRuntimeSettings, String> {
    let raw = db.get_app_setting(AI_RUNTIME_SETTINGS_KEY)?;
    let parsed = match raw {
        Some(value) => {
            let mut json: serde_json::Value = serde_json::from_str(&value)
                .map_err(|error| format!("解析 AI 运行时配置失败: {error}"))?;
            migrate_legacy_enabled_models(&mut json);
            serde_json::from_value::<AiRuntimeSettings>(json)
                .map_err(|error| format!("解析 AI 运行时配置失败: {error}"))?
        }
        None => default_settings(),
    };
    Ok(normalize(parsed))
}

pub fn save_settings(
    db: &LocalDb,
    settings: AiRuntimeSettings,
) -> Result<AiRuntimeSettings, String> {
    let normalized = normalize(settings);
    let value = serde_json::to_string(&normalized)
        .map_err(|error| format!("序列化 AI 运行时配置失败: {error}"))?;
    db.set_app_setting(AI_RUNTIME_SETTINGS_KEY, &value)?;
    Ok(normalized)
}
