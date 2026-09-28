/**
 * Shared AI host contracts.
 *
 * A host is only a presentation surface. Conversations, runs and context are
 * owned by the AI session and can therefore move between the floating panel,
 * sidebar and full page without starting a second request.
 */
export type AIHostMode = "floating" | "sidebar" | "page";
export type AIConnectionKind = "model-api" | "agent-cli";

export const GLOBAL_AI_EVENT = "aichihongshu:open-global-ai";
export const PAGE_AI_SIDEBAR_EVENT = "aichihongshu:page-ai-sidebar-visibility";
const openPageAISidebarSources = new Set<string>();

export function openGlobalAIHost(options?: { sessionKey?: string; historyKey?: string }): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GLOBAL_AI_EVENT, { detail: options }));
}

export function publishPageAISidebarVisibility(source: string, open: boolean): void {
  if (typeof window === "undefined") return;
  if (open) openPageAISidebarSources.add(source);
  else openPageAISidebarSources.delete(source);
  window.dispatchEvent(new CustomEvent(PAGE_AI_SIDEBAR_EVENT, { detail: { source, open } }));
}

export function getOpenPageAISidebarSources(): string[] {
  return [...openPageAISidebarSources];
}

export interface AIContextRef {
  accountId: number | null;
  noteId?: number;
  itemId?: number;
  route?: string;
  title?: string;
  /** IDs of objects explicitly attached to this conversation. */
  references?: string[];
}

export interface AIHostState {
  mode: AIHostMode;
  context: AIContextRef;
  sessionKey: string;
}

export interface AIModelApiConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  visionModel: string;
  apiKey: string;
}

export interface AIAgentCliConfig {
  enabled: boolean;
  provider: "claude" | "codex" | "opencode" | "";
  workingDirectory: string;
}

export interface AISettings {
  version: 1;
  defaultConnection: AIConnectionKind;
  defaultHostMode: AIHostMode;
  modelApi: AIModelApiConfig;
  agentCli: AIAgentCliConfig;
}

const SETTINGS_VERSION = "v1";
const DEFAULT_SETTINGS: AISettings = {
  version: 1,
  defaultConnection: "agent-cli",
  defaultHostMode: "sidebar",
  modelApi: { enabled: false, baseUrl: "", model: "", visionModel: "", apiKey: "" },
  agentCli: { enabled: true, provider: "", workingDirectory: "" },
};

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

function settingsKey(scopeKey: string): string {
  return `aichihongshu.ai-settings.${SETTINGS_VERSION}.${encodeURIComponent(scopeKey)}`;
}

function validMode(value: unknown): value is AIHostMode {
  return value === "floating" || value === "sidebar" || value === "page";
}

function validConnection(value: unknown): value is AIConnectionKind {
  return value === "model-api" || value === "agent-cli";
}

export function readAISettings(scopeKey: string): AISettings {
  try {
    const raw = storage()?.getItem(settingsKey(scopeKey));
    const parsed = raw ? JSON.parse(raw) as Partial<AISettings> : {};
    const modelApi = parsed.modelApi ?? {};
    const agentCli = parsed.agentCli ?? {};
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      version: 1,
      defaultConnection: validConnection(parsed.defaultConnection) ? parsed.defaultConnection : DEFAULT_SETTINGS.defaultConnection,
      defaultHostMode: validMode(parsed.defaultHostMode) ? parsed.defaultHostMode : DEFAULT_SETTINGS.defaultHostMode,
      modelApi: {
        ...DEFAULT_SETTINGS.modelApi,
        ...(typeof modelApi === "object" ? modelApi : {}),
        enabled: Boolean((modelApi as Partial<AIModelApiConfig>).enabled),
      },
      agentCli: {
        ...DEFAULT_SETTINGS.agentCli,
        ...(typeof agentCli === "object" ? agentCli : {}),
        enabled: (agentCli as Partial<AIAgentCliConfig>).enabled !== false,
      },
    };
  } catch {
    return { ...DEFAULT_SETTINGS, modelApi: { ...DEFAULT_SETTINGS.modelApi }, agentCli: { ...DEFAULT_SETTINGS.agentCli } };
  }
}

export function saveAISettings(scopeKey: string, settings: AISettings): void {
  try {
    storage()?.setItem(settingsKey(scopeKey), JSON.stringify({ ...settings, version: 1 }));
  } catch {
    // Restricted WebViews may deny local storage. The current form remains usable.
  }
}

export function defaultAISettings(): AISettings {
  return { ...DEFAULT_SETTINGS, modelApi: { ...DEFAULT_SETTINGS.modelApi }, agentCli: { ...DEFAULT_SETTINGS.agentCli } };
}

export function makeAISessionKey(context: AIContextRef, fallback = "workspace"): string {
  const account = context.accountId == null ? "unresolved" : String(context.accountId);
  const object = context.noteId != null ? `note-${context.noteId}` : context.itemId != null ? `item-${context.itemId}` : fallback;
  return `account-${account}:${object}`;
}

export const AI_HOST_MODES: ReadonlyArray<{ id: AIHostMode; label: string; description: string }> = [
  { id: "floating", label: "浮窗", description: "悬浮在当前工作区" },
  { id: "sidebar", label: "侧栏", description: "与当前页面并排" },
  { id: "page", label: "独立页", description: "完整助手工作区" },
];
