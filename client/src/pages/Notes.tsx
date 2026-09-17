import { useState, useEffect, useRef } from "react";
import { usePanelResize } from "../hooks/usePanelResize";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { api, API_BASE, openInBrowser, openInSystemBrowser, riskAckHeader } from "../lib/api";
import { NOTE_TYPE_GROUPS, getNoteTypeBadge, type NoteType } from "../lib/noteTypes";
import { Note, Item } from "../lib/types";
import { Dialog, Spinner, Empty, StatusBadge, primaryButtonClass, secondaryButtonClass } from "../components/ui";
import LocalImage from "../components/LocalImage";
import { Save, Copy, ChevronRight, Sparkles, ImagePlus, Hash, FileText, Trash2, X, Search, Send, Check, ExternalLink, Rocket, Loader2, FolderOpen, Images } from "lucide-react";
import AIPanel from "../components/AIPanel";
import { useToast } from "../components/Toast";
import { useRiskConfirm } from "../components/useRiskConfirm";
import { useHDRSetting } from "../hooks/useHDRSetting";
import { useDebounce } from "../hooks/useDebounce";
import BodyEditor from "../components/BodyEditor";
import {
  IS_TAURI_RUNTIME,
  createLocalDraft,
  deleteLocalNote,
  localItemToItem,
  localNoteToNote,
  readLocalWorkspaceSnapshot,
  restoreLocalNote,
  updateLocalNote,
  updateLocalNoteItems,
  updateLocalNoteStatus,
  type LocalWorkspaceSnapshot,
} from "../lib/local";
import { useAccountChange, useAccountContext } from "../lib/accountContext";
import { getCapability } from "../lib/capabilities";
import {
  createProposal,
  isProposalCurrent,
  listProposals,
  saveProposal,
  type AIProposal,
} from "../lib/aiProposal";
import { preparePublish, type PublishPreparation } from "../lib/publishPreparation";
import { noteToMarkdown } from "../lib/noteMarkdown";


const AUTOSAVE_DELAY = 1500; // ms
const NOTES_VIEW_KEY = "aichihongshu.notes-view.v1";

function notesViewKey(scopeKey: string): string {
  return `${NOTES_VIEW_KEY}:${encodeURIComponent(scopeKey)}`;
}

// ── Publish Modal ─────────────────────────────────────────────────────────────

type StageFile = { index: number; filename: string; item_id: number; title: string; url: string };

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
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] flex flex-col overflow-hidden">
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

// ── Note List ────────────────────────────────────────────────────────────────

