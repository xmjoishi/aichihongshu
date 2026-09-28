import { useWorkspaceEffect } from "../lib/workspaceActivity";
import { useEffect, useMemo, useState } from "react";
import { BookmarkPlus, ExternalLink, FileText, Globe2, Plus, RefreshCw, Search, Sparkles, UserRound, X } from "lucide-react";
import { useToast } from "./Toast";
import { useAccountContext } from "../lib/accountContext";
import {
  IS_TAURI_RUNTIME,
  LOCAL_INSPIRATIONS_UPDATED_EVENT,
  convertLocalInspiration,
  createLocalDraft,
  readLocalInspirations,
  saveLocalInspiration,
  type LocalInspirationCreate,
  type LocalInspirationSummary,
} from "../lib/local";
import {
  BROWSER_CAPTURE_QUEUE_UPDATED_EVENT,
  markBrowserCaptureFailed,
  markBrowserCaptureSaving,
  removeBrowserCaptureQueueEntry,
  readBrowserCaptureQueue,
  validateBrowserCapture,
  type BrowserCaptureEnvelope,
  type ValidatedBrowserCapture,
} from "../lib/browserCapture";
import { listInspirations, type Inspiration } from "../lib/inspirationCapture";

type MaterialFilter = "all" | "note_material" | "profile_material" | "web_material";

const FILTERS: Array<[MaterialFilter, string]> = [
  ["all", "全部"],
  ["note_material", "笔记"],
  ["profile_material", "主页"],
  ["web_material", "网页"],
];

function materialTypeLabel(type?: string): string {
  if (type === "note_material") return "笔记素材";
  if (type === "profile_material") return "主页素材";
  return "网页素材";
}

function legacyInspirationToLocal(item: Inspiration): LocalInspirationCreate {
  return {
    id: item.id,
    accountPoolId: item.accountId,
    title: item.title,
    sourceUrl: item.sourceUrl,
    body: item.body,
    observedAt: item.observedAt,
    reason: item.reason,
    dedupeKey: item.dedupeKey,
    materialType: item.materialType ?? "web_material",
    author: item.author ?? "",
    captureModules: item.captureModules ?? [],
  };
}

function captureToLocal(capture: ValidatedBrowserCapture, id: string, accountPoolId: number): LocalInspirationCreate {
  return {
    id,
    accountPoolId,
    title: capture.title,
    sourceUrl: capture.sourceUrl,
    body: capture.modules.collect.titleBody ? capture.body : "",
    observedAt: capture.observedAt,
    reason: capture.reason,
    dedupeKey: capture.dedupeKey,
    materialType: capture.materialType,
    author: capture.modules.collect.authorSource ? capture.author : "",
    captureModules: [
      ...(capture.modules.collect.titleBody ? ["titleBody"] : []),
      ...(capture.modules.collect.authorSource ? ["authorSource"] : []),
      ...(capture.modules.data.metrics ? ["metrics"] : []),
    ],
  };
}

function bodyWithoutRepeatedTitle(body: string, title: string): string {
  const trimmedBody = body.trimStart();
  const trimmedTitle = title.trim();
  if (!trimmedTitle || !trimmedBody.startsWith(trimmedTitle)) return body;
  return trimmedBody.slice(trimmedTitle.length).replace(/^[\s:：，,。.!！?？、—-]+/u, "").trim();
}

function sourceLabel(sourceUrl: string): string {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./i, "");
    return host.includes("xiaohongshu") ? "小红书 · 打开原文" : `${host} · 打开原文`;
  } catch {
    return "打开原文";
  }
}

function materialIcon(type: string) {
  if (type === "note_material") return <FileText size={14} />;
  if (type === "profile_material") return <UserRound size={14} />;
  return <Globe2 size={14} />;
}

