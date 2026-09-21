export type BrowserCaptureTransport = "manual" | "extension";

export interface BrowserCaptureMessage {
  title: string;
  sourceUrl?: string;
  body?: string;
  reason?: string;
  observedAt?: string;
  targetAccountId: number;
  transport: BrowserCaptureTransport;
  requestId?: string;
}

export interface ValidatedBrowserCapture extends BrowserCaptureMessage {
  title: string;
  sourceUrl: string;
  body: string;
  reason: string;
  observedAt: string;
  dedupeKey: string;
}

export type BrowserCaptureValidation =
  | { ok: true; value: ValidatedBrowserCapture }
  | { ok: false; code: "INVALID_MESSAGE" | "ACCOUNT_MISMATCH" | "INVALID_URL" | "TOO_LARGE"; message: string };

/**
 * The browser host is intentionally only a message transport.  It does not
 * get a database handle, a cookie, or a browser profile.  Once a message has
 * passed validation, this small envelope is persisted in the current account
 * WebView until the user acknowledges it and the local Rust command accepts
 * it.  Keeping the envelope here also gives a failed delivery a safe retry
 * path after a page refresh.
 */
export type BrowserCaptureQueueStatus = "pending_confirmation" | "saving" | "saved" | "failed";

export interface BrowserCaptureEnvelope {
  envelopeId: string;
  requestId?: string;
  targetAccountId: number;
  capture: ValidatedBrowserCapture;
  status: BrowserCaptureQueueStatus;
  attempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserCaptureEnqueueResult {
  envelope: BrowserCaptureEnvelope;
  duplicate: boolean;
}

const QUEUE_VERSION = 1;
const MAX_QUEUE_ENTRIES = 32;
const QUEUE_KEY_PREFIX = "aichihongshu.browser-capture-queue.v1";

const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_URL_CHARS = 2_000;
const MAX_BODY_CHARS = 20_000;
const MAX_REASON_CHARS = 2_000;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validateBrowserCapture(raw: unknown, activeAccountId: number): BrowserCaptureValidation {
  if (!raw || typeof raw !== "object") return { ok: false, code: "INVALID_MESSAGE", message: "浏览器剪藏消息格式无效" };
  const input = raw as Partial<BrowserCaptureMessage>;
  const serialized = JSON.stringify(raw);
  if (byteLength(serialized) > MAX_MESSAGE_BYTES) return { ok: false, code: "TOO_LARGE", message: "浏览器剪藏内容超过 128KB 限制" };
  if (input.targetAccountId !== activeAccountId) return { ok: false, code: "ACCOUNT_MISMATCH", message: "剪藏目标账号已变化，请重新选择当前账号" };
  if (input.transport !== "manual" && input.transport !== "extension") return { ok: false, code: "INVALID_MESSAGE", message: "未知的浏览器剪藏来源" };

  const title = text(input.title, MAX_TITLE_CHARS);
  if (!title) return { ok: false, code: "INVALID_MESSAGE", message: "剪藏标题不能为空" };
  const sourceUrl = text(input.sourceUrl, MAX_URL_CHARS);
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) return { ok: false, code: "INVALID_URL", message: "来源链接必须以 http:// 或 https:// 开头" };
  const body = text(input.body, MAX_BODY_CHARS);
  const reason = text(input.reason, MAX_REASON_CHARS);
  const observedAt = text(input.observedAt, 64) || new Date().toISOString();
  if (Number.isNaN(Date.parse(observedAt))) return { ok: false, code: "INVALID_MESSAGE", message: "观察时间格式无效" };
  const requestId = text(input.requestId, 128) || undefined;
  const dedupeKey = `${activeAccountId}|${sourceUrl.toLocaleLowerCase()}|${title.toLocaleLowerCase()}`;
  return { ok: true, value: { title, sourceUrl, body, reason, observedAt, targetAccountId: activeAccountId, transport: input.transport, requestId, dedupeKey } };
}

export function parseBrowserCaptureMessage(raw: string, activeAccountId: number): BrowserCaptureValidation {
  if (byteLength(raw) > MAX_MESSAGE_BYTES) return { ok: false, code: "TOO_LARGE", message: "浏览器剪藏消息超过 128KB 限制" };
  try { return validateBrowserCapture(JSON.parse(raw), activeAccountId); }
  catch { return { ok: false, code: "INVALID_MESSAGE", message: "浏览器剪藏消息不是有效 JSON" }; }
}

function queueStorageKey(databaseIdentity: string, accountId: number): string {
  return `${QUEUE_KEY_PREFIX}-${encodeURIComponent(databaseIdentity)}-account-${accountId}`;
}

function queueStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

function newEnvelopeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `capture-${crypto.randomUUID()}`;
  }
  return `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readRawQueue(databaseIdentity: string, accountId: number): BrowserCaptureEnvelope[] {
  try {
    const raw = queueStorage()?.getItem(queueStorageKey(databaseIdentity, accountId));
    const parsed = raw ? JSON.parse(raw) as { version?: number; entries?: unknown } : null;
    if (!parsed || parsed.version !== QUEUE_VERSION || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry): entry is BrowserCaptureEnvelope => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as Partial<BrowserCaptureEnvelope>;
      return typeof value.envelopeId === "string"
        && typeof value.targetAccountId === "number"
        && value.targetAccountId === accountId
        && typeof value.capture === "object"
        && (value.status === "pending_confirmation" || value.status === "saving" || value.status === "saved" || value.status === "failed")
        && typeof value.attempts === "number";
    });
  } catch {
    return [];
  }
}

function writeQueue(databaseIdentity: string, accountId: number, entries: BrowserCaptureEnvelope[]): void {
  const storage = queueStorage();
  if (!storage) return;
  const bounded = entries
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_QUEUE_ENTRIES);
  storage.setItem(queueStorageKey(databaseIdentity, accountId), JSON.stringify({ version: QUEUE_VERSION, entries: bounded }));
}

/** Read the current account queue. A crash during save becomes retryable. */
export function readBrowserCaptureQueue(databaseIdentity: string, accountId: number): BrowserCaptureEnvelope[] {
  const entries = readRawQueue(databaseIdentity, accountId);
  let changed = false;
  const recovered = entries.map((entry) => {
    if (entry.status !== "saving") return entry;
    changed = true;
    return { ...entry, status: "failed" as const, error: "上次保存被中断，可重试", updatedAt: new Date().toISOString() };
  });
  if (changed) writeQueue(databaseIdentity, accountId, recovered);
  return recovered;
}

/** Add a validated message, or return the existing envelope for an idempotent retry. */
export function enqueueBrowserCapture(databaseIdentity: string, capture: ValidatedBrowserCapture): BrowserCaptureEnqueueResult {
  const entries = readBrowserCaptureQueue(databaseIdentity, capture.targetAccountId);
  const existing = entries.find((entry) => (
    Boolean(capture.requestId && entry.requestId && capture.requestId === entry.requestId)
    || entry.capture.dedupeKey === capture.dedupeKey
  ));
  if (existing) return { envelope: existing, duplicate: true };

  const now = new Date().toISOString();
  const envelope: BrowserCaptureEnvelope = {
    envelopeId: newEnvelopeId(),
    ...(capture.requestId ? { requestId: capture.requestId } : {}),
    targetAccountId: capture.targetAccountId,
    capture,
    status: "pending_confirmation",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  writeQueue(databaseIdentity, capture.targetAccountId, [envelope, ...entries]);
  return { envelope, duplicate: false };
}

function updateBrowserCaptureQueue(
  databaseIdentity: string,
  accountId: number,
  envelopeId: string,
  update: Partial<Pick<BrowserCaptureEnvelope, "status" | "error" | "attempts">>,
): BrowserCaptureEnvelope | null {
  const entries = readBrowserCaptureQueue(databaseIdentity, accountId);
  let updated: BrowserCaptureEnvelope | null = null;
  const next = entries.map((entry) => {
    if (entry.envelopeId !== envelopeId) return entry;
    updated = { ...entry, ...update, updatedAt: new Date().toISOString() };
    return updated;
  });
  if (updated) writeQueue(databaseIdentity, accountId, next);
  return updated;
}

export function markBrowserCaptureSaving(databaseIdentity: string, accountId: number, envelopeId: string): BrowserCaptureEnvelope | null {
  const current = readBrowserCaptureQueue(databaseIdentity, accountId).find((entry) => entry.envelopeId === envelopeId);
  if (!current || current.status === "saved") return current ?? null;
  return updateBrowserCaptureQueue(databaseIdentity, accountId, envelopeId, { status: "saving", attempts: current.attempts + 1, error: undefined });
}

export function markBrowserCaptureSaved(databaseIdentity: string, accountId: number, envelopeId: string): BrowserCaptureEnvelope | null {
  return updateBrowserCaptureQueue(databaseIdentity, accountId, envelopeId, { status: "saved", error: undefined });
}

export function markBrowserCaptureFailed(databaseIdentity: string, accountId: number, envelopeId: string, error: string): BrowserCaptureEnvelope | null {
  return updateBrowserCaptureQueue(databaseIdentity, accountId, envelopeId, { status: "failed", error: text(error, 500) || "保存失败，可重试" });
}
