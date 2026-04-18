// API base URL — FastAPI server
export const API_BASE = "http://127.0.0.1:8765";

async function handleResponse(r: Response, label: string) {
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

export const api = {
  get: (path: string) =>
    fetch(`${API_BASE}${path}`)
      .then((r) => handleResponse(r, `GET ${path}`)),

  post: (path: string, body: unknown) =>
    fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => handleResponse(r, `POST ${path}`)),

  patch: (path: string, body: unknown) =>
    fetch(`${API_BASE}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => handleResponse(r, `PATCH ${path}`)),

  delete: (path: string) =>
    fetch(`${API_BASE}${path}`, { method: "DELETE" })
      .then((r) => handleResponse(r, `DELETE ${path}`)),

  upload: (path: string, formData: FormData) =>
    fetch(`${API_BASE}${path}`, { method: "POST", body: formData })
      .then((r) => handleResponse(r, `UPLOAD ${path}`)),

  imageUrl: (itemId: number) => `${API_BASE}/api/library/${itemId}/image`,

  /**
   * SSE 流式请求。每收到一行 data: {...} 就调用 onChunk(parsed)。
   * 返回 AbortController，调用 abort() 可取消。
   */
  stream: (
    path: string,
    body: unknown,
    onChunk: (data: Record<string, unknown>) => void,
    onDone?: () => void,
    onError?: (err: Error) => void,
  ): AbortController => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await fetch(`${API_BASE}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`SSE ${path}: ${r.status}`);
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