export function NoteList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { accountId, scopeKey } = useAccountContext();
  const noteRead = getCapability("note.read");
  const noteWrite = getCapability("note.write");
  const noteStatusWrite = getCapability("note.status.write");
  const noteDelete = getCapability("note.delete");
  const publish = getCapability("publish");
  const { confirmAndRetry, dialog: riskDialog } = useRiskConfirm();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("created_desc");
  const [showTrash, setShowTrash] = useState(false);

  function handleStatusChange(key: string) {
    setStatusFilter(key);
    // 已发 tab 默认按发布时间倒序，其他 tab 保持最新创建
    if (key === "published") setSort("published_desc");
    else setSort("created_desc");
  }
  const { imgStyle } = useHDRSetting();
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [publishingNote, setPublishingNote] = useState<Note | null>(null);
  const [autoPublishingId, setAutoPublishingId] = useState<number | null>(null);
  const [newDraftOpen, setNewDraftOpen] = useState(false);
  const [newDraftTitle, setNewDraftTitle] = useState("");
  const [creatingDraft, setCreatingDraft] = useState(false);
  const notesScrollRef = useRef<HTMLDivElement>(null);
  const viewScopeRef = useRef<string | null>(null);

  useAccountChange(() => {
    setNewDraftOpen(false);
    setNewDraftTitle("");
    setCreatingDraft(false);
  });

  useEffect(() => {
    viewScopeRef.current = scopeKey;
    try {
      const saved = JSON.parse(localStorage.getItem(notesViewKey(scopeKey)) ?? "null") as Partial<{ statusFilter: string; search: string; sort: string; showTrash: boolean }> | null;
      if (saved) {
        if (typeof saved.statusFilter === "string") setStatusFilter(saved.statusFilter);
        if (typeof saved.search === "string") setSearch(saved.search);
        if (typeof saved.sort === "string") setSort(saved.sort);
        if (typeof saved.showTrash === "boolean") setShowTrash(saved.showTrash);
      }
      const scroll = Number(sessionStorage.getItem(`${notesViewKey(scopeKey)}:scroll`));
      if (Number.isFinite(scroll) && notesScrollRef.current) notesScrollRef.current.scrollTop = scroll;
    } catch { /* preferences are optional */ }
  }, [scopeKey]);

  useEffect(() => {
    if (viewScopeRef.current !== scopeKey) return;
    try { localStorage.setItem(notesViewKey(scopeKey), JSON.stringify({ statusFilter, search, sort, showTrash })); } catch { /* optional */ }
  }, [scopeKey, statusFilter, search, sort, showTrash]);

  const searchDebounced = useDebounce(search, 300);

  const { data: remoteNotes = [], isLoading: remoteNotesLoading } = useQuery<Note[]>({
    queryKey: ["notes", statusFilter, searchDebounced, sort],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (searchDebounced) params.set("search", searchDebounced);
      if (sort) params.set("sort", sort);
      const qs = params.toString();
      return api.get(`/api/content/${qs ? `?${qs}` : ""}`);
    },
    enabled: !IS_TAURI_RUNTIME,
  });
  const { data: localWorkspace, isLoading: localNotesLoading } = useQuery<LocalWorkspaceSnapshot>({
    queryKey: ["local-notes", scopeKey, statusFilter, searchDebounced, sort],
    queryFn: () => readLocalWorkspaceSnapshot(accountId ?? undefined),
    enabled: IS_TAURI_RUNTIME && noteRead.available && accountId !== null,
  });
  const notes: Note[] = IS_TAURI_RUNTIME
    ? (showTrash ? (localWorkspace?.trashNotes ?? []) : (localWorkspace?.notes ?? []))
        .map(localNoteToNote)
        .filter((note) => !statusFilter || note.status === statusFilter)
        .filter((note) => !searchDebounced || `${note.title ?? ""} ${note.body ?? ""}`.toLowerCase().includes(searchDebounced.toLowerCase()))
        .sort((a, b) => {
          if (sort === "published_desc") return (b.published_at ?? "").localeCompare(a.published_at ?? "");
          return (b.created_at ?? "").localeCompare(a.created_at ?? "");
        })
    : remoteNotes;
  const isLoading = IS_TAURI_RUNTIME ? localNotesLoading : remoteNotesLoading;

  async function deleteNote(id: number) {
    if (!noteDelete.available) {
      toast(`${noteDelete.reason}。${noteDelete.nextStep}`, "info");
      return;
    }
    setDeletingId(id);
    try {
      if (IS_TAURI_RUNTIME) {
        if (accountId === null) throw new Error("当前账号尚未就绪");
        await deleteLocalNote(id, accountId);
        await qc.invalidateQueries({ queryKey: ["local-notes", scopeKey] });
        await qc.invalidateQueries({ queryKey: ["local-dashboard", scopeKey] });
      } else {
        await api.delete(`/api/content/${id}`);
        qc.invalidateQueries({ queryKey: ["notes"] });
      }
      toast(IS_TAURI_RUNTIME ? "笔记已移入回收站" : "笔记已删除", "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setDeletingId(null);
      setConfirmId(null);
    }
  }

  async function restoreNote(id: number) {
    if (!IS_TAURI_RUNTIME || accountId === null) return;
    setDeletingId(id);
    try {
      await restoreLocalNote(id, accountId);
      await qc.invalidateQueries({ queryKey: ["local-notes", scopeKey] });
      await qc.invalidateQueries({ queryKey: ["local-dashboard", scopeKey] });
      toast("笔记已恢复", "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setDeletingId(null);
    }
  }

  async function moveTo(noteId: number, newStatus: "draft" | "ready" | "published", noteUrl?: string) {
    if (!noteStatusWrite.available) {
      toast(`${noteStatusWrite.reason}。${noteStatusWrite.nextStep}`, "info");
      return;
    }
    if (IS_TAURI_RUNTIME) {
      const current = notes.find((item) => item.id === noteId);
      if (!current || accountId === null) {
        toast("当前账号下找不到这篇笔记", "error");
        return;
      }
      try {
        await updateLocalNoteStatus({
          noteId,
          accountPoolId: accountId,
          expectedVersion: current.content_version ?? 1,
          status: newStatus,
          noteUrl,
        });
        await qc.invalidateQueries({ queryKey: ["local-notes", scopeKey] });
        await qc.invalidateQueries({ queryKey: ["local-dashboard", scopeKey] });
      } catch (e: unknown) {
        toast((e as Error).message, "error");
      }
      return;
    }
    qc.setQueryData<Note[]>(["notes", statusFilter, searchDebounced, sort], (old = []) =>
      old.map((n) => (n.id === noteId ? { ...n, status: newStatus } : n))
    );
    try {
      await api.patch(`/api/content/${noteId}/status`, {
        status: newStatus,
        ...(noteUrl ? { note_url: noteUrl } : {}),
      });
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["analytics"] });
    } catch (e: unknown) {
      qc.invalidateQueries({ queryKey: ["notes"] });
      toast((e as Error).message, "error");
    }
  }

  async function autoPublish(note: Note) {
    if (!publish.available) {
      toast(`${publish.reason}。${publish.nextStep}`, "info");
      return;
    }
    if (autoPublishingId !== null) return;
    setAutoPublishingId(note.id);

    try {
      // 预检登录状态
      toast("正在检测小红书登录状态…", "info");
      const loginStatus = await api.get("/api/content/xhs-login-status");
      if (!loginStatus.logged_in) {
        toast("小红书未登录，请先在设置页面打开浏览器并扫码登录，然后关闭浏览器再重试", "error");
        setAutoPublishingId(null);
        return;
      }

      toast("已登录，正在启动自动发布，浏览器将自动打开…", "info");
      // 启动后台任务，立即返回 job_id（带 v0.2 主号保护二次确认）
      const { job_id } = await confirmAndRetry((ack) =>
        api.post(`/api/content/${note.id}/publish-auto`, {}, riskAckHeader(ack)),
      );

      // 轮询任务状态（最多等 5 分钟，每 3 秒一次）
      const maxTries = 100;
      for (let i = 0; i < maxTries; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const job = await api.get(`/api/content/${note.id}/publish-status/${job_id}`);
        if (job.status === "done") {
          if (job.success) {
            toast("自动发布成功 🎉", "success");
            moveTo(note.id, "published", job.note_url ?? undefined);
          } else {
            toast(`发布失败：${job.error || "未知错误"}`, "error");
          }
          return;
        }
      }
      toast("发布超时，请查看浏览器或手动确认", "error");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setAutoPublishingId(null);
    }
  }

  const statusTabs = [
    { key: "", label: "全部" },
    { key: "draft", label: "草稿" },
    { key: "ready", label: "待发" },
    { key: "published", label: "已发" },
  ];

  const sortOptions = [
    { key: "created_desc",   label: "最新创建" },
    { key: "created_asc",    label: "最早创建" },
    { key: "updated_desc",   label: "最近编辑" },
    { key: "published_desc", label: "发布时间" },
    { key: "title_asc",      label: "标题 A→Z" },
  ];

  async function createDraftFromList() {
    if (!noteWrite.available) {
      toast(`${noteWrite.reason}。${noteWrite.nextStep}`, "info");
      return;
    }
    setCreatingDraft(true);
    try {
      await createLocalDraft(newDraftTitle.trim() || "新建草稿", accountId ?? undefined);
      await qc.invalidateQueries({ queryKey: ["local-notes", scopeKey] });
      await qc.invalidateQueries({ queryKey: ["local-dashboard", scopeKey] });
      setNewDraftOpen(false);
      setNewDraftTitle("");
      toast("草稿已创建", "success");
    } catch (cause) {
      toast(`创建失败：${cause instanceof Error ? cause.message : String(cause)}`, "error");
    } finally {
      setCreatingDraft(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {riskDialog}
      {publishingNote && (
        <PublishModal
          note={publishingNote}
          onClose={() => setPublishingNote(null)}
          onPublished={(url) => { moveTo(publishingNote.id, "published", url); setPublishingNote(null); }}
        />
      )}

      {/* Toolbar */}
      <div className="border-b border-zinc-100 bg-white shrink-0">
        <div className="flex items-center gap-1 px-6 py-3">
          <h1 className="text-lg font-semibold text-zinc-900 mr-4">笔记</h1>
          {statusTabs.map((t) => (
            <button
              key={t.key}
              onClick={() => handleStatusChange(t.key)}
              className={`text-sm px-3 py-1 rounded-lg transition-colors ${
                statusFilter === t.key ? "bg-[#ff2442] text-white" : "text-zinc-500 hover:bg-zinc-100"
              }`}
            >
              {t.label}
            </button>
          ))}
          {IS_TAURI_RUNTIME && (
            <button
              onClick={() => { setShowTrash((value) => !value); setStatusFilter(""); }}
              className={`text-sm px-3 py-1 rounded-lg transition-colors ${showTrash ? "bg-amber-500 text-white" : "text-zinc-500 hover:bg-zinc-100"}`}
              title="本地笔记回收站；关联素材不会随笔记删除"
            >
              回收站{localWorkspace?.trashNotes?.length ? ` (${localWorkspace.trashNotes.length})` : ""}
            </button>
          )}
          <button
            onClick={() => {
              if (!noteWrite.available) {
                toast(`${noteWrite.reason}。${noteWrite.nextStep}`, "info");
              } else if (IS_TAURI_RUNTIME) {
                setNewDraftOpen(true);
              } else {
                toast("请先在图库选择素材后生成草稿", "info");
              }
            }}
            disabled={!noteWrite.available}
            title={noteWrite.available ? "新建草稿" : `${noteWrite.reason}；${noteWrite.nextStep}`}
            className="ml-auto text-sm px-4 py-1.5 rounded-lg bg-[#ff2442] text-white hover:bg-[#e01f3a] transition-colors"
          >
            + 新建
          </button>
        </div>
        {IS_TAURI_RUNTIME && (
          <div className="border-b border-[var(--color-border)] bg-[var(--color-selected)] px-6 py-2 text-xs text-[var(--color-text-secondary)]">
            当前笔记来自本地数据库；编辑、状态变更和素材关联已可用，{noteDelete.available ? "删除会进入回收站" : "删除仍需迁移"}，{publish.available ? "发布已可用" : "发布仍需迁移"}。
          </div>
        )}
        <div className="flex items-center gap-3 px-6 pb-3">
          <div className="relative flex-1 max-w-sm">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索标题、正文、标签..."
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442]"
            />
            {search && (
              <button onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                <X size={13} />
              </button>
            )}
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 text-zinc-600 focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442] bg-white"
          >
            {sortOptions.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* List */}
      <div ref={notesScrollRef} className="flex-1 overflow-y-auto p-6" onScroll={(event) => {
        try { sessionStorage.setItem(`${notesViewKey(scopeKey)}:scroll`, String(event.currentTarget.scrollTop)); } catch { /* optional */ }
      }}>
        {isLoading ? (
          <Spinner />
        ) : notes.length === 0 ? (
          <Empty message="暂无笔记，先到图库导入图片并生成草稿" />
        ) : (
          <div className="space-y-3 max-w-2xl">
            {notes.map((note) => (
              <div key={note.id}
                className="bg-white rounded-xl p-4 border border-zinc-100 hover:border-zinc-200 transition-colors group relative"
              >
                {/* 主体内容行 */}
                <div className={`flex items-start gap-3 ${showTrash ? "" : "cursor-pointer"}`} onClick={() => { if (!showTrash) navigate(`/notes/${note.id}`); }}>
                  {note.item_id ? (
                    <LocalImage
                      itemId={note.item_id}
                      src={`${API_BASE}/api/library/${note.item_id}/image`}
                      alt=""
                      style={imgStyle()}
                      className="w-14 h-14 rounded-lg object-cover shrink-0 bg-zinc-100"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-zinc-100 shrink-0 flex items-center justify-center text-zinc-300 text-xs">无图</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <StatusBadge status={note.status} />
                      {(() => {
                        const badge = getNoteTypeBadge(note.note_type);
                        if (!badge) return null;
                        return (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badge.className}`}>
                            {badge.label}
                          </span>
                        );
                      })()}
                      <span className="text-xs text-zinc-400">{note.created_at?.slice(0, 10)}</span>
                    </div>
                    <p className="text-sm font-medium text-zinc-900 truncate">
                      {note.title || "（未填写标题）"}
                    </p>
                    {note.body && (
                      <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{note.body}</p>
                    )}
                    {note.tags.length > 0 && (
                      <p className="text-xs text-[#ff2442] mt-1">
                        {note.tags.slice(0, 4).map((t) => `#${t}`).join(" ")}
                      </p>
                    )}
                  </div>
                </div>

                {/* 底部操作栏 */}
                <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-zinc-50">
                  {/* 左侧：互动数据（已发布）/ 状态推进按钮（草稿/待发） */}
                  <div className="flex items-center gap-2">
                    {!showTrash && note.status === "published" && publish.available && (
                      <div className="flex gap-2 items-center">
                        {note.note_url && (
                          <button
                            onClick={(e) => { e.stopPropagation(); openInBrowser(note.note_url!); }}
                            className="flex items-center gap-1 text-xs text-[#ff2442] border border-[#ff2442]/30 bg-[#ff2442]/5 px-2.5 py-1 rounded-lg hover:bg-[#ff2442]/10 transition-colors"
                            title="在小红书查看"
                          >
                            <ExternalLink size={10} />打开链接
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); moveTo(note.id, "ready"); }}
                          className="text-xs text-amber-600 border border-amber-200 bg-amber-50 px-2.5 py-1 rounded-lg hover:bg-amber-100 transition-colors"
                          title="退回待发，可重新发布"
                        >
                          重新发布
                        </button>
                        <div className="flex gap-3 text-xs text-zinc-400">
                          <span>❤ {note.likes}</span>
                          <span>💬 {note.comments}</span>
                          <span>⭐ {note.collects}</span>
                        </div>
                      </div>
                    )}
                    {!showTrash && note.status === "ready" && (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); moveTo(note.id, "draft"); }}
                          className="text-xs text-zinc-400 border border-zinc-200 px-2.5 py-1 rounded-lg hover:bg-zinc-50 transition-colors"
                        >
                          退回草稿
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setPublishingNote(note); }}
                          disabled={!publish.available}
                          title={publish.available ? "发布" : `${publish.reason}；${publish.nextStep}`}
                          className="flex items-center gap-1 text-xs text-white bg-[#ff2442] px-2.5 py-1 rounded-lg hover:bg-[#e01f3a] transition-colors font-medium"
                        >
                          <Send size={10} />发布
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); autoPublish(note); }}
                          disabled={autoPublishingId !== null || !publish.available}
                          className="flex items-center gap-1 text-xs text-white bg-violet-500 px-2.5 py-1 rounded-lg hover:bg-violet-600 disabled:opacity-50 transition-colors font-medium"
                          title="Playwright 自动发布到小红书"
                        >
                          {autoPublishingId === note.id
                            ? <Loader2 size={10} className="animate-spin" />
                            : <Rocket size={10} />}
                          {autoPublishingId === note.id ? "发布中…" : "自动发布"}
                        </button>
                      </>
                    )}
                  </div>
                  {/* 右侧：编辑 + 删除 */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!showTrash && (
                      <button
                        onClick={() => navigate(`/notes/${note.id}`)}
                        className="p-1.5 rounded-lg text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
                        title="编辑笔记"
                      >
                        <ChevronRight size={14} />
                      </button>
                    )}
                    {showTrash ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); void restoreNote(note.id); }}
                        disabled={deletingId === note.id}
                        className="text-xs px-2 py-1 rounded-lg text-amber-700 bg-amber-50 hover:bg-amber-100 disabled:opacity-50"
                        title="恢复到笔记列表"
                      >
                        {deletingId === note.id ? "恢复中…" : "恢复"}
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmId(note.id); }}
                        disabled={!noteDelete.available}
                        className="p-1.5 rounded-lg text-zinc-300 hover:text-red-500 hover:bg-red-50 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                        title={noteDelete.available ? "移入笔记回收站" : `${noteDelete.reason}；${noteDelete.nextStep}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 删除确认弹窗 */}
      {confirmId !== null && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setConfirmId(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-6" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold text-zinc-800 mb-1">确认删除？</p>
            <p className="text-xs text-zinc-400 mb-5">笔记会移入当前账号回收站，关联素材会保留，可从回收站恢复。</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmId(null)}
                className="text-xs px-4 py-2 rounded-lg text-zinc-500 hover:bg-zinc-100 transition-colors">
                取消
              </button>
              <button onClick={() => deleteNote(confirmId)} disabled={deletingId === confirmId}
                className="text-xs px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors">
                {deletingId === confirmId ? "删除中..." : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
      {newDraftOpen && (
        <Dialog
          title="新建草稿"
          description="创建后会回到列表，当前本地层先保证创建与回读。"
          onClose={() => !creatingDraft && setNewDraftOpen(false)}
          footer={<><button type="button" className={secondaryButtonClass} disabled={creatingDraft} onClick={() => setNewDraftOpen(false)}>取消</button><button type="button" className={primaryButtonClass} disabled={creatingDraft} onClick={() => void createDraftFromList()}>{creatingDraft ? "创建中…" : "创建草稿"}</button></>}
        >
          <label className="block text-sm font-medium text-[var(--color-text-primary)]">标题（可选）<input autoFocus value={newDraftTitle} onChange={(event) => setNewDraftTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void createDraftFromList()} placeholder="例如：春日客厅改造灵感" className="mt-2 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)]" /></label>
        </Dialog>
      )}
    </div>
  );
}

