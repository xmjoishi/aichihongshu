// API base URL — FastAPI server
export const API_BASE = "http://127.0.0.1:8765";

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
    fetch(`${API_BASE}${path}`, { headers })
      .then((r) => handleResponse(r, `GET ${path}`)),

  post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }).then((r) => handleResponse(r, `POST ${path}`)),

  patch: (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${API_BASE}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }).then((r) => handleResponse(r, `PATCH ${path}`)),

  delete: (path: string, headers: Record<string, string> = {}) =>
    fetch(`${API_BASE}${path}`, { method: "DELETE", headers })
      .then((r) => handleResponse(r, `DELETE ${path}`)),

  put: (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${API_BASE}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }).then((r) => handleResponse(r, `PUT ${path}`)),

  upload: (path: string, formData: FormData) =>
    fetch(`${API_BASE}${path}`, { method: "POST", body: formData })
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
        const r = await fetch(`${API_BASE}${path}`, fetchOpts);
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
 * 用 Playwright Chromium（爬虫同款浏览器）打开指定 URL。
 * 适合需要小红书登录态的内容链接（笔记、用户主页等）。
 * 若爬虫浏览器已在运行则在其中开新标签，否则启动 Chromium 并打开。
 * fire-and-forget：不 await，不做任何 fallback，避免触发 Tauri about:blank。
 */
export function openInBrowser(url: string): void {
  if (!url) return;
  fetch(`${API_BASE}/api/crawler/open-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  }).catch(() => {/* 静默失败 */});
}

/**
 * 用系统默认浏览器打开 URL。
 * 适合创作者中心发布页等不需要爬虫登录态的场景。
 */
export async function openInSystemBrowser(url: string): Promise<void> {
  if (!url) return;
  await openUrl(url);
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
