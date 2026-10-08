import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, FolderOpen, Images, Loader2, Send, X } from "lucide-react";
import LocalImage from "../../components/LocalImage";
import { useToast } from "../../components/Toast";
import { api, API_BASE, openInSystemBrowser } from "../../lib/api";
import type { Note } from "../../lib/types";

// ── Publish Modal ─────────────────────────────────────────────────────────────

type StageFile = { index: number; filename: string; item_id: number; title: string; url: string };

export function PublishModal({
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
  const [staging, setStaging] = useState(false);
  const [stageFiles, setStageFiles] = useState<StageFile[] | null>(null);
  const [stageDir, setStageDir] = useState<string>("");
  const { toast } = useToast();

  const hasImages = (note.item_ids?.length ?? 0) > 0;

  const tagLine = note.tags.length > 0
    ? "\n\n" + note.tags.map((t) => `#${t}`).join(" ")
    : "";
  const fullText = `${note.title ?? ""}\n\n${note.body ?? ""}${tagLine}`.trim();

  // 进入时自动暂存图片
  useEffect(() => {
    if (!hasImages) return;
    prepareImages();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function prepareImages() {
    setStaging(true);
    try {
      const res = await api.post(`/api/content/${note.id}/stage-images`, {});
      setStageFiles(res.files ?? []);
      setStageDir(res.stage_dir ?? "");
    } catch {
      // 非致命错误，不影响发布流程
    } finally {
      setStaging(false);
    }
  }

  async function openInFinder() {
    try {
      await api.post(`/api/content/${note.id}/open-stage-dir`, {});
    } catch {
      toast("无法打开文件夹", "error");
    }
  }

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
      // 清理暂存目录
      if (stageFiles !== null) {
        api.delete(`/api/content/${note.id}/stage-images`).catch(() => {});
      }
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
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
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

          {/* ── 图片暂存区 ── */}
          {hasImages && (
            <div className="rounded-xl border border-zinc-200 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-zinc-50 border-b border-zinc-100">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-600">
                  <Images size={13} />
                  配图暂存
                  {stageFiles !== null && (
                    <span className="text-zinc-400 font-normal">（{stageFiles.length} 张，按顺序上传）</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {stageFiles !== null && stageDir && (
                    <button
                      onClick={openInFinder}
                      className="flex items-center gap-1 text-xs text-zinc-500 hover:text-[#ff2442] transition-colors px-2 py-1 rounded-lg hover:bg-zinc-100"
                      title="在 Finder 中打开暂存文件夹"
                    >
                      <FolderOpen size={12} />
                      打开文件夹
                    </button>
                  )}
                  {staging && (
                    <span className="text-xs text-zinc-400 flex items-center gap-1">
                      <Loader2 size={11} className="animate-spin" />准备中…
                    </span>
                  )}
                </div>
              </div>

              {/* 图片网格 */}
              {stageFiles === null && !staging ? (
                <div className="px-3 py-3 flex gap-2 overflow-x-auto">
                  {note.item_ids!.map((id) => (
                    <LocalImage key={id} itemId={id} src={`${API_BASE}/api/library/${id}/image`}
                      className="w-20 h-20 rounded-xl object-cover shrink-0 bg-zinc-100" alt=""
                    />
                  ))}
                </div>
              ) : stageFiles !== null && stageFiles.length > 0 ? (
                <div className="px-3 py-3 flex gap-2 overflow-x-auto">
                  {stageFiles.map((f) => (
                    <div key={f.filename} className="shrink-0 flex flex-col items-center gap-1">
                      <div className="relative">
                        <LocalImage
                          itemId={f.item_id}
                          src={`${API_BASE}${f.url}`}
                          className="w-20 h-20 rounded-xl object-cover bg-zinc-100"
                          alt={f.title}
                        />
                        <span className="absolute top-1 left-1 bg-black/60 text-white text-[10px] rounded-md px-1 py-0.5 leading-none">
                          {f.index}
                        </span>
                      </div>
                      <span className="text-[10px] text-zinc-400 max-w-[80px] truncate">{f.title || f.filename}</span>
                    </div>
                  ))}
                </div>
              ) : staging ? (
                <div className="px-3 py-5 flex justify-center">
                  <Loader2 size={20} className="animate-spin text-zinc-300" />
                </div>
              ) : null}

              {/* 提示文字 */}
              {stageFiles !== null && (
                <div className="px-3 py-2 bg-amber-50 border-t border-amber-100">
                  <p className="text-[11px] text-amber-700 leading-relaxed">
                    图片已复制到暂存文件夹，请点击「打开文件夹」后按编号顺序拖拽上传到小红书。确认发布后将自动清理。
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── 标题 ── */}
          <div className="bg-zinc-50 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-zinc-500">标题</span>
              <button onClick={() => copy("title")}
                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-[#ff2442] transition-colors">
                {copied === "title" ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
                {copied === "title" ? "已复制" : "复制"}
              </button>
            </div>
            <p className="text-sm text-zinc-800 font-medium leading-snug">{note.title || "（无标题）"}</p>
          </div>

          {/* ── 正文 ── */}
          <div className="bg-zinc-50 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-zinc-500">正文 + 标签</span>
              <button onClick={() => copy("body")}
                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-[#ff2442] transition-colors">
                {copied === "body" ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
                {copied === "body" ? "已复制" : "复制"}
              </button>
            </div>
            <p className="text-xs text-zinc-700 whitespace-pre-wrap leading-relaxed line-clamp-6">{note.body || "（无正文）"}</p>
            {note.tags.length > 0 && (
              <p className="text-xs text-[#ff2442] mt-2">{note.tags.map((t) => `#${t}`).join(" ")}</p>
            )}
          </div>

          {/* ── 一键复制 + 打开发布页 ── */}
          <button onClick={() => copy("all")}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 border-dashed border-zinc-200 text-xs text-zinc-500 hover:border-[#ff2442] hover:text-[#ff2442] transition-colors">
            {copied === "all" ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
            {copied === "all" ? "已复制全文" : "一键复制全文（标题 + 正文 + 标签）"}
          </button>
          <button onClick={() => openInSystemBrowser("https://creator.xiaohongshu.com/publish/publish")}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#ff2442] text-white text-xs font-medium hover:bg-[#e01f3a] transition-colors">
            <ExternalLink size={13} />打开小红书发布页
          </button>

          {/* ── 笔记链接 ── */}
          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">发布后粘贴笔记链接（可选，用于数据追踪）</label>
            <input type="text" value={noteUrl} onChange={(e) => setNoteUrl(e.target.value)}
              placeholder="https://www.xiaohongshu.com/explore/..."
              className="w-full text-xs border border-zinc-200 rounded-xl px-3 py-2 outline-none focus:border-[#ff2442] transition-colors placeholder:text-zinc-300" />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-zinc-100 shrink-0 flex gap-2">
          <button onClick={onClose}
            className="flex-1 py-2 rounded-xl border border-zinc-200 text-xs text-zinc-500 hover:bg-zinc-50 transition-colors">
            稍后再说
          </button>
          <button onClick={confirmPublished} disabled={saving}
            className="flex-1 py-2 rounded-xl bg-green-500 text-white text-xs font-medium hover:bg-green-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5">
            <Check size={13} />{saving ? "保存中…" : "确认已发布"}
          </button>
        </div>
      </div>
    </div>
  );
}
