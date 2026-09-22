import { useState, useCallback, useRef, useEffect } from "react";
import { api, API_BASE } from "../lib/api";
import { ACCOUNT_CHANGED_EVENT, useAccountContext } from "../lib/accountContext";
import { IS_TAURI_RUNTIME } from "../lib/local";
import { readLocalAIRun, readLocalAIRunArtifacts, saveLocalAIRun, saveLocalAIRunArtifact, updateLocalAIRun } from "../lib/local";
import { markLocalAITextVerified, probeLocalAIProviders, streamLocalAI, type LocalAIProviderId } from "../lib/localAi";
import { publishAISession, subscribeAISession } from "../lib/aiSession";

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

interface UseAIStreamOptions {
  noteId?: number;
  itemId?: number;
  accountId?: number | null;
  systemExtra?: string;
  localProviderId?: LocalAIProviderId;
  localProviderScope?: string;
  /** Shared conversation identity used by all AI host presentations. */
  sessionKey?: string;
  /** Stable Agent session id used to isolate restart-safe history. */
  historyKey?: string;
  /** Ask is conversational; Agent asks the model to plan actions explicitly. */
  assistantMode?: "ask" | "agent";
}

export type AIRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface AIRunMetadata {
  runId: string;
  accountId: number | null;
  provider?: string;
  noteId?: number;
  itemId?: number;
  startedAt: string;
  finishedAt?: string;
  status: AIRunStatus;
  /** 仅保存脱敏、限长错误分类，不保存请求正文或凭据。 */
  error?: string;
}

const AI_HISTORY_VERSION = "v2";
const AI_RUN_VERSION = "v1";
const MAX_HISTORY_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_RUN_ERROR_CHARS = 240;

// 进程内标记用于区分“同一应用中的组件重挂载”和“应用重开”。
// localStorage 中遗留的 running run 若不在此集合内，会在加载时标为 interrupted。
const liveRunIds = new Set<string>();

function objectScope(noteId?: number, itemId?: number, historyKey?: string): string {
  if (historyKey) return `session-${encodeURIComponent(historyKey)}`;
  return noteId != null ? `note-${noteId}` : itemId != null ? `item-${itemId}` : "session";
}

function persistentStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function storageKey(databaseIdentity: string, accountId: number | null | undefined, noteId?: number, itemId?: number, historyKey?: string) {
  const accountScope = accountId == null ? "unresolved" : String(accountId);
  return `ai-history-${AI_HISTORY_VERSION}-db-${encodeURIComponent(databaseIdentity)}-account-${accountScope}-${objectScope(noteId, itemId, historyKey)}`;
}

function legacyStorageKey(databaseIdentity: string, accountId: number | null | undefined, noteId?: number, itemId?: number, historyKey?: string) {
  const accountScope = accountId == null ? "unresolved" : String(accountId);
  return `ai-history-v1-db-${encodeURIComponent(databaseIdentity)}-account-${accountScope}-${objectScope(noteId, itemId, historyKey)}`;
}

function normalizeHistory(value: unknown): AIMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((message): message is AIMessage =>
      Boolean(message) &&
      (message as AIMessage).role !== undefined &&
      ((message as AIMessage).role === "user" || (message as AIMessage).role === "assistant") &&
      typeof (message as AIMessage).content === "string",
    )
    .map((message) => ({ role: message.role, content: message.content.slice(0, MAX_MESSAGE_CHARS) }))
    .slice(-MAX_HISTORY_MESSAGES);
}

function loadHistory(databaseIdentity: string, accountId: number | null | undefined, noteId?: number, itemId?: number, historyKey?: string): AIMessage[] {
  const key = storageKey(databaseIdentity, accountId, noteId, itemId, historyKey);
  const storage = persistentStorage();
  try {
    const raw = storage?.getItem(key);
    if (raw) return normalizeHistory(JSON.parse(raw));
  } catch {
    // 存储不可用或历史损坏时从空历史开始，不影响当前流。
  }

  // 只读兼容上一版会话历史，第一次加载后迁移到可重启的 localStorage。
  try {
    const legacy = typeof window !== "undefined" ? window.sessionStorage.getItem(legacyStorageKey(databaseIdentity, accountId, noteId, itemId, historyKey)) : null;
    const migrated = legacy ? normalizeHistory(JSON.parse(legacy)) : [];
    if (migrated.length > 0) saveHistory(databaseIdentity, accountId, noteId, itemId, migrated, historyKey);
    return migrated;
  } catch {
    return [];
  }
}