// ── Note Editor ──────────────────────────────────────────────────────────────

export function NoteEditor() {
  const { id } = useParams<{ id: string }>();
  const noteId = Number(id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { accountId, accountAlias, databaseIdentity, scopeKey } = useAccountContext();
  const noteRead = getCapability("note.read");
  const noteWrite = getCapability("note.write");
  const noteItemsWrite = getCapability("note.items.write");
  const noteStatusWrite = getCapability("note.status.write");
  const aiGenerate = getCapability("ai.generate");
  const noteExport = getCapability("note.export");

  const { data: remoteNote, isLoading: remoteNoteLoading } = useQuery<Note>({
    queryKey: ["note", noteId],
    queryFn: () => api.get(`/api/content/${noteId}`),
    enabled: !IS_TAURI_RUNTIME,
  });
  const { data: localWorkspace, isLoading: localNoteLoading } = useQuery<LocalWorkspaceSnapshot>({
    queryKey: ["local-note", scopeKey, noteId],
    queryFn: () => readLocalWorkspaceSnapshot(accountId ?? undefined),
    enabled: IS_TAURI_RUNTIME && noteRead.available && accountId !== null,
  });
  const note = IS_TAURI_RUNTIME
    ? localWorkspace?.notes.map(localNoteToNote).find((item) => item.id === noteId)
    : remoteNote;
  const isLoading = IS_TAURI_RUNTIME ? localNoteLoading : remoteNoteLoading;
  const localMode = IS_TAURI_RUNTIME;

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");       // HTML 字符串（Tiptap 输出）
  const [tagsInput, setTagsInput] = useState("");
  const [noteType, setNoteType] = useState<NoteType>("text");
  const [saving, setSaving] = useState(false);
  const [autoSaved, setAutoSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showAI, setShowAI] = useState(() => aiGenerate.available && (typeof window === "undefined" || window.innerWidth >= 900));
  const [publishPreparation, setPublishPreparation] = useState<PublishPreparation | null>(null);
  const { width: promptWidth, dragging: promptDragging, onDragStart: onPromptDragStart } = usePanelResize({
    defaultWidth: 320,
    min: 240,
    max: 600,
    direction: "left",
    storageKey: "prompt-panel-width",
  });

  // Init local state once note loads
  const [inited, setInited] = useState(false);
  const [noteVersion, setNoteVersion] = useState(1);
  const noteVersionRef = useRef(1);
  // A proposal keeps the version from the AI session that produced it. This
  // ref deliberately does not follow editor saves while the panel is open, so
  // an older suggestion cannot silently overwrite a newer draft.
  const aiProposalBaseVersionRef = useRef(1);
  const [lastAIProposal, setLastAIProposal] = useState<AIProposal | null>(null);
  const [proposalHistory, setProposalHistory] = useState<AIProposal[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  if (note && !inited) {
    setTitle(note.title ?? "");
    // body 直接存纯文本；兼容旧版 HTML 存储：自动剥离标签
    const rawBody = note.body ?? "";
    const isHtml = /<[a-z][\s\S]*>/i.test(rawBody);
    const plainBody = isHtml
      ? rawBody
          .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n")
          .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\n{3,}/g, "\n\n").trim()
      : rawBody;
    setBody(plainBody);
    setTagsInput(note.tags.join(" "));
    setNoteType((note.note_type as "text" | "image" | "video") || "text");
    const version = note.content_version ?? 1;
    setNoteVersion(version);
    noteVersionRef.current = version;
    aiProposalBaseVersionRef.current = version;
    setInited(true);
  }

  // Debounce 自动保存
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveEpochRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useAccountChange(() => {
    saveEpochRef.current += 1;
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    setSaving(false);
    setSaveError(null);
  });

  // 账号或对象切换后丢弃旧编辑态，避免未保存草稿被新账号复用。
  useEffect(() => {
    saveEpochRef.current += 1;
    setInited(false);
    setTitle("");
    setBody("");
    setTagsInput("");
    setNoteVersion(1);
    noteVersionRef.current = 1;
    aiProposalBaseVersionRef.current = 1;
    setLastAIProposal(null);
    setProposalHistory([]);
    setAutoSaved(false);
    setSaveError(null);
    setShowPrompt(false);
  }, [scopeKey, noteId]);

  // Restore only the latest bounded history for this database/account/note.
  // The scope changes whenever the active account changes, so a prior account's
  // proposal can never become the current editor's diff by accident.
  useEffect(() => {
    const history = listProposals(databaseIdentity, accountId, noteId);
    setProposalHistory(history);
    setLastAIProposal(history[0] ?? null);
  }, [accountId, databaseIdentity, noteId]);

  type SavePayload = {
    title: string;
    body: string;
    tagsInput: string;
    noteType: NoteType;
    itemIds: number[];
    epoch: number;
    accountId: number | null;
    noteId: number;
  };

  function enqueueSave(payload: SavePayload): Promise<void> {
    const queued = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (payload.epoch !== saveEpochRef.current || payload.noteId !== noteId) return;
        setSaving(true);
        try {
          const tags = payload.tagsInput.split(/[\s,，#]+/).map((t) => t.trim()).filter(Boolean);
          if (localMode) {
            if (!noteWrite.available) throw new Error(`${noteWrite.reason}。${noteWrite.nextStep}`);
            if (payload.accountId === null) throw new Error("当前账号尚未就绪");
            const updated = await updateLocalNote({
              noteId: payload.noteId,
              accountPoolId: payload.accountId,
              expectedVersion: noteVersionRef.current,
              title: payload.title,
              body: payload.body,
              tags,
              noteType: payload.noteType,
              itemIds: payload.itemIds,
            });
            if (payload.epoch !== saveEpochRef.current) return;
            const nextVersion = updated.contentVersion ?? noteVersionRef.current + 1;
            noteVersionRef.current = nextVersion;
            setNoteVersion(nextVersion);
            await qc.invalidateQueries({ queryKey: ["local-note", scopeKey, payload.noteId] });
            await qc.invalidateQueries({ queryKey: ["local-notes", scopeKey] });
            await qc.invalidateQueries({ queryKey: ["local-dashboard", scopeKey] });
          } else {
            await api.patch(`/api/content/${payload.noteId}`, {
              title: payload.title,
              body: payload.body,
              tags,
              note_type: payload.noteType,
            });
            if (payload.epoch !== saveEpochRef.current || payload.accountId !== accountId) return;
            qc.invalidateQueries({ queryKey: ["notes"] });
            qc.invalidateQueries({ queryKey: ["note", payload.noteId] });
          }
          if (payload.epoch !== saveEpochRef.current) return;
          setSaveError(null);
          setAutoSaved(true);
          setTimeout(() => setAutoSaved(false), 2000);
        } catch (cause) {
          if (payload.epoch === saveEpochRef.current) {
            setSaveError(cause instanceof Error ? cause.message : String(cause));
          }
          throw cause;
        } finally {
          if (payload.epoch === saveEpochRef.current) setSaving(false);
        }
      });
    saveQueueRef.current = queued.catch(() => undefined);
    return queued;
  }

  function scheduleAutoSave(newTitle: string, newBody: string, newTags: string, nextNoteType = noteType) {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    const saveEpoch = saveEpochRef.current;
    const originAccountId = accountId;
    const originNoteId = noteId;
    const itemIds = note?.item_ids?.length ? note.item_ids : (note?.item_id ? [note.item_id] : []);
    autoSaveTimer.current = setTimeout(() => {
      void enqueueSave({
        title: newTitle,
        body: newBody,
        tagsInput: newTags,
        noteType: nextNoteType,
        itemIds,
        epoch: saveEpoch,
        accountId: originAccountId,
        noteId: originNoteId,
      }).catch(() => undefined);
    }, AUTOSAVE_DELAY);
  }

  // 清理 timer
  useEffect(() => () => { autoSaveTimer.current && clearTimeout(autoSaveTimer.current); }, []);

  async function save() {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    const saveEpoch = saveEpochRef.current;
    const originAccountId = accountId;
    const originNoteId = noteId;
    try {
      await enqueueSave({
        title,
        body,
        tagsInput,
        noteType,
        itemIds: note?.item_ids?.length ? note.item_ids : (note?.item_id ? [note.item_id] : []),
        epoch: saveEpoch,
        accountId: originAccountId,
        noteId: originNoteId,
      });
      if (saveEpoch !== saveEpochRef.current || originAccountId !== accountId) return;
      toast("已保存", "success");
    } catch (e: unknown) {
      if (saveEpoch === saveEpochRef.current) toast((e as Error).message, "error");
    }
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  });

  async function markReady() {
    if (!noteStatusWrite.available) {
      toast(`${noteStatusWrite.reason}。${noteStatusWrite.nextStep}`, "info");
      return;
    }
    try {
      if (localMode) {
        if (accountId === null) throw new Error("当前账号尚未就绪");
        const updated = await updateLocalNoteStatus({
          noteId,
          accountPoolId: accountId,
          expectedVersion: noteVersionRef.current,
          status: "ready",
        });
        const nextVersion = updated.contentVersion ?? noteVersionRef.current + 1;
        noteVersionRef.current = nextVersion;
        setNoteVersion(nextVersion);
        setSaveError(null);
        await qc.invalidateQueries({ queryKey: ["local-note", scopeKey, noteId] });
        await qc.invalidateQueries({ queryKey: ["local-notes", scopeKey] });
      } else {
        await api.patch(`/api/content/${noteId}/status`, { status: "ready" });
        qc.invalidateQueries({ queryKey: ["note", noteId] });
        qc.invalidateQueries({ queryKey: ["notes"] });
      }
    } catch (e: unknown) {
      setSaveError((e as Error).message);
      toast((e as Error).message, "error");
    }
  }

  async function copyMarkdown() {
    if (!noteExport.available) {
      toast(`${noteExport.reason}。${noteExport.nextStep}`, "info");
      return;
    }
    try {
      const markdown = localMode
        ? noteToMarkdown({
            title,
            body,
            tags: tagsInput.split(/[\s,，#]+/).map((tag) => tag.trim()).filter(Boolean),
            status: note?.status ?? "draft",
            createdAt: note?.created_at,
            coverDesc: note?.cover_desc,
          })
        : (await api.get(`/api/content/${noteId}/export`)).markdown;
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    }
  }

  function loadPrompt() {
    if (!note?.prompt_used) return;
    setPrompt(note.prompt_used);
    setShowPrompt(true);
  }

  function adoptAIProposal(field: AIProposal["field"], value: string, apply: () => void) {
    const previousValue = field === "title" ? title : field === "body" ? body : tagsInput;
    const proposal = createProposal({
      accountId,
      noteId,
      baseVersion: aiProposalBaseVersionRef.current,
      field,
      previousValue,
      value,
    });
    if (!isProposalCurrent(proposal, { accountId, noteId, version: noteVersionRef.current })) {
      const next = { ...proposal, status: "conflict" as const };
      saveProposal(databaseIdentity, next);
      setProposalHistory((current) => [next, ...current.filter((item) => item.id !== next.id)].slice(0, 40));
      setLastAIProposal(next);
      toast("AI 提案基于旧版本，原文已保留；请重新生成后再采用", "info");
      return;
    }
    apply();
    const next = { ...proposal, status: "applied" as const };
    saveProposal(databaseIdentity, next);
    setProposalHistory((current) => [next, ...current.filter((item) => item.id !== next.id)].slice(0, 40));
    setLastAIProposal(next);
  }

  /** AIPanel 点击「应用到编辑器」时，将文本追加到正文。 */
  function handleAIApply(text: string) {
    adoptAIProposal("body", text, () => {
      const newBody = body ? body + "\n" + text : text;
      setBody(newBody);
      scheduleAutoSave(title, newBody, tagsInput);
    });
  }

  if (isLoading) return <Spinner />;
  if (!note) return <div className="p-6 text-zinc-400">笔记不存在</div>;

  const saveStatus = saving
    ? "保存中…"
    : saveError
      ? "保存失败"
      : autoSaved
        ? "已保存"
        : `已同步 · v${noteVersion}`;
  const accountLabel = accountAlias || (accountId === null ? "未选择" : `账号 #${accountId}`);
  const hasAIConflict = lastAIProposal?.status === "conflict";

  return (
    <div className="creator-note-editor flex h-full min-w-0">
      {/* Left: Phone Preview + Editor */}
      <div className="creator-note-main flex-1 flex min-w-0 flex-col overflow-hidden">
        {/* Toolbar */}
          <div className="creator-note-toolbar flex items-center gap-3 px-6 py-3 border-b border-zinc-100 bg-white">
          <button
            onClick={() => navigate("/notes")}
            className="text-zinc-400 hover:text-zinc-700 text-sm"
          >
            ← 返回
          </button>
          <StatusBadge status={note.status} />
          <span className="text-[11px] text-[var(--color-text-secondary)] border border-[var(--color-border)] rounded-full px-2 py-0.5 max-w-[180px] truncate" title={`当前账号：${accountLabel}`}>
            当前账号：{accountLabel}
          </span>
          <span
            className={`creator-note-save-status text-xs ${saveError ? "text-red-500" : saving ? "text-amber-600" : "text-zinc-400"}`}
            aria-live="polite"
            title={saveError ?? undefined}
          >
            {saveStatus}{saveError ? "，点击保存重试" : ""}
          </span>
          {hasAIConflict && (
            <span className="creator-note-conflict text-xs text-amber-600" role="status">
              内容已变化，AI 建议未采用
            </span>
          )}
          <div className="creator-note-toolbar-actions ml-auto flex min-w-0 flex-wrap justify-end gap-2">
            <button
              onClick={() => { setShowAI(true); setShowPrompt(false); }}
              aria-disabled={!aiGenerate.available}
              title={aiGenerate.available ? "打开 AI 助手" : `${aiGenerate.reason}；${aiGenerate.nextStep}`}
              className={`flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-lg transition-colors ${
                showAI
                  ? "bg-[#fff0f2] border-[#ff2442] text-[#ff2442]"
                  : aiGenerate.available
                    ? "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
                    : "border-amber-200 text-amber-600 hover:bg-amber-50"
              }`}
            >
              <Sparkles size={13} />
              AI 助手
            </button>
            {note.prompt_used && (
              <button
                onClick={() => { loadPrompt(); setShowAI(false); }}
                className={`flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-lg transition-colors ${
                  showPrompt
                    ? "bg-[#fff0f2] border-[#ff2442] text-[#ff2442]"
                    : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
                }`}
              >
                <FileText size={13} />
                查看 Prompt
              </button>
            )}
            <button
              onClick={copyMarkdown}
              disabled={!noteExport.available}
              title={noteExport.available ? "复制 Markdown" : `${noteExport.reason}；${noteExport.nextStep}`}
              className="flex items-center gap-1.5 text-xs border border-zinc-200 px-3 py-1.5 rounded-lg hover:bg-zinc-50"
            >
              <Copy size={13} />
              {copied ? "已复制!" : "复制 MD"}
            </button>
            {note.status === "draft" && (
              <button
                onClick={markReady}
                disabled={!noteStatusWrite.available}
                title={noteStatusWrite.available ? "标记待发" : `${noteStatusWrite.reason}；${noteStatusWrite.nextStep}`}
                className="text-xs bg-amber-500 text-white px-3 py-1.5 rounded-lg hover:bg-amber-600"
              >
                标记待发
              </button>
            )}
            <button
              type="button"
              onClick={() => setPublishPreparation(preparePublish({ ...note, title, body, tags: tagsInput.split(/[\s,，#]+/).map((tag) => tag.trim()).filter(Boolean) }, accountId))}
              className="flex items-center gap-1.5 text-xs border border-zinc-200 px-3 py-1.5 rounded-lg text-zinc-500 hover:bg-zinc-50"
              title="检查当前内容快照，不会提交到平台"
            >
              发布检查
            </button>
            <button
              onClick={save}
              disabled={saving}
              title={saveError ? `${saveError}；点击重试` : "保存笔记"}
              className="creator-note-toolbar-save flex shrink-0 items-center gap-1.5 text-xs bg-[#ff2442] text-white px-3 py-1.5 rounded-lg hover:bg-[#e01f3a] disabled:opacity-50"
            >
              <Save size={13} />
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>

        {lastAIProposal && (
          <div className="creator-note-ai-diff mx-6 mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600" role="status">
            <div className="flex items-center justify-between gap-2">
              <span>AI 提案：{lastAIProposal.field === "title" ? "标题" : lastAIProposal.field === "body" ? "正文" : "标签"} · {lastAIProposal.status === "conflict" ? "未采用" : "已采用"} · 历史 {proposalHistory.length} 条</span>
              <details>
                <summary className="cursor-pointer text-[#ff2442]">查看差异</summary>
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  <div className="rounded bg-red-50 px-2 py-1"><span className="text-[10px] text-red-500">原值</span><p className="whitespace-pre-wrap break-words line-through decoration-red-300">{lastAIProposal.previousValue || "（空）"}</p></div>
                  <div className="rounded bg-green-50 px-2 py-1"><span className="text-[10px] text-green-600">建议</span><p className="whitespace-pre-wrap break-words">{lastAIProposal.value || "（空）"}</p></div>
                </div>
              </details>
            </div>
          </div>
        )}

        {localMode && (
          <div className="border-b border-[var(--color-border)] bg-[var(--color-selected)] px-6 py-2 text-xs text-[var(--color-text-secondary)]">
            当前笔记来自本地数据库；{noteWrite.available ? "标题、正文、标签、类型和状态支持本地保存" : "本地笔记编辑仍需迁移"}；{noteItemsWrite.available ? "素材关联、排序与移除可用" : "素材关联仍需迁移"}；{noteExport.available ? "导出可用" : "导出仍需迁移"}，{aiGenerate.available ? "AI 可用" : "AI 仍需迁移"}。
          </div>
        )}
        {publishPreparation && (
          <div className={`border-b px-6 py-2 text-xs ${publishPreparation.ready ? "border-emerald-100 bg-emerald-50 text-emerald-700" : "border-amber-100 bg-amber-50 text-amber-700"}`} role="status">
            <span className="font-medium">{publishPreparation.ready ? "内容检查通过" : "内容检查未通过"}</span>
            <span className="ml-2">快照 {publishPreparation.snapshotKey}</span>
            {!publishPreparation.ready && <span className="ml-2">{publishPreparation.issues.map((issue) => issue.message).join("；")}</span>}
          </div>
        )}

        {/* Editor body: two-column on wide screens, stacked on narrow */}
        <div className="flex-1 overflow-hidden">
          <div className="flex gap-0 h-full">
            {/* Phone-style preview card */}
            <NoteImagePanel
              itemIds={note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : [])}
              title={title}
              body={body}
              tags={note.tags}
              localItems={localWorkspace?.items.map(localItemToItem)}
            />

            {/* Text editor */}
            <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
              {/* 图片缩略条（仿小红书发布页，标题上方） */}
              <div className="px-6 pt-6 shrink-0">
                <NoteImageStrip
                  itemIds={note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : [])}
                  noteId={noteId}
                  localItems={localWorkspace?.items.map(localItemToItem)}
                  onItemIdsChange={async (itemIds) => {
                    const saveEpoch = saveEpochRef.current;
                    if (localMode) {
                      if (!noteItemsWrite.available) throw new Error(`${noteItemsWrite.reason}。${noteItemsWrite.nextStep}`);
                      if (accountId === null) throw new Error("当前账号尚未就绪");
                      const updated = await updateLocalNoteItems({
                        noteId,
                        accountPoolId: accountId,
                        expectedVersion: noteVersionRef.current,
                        itemIds,
                      });
                      if (saveEpoch !== saveEpochRef.current) return;
                      noteVersionRef.current = updated.contentVersion;
                      setNoteVersion(updated.contentVersion);
                      await qc.invalidateQueries({ queryKey: ["local-note", scopeKey, noteId] });
                      await qc.invalidateQueries({ queryKey: ["local-notes", scopeKey] });
                    } else {
                      await api.patch(`/api/content/${noteId}`, { item_ids: itemIds });
                      await qc.invalidateQueries({ queryKey: ["note", noteId] });
                    }
                  }}
                  readOnly={false}
                  allowAdd={!localMode}
                />
                {localMode && (
                  <p className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
                    本地模式支持当前账号素材的关联、排序与移除；新增素材导入仍待迁移。
                  </p>
                )}

                {/* Title */}
                <input
                  type="text"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    scheduleAutoSave(e.target.value, body, tagsInput);
                  }}
                  readOnly={false}
                  placeholder="笔记标题..."
                  className="w-full text-xl font-semibold text-zinc-900 outline-none bg-transparent placeholder:text-zinc-300 mb-3"
                />
              </div>

              {/* Body — 纯文本编辑器 + 表情 */}
              <BodyEditor
                value={body}
                onChange={(text) => {
                  setBody(text);
                  scheduleAutoSave(title, text, tagsInput);
                }}
                tagsLength={tagsInput.length}
                className="flex-1 min-h-0"
                readOnly={false}
              />

              {/* 话题标签 — 固定在底部，紧凑 */}
              <div className="shrink-0 border-t border-zinc-100 px-6 py-2">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Hash size={11} className="text-zinc-400" />
                  <label className="text-[11px] text-zinc-400">话题标签（空格或#分隔）</label>
                </div>
                <input
                  type="text"
                  value={tagsInput}
                  onChange={(e) => {
                    setTagsInput(e.target.value);
                    scheduleAutoSave(title, body, e.target.value);
                  }}
                  readOnly={false}
                  placeholder="#出租屋改造 #租房好物 ..."
                  className="w-full text-xs text-[#ff2442] outline-none bg-transparent placeholder:text-zinc-300 leading-snug"
                />
              </div>

              {/* 发布类型选择 — 两层结构 */}
              <div className="shrink-0 border-t border-zinc-100 px-6 py-2.5 flex items-center gap-3 flex-wrap">
                <span className="text-[11px] text-zinc-400 shrink-0">发布类型</span>
                <div className="flex gap-2 flex-wrap">
                  {NOTE_TYPE_GROUPS.map((group) => {
                    const groupActive = group.types.some((t) => t.key === noteType);
                    // 单类型分组直接渲染按钮，多类型分组渲染分组+子项
                    if (group.types.length === 1) {
                      const t = group.types[0];
                      return (
                        <button
                          key={t.key}
                          disabled={!t.available}
                          onClick={async () => {
                            if (!t.available) return;
                            setNoteType(t.key);
                            try {
                              if (localMode) {
                                await enqueueSave({
                                  title,
                                  body,
                                  tagsInput,
                                  noteType: t.key,
                                  itemIds: note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : []),
                                  epoch: saveEpochRef.current,
                                  accountId,
                                  noteId,
                                });
                              } else {
                                await api.patch(`/api/content/${noteId}`, { note_type: t.key });
                                qc.invalidateQueries({ queryKey: ["note", noteId] });
                              }
                            } catch (cause) {
                              toast((cause as Error).message, "error");
                            }
                          }}
                          title={t.description}
                          className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                            noteType === t.key
                              ? "bg-[#ff2442] text-white"
                              : t.available
                                ? "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                                : "bg-zinc-50 text-zinc-300 cursor-not-allowed"
                          }`}
                        >
                          <span>{t.icon}</span>{t.label}
                          {!t.available && <span className="text-[9px] ml-0.5">即将</span>}
                        </button>
                      );
                    }
                    // 多类型分组（图文）：分组标题 + 子按钮
                    return (
                      <div key={group.key} className="flex items-center gap-1">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${
                          groupActive ? "border-[#ff2442]/30 text-[#ff2442] bg-[#ff2442]/5" : "border-zinc-200 text-zinc-400"
                        }`}>
                          {group.icon}{group.label}
                        </span>
                        <span className="text-zinc-200 text-[10px]">›</span>
                        {group.types.map((t) => (
                          <button
                            key={t.key}
                            disabled={!t.available}
                          onClick={async () => {
                            if (!t.available) return;
                            setNoteType(t.key);
                            try {
                              if (localMode) {
                                await enqueueSave({
                                  title,
                                  body,
                                  tagsInput,
                                  noteType: t.key,
                                  itemIds: note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : []),
                                  epoch: saveEpochRef.current,
                                  accountId,
                                  noteId,
                                });
                              } else {
                                await api.patch(`/api/content/${noteId}`, { note_type: t.key });
                                qc.invalidateQueries({ queryKey: ["note", noteId] });
                              }
                            } catch (cause) {
                              toast((cause as Error).message, "error");
                            }
                            }}
                            title={t.description}
                            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                              noteType === t.key
                                ? "bg-[#ff2442] text-white"
                                : t.available
                                  ? "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                                  : "bg-zinc-50 text-zinc-300 cursor-not-allowed"
                            }`}
                          >
                            <span>{t.icon}</span>{t.label}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right: AI Panel / Prompt Panel */}
      {showAI && (
        <AIPanel
          noteId={noteId}
          itemId={note.item_id}
          accountId={accountId}
          available={aiGenerate.available}
          unavailableReason={aiGenerate.reason}
          unavailableNextStep={aiGenerate.nextStep}
          sourceNotice={`AI 提案仅基于当前笔记、已选素材和已注入经验；只有带正文的真实来源才可用于摘要。${lastAIProposal?.status === "conflict" ? "上次提案版本已变化，未覆盖原文。" : ""}`}
          onApply={handleAIApply}
          onApplyTitle={(t) => {
            adoptAIProposal("title", t, () => {
              setTitle(t);
              scheduleAutoSave(t, body, tagsInput);
            });
          }}
          onApplyTags={(tags) => {
            adoptAIProposal("tags", tags, () => {
              setTagsInput(tags);
              scheduleAutoSave(title, body, tags);
            });
          }}
          onApplyBody={(text, mode) => {
            adoptAIProposal("body", text, () => {
              const newBody = mode === "replace" ? text : (body ? body + "\n\n" + text : text);
              setBody(newBody);
              scheduleAutoSave(title, newBody, tagsInput);
            });
          }}
          onClose={() => setShowAI(false)}
        />
      )}
      {showPrompt && prompt && (
        <div
          className="creator-note-aux-panel creator-note-prompt-panel border-l border-zinc-100 bg-white flex flex-col shrink-0 relative select-none"
          style={{ width: promptWidth, cursor: promptDragging ? "col-resize" : undefined }}
        >
          {/* 拖拽条 */}
          <div
            onMouseDown={onPromptDragStart}
            className="absolute left-0 top-0 bottom-0 z-10 flex items-center justify-center group cursor-col-resize"
            style={{ width: 12, marginLeft: -4 }}
            title="拖动调整宽度"
          >
            <div
              className={`w-[3px] h-full rounded-full transition-colors duration-150
                ${promptDragging ? "bg-[#ff2442]" : "bg-transparent group-hover:bg-[#ff2442]/40"}`}
            />
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-700">
              <FileText size={14} className="text-[#ff2442]" />
              创作 Prompt
            </div>
            <button onClick={() => setShowPrompt(false)} aria-label="收起创作 Prompt" className="creator-note-aux-collapse text-zinc-400 hover:text-zinc-700 text-xs">
              收起
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <pre className="text-xs text-zinc-600 whitespace-pre-wrap leading-relaxed">{prompt}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TagFilterRow ─────────────────────────────────────────────────────────────
// 标签筛选行，默认折叠为一行（overflow-hidden），有激活标签时自动展开

function TagFilterRow({ allTags, activeTags, onToggle, onClear }: {
  allTags: string[];
  activeTags: string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex items-start gap-1.5">
      <div className={`flex gap-1.5 flex-wrap flex-1 min-w-0 ${expanded ? "" : "overflow-hidden"}`}
        style={expanded ? undefined : { maxHeight: "22px" }}
      >
        {allTags.map((tag) => (
          <button
            key={tag}
            onClick={() => onToggle(tag)}
            className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors shrink-0 ${
              activeTags.includes(tag)
                ? "bg-[#ff2442] text-white border-[#ff2442]"
                : "bg-zinc-50 text-zinc-500 border-zinc-200 hover:border-[#ff2442]/50 hover:text-[#ff2442]"
            }`}
          >
            {tag}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {activeTags.length > 0 && (
          <button onClick={onClear} className="text-[11px] text-zinc-400 hover:text-zinc-600 transition-colors px-1">
            清除
          </button>
        )}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-zinc-400 hover:text-zinc-600 transition-colors px-1"
        >
          {expanded ? "收起" : "展开"}
        </button>
      </div>
    </div>
  );
}

// ── LibraryPickerModal ───────────────────────────────────────────────────────
// 从图库选择图片关联到笔记

function LibraryPickerModal({
  alreadyLinked,
  onConfirm,
  onClose,
}: {
  alreadyLinked: number[];
  onConfirm: (ids: number[]) => void;
  onClose: () => void;
}) {
  const { imgStyle } = useHDRSetting();
  const [search, setSearch] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [showLinked, setShowLinked] = useState(true);
  const [selected, setSelected] = useState<number[]>([]);

  const { data: items = [], isLoading } = useQuery<Item[]>({
    queryKey: ["library-picker"],
    queryFn: () => api.get("/api/library/"),
    staleTime: 10_000,
  });

  // 从所有图片的 tags 汇总去重
  const allTags = Array.from(new Set(items.flatMap((i) => i.tags ?? []))).sort();

  const filtered = items.filter((item) => {
    const isLinked = alreadyLinked.includes(item.id);
    if (isLinked && !showLinked) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const matchText = item.title?.toLowerCase().includes(q) ||
        item.tags?.some((t) => t.toLowerCase().includes(q));
      if (!matchText) return false;
    }
    if (activeTags.length > 0) {
      if (!activeTags.every((t) => item.tags?.includes(t))) return false;
    }
    return true;
  });

  // 已添加的按 alreadyLinked 顺序排在前面，其余按原顺序
  const sorted = [
    ...filtered.filter((i) => alreadyLinked.includes(i.id))
               .sort((a, b) => alreadyLinked.indexOf(a.id) - alreadyLinked.indexOf(b.id)),
    ...filtered.filter((i) => !alreadyLinked.includes(i.id)),
  ];

  function toggleTag(tag: string) {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }

  function toggle(id: number) {
    if (alreadyLinked.includes(id)) return;
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-12 px-4 pb-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl w-full max-w-2xl shadow-xl flex flex-col"
        style={{ maxHeight: "calc(100vh - 80px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 shrink-0">
          <span className="font-semibold text-zinc-800 text-sm">从图库选择</span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Search + 筛选 */}
        <div className="px-5 py-3 border-b border-zinc-100 shrink-0 space-y-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索图片名称或标签..."
            autoFocus
            className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442]"
          />
          {/* 第一行：固定筛选项 */}
          {alreadyLinked.length > 0 && (
            <div className="flex gap-1.5 items-center">
              <button
                onClick={() => setShowLinked((v) => !v)}
                className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${
                  showLinked
                    ? "bg-zinc-700 text-white border-zinc-700"
                    : "bg-zinc-50 text-zinc-500 border-zinc-200 hover:border-zinc-400"
                }`}
              >
                已添加 {alreadyLinked.length}
              </button>
            </div>
          )}
          {/* 第二行：标签，默认折叠为一行 */}
          {allTags.length > 0 && (
            <TagFilterRow
              allTags={allTags}
              activeTags={activeTags}
              onToggle={toggleTag}
              onClear={() => setActiveTags([])}
            />
          )}
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-zinc-400 text-center py-10">
              {search || activeTags.length > 0 ? "没有匹配的图片" : "图库为空"}
            </p>
          ) : (
            <div className="grid grid-cols-4 gap-3">
              {sorted.map((item) => {
                const isLinked = alreadyLinked.includes(item.id);
                const isSelected = selected.includes(item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => toggle(item.id)}
                    disabled={isLinked}
                    className={`relative rounded-xl overflow-hidden border-2 transition-all aspect-square ${
                      isLinked
                        ? "border-zinc-300 cursor-default opacity-60"
                        : isSelected
                          ? "border-[#ff2442] shadow-md"
                          : "border-transparent hover:border-zinc-300"
                    }`}
                  >
                    <LocalImage
                      itemId={item.id}
                      src={`${API_BASE}/api/library/${item.id}/image`}
                      alt={item.title}
                      style={imgStyle()}
                      className="w-full h-full object-cover"
                    />
                    {/* 已关联标记 */}
                    {isLinked && (
                      <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                        <span className="text-[10px] text-white bg-black/60 px-2 py-0.5 rounded-full font-medium">已添加</span>
                      </div>
                    )}
                    {/* 新选中遮罩 */}
                    {isSelected && (
                      <div className="absolute inset-0 bg-[#ff2442]/20 flex items-end justify-end p-1.5">
                        <span className="w-5 h-5 rounded-full bg-[#ff2442] text-white text-[10px] font-bold flex items-center justify-center">
                          {selected.indexOf(item.id) + 1}
                        </span>
                      </div>
                    )}
                    {/* 标题 */}
                    {item.title && (
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1">
                        <p className="text-[10px] text-white truncate">{item.title}</p>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-zinc-100 shrink-0">
          <span className="text-xs text-zinc-400">
            {selected.length > 0 ? `已选 ${selected.length} 张` : "点击图片选择"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-xs px-4 py-2 rounded-lg text-zinc-500 hover:bg-zinc-100 transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => { onConfirm(selected); onClose(); }}
              disabled={selected.length === 0}
              className="text-xs px-4 py-2 rounded-lg bg-[#ff2442] text-white hover:bg-[#e01f3a] disabled:opacity-40 transition-colors"
            >
              确认添加
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 共享的上传+关联逻辑 ──────────────────────────────────────────────
async function uploadAndLink(
  file: File,
  noteId: number,
  currentIds: number[],
  onDone: (ids: number[]) => void,
  onError: (msg: string) => void,
) {
  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("analyze", "true");
    const item: Item = await api.upload("/api/library/", fd);
    const newIds = [...currentIds, item.id];
    await api.patch(`/api/content/${noteId}`, { item_ids: newIds });
    onDone(newIds);
  } catch (e: unknown) {
    onError((e as Error).message);
  }
}

// ── NoteImagePanel ────────────────────────────────────────────────────────────
// 仿小红书编辑页左侧预览区：「笔记预览」和「封面预览」两种视图切换

function NoteImagePanel({ itemIds, title, body, tags, localItems }: {
  itemIds: number[];
  title: string;
  body: string;
  tags: string[];
  localItems?: Item[];
}) {
  const { imgStyle } = useHDRSetting();
  const localItemsById = new Map((localItems ?? []).map((item) => [item.id, item]));
  const results = useQueries({
    queries: itemIds.map((id) => ({
      queryKey: ["item", id],
      queryFn: () => api.get(`/api/library/${id}`) as Promise<Item>,
      enabled: !!id && !localItemsById.has(id),
    })),
  });
  const images = itemIds
    .map((id, index) => localItemsById.get(id) ?? results[index]?.data)
    .filter((d): d is Item => !!d);

  // 拉取账号人设（头像 + 名称）
  const { data: profile } = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.get("/api/profile") as Promise<{ display_name?: string; avatar_url?: string }>,
    staleTime: 5 * 60 * 1000,
  });
  const displayName = profile?.display_name || "账号名称";
  const avatarUrl = profile?.avatar_url || "";

  const [tab, setTab] = useState<"note" | "cover">("note");
  const [imgIdx, setImgIdx] = useState(0);
  const safeIdx = Math.min(imgIdx, Math.max(images.length - 1, 0));

  // 封面图（第一张）
  const coverImg = images[0];

  return (
    <div className="w-[230px] shrink-0 border-r border-zinc-100 bg-zinc-50 flex flex-col items-center py-4 px-3 gap-3 overflow-y-auto">

      {/* 切换 Tab */}
      <div className="w-full flex bg-zinc-100 rounded-xl p-0.5 shrink-0">
        {(["note", "cover"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 text-[11px] font-medium py-1.5 rounded-lg transition-colors ${
              tab === t ? "bg-white text-zinc-800 shadow-sm" : "text-zinc-400 hover:text-zinc-600"
            }`}
          >
            {t === "note" ? "笔记预览" : "封面预览"}
          </button>
        ))}
      </div>

      {/* 手机壳 */}
      <div className="w-full shrink-0">
        {/* 手机外壳 */}
        <div className="relative mx-auto w-full rounded-[22px] border-[3px] border-zinc-800 bg-white shadow-xl overflow-hidden">
          {/* 状态栏 */}
          <div className="flex items-center justify-between px-4 pt-2 pb-1 bg-white shrink-0">
            <span className="text-[9px] font-semibold text-zinc-800">9:41</span>
            <div className="flex items-center gap-1">
              <svg width="10" height="7" viewBox="0 0 10 7" fill="none"><rect x="0" y="2" width="2" height="5" rx="0.5" fill="#3f3f46"/><rect x="2.5" y="1.5" width="2" height="5.5" rx="0.5" fill="#3f3f46"/><rect x="5" y="0.5" width="2" height="6.5" rx="0.5" fill="#3f3f46"/><rect x="7.5" y="0" width="2" height="7" rx="0.5" fill="#3f3f46"/></svg>
              <svg width="11" height="8" viewBox="0 0 11 8" fill="none"><path d="M5.5 1.5C7.4 1.5 9.1 2.3 10.3 3.6L11 2.9C9.6 1.4 7.65 0.5 5.5 0.5C3.35 0.5 1.4 1.4 0 2.9L0.7 3.6C1.9 2.3 3.6 1.5 5.5 1.5Z" fill="#3f3f46"/><path d="M5.5 3.5C6.9 3.5 8.15 4.1 9.05 5.05L9.75 4.35C8.65 3.2 7.15 2.5 5.5 2.5C3.85 2.5 2.35 3.2 1.25 4.35L1.95 5.05C2.85 4.1 4.1 3.5 5.5 3.5Z" fill="#3f3f46"/><circle cx="5.5" cy="6.5" r="1" fill="#3f3f46"/></svg>
              <svg width="16" height="8" viewBox="0 0 16 8" fill="none"><rect x="0.5" y="0.5" width="13" height="7" rx="2" stroke="#3f3f46"/><rect x="1.5" y="1.5" width="10" height="5" rx="1.5" fill="#3f3f46"/><path d="M14.5 2.5V5.5C15.1 5.2 15.5 4.7 15.5 4C15.5 3.3 15.1 2.8 14.5 2.5Z" fill="#3f3f46"/></svg>
            </div>
          </div>

          {tab === "note" ? (
            /* ── 笔记预览 ── */
            <>
              {/* 导航栏 */}
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-100">
                <ChevronRight size={14} className="rotate-180 text-zinc-500" />
                <div className="flex items-center gap-1.5 min-w-0">
                  {avatarUrl ? (
                    <img src={avatarUrl} className="w-4 h-4 rounded-full object-cover shrink-0" alt="" />
                  ) : (
                    <div className="w-4 h-4 rounded-full bg-[#ff2442]/20 shrink-0" />
                  )}
                  <span className="text-[10px] font-medium text-zinc-800 truncate max-w-[80px]">{displayName}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] border border-[#ff2442] text-[#ff2442] px-1.5 py-0.5 rounded-full leading-none">关注</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                </div>
              </div>

              {/* 大图区域 */}
              <div className="relative w-full aspect-[4/5] bg-zinc-100 overflow-hidden">
                {images.length > 0 ? (
                  <LocalImage
                    itemId={images[safeIdx]?.id}
                    src={`${API_BASE}/api/library/${images[safeIdx]?.id}/image`}
                    alt={images[safeIdx]?.title}
                    style={imgStyle()}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-zinc-300">
                    <ImagePlus size={22} />
                    <span className="text-[10px]">暂无图片</span>
                  </div>
                )}
                {/* 翻页箭头 */}
                {images.length > 1 && (
                  <>
                    <button
                      onClick={() => setImgIdx(Math.max(safeIdx - 1, 0))}
                      className="absolute left-1 top-1/2 -translate-y-1/2 w-6 h-6 bg-black/30 rounded-full flex items-center justify-center"
                    >
                      <ChevronRight size={12} className="rotate-180 text-white" />
                    </button>
                    <button
                      onClick={() => setImgIdx(Math.min(safeIdx + 1, images.length - 1))}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 bg-black/30 rounded-full flex items-center justify-center"
                    >
                      <ChevronRight size={12} className="text-white" />
                    </button>
                    {/* 计数 */}
                    <div className="absolute top-2 right-2 bg-black/40 text-white text-[9px] px-1.5 py-0.5 rounded-full">
                      {safeIdx + 1}/{images.length}
                    </div>
                    {/* 点点指示器 */}
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
                      {images.map((_, i) => (
                        <div key={i} className={`rounded-full transition-all ${i === safeIdx ? "w-3 h-1.5 bg-[#ff2442]" : "w-1.5 h-1.5 bg-white/60"}`} />
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* 正文区域 */}
              <div className="px-3 py-2 max-h-[90px] overflow-hidden">
                {title && (
                  <p className="text-[10px] font-semibold text-zinc-800 leading-snug mb-1 line-clamp-1">{title}</p>
                )}
                {body ? (
                  <p className="text-[9px] text-zinc-600 leading-relaxed line-clamp-4 whitespace-pre-wrap">{body}</p>
                ) : (
                  <div className="space-y-1">
                    <div className="h-1.5 w-full rounded bg-zinc-100" />
                    <div className="h-1.5 w-4/5 rounded bg-zinc-100" />
                    <div className="h-1.5 w-3/5 rounded bg-zinc-100" />
                  </div>
                )}
                {tags.length > 0 && (
                  <p className="text-[8px] text-[#ff2442] mt-1 line-clamp-1">{tags.map(t => `#${t}`).join(" ")}</p>
                )}
              </div>

              {/* 底部操作栏 */}
              <div className="flex items-center px-3 py-2 border-t border-zinc-100 gap-2">
                <div className="flex-1 bg-zinc-100 rounded-full px-2 py-1">
                  <span className="text-[8px] text-zinc-400">说点什么…</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {[
                    <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg><span className="text-[8px]">点赞</span></>,
                    <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg><span className="text-[8px]">收藏</span></>,
                    <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span className="text-[8px]">评论</span></>,
                  ].map((icon, i) => (
                    <div key={i} className="flex items-center gap-0.5 text-zinc-400">{icon}</div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            /* ── 封面预览（信息流视图） ── */
            <>
              {/* 顶部 tab 导航 */}
              <div className="flex items-center justify-between px-2 pt-1 pb-1.5 border-b border-zinc-100">
                <span className="text-[9px] text-zinc-400">关注</span>
                <span className="text-[9px] font-semibold text-zinc-800 border-b border-zinc-800 pb-0.5">发现</span>
                <span className="text-[9px] text-zinc-400">附近</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-zinc-500"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </div>
              {/* 分类 tab */}
              <div className="flex items-center gap-2 px-2 py-1 border-b border-zinc-100 overflow-hidden">
                {["推荐","直播","短剧","穿搭","旅行"].map((t, i) => (
                  <span key={t} className={`text-[8px] whitespace-nowrap ${i === 0 ? "font-semibold text-zinc-800" : "text-zinc-400"}`}>{t}</span>
                ))}
              </div>

              {/* 瀑布流双列 */}
              <div className="flex gap-1.5 px-1.5 py-1.5" style={{ minHeight: 220 }}>
                {/* 左列：当前笔记在第一位 */}
                <div className="flex-1 flex flex-col gap-1.5">
                  {/* 当前笔记 */}
                  <div className="rounded-xl overflow-hidden bg-zinc-50 border border-zinc-100">
                    <div className="aspect-[3/4] bg-zinc-100 overflow-hidden">
                      {coverImg ? (
                        <LocalImage
                          itemId={coverImg.id}
                          src={`${API_BASE}/api/library/${coverImg.id}/image`}
                          alt={coverImg.title}
                          style={imgStyle()}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <ImagePlus size={16} className="text-zinc-300" />
                        </div>
                      )}
                    </div>
                    <div className="px-1.5 py-1">
                      <p className="text-[8px] font-medium text-zinc-800 line-clamp-2 leading-snug">
                        {title || "笔记标题…"}
                      </p>
                      <div className="flex items-center justify-between mt-0.5">
                        <div className="flex items-center gap-0.5">
                          {avatarUrl ? (
                            <img src={avatarUrl} className="w-3 h-3 rounded-full object-cover shrink-0" alt="" />
                          ) : (
                            <div className="w-3 h-3 rounded-full bg-[#ff2442]/20" />
                          )}
                          <span className="text-[7px] text-zinc-400 truncate max-w-[40px]">{displayName}</span>
                        </div>
                        <div className="flex items-center gap-0.5 text-zinc-400">
                          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                          <span className="text-[7px]">0</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  {/* 占位卡片 */}
                  <div className="rounded-xl overflow-hidden bg-zinc-50 border border-zinc-100">
                    <div className="aspect-[3/5] bg-zinc-100" />
                    <div className="px-1.5 py-1 space-y-0.5">
                      <div className="h-1.5 w-4/5 rounded bg-zinc-200" />
                      <div className="h-1 w-3/5 rounded bg-zinc-100" />
                    </div>
                  </div>
                </div>
                {/* 右列：占位卡片 */}
                <div className="flex-1 flex flex-col gap-1.5 pt-3">
                  <div className="rounded-xl overflow-hidden bg-zinc-50 border border-zinc-100">
                    <div className="aspect-[3/4] bg-zinc-100" />
                    <div className="px-1.5 py-1 space-y-0.5">
                      <div className="h-1.5 w-4/5 rounded bg-zinc-200" />
                      <div className="h-1 w-3/5 rounded bg-zinc-100" />
                    </div>
                  </div>
                  <div className="rounded-xl overflow-hidden bg-zinc-50 border border-zinc-100">
                    <div className="aspect-[3/3] bg-zinc-100" />
                    <div className="px-1.5 py-1 space-y-0.5">
                      <div className="h-1.5 w-4/5 rounded bg-zinc-200" />
                      <div className="h-1 w-3/5 rounded bg-zinc-100" />
                    </div>
                  </div>
                </div>
              </div>

              {/* 底部导航栏 */}
              <div className="flex items-center justify-around px-2 py-2 border-t border-zinc-100">
                {[
                  { label: "首页", active: true },
                  { label: "市集", active: false },
                  { label: "+", active: false, special: true },
                  { label: "消息", active: false },
                  { label: "我", active: false },
                ].map((item) => (
                  <div key={item.label} className="flex flex-col items-center">
                    {item.special ? (
                      <div className="w-6 h-4 bg-[#ff2442] rounded-md flex items-center justify-center">
                        <span className="text-white text-[10px] font-bold leading-none">+</span>
                      </div>
                    ) : (
                      <span className={`text-[8px] ${item.active ? "font-semibold text-zinc-800" : "text-zinc-400"}`}>
                        {item.label}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── NoteImageStrip ────────────────────────────────────────────────────────────
// 右侧编辑区标题上方的横向图片缩略条，仿小红书发布页多图选择器

function NoteImageStrip({ itemIds, noteId, localItems, onItemIdsChange, readOnly = false, allowAdd = true }: {
  itemIds: number[];
  noteId: number;
  localItems?: Item[];
  onItemIdsChange: (ids: number[]) => Promise<void> | void;
  readOnly?: boolean;
  allowAdd?: boolean;
}) {
  const { imgStyle } = useHDRSetting();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  // 拖拽排序状态
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const dragIdxRef = useRef<number | null>(null);
  const overIdxRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const localItemsById = new Map((localItems ?? []).map((item) => [item.id, item]));
  async function persistItemIds(nextItemIds: number[]) {
    await onItemIdsChange(nextItemIds);
  }
  const results = useQueries({
    queries: itemIds.map((id) => ({
      queryKey: ["item", id],
      queryFn: () => api.get(`/api/library/${id}`) as Promise<Item>,
      enabled: !!id && !localItemsById.has(id),
    })),
  });
  const images = itemIds
    .map((id, index) => localItemsById.get(id) ?? results[index]?.data)
    .filter((d): d is Item => !!d);

  // ESC 关闭灯箱
  useEffect(() => {
    if (lightboxIdx === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxIdx(null);
      if (e.key === "ArrowRight") setLightboxIdx((i) => i !== null ? Math.min(i + 1, images.length - 1) : null);
      if (e.key === "ArrowLeft") setLightboxIdx((i) => i !== null ? Math.max(i - 1, 0) : null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightboxIdx, images.length]);

  if (itemIds.length === 0 && !uploading) return null;

  return (
    <>
      <div className="flex gap-2.5 mb-5 overflow-x-auto scrollbar-none pb-0.5">
        {images.map((img, idx) => (
          <div
            key={img.id}
            className={[
              "relative shrink-0 group transition-all select-none",
              dragIdx === idx ? "opacity-40 scale-95" : "opacity-100 scale-100",
              overIdx === idx && dragIdx !== null && dragIdx !== idx
                ? "ring-2 ring-offset-2 ring-blue-400 rounded-xl"
                : "",
            ].join(" ")}
            onMouseDown={(e) => {
              if (readOnly) return;
              if (e.button !== 0) return;
              e.preventDefault();
              dragIdxRef.current = idx;
              isDraggingRef.current = false;

              const onMouseMove = () => {
                if (!isDraggingRef.current) {
                  isDraggingRef.current = true;
                  setDragIdx(dragIdxRef.current);
                }
              };

              const onMouseUp = async () => {
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onMouseUp);
                const from = dragIdxRef.current;
                const to = overIdxRef.current;
                setDragIdx(null);
                setOverIdx(null);
                dragIdxRef.current = null;
                overIdxRef.current = null;
                isDraggingRef.current = false;

                if (from === null || to === null || from === to) return;
                const newIds = [...itemIds];
                const [moved] = newIds.splice(from, 1);
                newIds.splice(to, 0, moved);
                try {
                  await persistItemIds(newIds);
                } catch (e: unknown) { toast((e as Error).message, "error"); }
              };

              window.addEventListener("mousemove", onMouseMove);
              window.addEventListener("mouseup", onMouseUp);
            }}
            onMouseEnter={() => {
              if (dragIdxRef.current !== null) {
                overIdxRef.current = idx;
                setOverIdx(idx);
              }
            }}
          >
            <div
              className="w-[120px] h-[120px] rounded-xl overflow-hidden border-2 border-[#ff2442] shadow-sm cursor-grab active:cursor-grabbing"
              onClick={() => { if (!isDraggingRef.current) setLightboxIdx(idx); }}
            >
              <LocalImage
                itemId={img.id}
                src={`${API_BASE}/api/library/${img.id}/image`}
                alt={img.title}
                style={imgStyle()}
                className="w-full h-full object-cover pointer-events-none"
              />
              <span className="absolute top-1 right-1 min-w-[18px] h-[18px] rounded-full bg-black/50 text-white text-[10px] font-bold flex items-center justify-center px-1 leading-none">
                {idx + 1}
              </span>
            </div>
            {!readOnly && <button
              onClick={async () => {
                const newIds = itemIds.filter((id) => id !== img.id);
                try {
                  await persistItemIds(newIds);
                } catch (e: unknown) { toast((e as Error).message, "error"); }
              }}
              className="absolute -top-1 -right-1 z-10 w-5 h-5 rounded-full bg-zinc-800 text-white text-[10px] items-center justify-center hidden group-hover:flex hover:bg-red-500 transition-colors"
            >✕</button>}
          </div>
        ))}
        {images.length < 9 && !readOnly && allowAdd && (
          <>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setUploading(true);
                await uploadAndLink(file, noteId, itemIds,
                  (ids) => { onItemIdsChange(ids); setUploading(false); },
                  (msg) => { toast(msg, "error"); setUploading(false); }
                );
                e.target.value = "";
              }}
            />
            {/* 添加按钮：两个入口 */}
            <div className="shrink-0 w-[120px] h-[120px] rounded-xl border-2 border-dashed border-zinc-200 flex flex-col items-center justify-center gap-1.5 text-zinc-300 hover:border-zinc-300 transition-colors">
              {uploading ? (
                <div className="w-4 h-4 border-2 border-zinc-300 border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <button
                    onClick={() => setShowPicker(true)}
                    className="flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-lg bg-zinc-50 hover:bg-[#fff0f2] hover:text-[#ff2442] text-zinc-500 border border-zinc-200 hover:border-[#ff2442]/40 transition-colors w-[90px] justify-center"
                  >
                    <ImagePlus size={11} />
                    从图库选
                  </button>
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-lg bg-zinc-50 hover:bg-zinc-100 text-zinc-400 border border-zinc-200 transition-colors w-[90px] justify-center"
                  >
                    <ImagePlus size={11} />
                    上传本地
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* 图库选择弹窗 */}
      {showPicker && (
        <LibraryPickerModal
          alreadyLinked={itemIds}
          onClose={() => setShowPicker(false)}
          onConfirm={async (newIds) => {
            const merged = [...itemIds, ...newIds].slice(0, 9);
            try {
              await persistItemIds(merged);
            } catch (e: unknown) { toast((e as Error).message, "error"); }
          }}
        />
      )}

    {/* 灯箱 */}
    {lightboxIdx !== null && images[lightboxIdx] && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
        onClick={() => setLightboxIdx(null)}
      >
        {/* 上一张 */}
        {lightboxIdx > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setLightboxIdx(lightboxIdx - 1); }}
            className="absolute left-6 w-10 h-10 rounded-full bg-white/10 hover:bg-white/25 text-white flex items-center justify-center text-lg transition-colors"
          >‹</button>
        )}

        <LocalImage
          itemId={images[lightboxIdx].id}
          src={`${API_BASE}/api/library/${images[lightboxIdx].id}/image`}
          alt={images[lightboxIdx].title}
          style={imgStyle()}
          className="max-h-[90vh] max-w-[80vw] rounded-2xl shadow-2xl object-contain"
          onClick={(e) => e.stopPropagation()}
        />

        {/* 下一张 */}
        {lightboxIdx < images.length - 1 && (
          <button
            onClick={(e) => { e.stopPropagation(); setLightboxIdx(lightboxIdx + 1); }}
            className="absolute right-6 w-10 h-10 rounded-full bg-white/10 hover:bg-white/25 text-white flex items-center justify-center text-lg transition-colors"
          >›</button>
        )}

        {/* 页码 + 关闭 */}
        <div className="absolute top-5 right-5 flex items-center gap-3">
          {images.length > 1 && (
            <span className="text-white/60 text-sm tabular-nums">{lightboxIdx + 1} / {images.length}</span>
          )}
          <button
            onClick={() => setLightboxIdx(null)}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/25 text-white flex items-center justify-center transition-colors text-base"
          >✕</button>
        </div>
      </div>
    )}
    </>
  );
}
