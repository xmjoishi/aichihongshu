// Local API base URL. Web dev can point at `rn serve` without changing source.
const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim();
export const API_BASE = (configuredApiBase || "http://127.0.0.1:8765").replace(/\/+$/, "");

export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

import { openUrl } from "@tauri-apps/plugin-opener";

/** 风险二次确认所需的特殊错误（HTTP 428）。 */
export class RiskConfirmationRequiredError extends Error {
  action: string;
  role: string;
  alias: string;
  payload: Record<string, unknown>;
  constructor(payload: Record<string, unknown>) {
    super(String(payload?.message ?? "需要风险确认"));
    this.name = "RiskConfirmationRequiredError";
    this.action = String(payload?.action ?? "");
    this.role = String(payload?.role ?? "");
    this.alias = String(payload?.alias ?? "");
    this.payload = payload;
  }
}

export function isBackendUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("failed to fetch") || msg.includes("networkerror") || msg.includes("load failed");
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/health`, { cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

let writeSessionToken: string | null | undefined;
let writeSessionExpiresAt = 0;
let writeSessionRequest: Promise<string | null> | null = null;

async function getWriteSessionToken(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && writeSessionExpiresAt > Date.now()) return writeSessionToken ?? null;
  if (!forceRefresh && writeSessionRequest) return writeSessionRequest;

  writeSessionToken = undefined;
  writeSessionExpiresAt = 0;
  const request = fetch(`${API_BASE}/api/session`, { cache: "no-store" })
    .then(async (response) => {
      if (response.status === 404 || response.status === 405) {
        throw new Error("当前 API 服务缺少安全写入会话；请使用 Rust rn serve 服务后重试");
      }
      if (!response.ok) {
        throw new Error(`获取本地写入会话失败：HTTP ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || !("token" in payload)
        || typeof payload.token !== "string" || !payload.token) {
        throw new Error("本地 API 返回了无效的写入会话");
      }
      writeSessionToken = payload.token;
      // The token lives until the Rust process exits; a 403 forces one refresh.
      writeSessionExpiresAt = Number.POSITIVE_INFINITY;
      return payload.token;
    })
    .catch((error: unknown) => {
      writeSessionToken = undefined;
      writeSessionExpiresAt = 0;
      throw error;
    })
    .finally(() => {
      if (writeSessionRequest === request) writeSessionRequest = null;
    });
  writeSessionRequest = request;
  return request;
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method || "GET").toUpperCase();
  const isWrite = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (!isWrite) return fetch(`${API_BASE}${path}`, options);

  const send = (token: string | null) => {
    const headers = new Headers(options.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${API_BASE}${path}`, { ...options, headers });
  };
  const token = await getWriteSessionToken();
  const response = await send(token);
  if (response.status !== 403) return response;

  // A restarted Rust process gets a new token. Refresh once and retry; the
  // server still performs the final Origin, token, account and payload checks.
  const refreshedToken = await getWriteSessionToken(true);
  return refreshedToken ? send(refreshedToken) : response;
}

async function handleResponse(r: Response, label: string) {
  if (r.status === 428) {
    // 风险二次确认
    try {
      const j = await r.json();
      const detail = (j?.detail ?? j) as Record<string, unknown>;
      throw new RiskConfirmationRequiredError(detail);
    } catch (e) {
      if (e instanceof RiskConfirmationRequiredError) throw e;
      throw new Error(`${label}: 428 需要二次确认`);
    }
  }
  if (!r.ok) {
    let detail = `${r.status}`;
    try {
      const j = await r.json();
      detail = j.detail ?? detail;
    } catch {/* ignore */}
    throw new Error(`${label}: ${detail}`);
  }
  return r.json();
}

/** 风险确认 header 工厂。 */
export const riskAckHeader = (ack: boolean): Record<string, string> =>
  ack ? { "X-Risk-Acknowledged": "yes" } : {};

export const api = {
  get: (path: string, headers: Record<string, string> = {}) =>
    apiFetch(path, { headers })
      .then((r) => handleResponse(r, `GET ${path}`)),

  post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
    apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }).then((r) => handleResponse(r, `POST ${path}`)),

  patch: (path: string, body: unknown, headers: Record<string, string> = {}) =>
    apiFetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }).then((r) => handleResponse(r, `PATCH ${path}`)),

  delete: (path: string, headers: Record<string, string> = {}) =>
    apiFetch(path, { method: "DELETE", headers })
      .then((r) => handleResponse(r, `DELETE ${path}`)),

  put: (path: string, body: unknown, headers: Record<string, string> = {}) =>
    apiFetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }).then((r) => handleResponse(r, `PUT ${path}`)),

  upload: (path: string, formData: FormData) =>
    apiFetch(path, { method: "POST", body: formData })
      .then((r) => handleResponse(r, `UPLOAD ${path}`)),

  imageUrl: (itemId: number) => `${API_BASE}/api/library/${itemId}/image`,

  /**
   * SSE 流式请求。每收到一行 data: {...} 就调用 onChunk(parsed)。
   * 返回 AbortController，调用 abort() 可取消。
   * method 默认 POST，传 "GET" 时 body 参数忽略。
   */
  stream: (
    path: string,
    body: unknown,
    onChunk: (data: Record<string, unknown>) => void,
    onDone?: () => void,
    onError?: (err: Error) => void,
    method: "POST" | "GET" = "POST",
    headers?: Record<string, string>,
  ): AbortController => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const fetchOpts: RequestInit = {
          method,
          signal: ctrl.signal,
        };
        const hdrs: Record<string, string> = { ...(headers || {}) };
        if (method === "POST") {
          hdrs["Content-Type"] = "application/json";
          fetchOpts.body = JSON.stringify(body);
        }
        fetchOpts.headers = hdrs;
        const r = await apiFetch(path, fetchOpts);
        if (!r.ok) {
          // v0.2: 428 → 风险确认请求
          if (r.status === 428) {
            try {
              const data = await r.json();
              if (data?.detail?.code === "REQUIRES_CONFIRMATION") {
                throw new RiskConfirmationRequiredError(data.detail);
              }
            } catch (e) {
              if (e instanceof RiskConfirmationRequiredError) throw e;
            }
          }
          throw new Error(`SSE ${path}: ${r.status}`);
        }
        const reader = r.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                onChunk(JSON.parse(line.slice(6)));
              } catch {/* skip malformed */}
            }
          }
        }
        onDone?.();
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          onError?.(err as Error);
        }
      }
    })();
    return ctrl;
  },
};

/**
 * 打开用户明确选择的外部网页。
 * 桌面端使用系统默认浏览器；Web 端使用当前浏览器的新标签，不依赖爬虫服务。
 */
export async function openExternalUrl(input: string): Promise<void> {
  const value = input.trim();
  if (!value) throw new Error("链接为空");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("链接格式无效");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("只允许打开 HTTP 或 HTTPS 链接");
  }

  if (IS_TAURI) {
    await openUrl(url.toString());
    return;
  }
  const link = document.createElement("a");
  link.href = url.toString();
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  link.click();
}

/**
 * 用系统默认浏览器打开 URL。
 * 适合创作者中心发布页等不需要爬虫登录态的场景。
 */
export async function openInSystemBrowser(url: string): Promise<void> {
  if (!url) return;
  await openExternalUrl(url);
}

// ---- 灵感页接口 ----

export interface InspireParams {
  topic: string;
  item_ids: number[];
  extra_image_desc: string;
  account_ids: string[];
  extra_instruction: string;
}

/**
 * 灵感生成 SSE 流式请求。
 */
export function inspireStream(
  params: InspireParams,
  onChunk: (data: Record<string, unknown>) => void,
  onDone?: () => void,
  onError?: (err: Error) => void,
): AbortController {
  return api.stream("/api/ai/inspire", params, onChunk, onDone, onError);
}

/**
 * 获取话题热词候选列表。
 */
export function fetchTopics(): Promise<{ topics: { word: string; count: number }[] }> {
  return api.get("/api/analytics/topics");
}
