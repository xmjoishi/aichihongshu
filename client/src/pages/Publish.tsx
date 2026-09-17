import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Check, X, Send } from "lucide-react";
import { api, API_BASE, openInSystemBrowser } from "../lib/api";
import { Note } from "../lib/types";
import { Spinner, StatusBadge } from "../components/ui";
import { useToast } from "../components/Toast";
import LocalImage from "../components/LocalImage";
import {
  IS_TAURI_RUNTIME,
  localNoteToNote,
  readLocalWorkspaceSnapshot,
  updateLocalNoteStatus,
  type LocalWorkspaceSnapshot,
} from "../lib/local";
import { useAccountContext } from "../lib/accountContext";
import { preparePublish, type PublishPreparation } from "../lib/publishPreparation";

// ─── 发布助手弹窗 ─────────────────────────────────────────────

function PublishModal({
  note,
  onClose,
  onPublished,
}: {
  note: Note;
  onClose: () => void;
  onPublished: (noteUrl: string) => void;
}) {
  const [noteUrl, setNoteUrl] = useState(note.note_url ?? "");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<"title" | "body" | "all" | null>(null);
  const { toast } = useToast();

  // 拼装正文 + 标签
  const tagLine = note.tags.length > 0
    ? "\n\n" + note.tags.map((t) => `#${t}`).join(" ")
    : "";
  const fullText = `${note.title ?? ""}\n\n${note.body ?? ""}${tagLine}`.trim();

  async function copy(type: "title" | "body" | "all") {
    const text =
      type === "title" ? (note.title ?? "") :
      type === "body"  ? `${note.body ?? ""}${tagLine}` :
      fullText;
    await navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 1500);
  }

  async function confirmPublished() {
    setSaving(true);
    try {
      await api.patch(`/api/content/${note.id}/status`, {
        status: "published",
        note_url: noteUrl || undefined,
      });
      toast("已标记为发布 ✓", "success");
      onPublished(noteUrl);
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 shrink-0">
          <div className="flex items-center gap-2">
            <Send size={16} className="text-[#ff2442]" />
            <span className="font-semibold text-zinc-800 text-sm">发布助手</span>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 图片预览 */}
          {note.item_ids && note.item_ids.length > 0 && (
            <div>
              <p className="text-xs text-zinc-400 mb-2">配图（共 {note.item_ids.length} 张）</p>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {note.item_ids.map((id) => (
                  <img
                    key={id}
                    src={`${API_BASE}/api/library/${id}/image`}
                    className="w-20 h-20 rounded-xl object-cover shrink-0 bg-zinc-100"
                    alt=""
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 标题 */}
          <div className="bg-zinc-50 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-zinc-500">标题</span>
              <button
                onClick={() => copy("title")}
                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-[#ff2442] transition-colors"
              >
                {copied === "title" ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
                {copied === "title" ? "已复制" : "复制"}
              </button>
            </div>
            <p className="text-sm text-zinc-800 font-medium leading-snug">
              {note.title || "（无标题）"}
            </p>
          </div>

          {/* 正文 + 标签 */}
          <div className="bg-zinc-50 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-zinc-500">正文 + 标签</span>
              <button
                onClick={() => copy("body")}
                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-[#ff2442] transition-colors"
              >
                {copied === "body" ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
                {copied === "body" ? "已复制" : "复制"}
              </button>
            </div>
            <p className="text-xs text-zinc-700 whitespace-pre-wrap leading-relaxed line-clamp-6">
              {note.body || "（无正文）"}
            </p>
            {note.tags.length > 0 && (
              <p className="text-xs text-[#ff2442] mt-2">
                {note.tags.map((t) => `#${t}`).join(" ")}
              </p>
            )}
          </div>

          {/* 一键复制全文 */}
          <button
            onClick={() => copy("all")}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl
                       border-2 border-dashed border-zinc-200 text-xs text-zinc-500
                       hover:border-[#ff2442] hover:text-[#ff2442] transition-colors"
          >
            {copied === "all" ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
            {copied === "all" ? "已复制全文" : "一键复制全文（标题 + 正文 + 标签）"}
          </button>

          {/* 跳转小红书 */}
          <button
            onClick={() => openInSystemBrowser("https://creator.xiaohongshu.com/publish/publish")}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl
                       bg-[#ff2442] text-white text-xs font-medium hover:bg-[#e01f3a] transition-colors"
          >
            <ExternalLink size={13} />
            打开小红书发布页
          </button>

          {/* 填写笔记链接 */}
          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">
              发布后粘贴笔记链接（可选，用于数据追踪）
            </label>
            <input
              type="text"
              value={noteUrl}
              onChange={(e) => setNoteUrl(e.target.value)}
              placeholder="https://www.xiaohongshu.com/explore/..."
              className="w-full text-xs border border-zinc-200 rounded-xl px-3 py-2
                         outline-none focus:border-[#ff2442] transition-colors placeholder:text-zinc-300"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-zinc-100 shrink-0 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-xl border border-zinc-200 text-xs text-zinc-500
                       hover:bg-zinc-50 transition-colors"
          >
            稍后再说
          </button>
          <button
            onClick={confirmPublished}
            disabled={saving}
            className="flex-1 py-2 rounded-xl bg-green-500 text-white text-xs font-medium
                       hover:bg-green-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
          >
            <Check size={13} />
            {saving ? "保存中…" : "确认已发布"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 主页面 ───────────────────────────────────────────────────

export default function Publish() {
  if (IS_TAURI_RUNTIME) return <LocalPublishWorkflow />;

  const qc = useQueryClient();
  const { toast } = useToast();
  const [publishingNote, setPublishingNote] = useState<Note | null>(null);

  const { data: notes = [], isLoading } = useQuery<Note[]>({
    queryKey: ["notes-all"],
    queryFn: () => api.get("/api/content/"),
  });

  const columns: { status: "draft" | "ready" | "published"; label: string; color: string }[] = [
    { status: "draft", label: "草稿", color: "border-zinc-200" },
    { status: "ready", label: "待发布", color: "border-amber-300" },
    { status: "published", label: "已发布", color: "border-green-300" },
  ];

  async function moveTo(noteId: number, newStatus: "draft" | "ready" | "published", noteUrl?: string) {
    qc.setQueryData<Note[]>(["notes-all"], (old = []) =>
      old.map((n) => (n.id === noteId ? { ...n, status: newStatus } : n))
    );
    qc.setQueryData<Note[]>(["notes"], (old = []) =>
      old.map((n) => (n.id === noteId ? { ...n, status: newStatus } : n))
    );
    try {
      await api.patch(`/api/content/${noteId}/status`, {
        status: newStatus,
        ...(noteUrl ? { note_url: noteUrl } : {}),
      });
      qc.invalidateQueries({ queryKey: ["notes-all"] });
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["analytics"] });
    } catch (e: unknown) {
      qc.invalidateQueries({ queryKey: ["notes-all"] });
      toast((e as Error).message, "error");
    }
  }

  function handlePublished(noteUrl: string) {
    if (!publishingNote) return;
    moveTo(publishingNote.id, "published", noteUrl);
    setPublishingNote(null);
  }

  if (isLoading) return <Spinner />;

  return (
    <>
      {publishingNote && (
        <PublishModal
          note={publishingNote}
          onClose={() => setPublishingNote(null)}
          onPublished={handlePublished}
        />
      )}

      <div className="flex flex-col h-full">
        <div className="flex items-center px-6 py-4 border-b border-zinc-100 bg-white">
          <h1 className="text-lg font-semibold text-zinc-900">发布工作流</h1>
          <span className="ml-3 text-xs text-zinc-400">拖动或点按钮推进状态，待发布笔记可一键发布</span>
        </div>

        <div className="flex-1 overflow-x-auto p-6">
          <div className="flex gap-4 h-full min-h-0" style={{ minWidth: "700px" }}>
            {columns.map((col) => {
              const colNotes = notes.filter((n) => n.status === col.status);
              return (
                <div key={col.status} className="flex-1 flex flex-col min-w-52">
                  <div className={`flex items-center gap-2 mb-3 pb-2 border-b-2 ${col.color}`}>
                    <StatusBadge status={col.status} />
                    <span className="text-xs text-zinc-400">({colNotes.length})</span>
                  </div>
                  <div className="flex-1 overflow-y-auto space-y-2">
                    {colNotes.length === 0 ? (
                      <p className="text-xs text-zinc-300 text-center py-8">暂无</p>
                    ) : (
                      colNotes.map((note) => (
                        <div key={note.id}
                          className="bg-white rounded-xl p-3 border border-zinc-100 shadow-sm
                                     transition-all hover:shadow-md hover:-translate-y-0.5">
                          <p className="text-xs font-medium text-zinc-800 line-clamp-2 mb-2">
                            {note.title || "（未填写标题）"}
                          </p>
                          {note.tags.length > 0 && (
                            <p className="text-xs text-[#ff2442] mb-2 truncate">
                              {note.tags.slice(0, 3).map((t) => `#${t}`).join(" ")}
                            </p>
                          )}
                          {note.status === "published" && (
                            <div className="flex gap-3 text-xs text-zinc-400 mb-2">
                              <span>❤ {note.likes}</span>
                              <span>💬 {note.comments}</span>
                              <span>⭐ {note.collects}</span>
                            </div>
                          )}
                          <div className="flex gap-1 flex-wrap">
                            {col.status !== "draft" && (
                              <button onClick={() => moveTo(note.id, "draft")}
                                className="text-xs text-zinc-400 hover:text-zinc-600 border border-zinc-100 px-2 py-0.5 rounded transition-colors">
                                退回草稿
                              </button>
                            )}
                            {col.status === "draft" && (
                              <button onClick={() => moveTo(note.id, "ready")}
                                className="text-xs text-amber-600 border border-amber-200 bg-amber-50 px-2 py-0.5 rounded hover:bg-amber-100 transition-colors">
                                → 待发
                              </button>
                            )}
                            {col.status === "ready" && (
                              <button
                                onClick={() => setPublishingNote(note)}
                                className="flex items-center gap-1 text-xs text-white bg-[#ff2442] px-2.5 py-1 rounded-lg hover:bg-[#e01f3a] transition-colors font-medium"
                              >
                                <Send size={10} />
                                发布
                              </button>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Local mode keeps publish preparation and manual confirmation in Rust SQLite.
 * It deliberately never submits to the platform or calls the legacy API.
 */
function LocalPublishWorkflow() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { accountId, scopeKey } = useAccountContext();
  const [publishingNote, setPublishingNote] = useState<Note | null>(null);
  const { data: workspace, isLoading, error } = useQuery<LocalWorkspaceSnapshot>({
    queryKey: ["local-publish", scopeKey],
    queryFn: () => readLocalWorkspaceSnapshot(accountId ?? undefined),
    enabled: accountId !== null,
  });

  const notes = (workspace?.notes ?? []).map(localNoteToNote);
  const columns: { status: Note["status"]; label: string; color: string }[] = [
    { status: "draft", label: "草稿", color: "border-zinc-200" },
    { status: "ready", label: "待发布", color: "border-amber-300" },
    { status: "published", label: "已确认发布", color: "border-green-300" },
  ];

  async function moveTo(note: Note, status: Note["status"], noteUrl?: string): Promise<boolean> {
    if (accountId === null) {
      toast("当前账号尚未就绪", "error");
      return false;
    }
    try {
      await updateLocalNoteStatus({
        noteId: note.id,
        accountPoolId: accountId,
        expectedVersion: note.content_version ?? 1,
        status,
        noteUrl,
      });
      await qc.invalidateQueries({ queryKey: ["local-publish", scopeKey] });
      toast(status === "published" ? "已记录为手工确认发布" : "状态已更新", "success");
      return true;
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), "error");
      return false;
    }
  }

  if (isLoading) return <Spinner />;
  if (error) return <div className="p-6 text-sm text-red-500">本地发布工作流读取失败：{String(error)}</div>;

  return (
    <>
      {publishingNote && (
        <LocalPublishModal
          note={publishingNote}
          accountId={accountId}
          onClose={() => setPublishingNote(null)}
          onConfirmed={async (url) => {
            if (await moveTo(publishingNote, "published", url)) {
              setPublishingNote(null);
            }
          }}
        />
      )}
      <div className="flex h-full flex-col">
        <div className="flex items-center px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">发布准备</h1>
          <span className="ml-3 text-xs text-[var(--color-text-secondary)]">本地快照、复制和手工确认；不会自动提交平台</span>
        </div>
        <div className="flex-1 overflow-x-auto p-6">
          <div className="flex gap-4 h-full min-h-0" style={{ minWidth: "700px" }}>
            {columns.map((column) => {
              const columnNotes = notes.filter((note) => note.status === column.status);
              return (
                <div key={column.status} className="flex-1 flex flex-col min-w-52">
                  <div className={`flex items-center gap-2 mb-3 pb-2 border-b-2 ${column.color}`}>
                    <StatusBadge status={column.status} />
                    <span className="text-xs text-[var(--color-text-secondary)]">({columnNotes.length})</span>
                  </div>
                  <div className="flex-1 overflow-y-auto space-y-2">
                    {columnNotes.length === 0 ? <p className="text-xs text-zinc-300 text-center py-8">暂无</p> : columnNotes.map((note) => (
                      <div key={note.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm">
                        <p className="text-xs font-medium text-[var(--color-text-primary)] line-clamp-2 mb-2">{note.title || "（未填写标题）"}</p>
                        <p className="text-[11px] text-[var(--color-text-secondary)] mb-2">版本 v{note.content_version ?? 1} · {note.item_ids?.length ?? 0} 张素材</p>
                        <div className="flex gap-1 flex-wrap">
                          {column.status === "draft" && (
                            <button onClick={() => void moveTo(note, "ready")} className="text-xs text-amber-600 border border-amber-200 bg-amber-50 px-2 py-0.5 rounded hover:bg-amber-100">→ 待发布</button>
                          )}
                          {column.status === "ready" && (
                            <button onClick={() => setPublishingNote(note)} className="flex items-center gap-1 text-xs text-white bg-[#ff2442] px-2.5 py-1 rounded-lg hover:bg-[#e01f3a] font-medium"><Send size={10} />发布准备</button>
                          )}
                          {column.status !== "draft" && (
                            <button onClick={() => void moveTo(note, "draft")} className="text-xs text-zinc-500 border border-zinc-200 px-2 py-0.5 rounded hover:bg-zinc-50">退回草稿</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

function LocalPublishModal({
  note,
  accountId,
  onClose,
  onConfirmed,
}: {
  note: Note;
  accountId: number | null;
  onClose: () => void;
  onConfirmed: (noteUrl?: string) => Promise<void>;
}) {
  const { toast } = useToast();
  const [noteUrl, setNoteUrl] = useState(note.note_url ?? "");
  const [copied, setCopied] = useState<"title" | "body" | "all" | null>(null);
  const [saving, setSaving] = useState(false);
  const preparation: PublishPreparation = preparePublish(note, accountId);
  const tagLine = note.tags.length ? `\n\n${note.tags.map((tag) => `#${tag}`).join(" ")}` : "";
  const fullText = `${note.title ?? ""}\n\n${note.body ?? ""}${tagLine}`.trim();

  async function copy(type: "title" | "body" | "all") {
    const text = type === "title" ? (note.title ?? "") : type === "body" ? `${note.body ?? ""}${tagLine}` : fullText;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(type);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast("剪贴板不可用，请手动复制", "error");
    }
  }

  async function confirmPublished() {
    if (!preparation.ready) {
      toast(preparation.issues.map((issue) => issue.message).join("；"), "warning");
      return;
    }
    setSaving(true);
    try {
      await onConfirmed(noteUrl.trim() || undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2"><Send size={16} className="text-[#ff2442]" /><span className="font-semibold text-sm text-[var(--color-text-primary)]">发布准备</span></div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className={`rounded-xl border px-3 py-2 text-xs ${preparation.ready ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`} role="status">
            <p className="font-medium">{preparation.ready ? "内容检查通过" : "内容检查未通过"}</p>
            <p className="mt-1 break-all">快照：{preparation.snapshotKey}</p>
            {!preparation.ready && <p className="mt-1">{preparation.issues.map((issue) => issue.message).join("；")}</p>}
          </div>
          {note.item_ids?.length ? <div className="flex gap-2 overflow-x-auto">{note.item_ids.map((id) => <LocalImage key={id} itemId={id} src="" variant="thumbnail" className="h-16 w-16 shrink-0 rounded-lg object-cover bg-zinc-100" alt="" />)}</div> : null}
          <div className="rounded-xl bg-[var(--color-surface-2)] p-3"><div className="flex items-center justify-between mb-1.5"><span className="text-xs text-[var(--color-text-secondary)]">标题</span><button onClick={() => void copy("title")} className="text-xs text-zinc-400 hover:text-[#ff2442]">{copied === "title" ? "已复制" : "复制"}</button></div><p className="text-sm font-medium text-[var(--color-text-primary)]">{note.title || "（无标题）"}</p></div>
          <div className="rounded-xl bg-[var(--color-surface-2)] p-3"><div className="flex items-center justify-between mb-1.5"><span className="text-xs text-[var(--color-text-secondary)]">正文 + 标签</span><button onClick={() => void copy("body")} className="text-xs text-zinc-400 hover:text-[#ff2442]">{copied === "body" ? "已复制" : "复制"}</button></div><p className="text-xs text-[var(--color-text-primary)] whitespace-pre-wrap leading-relaxed max-h-36 overflow-y-auto">{note.body || "（无正文）"}</p></div>
          <button onClick={() => void copy("all")} className="w-full rounded-xl border-2 border-dashed border-zinc-200 py-2.5 text-xs text-zinc-500 hover:border-[#ff2442] hover:text-[#ff2442]">{copied === "all" ? "已复制全文" : "一键复制全文（标题 + 正文 + 标签）"}</button>
          <button onClick={() => openInSystemBrowser("https://creator.xiaohongshu.com/publish/publish")} className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#ff2442] text-white text-xs font-medium hover:bg-[#e01f3a]"><ExternalLink size={13} />打开小红书发布页</button>
          <label className="block text-xs text-[var(--color-text-secondary)]">发布后粘贴笔记链接（可选）<input value={noteUrl} onChange={(event) => setNoteUrl(event.target.value)} placeholder="https://www.xiaohongshu.com/explore/..." className="mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs" /></label>
          <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg px-3 py-2">这里不会自动提交平台。只有你在平台完成发布后，点击底部按钮才会记录为“已确认发布”。</p>
        </div>
        <div className="px-5 py-4 border-t border-[var(--color-border)] flex gap-2"><button onClick={onClose} className="flex-1 py-2 rounded-xl border border-zinc-200 text-xs text-zinc-500 hover:bg-zinc-50">稍后再说</button><button onClick={() => void confirmPublished()} disabled={saving || !preparation.ready} className="flex-1 py-2 rounded-xl bg-green-500 text-white text-xs font-medium hover:bg-green-600 disabled:opacity-50">{saving ? "保存中…" : "确认已发布"}</button></div>
      </div>
    </div>
  );
}
