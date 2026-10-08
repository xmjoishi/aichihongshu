export type BrowserCaptureTransport = "manual" | "extension";
export type BrowserCaptureKind = "clip" | "note_snapshot" | "ref_snapshot";
export type BrowserCaptureMaterialType = "note_material" | "profile_material" | "web_material" | "image_material";
export type BrowserCaptureClipKind = "account" | "note" | "material";
export type BrowserCapturePageType = "note" | "profile" | "web";

export interface BrowserCaptureMetrics {
  like?: number | null;
  collect?: number | null;
  comment?: number | null;
  followers?: number | null;
  noteCount?: number | null;
  share?: number | null;
}

export interface BrowserCaptureProfile {
  avatarUrl: string | null;
  bio: string;
  follows: number | null;
  ipLocation: string;
  tags: string[];
}

export interface BrowserCaptureModules {
  collect: { titleBody: boolean; authorSource: boolean; images: boolean; comments: boolean };
  data: { metrics: boolean; publishedAt: boolean };
}

export interface BrowserCaptureDetails {
  images: Array<{ url: string; width?: number | null; height?: number | null; domIndex?: number; order?: number; source?: string }>;
  comments: Array<{ author?: string; text: string; likes?: number | null; truncated?: boolean; source?: string }>;
  evidence: Record<string, { source?: string | null; missingReason?: string | null }>;
  publishedAt?: string | null;
  publishedLocation?: string | null;
  importedItemIds?: number[];
}

export interface BrowserCaptureMessage {
  title: string;
  sourceUrl?: string;
  body?: string;
  reason?: string;
  observedAt?: string;
  targetAccountId: number;
  transport: BrowserCaptureTransport;
  requestId?: string;
  kind?: BrowserCaptureKind;
  clipKind?: BrowserCaptureClipKind;
  materialType?: BrowserCaptureMaterialType;
  pageType?: BrowserCapturePageType;
  imageTransferProtocol?: boolean;
  author?: string;
  like?: number | null;
  collect?: number | null;
  comment?: number | null;
  followers?: number | null;
  noteCount?: number | null;
  metrics?: Partial<BrowserCaptureMetrics>;
  profile?: Partial<BrowserCaptureProfile> | null;
  images?: Array<{ url: string; width?: number | null; height?: number | null; domIndex?: number; source?: string }>;
  comments?: Array<{ author?: string; text: string; likes?: number | null; truncated?: boolean }>;
  evidence?: Record<string, { source?: string | null; missingReason?: string | null }>;
  publishedAt?: string | null;
  publishedLocation?: string | null;
  captureDetails?: Partial<BrowserCaptureDetails>;
  referenceAccountId?: number | null;
  modules?: Partial<BrowserCaptureModules>;
}

export interface ValidatedBrowserCapture extends BrowserCaptureMessage {
  title: string;
  sourceUrl: string;
  body: string;
  reason: string;
  observedAt: string;
  dedupeKey: string;
  kind: BrowserCaptureKind;
  clipKind: BrowserCaptureClipKind;
  materialType: BrowserCaptureMaterialType;
  pageType: BrowserCapturePageType;
  imageTransferProtocol: boolean;
  author: string;
  metrics: BrowserCaptureMetrics;
  profile: BrowserCaptureProfile;
  referenceAccountId: number | null;
  modules: BrowserCaptureModules;
  images: NonNullable<BrowserCaptureMessage["images"]>;
  comments: NonNullable<BrowserCaptureMessage["comments"]>;
  evidence: NonNullable<BrowserCaptureMessage["evidence"]>;
  captureDetails: BrowserCaptureDetails;
}

export type BrowserCaptureValidation =
  | { ok: true; value: ValidatedBrowserCapture }
  | { ok: false; code: "INVALID_MESSAGE" | "ACCOUNT_MISMATCH" | "INVALID_URL" | "TOO_LARGE"; message: string };

export function serializeBrowserCapturePayload(capture: ValidatedBrowserCapture): string {
  return JSON.stringify({
    ...capture.captureDetails,
    images: capture.captureDetails.images,
    comments: capture.captureDetails.comments,
    metrics: capture.metrics,
    profile: capture.profile,
    tags: capture.profile.tags,
    publishedAt: capture.captureDetails.publishedAt ?? capture.publishedAt,
    publishedLocation: capture.captureDetails.publishedLocation ?? capture.publishedLocation,
  });
}