function saveHistory(databaseIdentity: string, accountId: number | null | undefined, noteId: number | undefined, itemId: number | undefined, msgs: AIMessage[], historyKey?: string) {
  const key = storageKey(databaseIdentity, accountId, noteId, itemId, historyKey);
  const storage = persistentStorage();
  try {
    storage?.setItem(key, JSON.stringify(normalizeHistory(msgs)));
  } catch {}
}

function runStorageKey(databaseIdentity: string, accountId: number | null, noteId?: number, itemId?: number, historyKey?: string): string {
  const accountScope = accountId == null ? "unresolved" : String(accountId);
  return `ai-run-${AI_RUN_VERSION}-db-${encodeURIComponent(databaseIdentity)}-account-${accountScope}-${objectScope(noteId, itemId, historyKey)}`;
}

function newRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function safeRunError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "AI 请求失败");
  return raw
    .replace(/(api[_ -]?key|token|secret|password)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .slice(0, MAX_RUN_ERROR_CHARS);
}

function parseRunMetadata(value: unknown): AIRunMetadata | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Partial<AIRunMetadata>;
  const statuses: AIRunStatus[] = ["running", "completed", "failed", "cancelled", "interrupted"];
  if (typeof run.runId !== "string" || !statuses.includes(run.status as AIRunStatus) || typeof run.startedAt !== "string") return null;
  if (typeof run.accountId !== "number" && run.accountId !== null) return null;
  return {
    runId: run.runId,
    accountId: run.accountId ?? null,
    ...(typeof run.provider === "string" ? { provider: run.provider } : {}),
    ...(typeof run.noteId === "number" ? { noteId: run.noteId } : {}),
    ...(typeof run.itemId === "number" ? { itemId: run.itemId } : {}),
    startedAt: run.startedAt,
    ...(typeof run.finishedAt === "string" ? { finishedAt: run.finishedAt } : {}),
    status: run.status as AIRunStatus,
    ...(typeof run.error === "string" ? { error: run.error.slice(0, MAX_RUN_ERROR_CHARS) } : {}),
  };
}

function saveRunMetadata(databaseIdentity: string, run: AIRunMetadata, historyKey?: string): void {
  try {
    persistentStorage()?.setItem(runStorageKey(databaseIdentity, run.accountId, run.noteId, run.itemId, historyKey), JSON.stringify(run));
  } catch {}
  if (IS_TAURI_RUNTIME && !historyKey) {
    void saveLocalAIRun({
      runId: run.runId,
      accountPoolId: run.accountId,
      noteId: run.noteId,
      itemId: run.itemId,
      provider: run.provider ?? "local-cli",
      startedAt: run.startedAt,
      status: run.status,
      finishedAt: run.finishedAt ?? null,
      error: run.error ?? null,
    }).catch(() => {
      // localStorage remains the bounded fallback when the native command is unavailable.
    });
  }
}

function buildLocalAIPrompt(messages: AIMessage[], systemExtra?: string, assistantMode: "ask" | "agent" = "ask"): string {
  const transcript = messages
    .map((message) => `${message.role === "user" ? "用户" : "助手"}: ${message.content}`)
    .join("\n\n");
  return [
    assistantMode === "agent"
      ? "你是爱吃红薯桌面端的 Agent。先理解当前页面和用户目标，先给出行动计划；涉及发布、删除、修改或外部操作时必须先明确列出待确认动作，不要擅自执行。"
      : "你是爱吃红薯桌面端的 Ask 助手。只回答当前任务，不执行命令、不修改文件、不访问网络。",
    systemExtra ? `当前上下文：${systemExtra}` : "",
    "以下是对话记录：",
    transcript,
    "请直接给出助手回复。",
  ].filter(Boolean).join("\n\n");
}

