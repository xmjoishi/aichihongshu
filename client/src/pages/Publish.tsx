import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Check, X, Send } from "lucide-react";
import { api, API_BASE, openInChromium } from "../lib/api";
import { Note } from "../lib/types";
import { Spinner, StatusBadge } from "../components/ui";
import { useToast } from "../components/Toast";

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
            onClick={() => openInChromium("https://creator.xiaohongshu.com/publish/publish")}
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
