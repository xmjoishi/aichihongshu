import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startLocalAIStream, type LocalAIStreamEvent } from "./localAiStream";

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

export interface ProbeLocalAIProvidersOptions {
  /** Bypass the short-lived process cache, used by an explicit refresh button. */
  force?: boolean;
  /** Cache duration in milliseconds. Defaults to 30 seconds. */
  ttlMs?: number;
}

const DEFAULT_PROBE_CACHE_TTL_MS = 30_000;
let providerProbeCache: { providers: LocalAIProviderStatus[]; expiresAt: number } | null = null;
let providerProbeInFlight: Promise<LocalAIProviderStatus[]> | null = null;

export function invalidateLocalAIProviderProbeCache(): void {
  providerProbeCache = null;
}

/**
 * Probe all supported local CLIs once per short cache window. The Rust command
 * already returns the complete matrix; callers must not probe each provider
 * separately. Concurrent callers share the same in-flight request as well.
 */
function loadLocalAIProviders(options: ProbeLocalAIProvidersOptions = {}): Promise<LocalAIProviderStatus[]> {
  const now = Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_PROBE_CACHE_TTL_MS;
  if (!options.force && providerProbeCache && providerProbeCache.expiresAt > now) {
    return Promise.resolve(providerProbeCache.providers);
  }
  if (providerProbeInFlight) return providerProbeInFlight;
  if (options.force) providerProbeCache = null;
  const request = invoke<LocalAIProviderStatus[]>("probe_local_ai_providers")
    .then((providers) => {
      providerProbeCache = { providers, expiresAt: Date.now() + ttlMs };
      return providers;
    })
    .finally(() => {
      providerProbeInFlight = null;
    });
  providerProbeInFlight = request;
  return request;
}

/** Cached probe entry point; kept argument-free so it can be used directly as a queryFn. */
export function probeLocalAIProviders(): Promise<LocalAIProviderStatus[]> {
  return loadLocalAIProviders();
}

/** Explicit refresh entry point for settings and the AI panel refresh action. */
export function refreshLocalAIProviders(): Promise<LocalAIProviderStatus[]> {
  return loadLocalAIProviders({ force: true });
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

/** Start a local CLI call; the listener lifecycle is shared with Model API streams. */
export function streamLocalAI(
  runId: string,
  provider: LocalAIProviderStatus["id"],
  prompt: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (error: Error) => void,
): AbortController {
  return startLocalAIStream({
    runId,
    startRun: () => invoke("start_local_ai", { request: { runId, provider, prompt } }),
    cancelCommand: "cancel_local_ai",
    listen: (eventName, callback) => listen<LocalAIStreamEvent>(eventName, callback),
    invoke: (command, args) => invoke(command, args),
    onChunk,
    onDone,
    onError,
    fallbackError: "本地 AI CLI 调用失败",
  });
}

/** Start a Model API stream using the same event contract and cancellation lifecycle. */
export function streamModelApi(
  runId: string,
  providerId: string,
  model: string | null | undefined,
  prompt: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (error: Error) => void,
): AbortController {
  return startLocalAIStream({
    runId,
    startRun: () => invoke("start_model_api_run", {
      request: { runId, providerId, model: model ?? null, prompt },
    }),
    cancelCommand: "cancel_model_api_run",
    listen: (eventName, callback) => listen<LocalAIStreamEvent>(eventName, callback),
    invoke: (command, args) => invoke(command, args),
    onChunk,
    onDone,
    onError,
    fallbackError: "Model API 调用失败",
  });
}