function loadRunMetadata(databaseIdentity: string, accountId: number | null, noteId?: number, itemId?: number, historyKey?: string): AIRunMetadata | null {
  const key = runStorageKey(databaseIdentity, accountId, noteId, itemId, historyKey);
  try {
    const raw = persistentStorage()?.getItem(key);
    const parsed = raw ? parseRunMetadata(JSON.parse(raw)) : null;
    if (!parsed) return null;
    if (parsed.status === "running" && !liveRunIds.has(parsed.runId)) {
      const recovered: AIRunMetadata = {
        ...parsed,
        status: "interrupted",
        finishedAt: new Date().toISOString(),
        error: "应用重新打开前的 AI 运行未完成",
      };
      saveRunMetadata(databaseIdentity, recovered, historyKey);
      return recovered;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * SSE 流式 AI 对话 Hook
 * 返回消息列表、流式输出中的 pending 文本、发送函数、加载状态和清空函数
 */
export function useAIStream(opts: UseAIStreamOptions = {}) {
  const accountContext = useAccountContext();
  const effectiveAccountId = opts.accountId ?? accountContext.accountId;
  const databaseIdentity = accountContext.databaseIdentity || API_BASE;
  const sessionKey = opts.sessionKey ?? `account-${effectiveAccountId ?? "unresolved"}:${objectScope(opts.noteId, opts.itemId, opts.historyKey)}`;
  const [messages, setMessages] = useState<AIMessage[]>(() => loadHistory(databaseIdentity, effectiveAccountId, opts.noteId, opts.itemId, opts.historyKey));
  const [streaming, setStreaming] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialRun = loadRunMetadata(databaseIdentity, effectiveAccountId ?? null, opts.noteId, opts.itemId, opts.historyKey);
  const [run, setRun] = useState<AIRunMetadata | null>(initialRun);
  const ctrlRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  const runRef = useRef<AIRunMetadata | null>(initialRun);

  const replaceRun = useCallback((next: AIRunMetadata | null) => {
    runRef.current = next;
    setRun(next);
  }, []);

  const finishRun = useCallback((status: Exclude<AIRunStatus, "running">, runError?: unknown) => {
    const current = runRef.current;
    if (!current || current.status !== "running") return;
    const finished: AIRunMetadata = {
      ...current,
      status,
      finishedAt: new Date().toISOString(),
      ...(runError ? { error: safeRunError(runError) } : {}),
    };
    liveRunIds.delete(current.runId);
    runRef.current = finished;
    setRun(finished);
    saveRunMetadata(databaseIdentity, finished, opts.historyKey);
    if (IS_TAURI_RUNTIME && !opts.historyKey) {
      void updateLocalAIRun({
        runId: finished.runId,
        accountPoolId: finished.accountId,
        status: finished.status,
        finishedAt: finished.finishedAt,
        error: finished.error ?? null,
      }).catch(() => {});
    }
  }, [databaseIdentity, opts.historyKey]);

  // 账号切换事件先于 query 刷新到达，立即取消旧账号的流式回调。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const invalidate = () => {
      requestSeqRef.current += 1;
      finishRun("cancelled", "账号或对象已切换");
      ctrlRef.current?.abort();
      setStreaming("");
      setLoading(false);
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, invalidate);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, invalidate);
  }, [finishRun]);

  // 账号/对象切换时从隔离的 localStorage 恢复历史，并丢弃旧流。
  useEffect(() => {
    requestSeqRef.current += 1;
    finishRun("cancelled", "账号或对象已切换");
    ctrlRef.current?.abort();
    setMessages(loadHistory(databaseIdentity, effectiveAccountId, opts.noteId, opts.itemId, opts.historyKey));
    replaceRun(loadRunMetadata(databaseIdentity, effectiveAccountId ?? null, opts.noteId, opts.itemId, opts.historyKey));
    setStreaming("");
    setLoading(false);
    setError(null);
  }, [databaseIdentity, effectiveAccountId, opts.historyKey, opts.itemId, opts.noteId, finishRun, replaceRun]);

  // All host presentations subscribe to the same in-process session. This
  // keeps a sidebar, floating panel and full page in lockstep without opening
  // a second stream. Persistent history remains the restart-safe fallback.
  useEffect(() => subscribeAISession((event) => {
    if (event.sessionKey !== sessionKey) return;
    if (event.messages) setMessages(event.messages);
    if (event.streaming !== undefined) setStreaming(event.streaming);
    if (event.loading !== undefined) setLoading(event.loading);
    if (event.error !== undefined) setError(event.error);
    if (event.run !== undefined) replaceRun(event.run);
  }), [replaceRun, sessionKey]);

  // Native run metadata is the durable source for Tauri. Keep the bounded
  // browser storage fallback above so the panel still opens while a migration
  // or older database is being upgraded.
  useEffect(() => {
    if (!IS_TAURI_RUNTIME || opts.historyKey) return;
    let disposed = false;
    void readLocalAIRun(effectiveAccountId ?? null, opts.noteId, opts.itemId)
      .then((stored) => {
        if (disposed || !stored) return;
        const current = runRef.current;
        if (current?.status === "running" && liveRunIds.has(current.runId)) return;
        const normalized: AIRunMetadata = {
          runId: stored.runId,
          accountId: stored.accountPoolId,
          ...(typeof stored.provider === "string" ? { provider: stored.provider } : {}),
          ...(typeof stored.noteId === "number" ? { noteId: stored.noteId } : {}),
          ...(typeof stored.itemId === "number" ? { itemId: stored.itemId } : {}),
          startedAt: stored.startedAt,
          ...(stored.finishedAt ? { finishedAt: stored.finishedAt } : {}),
          status: stored.status,
          ...(stored.error ? { error: stored.error } : {}),
        };
        if (normalized.status === "running" && !liveRunIds.has(normalized.runId)) {
          const interrupted: AIRunMetadata = {
            ...normalized,
            status: "interrupted",
            finishedAt: new Date().toISOString(),
            error: "应用重新打开前的 AI 运行未完成",
          };
          replaceRun(interrupted);
          saveRunMetadata(databaseIdentity, interrupted, opts.historyKey);
          void updateLocalAIRun({
            runId: interrupted.runId,
            accountPoolId: interrupted.accountId,
            status: "interrupted",
            finishedAt: interrupted.finishedAt,
            error: interrupted.error,
          }).catch(() => {});
          return;
        }
        replaceRun(normalized);
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, [databaseIdentity, effectiveAccountId, opts.historyKey, opts.itemId, opts.noteId, replaceRun]);

  // If WebView history was cleared but the native artifact remains, restore
  // the last bounded assistant output without reconstructing a fake prompt.
  useEffect(() => {
    if (!IS_TAURI_RUNTIME || opts.historyKey) return;
    let disposed = false;
    void readLocalAIRunArtifacts(effectiveAccountId ?? null, opts.noteId, opts.itemId)
      .then((artifacts) => {
        if (disposed || artifacts.length === 0) return;
        const latest = artifacts[0];
        setMessages((previous) => previous.length > 0 ? previous : [{ role: "assistant", content: latest.content }]);
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, [effectiveAccountId, opts.itemId, opts.noteId]);

  // 展示宿主卸载只代表用户关闭/切换了 AI 视图，不取消后台运行。
  // 运行结果继续写入会话历史和本地运行记录；用户需要通过“停止生成”、
  // 清空对话或切换账号/对象来显式取消。这样浮窗、侧栏、独立页之间可安全切换。

  const send = useCallback(
    (userText: string, replaceLastUser = false) => {
      if (!userText.trim() || loading) return;
      setError(null);

      const requestSeq = ++requestSeqRef.current;
      const originAccountId = effectiveAccountId ?? null;
      const originNoteId = opts.noteId;
      const originItemId = opts.itemId;
      const isCurrent = () => requestSeq === requestSeqRef.current;

      const userMsg: AIMessage = { role: "user", content: userText };
      const baseMessages = replaceLastUser && messages[messages.length - 1]?.role === "user"
        ? messages.slice(0, -1)
        : messages;
      const newMessages = [...baseMessages, userMsg];
      const startedRun: AIRunMetadata = {
        runId: newRunId(),
        accountId: originAccountId,
        ...(opts.localProviderId ? { provider: opts.localProviderId } : {}),
        ...(typeof originNoteId === "number" ? { noteId: originNoteId } : {}),
        ...(typeof originItemId === "number" ? { itemId: originItemId } : {}),
        startedAt: new Date().toISOString(),
        status: "running",
      };
      liveRunIds.add(startedRun.runId);
      runRef.current = startedRun;
      setRun(startedRun);
      saveRunMetadata(databaseIdentity, startedRun, opts.historyKey);
      setMessages(newMessages);
      saveHistory(databaseIdentity, originAccountId, originNoteId, originItemId, newMessages, opts.historyKey);
      setStreaming("");
      setLoading(true);
      publishAISession({ sessionKey, messages: newMessages, streaming: "", loading: true, error: null, run: startedRun });

      let buffer = "";
      const onChunk = (text: string) => {
        if (!isCurrent()) return;
        buffer += text;
        setStreaming(buffer);
        publishAISession({ sessionKey, streaming: buffer, loading: true });
      };
      const onDone = () => {
        if (!isCurrent()) return;
        const completedAt = new Date().toISOString();
        const currentRun = runRef.current;
        if (IS_TAURI_RUNTIME && !opts.historyKey && currentRun && buffer.trim()) {
          const providerId = currentRun.provider;
          if (opts.localProviderScope && (providerId === "claude" || providerId === "codex" || providerId === "opencode")) {
            markLocalAITextVerified(opts.localProviderScope, providerId);
          }
          void saveLocalAIRun({
            runId: currentRun.runId,
            accountPoolId: currentRun.accountId,
            noteId: currentRun.noteId,
            itemId: currentRun.itemId,
            provider: currentRun.provider ?? "local-cli",
            startedAt: currentRun.startedAt,
            status: "completed",
            finishedAt: completedAt,
            error: null,
          }).then(() => saveLocalAIRunArtifact({
            runId: currentRun.runId,
            accountPoolId: currentRun.accountId,
            noteId: currentRun.noteId,
            itemId: currentRun.itemId,
            kind: "assistant_text",
            content: buffer,
          })).catch(() => {});
        }
        setMessages((prev) => {
          const updated = [...prev, { role: "assistant" as const, content: buffer }];
          saveHistory(databaseIdentity, originAccountId, originNoteId, originItemId, updated, opts.historyKey);
          publishAISession({ sessionKey, messages: updated, streaming: "", loading: false });
          return updated;
        });
        setStreaming("");
        setLoading(false);
        finishRun("completed");
        publishAISession({ sessionKey, streaming: "", loading: false, run: runRef.current });
      };
      const onError = (err: Error) => {
        if (!isCurrent()) return;
        setError(err.message);
        setLoading(false);
        finishRun("failed", err);
        publishAISession({ sessionKey, loading: false, error: err.message, run: runRef.current });
      };

      if (IS_TAURI_RUNTIME) {
        // 本地模式只走已允许的 CLI 命令；探测和启动均不经过 shell，且不写配置。
        const placeholder = new AbortController();
        ctrlRef.current = placeholder;
        void probeLocalAIProviders()
          .then((providers) => {
            if (!isCurrent() || placeholder.signal.aborted) return;
            const provider = providers.find((candidate) => candidate.id === opts.localProviderId && candidate.state === "present")
              ?? providers.find((candidate) => candidate.state === "present");
            if (!provider) {
              onError(new Error("未发现可用的本地 AI CLI（claude、codex、opencode）"));
              return;
            }
            const runWithProvider: AIRunMetadata = { ...startedRun, provider: provider.id };
            runRef.current = runWithProvider;
            setRun(runWithProvider);
            saveRunMetadata(databaseIdentity, runWithProvider, opts.historyKey);
            const controller = streamLocalAI(
              startedRun.runId,
              provider.id,
              buildLocalAIPrompt(newMessages, opts.systemExtra, opts.assistantMode),
              // Native CLI events already preserve the provider's text
              // boundaries. Appending a newline to every delta would split
              // one sentence into a line per token in the chat view.
              onChunk,
              onDone,
              onError,
            );
            ctrlRef.current = controller;
            if (placeholder.signal.aborted) controller.abort();
          })
          .catch(onError);
      } else {
        ctrlRef.current = api.stream(
          "/api/ai/chat",
          {
            messages: newMessages,
            note_id: originNoteId ?? null,
            item_id: originItemId ?? null,
            system_extra: [
              opts.systemExtra,
              opts.assistantMode === "agent"
                ? "当前为 Agent 模式：先输出行动计划；涉及页面写入、发布、删除或外部操作时必须先请求用户确认。"
                : "当前为 Ask 模式：只回答和分析，不执行页面写入或外部操作。",
            ].filter(Boolean).join("\n\n") || null,
            assistant_mode: opts.assistantMode ?? "ask",
          },
          (chunk) => {
            if (!isCurrent()) return;
            if (chunk.text) onChunk(chunk.text as string);
          },
          onDone,
          onError,
        );
      }
    },
    [databaseIdentity, effectiveAccountId, finishRun, loading, messages, opts.assistantMode, opts.historyKey, opts.localProviderId, opts.localProviderScope, opts.noteId, opts.itemId, opts.systemExtra, sessionKey],
  );

  const clear = useCallback(() => {
    requestSeqRef.current += 1;
    finishRun("cancelled", "用户清空了当前对话");
    ctrlRef.current?.abort();
    setMessages([]);
    setStreaming("");
    setLoading(false);
    setError(null);
    saveHistory(databaseIdentity, effectiveAccountId, opts.noteId, opts.itemId, [], opts.historyKey);
    publishAISession({ sessionKey, messages: [], streaming: "", loading: false, error: null, run: runRef.current });
  }, [databaseIdentity, effectiveAccountId, finishRun, opts.historyKey, opts.itemId, opts.noteId, sessionKey]);

  const abort = useCallback(() => {
    requestSeqRef.current += 1;
    finishRun("cancelled", "用户停止生成");
    ctrlRef.current?.abort();
    setStreaming("");
    setLoading(false);
    publishAISession({ sessionKey, streaming: "", loading: false, run: runRef.current });
  }, [finishRun, sessionKey]);

  const retry = useCallback(() => {
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    if (lastUserMessage) send(lastUserMessage.content, true);
  }, [messages, send]);

  return { messages, streaming, loading, error, run, send, retry, clear, abort };
}
