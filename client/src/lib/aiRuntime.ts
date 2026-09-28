import { invoke } from "@tauri-apps/api/core";

export type AiDefaultTargetKind = "model-api" | "agent-cli";

export interface AiDefaultTarget {
  kind: AiDefaultTargetKind;
  provider: string;
  model: string;
}

export interface CliModelCacheEntry {
  value: string;
  label: string;
  source: string;
}

export interface AiAgentCliSettings {
  enabled: boolean;
  provider: string;
  workingDirectory: string;
  /** 按 CLI 隔离：claude/codex/opencode -> 启用模型清单 */
  enabledModels: Record<string, string[]>;
  /** 按 CLI 隔离的扫描结果缓存；点「刷新模型」才更新 */
  modelPool: Record<string, CliModelCacheEntry[]>;
}

export interface AiRuntimeSettings {
  defaultTarget: AiDefaultTarget;
  agentCli: AiAgentCliSettings;
}

export function readAiRuntimeSettings(): Promise<AiRuntimeSettings> {
  return invoke("read_ai_runtime_settings");
}

export function saveAiRuntimeSettings(settings: AiRuntimeSettings): Promise<AiRuntimeSettings> {
  return invoke("save_ai_runtime_settings", { settings });
}

export function listModelApiModels(providerId: string): Promise<string[]> {
  return invoke("list_model_api_models", { providerId });
}

export interface LocalCliModel {
  value: string;
  label: string;
  source: "default" | "discovered" | "configured" | "manual";
}

export function listLocalCliModels(provider: string): Promise<LocalCliModel[]> {
  return invoke("list_local_cli_models", { provider });
}
