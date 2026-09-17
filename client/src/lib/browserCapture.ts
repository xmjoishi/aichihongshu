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
