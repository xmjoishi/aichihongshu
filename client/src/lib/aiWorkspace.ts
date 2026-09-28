/**
 * Lightweight metadata for the Agent workspace list.
 *
 * Conversation messages and AI runs have their own persistence. This module
 * stores only the account-scoped list metadata needed by a sidebar or the
 * independent assistant page, so it remains safe to reorder or migrate later.
 * A newly opened session is temporary until its first valid message promotes
 * it into this list.
 */
export interface AgentSessionMetadata {
  id: string;
  title: string;
  accountId: number | null;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  lastMessagePreview: string;
}

export interface CreateAgentSessionInput {
  id?: string;
  title?: string;
  lastMessagePreview?: string;
  pinned?: boolean;
  createdAt?: string;
  /** New sessions are temporary until their first valid message by default. */
  persist?: boolean;
}

const STORAGE_VERSION = "v1";
const LAST_SESSION_VERSION = "v1";
const MAX_TITLE_LENGTH = 120;
const MAX_PREVIEW_LENGTH = 240;
export const AGENT_SESSIONS_CHANGED_EVENT = "aichihongshu:agent-sessions-changed";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

function accountKey(accountId: number | null): string {
  return accountId == null ? "unresolved" : String(accountId);
}

function sessionsKey(accountId: number | null): string {
  return `aichihongshu.agent-sessions.${STORAGE_VERSION}.account-${encodeURIComponent(accountKey(accountId))}`;
}

function lastSessionKey(accountId: number | null): string {
  return `aichihongshu.agent-last-session.${LAST_SESSION_VERSION}.account-${encodeURIComponent(accountKey(accountId))}`;
}

/** The workspace tab resumes its last session; explicit new-session controls create another one. */
export function readLastAgentSession(accountId: number | null): string | null {
  try {
    const id = window.sessionStorage.getItem(lastSessionKey(accountId));
    return id && id.length <= 180 ? id : null;
  } catch {
    return null;
  }
}

