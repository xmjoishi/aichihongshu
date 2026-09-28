//! 本地 CLI 模型发现：预置清单 + 按 CLI 实际能力扫描（对齐 Noomd）。

use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCliModel {
    pub value: String,
    pub label: String,
    /// default | discovered | configured | manual
    pub source: String,
}

fn default_models(provider: &str) -> Vec<LocalCliModel> {
    let options: Vec<(&str, &str)> = match provider {
        "claude" => vec![
            ("default", "默认模型"),
            ("sonnet", "Sonnet"),
            ("opus", "Opus"),
            ("haiku", "Haiku"),
        ],
        "codex" | "opencode" => vec![("default", "默认模型")],
        _ => Vec::new(),
    };
    options
        .into_iter()
        .map(|(value, label)| LocalCliModel {
            value: value.to_string(),
            label: label.to_string(),
            source: "default".to_string(),
        })
        .collect()
}

fn parse_configured_codex_model() -> Option<String> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let body = std::fs::read_to_string(home.join(".codex").join("config.toml")).ok()?;
    body.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.starts_with("model") || !trimmed.contains('=') {
            return None;
        }
        let value = trimmed
            .split_once('=')?
            .1
            .trim()
            .trim_matches('"')
            .trim_matches('\'');
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn strip_terminal_ansi(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_escape = false;
    for ch in value.chars() {
        if ch == '\u{1b}' {
            in_escape = true;
        } else if in_escape {
            if ch.is_ascii_alphabetic() {
                in_escape = false;
            }
        } else {
            output.push(ch);
        }
    }
    output
}

fn parse_opencode_models(output: &str) -> Vec<LocalCliModel> {
    let mut seen = std::collections::HashSet::new();
    output
        .lines()
        .filter_map(|line| {
            let clean = strip_terminal_ansi(line).trim().to_string();
            let candidate = clean
                .split_whitespace()
                .find(|token| token.contains('/') && !token.starts_with("http"))?
                .trim_matches(|ch: char| "|,[]()".contains(ch))
                .to_string();
            if candidate.split('/').count() < 2 || !seen.insert(candidate.clone()) {
                return None;
            }
            Some(LocalCliModel {
                value: candidate.clone(),
                label: candidate,
                source: "discovered".to_string(),
            })
        })
        .collect()
}

/// 扫描指定 CLI 的可用模型：预置清单在前，发现/配置项追加去重。
pub fn list_local_cli_models(provider: &str) -> Result<Vec<LocalCliModel>, String> {
    let mut models = default_models(provider);
    match provider {
        "codex" => {
            if let Some(model) = parse_configured_codex_model() {
                if !models.iter().any(|item| item.value == model) {
                    models.push(LocalCliModel {
                        label: model.clone(),
                        value: model,
                        source: "configured".to_string(),
                    });
                }
            }
        }
        "opencode" => {
            let mut child = Command::new("opencode")
                .args(["models", "--refresh"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| format!("OpenCode 模型扫描失败：{error}"))?;
            // Drain both pipes while waiting so a large model list cannot fill a pipe.
            let mut stdout = child.stdout.take().ok_or("无法读取模型扫描输出")?;
            let mut stderr = child.stderr.take().ok_or("无法读取模型扫描错误")?;
            let out = std::thread::spawn(move || {
                let mut bytes = Vec::new();
                stdout.read_to_end(&mut bytes).map(|_| bytes)
            });
            let err = std::thread::spawn(move || {
                let mut bytes = Vec::new();
                stderr.read_to_end(&mut bytes).map(|_| bytes)
            });
            let deadline = Instant::now() + Duration::from_secs(30);
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break status,
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(50))
                    }
                    result => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(match result {
                            Err(error) => format!("等待 OpenCode 模型扫描失败：{error}"),
                            _ => "OpenCode 模型扫描超时（30 秒），请检查 CLI 后重试".to_string(),
                        });
                    }
                }
            };
            let stdout = out
                .join()
                .map_err(|_| "模型输出读取任务失败")?
                .map_err(|e| e.to_string())?;
            let stderr = err
                .join()
                .map_err(|_| "模型错误读取任务失败")?
                .map_err(|e| e.to_string())?;
            let text = String::from_utf8_lossy(if stdout.is_empty() { &stderr } else { &stdout })
                .to_string();
            let discovered = parse_opencode_models(&text);
            if discovered.is_empty() && !status.success() {
                let summary: String = text.trim().chars().take(240).collect();
                return Err(format!("OpenCode 模型扫描失败：{summary}"));
            }
            for item in discovered {
                if !models.iter().any(|existing| existing.value == item.value) {
                    models.push(item);
                }
            }
        }
        "claude" => {}
        _ => return Err("不支持的本地 CLI Provider".to_string()),
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_claude_models_match_noomd() {
        let models = default_models("claude");
        assert_eq!(models.len(), 4);
        assert_eq!(models[0].value, "default");
    }

    #[test]
    fn parses_opencode_models_from_plain_output() {
        let scanned = parse_opencode_models("openai/gpt-4o\nanthropic/claude-sonnet-4-5\n");
        assert_eq!(scanned.len(), 2);
        assert!(scanned.iter().all(|item| item.source == "discovered"));
    }
}