export default function BrowserCollectionPanel() {
  const { toast } = useToast();
  const { accountId, databaseIdentity } = useAccountContext();
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const [filter, setFilter] = useState<MaterialFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest" | "title">("newest");
  const [inspirations, setInspirations] = useState<LocalInspirationSummary[]>([]);
  const [captureFailures, setCaptureFailures] = useState<BrowserCaptureEnvelope[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [savingManual, setSavingManual] = useState(false);

  useWorkspaceEffect(() => {
    if (!IS_TAURI_RUNTIME || accountId === null) {
      setCaptureFailures([]);
      return;
    }
    const refresh = () => setCaptureFailures(readBrowserCaptureQueue(databaseIdentity, accountId).filter((entry) => entry.status === "failed"));
    refresh();
    window.addEventListener(BROWSER_CAPTURE_QUEUE_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(BROWSER_CAPTURE_QUEUE_UPDATED_EVENT, refresh);
  }, [accountId, databaseIdentity]);

  useEffect(() => {
    if (!IS_TAURI_RUNTIME || accountId === null) {
      setInspirations([]);
      return;
    }
    let active = true;
    setLoading(true);
    void (async () => {
      let items = await readLocalInspirations(accountId);
      // Migrate pre-SQLite manually saved bookmarks once, only when the local
      // table is empty. This preserves existing captures without duplicate rewrites.
      if (items.length === 0) {
        const legacy = listInspirations(databaseIdentity, accountId);
        for (const item of legacy) {
          try { await saveLocalInspiration(legacyInspirationToLocal(item)); }
          catch { /* Skip an invalid old entry and keep migrating the rest. */ }
        }
        if (legacy.length > 0) items = await readLocalInspirations(accountId);
      }

      // Upgrade pending captures from the previous confirmation-queue flow.
      // Persist them into SQLite and remove their transient envelopes only
      // after the database confirms the write.
      const oldCaptures = readBrowserCaptureQueue(databaseIdentity, accountId);
      for (const entry of oldCaptures) {
        if (entry.status === "saved") {
          removeBrowserCaptureQueueEntry(databaseIdentity, accountId, entry.envelopeId);
          continue;
        }
        try {
          await saveLocalInspiration(captureToLocal(entry.capture, entry.envelopeId, accountId));
          removeBrowserCaptureQueueEntry(databaseIdentity, accountId, entry.envelopeId);
        } catch (error) {
          markBrowserCaptureFailed(databaseIdentity, accountId, entry.envelopeId, error instanceof Error ? error.message : String(error));
        }
      }
      items = await readLocalInspirations(accountId);
      if (active) {
        setInspirations(items);
        setCaptureFailures(readBrowserCaptureQueue(databaseIdentity, accountId).filter((entry) => entry.status === "failed"));
      }
    })()
      .catch((error) => {
        if (active) toast(`读取网页收藏失败：${(error as Error).message}`, "error");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [accountId, databaseIdentity, toast]);

  useWorkspaceEffect(() => {
    if (!IS_TAURI_RUNTIME || accountId === null) return;
    let visible = true;
    const onUpdated = (event?: Event) => {
      const updatedAccount = (event as CustomEvent<{ accountPoolId?: number }> | undefined)?.detail?.accountPoolId;
      if (updatedAccount !== undefined && updatedAccount !== accountId) return;
      void readLocalInspirations(accountId).then((items) => { if (visible) setInspirations(items); }).catch((error) => {
        if (visible) toast(`刷新网页收藏失败：${(error as Error).message}`, "error");
      });
    };
    // Catch up on captures received while this retained page was hidden.
    onUpdated();
    window.addEventListener(LOCAL_INSPIRATIONS_UPDATED_EVENT, onUpdated);
    return () => { visible = false; window.removeEventListener(LOCAL_INSPIRATIONS_UPDATED_EVENT, onUpdated); };
  }, [accountId, toast]);

  useWorkspaceEffect(() => {
    if (!createOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCreateOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createOpen]);

  const matchingInspirations = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase();
    if (!query) return inspirations;
    return inspirations.filter((item) => [item.title, item.body, item.author, item.sourceUrl, item.reason]
      .some((value) => value.toLocaleLowerCase().includes(query)));
  }, [inspirations, searchTerm]);
  const visibleInspirations = useMemo(() => {
    const filtered = matchingInspirations.filter((item) => filter === "all" || item.materialType === filter);
    return filtered.sort((left, right) => {
      if (sortOrder === "title") return left.title.localeCompare(right.title, "zh-CN");
      const leftTime = Date.parse(left.observedAt) || 0;
      const rightTime = Date.parse(right.observedAt) || 0;
      return sortOrder === "newest" ? rightTime - leftTime : leftTime - rightTime;
    });
  }, [filter, matchingInspirations, sortOrder]);
  const cardColumnsClass = visibleInspirations.length === 1
    ? "mx-auto max-w-xl columns-1"
    : visibleInspirations.length === 2
      ? "mx-auto max-w-5xl columns-1 md:columns-2"
      : "columns-1 md:columns-2 xl:columns-3";

  async function refreshInspirations() {
    if (accountId === null) return;
    setInspirations(await readLocalInspirations(accountId));
  }

  async function retryCaptureSave(envelope: BrowserCaptureEnvelope) {
    if (!IS_TAURI_RUNTIME || accountId === null) return;
    if (envelope.targetAccountId !== accountId) {
      toast("当前账号已变化，请切回原账号后重试", "error");
      return;
    }
    if (envelope.status === "saving") return;
    const saving = markBrowserCaptureSaving(databaseIdentity, accountId, envelope.envelopeId);
    if (!saving) {
      toast("旧剪藏记录已变化，请刷新后重试", "error");
      return;
    }
    try {
      await saveLocalInspiration(captureToLocal(saving.capture, saving.envelopeId, accountId));
      removeBrowserCaptureQueueEntry(databaseIdentity, accountId, envelope.envelopeId);
      await refreshInspirations();
      toast("旧剪藏已迁入网页收藏", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markBrowserCaptureFailed(databaseIdentity, accountId, envelope.envelopeId, message);
      toast(`${message}；可以点击重试`, "error");
    }
  }

  async function saveManualCapture() {
    if (!IS_TAURI_RUNTIME || accountId === null || savingManual) return;
    const validated = validateBrowserCapture({
      title,
      sourceUrl,
      body,
      reason,
      targetAccountId: accountId,
      transport: "manual",
    }, accountId);
    if (!validated.ok) {
      toast(validated.message, "error");
      return;
    }
    try {
      setSavingManual(true);
      const capture = validated.value;
      await saveLocalInspiration(captureToLocal(capture, `manual:${crypto.randomUUID()}`, accountId));
      setTitle("");
      setSourceUrl("");
      setBody("");
      setReason("");
      setCreateOpen(false);
      await refreshInspirations();
      toast("收藏已保存", "success");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setSavingManual(false);
    }
  }

  async function convertToDraft(item: LocalInspirationSummary) {
    if (!IS_TAURI_RUNTIME || accountId === null || item.status === "converted") return;
    try {
      const draft = await createLocalDraft(item.title, accountId);
      await convertLocalInspiration(item.id, accountId, draft.id);
      await refreshInspirations();
      toast("已转为笔记草稿", "success");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-canvas)] p-6">
      <div className="mx-auto max-w-7xl space-y-5 pb-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="sr-only">网页收藏</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-[var(--color-text-secondary)]">{accountId === null ? "等待当前账号就绪" : "当前账号"}</span>
            {IS_TAURI_RUNTIME && <button type="button" onClick={() => setCreateOpen(true)} disabled={accountId === null} className="inline-flex items-center gap-1.5 rounded-xl bg-[#ff2442] px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-[#e61f3b] disabled:opacity-50"><Plus size={16} />新增收藏</button>}
          </div>
        </div>

        {!IS_TAURI_RUNTIME ? (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-text-secondary)]">
            网页收藏当前保存在桌面端本地数据库，请在桌面应用中查看。
          </div>
        ) : (
          <>
            {captureFailures.length > 0 && (
              <section className="rounded-2xl border border-red-200 bg-red-50/70 p-4">
                <div className="mb-3 flex items-center justify-between text-sm font-medium text-red-800">
                  <span>旧剪藏迁入失败 · {captureFailures.length}</span>
                  <span className="text-xs font-normal">重试成功后会直接出现在收藏卡片中</span>
                </div>
                <div className="space-y-2">
                  {captureFailures.map((entry) => (
                    <div key={entry.envelopeId} className="flex flex-wrap items-center gap-2 rounded-lg border border-red-100 bg-white px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{entry.capture.title}</span>
                      <span className="text-xs text-red-600">保存失败</span>
                      {entry.error && <span className="max-w-[220px] truncate text-xs text-red-500" title={entry.error}>{entry.error}</span>}
                      <button type="button" disabled={entry.status === "saving"} onClick={() => void retryCaptureSave(entry)} className="shrink-0 rounded-md border border-[#ff2442] px-2.5 py-1 text-xs text-[#ff2442] disabled:opacity-40">重试入库</button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text-primary)]"><Sparkles size={16} className="text-[#ff2442]" />已收藏内容</div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <label className="flex h-9 min-w-[220px] items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[var(--color-text-secondary)] focus-within:border-[#ff2442]">
                  <Search size={14} />
                  <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="搜索标题、正文、作者、来源" className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-secondary)]" />
                </label>
                <select aria-label="收藏排序" value={sortOrder} onChange={(event) => setSortOrder(event.target.value as "newest" | "oldest" | "title")} className="h-9 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs text-[var(--color-text-secondary)] outline-none focus:border-[#ff2442]">
                  <option value="newest">最近收藏</option>
                  <option value="oldest">最早收藏</option>
                  <option value="title">标题排序</option>
                </select>
                <div role="tablist" aria-label="按收藏来源筛选" className="flex flex-wrap gap-1.5">
                  {FILTERS.map(([key, label]) => (
                    <button key={key} type="button" role="tab" aria-selected={filter === key} onClick={() => setFilter(key)} className={`rounded-full border bg-[var(--color-surface)] px-3 py-1.5 text-xs transition-colors ${filter === key ? "border-[#ff2442] text-[#ff2442]" : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"}`}>
                      {label}{key === "all" ? ` · ${matchingInspirations.length}` : ` · ${matchingInspirations.filter((item) => item.materialType === key).length}`}
                    </button>
                  ))}
                </div>
              </div>
            </div>
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--color-text-secondary)]"><RefreshCw size={15} className="animate-spin" />正在读取收藏…</div>
              ) : visibleInspirations.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-12 text-center text-sm text-[var(--color-text-secondary)]">
                  {searchTerm.trim()
                    ? matchingInspirations.length > 0 ? "其他来源有匹配项，请调整来源筛选。" : "没有找到匹配的收藏。"
                    : `这里还没有${filter === "all" ? "收藏内容" : FILTERS.find(([key]) => key === filter)?.[1] + "素材"}。使用浏览器插件收藏，或点击右上角「新增收藏」。`}
                </div>
              ) : (
                <div className={`${cardColumnsClass} gap-4`}>
                  {visibleInspirations.map((item) => {
                    const body = bodyWithoutRepeatedTitle(item.body, item.title);
                    return <article key={item.id} className="mb-4 break-inside-avoid overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs text-[var(--color-text-secondary)]">{materialIcon(item.materialType)}{materialTypeLabel(item.materialType)}</span>
                        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] text-emerald-700">{item.status === "converted" ? "已转草稿" : "已收藏"}</span>
                      </div>
                      <div className="p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="min-w-0 flex-1 text-sm font-semibold leading-5 text-[var(--color-text-primary)]">{item.title}</h3>
                          {item.author && <span className="text-xs text-[var(--color-text-secondary)]">{item.author}</span>}
                        </div>
                        {body ? <p className="mt-2 line-clamp-5 whitespace-pre-line text-sm leading-6 text-[var(--color-text-secondary)]">{body}</p> : <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">尚未获取正文</p>}
                        {item.reason && <p className="mt-3 border-l-2 border-[#ffb4c0] pl-3 text-xs leading-5 text-[var(--color-text-secondary)]">{item.reason}</p>}
                        {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer" referrerPolicy="no-referrer" aria-label={`打开原文：${sourceLabel(item.sourceUrl)}`} className="mt-3 flex items-center gap-1.5 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[#ff2442] hover:underline"><ExternalLink size={12} /><span className="min-w-0 truncate">{sourceLabel(item.sourceUrl)}</span></a>}
                      </div>
                      <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] px-4 py-3">
                        <time className="text-[10px] text-[var(--color-text-secondary)]" dateTime={item.observedAt}>{new Date(item.observedAt).toLocaleDateString()}</time>
                        {item.status === "saved" && <button type="button" onClick={() => void convertToDraft(item)} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition hover:border-[#ff2442] hover:text-[#ff2442]">转为草稿</button>}
                      </div>
                    </article>
                  })}
                </div>
              )}
          </>
        )}
      </div>
      {createOpen && IS_TAURI_RUNTIME && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="add-collection-title" className="max-h-[min(90vh,760px)] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h3 id="add-collection-title" className="text-base font-semibold text-[var(--color-text-primary)]">新增网页收藏</h3>
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">保存标题、来源链接和自己的观察，归入当前账号。</p>
              </div>
              <button type="button" onClick={() => setCreateOpen(false)} aria-label="关闭弹窗" className="rounded-lg p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"><X size={18} /></button>
            </div>
            <form onSubmit={(event) => { event.preventDefault(); void saveManualCapture(); }} className="space-y-3">
              <label className="block text-xs font-medium text-[var(--color-text-secondary)]">标题<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="给这条收藏起个标题" className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm font-normal text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]" /></label>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)]">来源链接（可选）<input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://..." className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm font-normal text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]" /></label>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)]">摘录 / 观察<textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="记录你看到的内容或值得留意的细节" className="mt-1.5 h-36 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm font-normal text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]" /></label>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)]">为什么值得参考<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="可选，补充之后可能用到的原因" className="mt-1.5 h-20 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm font-normal text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]" /></label>
              <div className="flex justify-end gap-2 border-t border-[var(--color-border)] pt-4">
                <button type="button" onClick={() => setCreateOpen(false)} className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]">取消</button>
                <button type="submit" disabled={!title.trim() || savingManual} className="inline-flex items-center gap-1.5 rounded-lg bg-[#ff2442] px-4 py-2 text-sm font-medium text-white hover:bg-[#e61f3b] disabled:opacity-50"><BookmarkPlus size={14} />{savingManual ? "正在保存…" : "保存收藏"}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
