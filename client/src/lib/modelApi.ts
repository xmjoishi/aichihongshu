import { invoke } from "@tauri-apps/api/core";

export type ModelApiProviderKind = "openai-compatible" | "anthropic-compatible";

export interface ModelApiProviderView {
  id: string;
  kind: ModelApiProviderKind;
  label: string;
  endpoint: string;
  configured: boolean;
  apiKeyMasked: string;
  model: string;
  visionModel: string;
  enabledModels: string[];
  builtin: boolean;
  preset: string | null;
}

export interface ModelApiSettingsView {
  providers: ModelApiProviderView[];
  defaultProviderId: string;
  defaultModel: string;
}

export interface ModelApiProviderInput {
  id?: string | null;
  kind: ModelApiProviderKind;
  label: string;
  endpoint: string;
  /** null = 不修改既有密钥 */
  apiKey?: string | null;
  model: string;
  visionModel?: string | null;
  enabledModels: string[];
}

export function readModelApiSettings(): Promise<ModelApiSettingsView> {
  return invoke("read_model_api_settings");
}

export function upsertModelApiProvider(input: ModelApiProviderInput): Promise<ModelApiSettingsView> {
  return invoke("upsert_model_api_provider", { input });
}

export function deleteModelApiProvider(providerId: string): Promise<ModelApiSettingsView> {
  return invoke("delete_model_api_provider", { providerId });
}

export function setModelApiDefaultTarget(providerId: string, model: string): Promise<ModelApiSettingsView> {
  return invoke("set_model_api_default_target", { input: { providerId, model } });
}

export function testModelApiProvider(providerId: string): Promise<string> {
  return invoke("test_model_api_provider", { providerId });
}

export function startModelApiRun(request: {
  runId: string;
  providerId: string;
  model?: string | null;
  prompt: string;
}): Promise<void> {
  return invoke("start_model_api_run", { request });
}

export function cancelModelApiRun(runId: string): Promise<void> {
  return invoke("cancel_model_api_run", { runId });
}
