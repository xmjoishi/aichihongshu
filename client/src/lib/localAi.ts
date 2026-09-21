import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type LocalAIProviderState = "present" | "missing" | "failed";
export type LocalAIProviderId = "claude" | "codex" | "opencode";
const LOCAL_AI_PROVIDER_PREFERENCE_VERSION = "v1";
const LOCAL_AI_PROVIDER_EVIDENCE_VERSION = "v1";

export interface LocalAIProviderStatus {
  id: LocalAIProviderId;
  label: string;
  kind: "cli";
  state: LocalAIProviderState;
  version?: string;
  /** 只有真实调用成功后，前端才会把文本能力标记为 verified。 */
  text: boolean;
  image: boolean;
  tools: boolean;
  cancel: boolean;
  reason: string;
}

interface LocalAIEvent {
  runId: string;
  text?: string;
  error?: string;
}

export function probeLocalAIProviders(): Promise<LocalAIProviderStatus[]> {
  return invoke<LocalAIProviderStatus[]>("probe_local_ai_providers");
}

function providerPreferenceKey(scopeKey: string): string {
  return `aichihongshu.local-ai-provider.${LOCAL_AI_PROVIDER_PREFERENCE_VERSION}.${encodeURIComponent(scopeKey)}`;
}

function providerEvidenceKey(scopeKey: string): string {
  return `aichihongshu.local-ai-provider-evidence.${LOCAL_AI_PROVIDER_EVIDENCE_VERSION}.${encodeURIComponent(scopeKey)}`;
}

/** Provider choice is a non-sensitive UI preference, isolated by database and account scope. */
export function readPreferredLocalAIProvider(scopeKey: string): LocalAIProviderId | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(providerPreferenceKey(scopeKey));
    return value === "claude" || value === "codex" || value === "opencode" ? value : null;
  } catch {
    return null;
  }
}

export function savePreferredLocalAIProvider(scopeKey: string, provider: LocalAIProviderId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(providerPreferenceKey(scopeKey), provider);
  } catch {
    // Restricted WebViews may deny storage; the current panel selection still works.
  }
}

/** Read only successful text-call evidence; installation alone never populates this list. */
export function readVerifiedLocalAIProviders(scopeKey: string): LocalAIProviderId[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(providerEvidenceKey(scopeKey));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is LocalAIProviderId => value === "claude" || value === "codex" || value === "opencode");
  } catch {
    return [];
  }
}

export function markLocalAITextVerified(scopeKey: string, provider: LocalAIProviderId): void {
  if (typeof window === "undefined") return;
  try {
    const providers = new Set(readVerifiedLocalAIProviders(scopeKey));
    providers.add(provider);
    window.localStorage.setItem(providerEvidenceKey(scopeKey), JSON.stringify([...providers]));
  } catch {
    // Evidence is an enhancement; a restricted WebView must not fail the run.
  }
}

/**
 * 启动一次本地 CLI 文本调用。
 *
 * 事件监听先于 invoke 注册，避免极快 CLI 输出在前端订阅前丢失。
 * AbortController 会请求 Rust kill 子进程；如果进程已结束，取消是幂等的。
 */
export function streamLocalAI(
  runId: string,
  provider: LocalAIProviderStatus["id"],
  prompt: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (error: Error) => void,
): AbortController {
  const controller = new AbortController();
  let listeners: UnlistenFn[] = [];
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    listeners.forEach((unlisten) => unlisten());
    listeners = [];
  };

  controller.signal.addEventListener("abort", () => {
    cleanup();
    void invoke("cancel_local_ai", { runId }).catch(() => {
      // 取消是幂等动作；进程可能已自然退出。
    });
  }, { once: true });

  void (async () => {
    try {
      const [chunkOff, doneOff, errorOff] = await Promise.all([
        listen<LocalAIEvent>("local-ai://chunk", (event) => {
          if (event.payload.runId === runId && event.payload.text) onChunk(event.payload.text);
        }),
        listen<LocalAIEvent>("local-ai://done", (event) => {
          if (event.payload.runId !== runId || cleaned) return;
          cleanup();
          onDone();
        }),
        listen<LocalAIEvent>("local-ai://error", (event) => {
          if (event.payload.runId !== runId || cleaned) return;
          cleanup();
          onError(new Error(event.payload.error || "本地 AI CLI 调用失败"));
        }),
      ]);
      listeners = [chunkOff, doneOff, errorOff];
      if (controller.signal.aborted) {
        cleanup();
        return;
      }
      await invoke("start_local_ai", { request: { runId, provider, prompt } });
    } catch (error) {
      cleanup();
      if (!controller.signal.aborted) onError(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return controller;
}