/** Legacy queue envelopes are retained only to migrate older pending captures into SQLite. */
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
export const BROWSER_CAPTURE_QUEUE_UPDATED_EVENT = "aichihongshu-browser-capture-queue-updated";

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
  const kind: BrowserCaptureKind =
    input.kind === "note_snapshot" || input.kind === "ref_snapshot" || input.kind === "clip"
      ? input.kind
      : "clip";
  const clipKind: BrowserCaptureClipKind =
    input.clipKind === "account" || input.clipKind === "note" || input.clipKind === "material"
      ? input.clipKind
      : input.materialType === "profile_material" || kind === "ref_snapshot"
        ? "account"
        : input.materialType === "image_material"
          ? "material"
          : "note";
  const author = text(input.author, 200);
  const optionalMetric = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
    }
    return null;
  };
  const metrics: BrowserCaptureMetrics = {
    like: optionalMetric(input.like ?? input.metrics?.like),
    collect: optionalMetric(input.collect ?? input.metrics?.collect),
    comment: optionalMetric(input.comment ?? input.metrics?.comment),
    followers: optionalMetric(input.followers ?? input.metrics?.followers),
    noteCount: optionalMetric(input.noteCount ?? input.metrics?.noteCount),
    share: optionalMetric(input.metrics?.share),
  };
  const rawProfile = input.profile && typeof input.profile === "object" ? input.profile : {};
  let avatarUrl: string | null = null;
  if (typeof rawProfile.avatarUrl === "string") {
    try {
      const url = new URL(rawProfile.avatarUrl.trim());
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (url.protocol === "https:" && !url.username && !url.password && host && !host.includes(":")
        && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local")
        && !/^(0\.|10\.|127\.|169\.254\.|192\.168\.)/.test(host)
        && !/^172\.(1[6-9]|2\d|3[01])\./.test(host)
        && !/^(?:22[4-9]|23\d|24\d|25[0-5])\./.test(host)) {
        avatarUrl = url.href.slice(0, 2_000);
      }
    } catch { /* invalid avatar URL */ }
  }
  const profile: BrowserCaptureProfile = {
    avatarUrl,
    bio: text(rawProfile.bio, 2_000),
    follows: optionalMetric(rawProfile.follows),
    ipLocation: text(rawProfile.ipLocation, 100),
    tags: Array.isArray(rawProfile.tags)
      ? Array.from(new Set(rawProfile.tags.flatMap((tag) => {
        const value = text(tag, 80).replace(/^#/, "");
        return value ? [value] : [];
      }))).slice(0, 30)
      : [],
  };
  const referenceAccountId =
    typeof input.referenceAccountId === "number"
      && Number.isSafeInteger(input.referenceAccountId)
      && input.referenceAccountId > 0
      ? input.referenceAccountId
      : null;
  const materialType: BrowserCaptureMaterialType =
    input.materialType === "note_material"
      || input.materialType === "profile_material"
      || input.materialType === "web_material"
      || input.materialType === "image_material"
      ? input.materialType
      : kind === "note_snapshot"
        ? "note_material"
        : kind === "ref_snapshot"
          ? "profile_material"
          : "web_material";
  const pageType: BrowserCapturePageType =
    input.pageType === "note" || input.pageType === "profile" || input.pageType === "web"
      ? input.pageType
      : kind === "note_snapshot"
        ? "note"
        : kind === "ref_snapshot"
          ? "profile"
          : "web";
  const modules: BrowserCaptureModules = {
    collect: {
      titleBody: Boolean(input.modules?.collect?.titleBody ?? true),
      authorSource: Boolean(input.modules?.collect?.authorSource ?? true),
      images: (pageType === "note" || materialType === "image_material") && Boolean(input.modules?.collect?.images),
      comments: pageType === "note" && Boolean(input.modules?.collect?.comments),
    },
    data: {
      metrics: Boolean(input.modules?.data?.metrics ?? kind !== "clip"),
      publishedAt: Boolean(input.modules?.data?.publishedAt ?? false),
    },
  };
  const detailsInput = input.captureDetails ?? {};
  const rawImages = input.images ?? detailsInput.images;
  const rawComments = input.comments ?? detailsInput.comments;
  const images = modules.collect.images && Array.isArray(rawImages)
    ? rawImages.slice(0, 12).flatMap((image) => {
      if (!image || typeof image.url !== "string") return [];
      try {
        const url = new URL(image.url);
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || host.endsWith(".local")) return [];
        if (host.includes(":")) return [];
        if (/^(0\.|127\.|10\.|192\.168\.|169\.254\.)/.test(host)
          || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
          || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
          || /^192\.(0\.(0|2)\.|0\.)/.test(host)
          || /^198\.(18|19)\./.test(host)
          || /^198\.51\.100\./.test(host)
          || /^203\.0\.113\./.test(host)
          || /^(?:22[4-9]|23\d|24\d|25[0-5])\./.test(host)) return [];
        return [{
          url: url.href.slice(0, 2_000),
          width: optionalMetric(image.width),
          height: optionalMetric(image.height),
          domIndex: typeof image.domIndex === "number" && Number.isInteger(image.domIndex) ? Math.max(0, Math.min(image.domIndex, 1_000)) : 0,
          source: text(image.source, 80) || (materialType === "image_material" ? "selected-image" : "visible-note-image"),
        }];
      } catch { return []; }
    })
    : [];
  const comments = modules.collect.comments && Array.isArray(rawComments)
    ? rawComments.slice(0, 20).flatMap((comment) => {
      if (!comment || typeof comment.text !== "string" || !comment.text.trim()) return [];
      return [{
        author: text(comment.author, 80),
        text: text(comment.text, 350),
        likes: optionalMetric(comment.likes),
        truncated: Boolean(comment.truncated) || comment.text.length > 350,
      }];
    })
    : [];
  const evidence: NonNullable<BrowserCaptureMessage["evidence"]> = {};
  for (const key of ["like", "collect", "comment", "share", "followers", "noteCount"]) {
    const entry = input.evidence?.[key];
    if (entry && typeof entry === "object") evidence[key] = {
      source: text(entry.source, 120) || null,
      missingReason: text(entry.missingReason, 180) || null,
    };
  }
  const publishedAt = text(input.publishedAt ?? detailsInput.publishedAt, 80) || null;
  const publishedLocation = text(input.publishedLocation ?? detailsInput.publishedLocation, 100) || null;
  const captureDetails: BrowserCaptureDetails = {
    images: images.map((image, index) => ({ ...image, order: index })),
    comments: comments.map((comment) => ({ ...comment, source: "currently-loaded-comment" })),
    evidence: input.evidence ?? detailsInput.evidence ?? evidence,
    publishedAt,
    publishedLocation,
    importedItemIds: Array.isArray(detailsInput.importedItemIds)
      ? detailsInput.importedItemIds.filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 12)
      : [],
  };
  const dedupeKey = `${activeAccountId}|${sourceUrl.toLocaleLowerCase()}|${title.toLocaleLowerCase()}`;
  return {
    ok: true,
    value: {
      title,
      sourceUrl,
      body,
      reason,
      observedAt,
      targetAccountId: activeAccountId,
      transport: input.transport,
      requestId,
      dedupeKey,
      kind,
      clipKind,
      materialType,
      pageType,
      imageTransferProtocol: Boolean(input.imageTransferProtocol),
      author,
      metrics,
      profile,
      referenceAccountId,
      modules,
      images,
      comments,
      evidence,
      captureDetails,
      publishedAt,
      publishedLocation,
    },
  };
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
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BROWSER_CAPTURE_QUEUE_UPDATED_EVENT));
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

/** Remove a legacy queue item after it is already persisted in SQLite. */
export function removeBrowserCaptureQueueEntry(databaseIdentity: string, accountId: number, envelopeId: string): void {
  const entries = readBrowserCaptureQueue(databaseIdentity, accountId);
  const next = entries.filter((entry) => entry.envelopeId !== envelopeId);
  if (next.length !== entries.length) writeQueue(databaseIdentity, accountId, next);
}