export function rememberLastAgentSession(accountId: number | null, id: string): void {
  if (!id || id.length > 180) return;
  try {
    window.sessionStorage.setItem(lastSessionKey(accountId), id);
  } catch {
    // Current route state remains authoritative when session storage is unavailable.
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function text(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function normalize(value: unknown, accountId: number | null): AgentSessionMetadata | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<AgentSessionMetadata>;
  if (typeof item.id !== "string" || !item.id) return null;
  const now = new Date().toISOString();
  return {
    id: item.id,
    title: text(item.title, "未命名会话", MAX_TITLE_LENGTH),
    accountId,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
    pinned: item.pinned === true,
    lastMessagePreview: text(item.lastMessagePreview, "", MAX_PREVIEW_LENGTH),
  };
}

function sortSessions(sessions: AgentSessionMetadata[]): AgentSessionMetadata[] {
  return sessions.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function hasMessage(session: AgentSessionMetadata): boolean {
  return session.lastMessagePreview.trim().length > 0;
}

/** Read metadata for exactly one account. A missing/corrupt value is empty. */
export function readAgentSessions(accountId: number | null): AgentSessionMetadata[] {
  try {
    const raw = storage()?.getItem(sessionsKey(accountId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const deduped = new Map<string, AgentSessionMetadata>();
    parsed.forEach((item) => {
      const session = normalize(item, accountId);
      if (session) deduped.set(session.id, session);
    });
    // Older versions persisted an empty row as soon as the workspace opened.
    // Keep those rows out of history and let a first valid message promote the
    // corresponding temporary session instead.
    return sortSessions([...deduped.values()].filter(hasMessage));
  } catch {
    return [];
  }
}

export function writeAgentSessions(accountId: number | null, sessions: AgentSessionMetadata[]): void {
  try {
    const normalized = sessions
      .map((session) => normalize({ ...session, accountId }, accountId))
      .filter((session): session is AgentSessionMetadata => session !== null && hasMessage(session));
    storage()?.setItem(sessionsKey(accountId), JSON.stringify(sortSessions(normalized)));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, { detail: { accountId } }));
    }
  } catch {
    // Restricted WebViews may deny localStorage; callers retain the in-memory result.
  }
}

export function subscribeAgentSessions(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(AGENT_SESSIONS_CHANGED_EVENT, handler);
}

export function createAgentSession(accountId: number | null, input: CreateAgentSessionInput = {}): AgentSessionMetadata {
  const now = new Date().toISOString();
  const session: AgentSessionMetadata = {
    id: input.id || newId(),
    title: text(input.title, "新建会话", MAX_TITLE_LENGTH),
    accountId,
    createdAt: input.createdAt || now,
    updatedAt: now,
    pinned: input.pinned === true,
    lastMessagePreview: text(input.lastMessagePreview, "", MAX_PREVIEW_LENGTH),
  };
  if (input.persist === true && hasMessage(session)) {
    writeAgentSessions(accountId, [session, ...readAgentSessions(accountId)]);
  }
  return session;
}

export function renameAgentSession(accountId: number | null, id: string, title: string): AgentSessionMetadata | null {
  const sessions = readAgentSessions(accountId);
  const current = sessions.find((session) => session.id === id);
  if (!current) return null;
  const updated = { ...current, title: text(title, current.title, MAX_TITLE_LENGTH), updatedAt: new Date().toISOString() };
  writeAgentSessions(accountId, sessions.map((session) => session.id === id ? updated : session));
  return updated;
}

export function setAgentSessionPinned(accountId: number | null, id: string, pinned: boolean): AgentSessionMetadata | null {
  const sessions = readAgentSessions(accountId);
  const current = sessions.find((session) => session.id === id);
  if (!current) return null;
  const updated = { ...current, pinned, updatedAt: new Date().toISOString() };
  writeAgentSessions(accountId, sessions.map((session) => session.id === id ? updated : session));
  return updated;
}

export function pinAgentSession(accountId: number | null, id: string): AgentSessionMetadata | null {
  return setAgentSessionPinned(accountId, id, true);
}

export function unpinAgentSession(accountId: number | null, id: string): AgentSessionMetadata | null {
  return setAgentSessionPinned(accountId, id, false);
}

export function deleteAgentSession(accountId: number | null, id: string): boolean {
  const sessions = readAgentSessions(accountId);
  if (!sessions.some((session) => session.id === id)) return false;
  writeAgentSessions(accountId, sessions.filter((session) => session.id !== id));
  return true;
}

export function touchAgentSession(accountId: number | null, id: string, lastMessagePreview?: string): AgentSessionMetadata | null {
  const sessions = readAgentSessions(accountId);
  const current = sessions.find((session) => session.id === id);
  const preview = lastMessagePreview !== undefined ? text(lastMessagePreview, "", MAX_PREVIEW_LENGTH) : "";

  // A newly opened session exists only in the current route until its first
  // valid message. Promote it here, at the same boundary used by the panel
  // after a user message is accepted.
  if (!current) {
    if (!preview) return null;
    const now = new Date().toISOString();
    const promoted: AgentSessionMetadata = {
      id,
      title: preview.split("\n")[0].slice(0, MAX_TITLE_LENGTH) || "新建会话",
      accountId,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      lastMessagePreview: preview,
    };
    writeAgentSessions(accountId, [promoted, ...sessions]);
    return promoted;
  }

  const nextPreview = lastMessagePreview !== undefined ? preview : current.lastMessagePreview;
  const updated = {
    ...current,
    updatedAt: new Date().toISOString(),
    ...(lastMessagePreview !== undefined ? { lastMessagePreview: nextPreview } : {}),
    ...(current.title === "新建会话" && nextPreview ? { title: nextPreview.split("\n")[0].slice(0, MAX_TITLE_LENGTH) } : {}),
  };
  writeAgentSessions(accountId, sessions.map((session) => session.id === id ? updated : session));
  return updated;
}
