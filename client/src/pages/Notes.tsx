import { useState, useEffect, useRef } from "react";
import { usePanelResize } from "../hooks/usePanelResize";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { api, API_BASE, openInChromium } from "../lib/api";
import { Note, Item } from "../lib/types";
import { Spinner, Empty, StatusBadge } from "../components/ui";
import { Save, Copy, ChevronRight, Sparkles, ImagePlus, Hash, FileText, Trash2, X, Search, Send, Check, ExternalLink, Rocket, Loader2 } from "lucide-react";
import AIPanel from "../components/AIPanel";
import { useToast } from "../components/Toast";
import { useHDRSetting } from "../hooks/useHDRSetting";
import { useDebounce } from "../hooks/useDebounce";
import RichBodyEditor from "../components/RichBodyEditor";

/** 把 HTML 字符串转成纯文本（用于复制/导出/兼容旧存储） */
function htmlToPlainText(html: string): string {
  // <br>/<p> → 换行，剥去所有标签
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const AUTOSAVE_DELAY = 1500; // ms

// ── Publish Modal ─────────────────────────────────────────────────────────────

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
          {note.item_ids && note.item_ids.length > 0 && (
            <div>
              <p className="text-xs text-zinc-400 mb-2">配图（共 {note.item_ids.length} 张）</p>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {note.item_ids.map((id) => (
                  <img key={id} src={`${API_BASE}/api/library/${id}/image`}
                    className="w-20 h-20 rounded-xl object-cover shrink-0 bg-zinc-100" alt=""
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                ))}
              </div>
            </div>
          )}
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
          <button onClick={() => copy("all")}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 border-dashed border-zinc-200 text-xs text-zinc-500 hover:border-[#ff2442] hover:text-[#ff2442] transition-colors">
            {copied === "all" ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
            {copied === "all" ? "已复制全文" : "一键复制全文（标题 + 正文 + 标签）"}
          </button>
          <button onClick={() => openInChromium("https://creator.xiaohongshu.com/publish/publish")}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#ff2442] text-white text-xs font-medium hover:bg-[#e01f3a] transition-colors">
            <ExternalLink size={13} />打开小红书发布页
          </button>
          <div>
            <label className="text-xs text-zinc-400 block mb-1.5">发布后粘贴笔记链接（可选，用于数据追踪）</label>
            <input type="text" value={noteUrl} onChange={(e) => setNoteUrl(e.target.value)}
              placeholder="https://www.xiaohongshu.com/explore/..."
              className="w-full text-xs border border-zinc-200 rounded-xl px-3 py-2 outline-none focus:border-[#ff2442] transition-colors placeholder:text-zinc-300" />
          </div>
        </div>
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
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("created_desc");

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

  const searchDebounced = useDebounce(search, 300);

  const { data: notes = [], isLoading } = useQuery<Note[]>({
    queryKey: ["notes", statusFilter, searchDebounced, sort],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (searchDebounced) params.set("search", searchDebounced);
      if (sort) params.set("sort", sort);
      const qs = params.toString();
      return api.get(`/api/content/${qs ? `?${qs}` : ""}`);
    },
  });

  async function deleteNote(id: number) {
    setDeletingId(id);
    try {
      await api.delete(`/api/content/${id}`);
      qc.invalidateQueries({ queryKey: ["notes"] });
      toast("笔记已删除", "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setDeletingId(null);
      setConfirmId(null);
    }
  }

  async function moveTo(noteId: number, newStatus: "draft" | "ready" | "published", noteUrl?: string) {
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
      // 启动后台任务，立即返回 job_id
      const { job_id } = await api.post(`/api/content/${note.id}/publish-auto`, {});

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

  return (
    <div className="flex flex-col h-full">
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
          <button
            onClick={() => navigate("/notes/new")}
            className="ml-auto text-sm px-4 py-1.5 rounded-lg bg-[#ff2442] text-white hover:bg-[#e01f3a] transition-colors"
          >
            + 新建
          </button>
        </div>
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
      <div className="flex-1 overflow-y-auto p-6">
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
                <div className="flex items-start gap-3 cursor-pointer" onClick={() => navigate(`/notes/${note.id}`)}>
                  {note.item_id ? (
                    <img
                      src={`${API_BASE}/api/library/${note.item_id}/image`}
                      alt=""
                      style={imgStyle()}
                      className="w-14 h-14 rounded-lg object-cover shrink-0 bg-zinc-100"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-zinc-100 shrink-0 flex items-center justify-center text-zinc-300 text-xs">无图</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <StatusBadge status={note.status} />
                      {note.note_type && note.note_type !== "text" && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          note.note_type === "image" ? "bg-blue-50 text-blue-500" : "bg-purple-50 text-purple-500"
                        }`}>
                          {note.note_type === "image" ? "🖼️图文" : "🎬视频"}
                        </span>
                      )}
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
                    {note.status === "published" && (
                      <div className="flex gap-2 items-center">
                        {note.note_url && (
                          <button
                            onClick={(e) => { e.stopPropagation(); openInChromium(note.note_url!); }}
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
                    {note.status === "ready" && (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); moveTo(note.id, "draft"); }}
                          className="text-xs text-zinc-400 border border-zinc-200 px-2.5 py-1 rounded-lg hover:bg-zinc-50 transition-colors"
                        >
                          退回草稿
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setPublishingNote(note); }}
                          className="flex items-center gap-1 text-xs text-white bg-[#ff2442] px-2.5 py-1 rounded-lg hover:bg-[#e01f3a] transition-colors font-medium"
                        >
                          <Send size={10} />发布
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); autoPublish(note); }}
                          disabled={autoPublishingId !== null}
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
                    <button
                      onClick={() => navigate(`/notes/${note.id}`)}
                      className="p-1.5 rounded-lg text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
                      title="编辑笔记"
                    >
                      <ChevronRight size={14} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmId(note.id); }}
                      className="p-1.5 rounded-lg text-zinc-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                      title="删除笔记"
                    >
                      <Trash2 size={13} />
                    </button>
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
            <p className="text-xs text-zinc-400 mb-5">此操作不可恢复，笔记将被永久删除。</p>
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

  const { data: note, isLoading } = useQuery<Note>({
    queryKey: ["note", noteId],
    queryFn: () => api.get(`/api/content/${noteId}`),
  });

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");       // HTML 字符串（Tiptap 输出）
  const [tagsInput, setTagsInput] = useState("");
  const [noteType, setNoteType] = useState<"text" | "image" | "video">("text");
  const [saving, setSaving] = useState(false);
  const [autoSaved, setAutoSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showAI, setShowAI] = useState(true);
  const { width: promptWidth, dragging: promptDragging, onDragStart: onPromptDragStart } = usePanelResize({
    defaultWidth: 320,
    min: 240,
    max: 600,
    direction: "left",
    storageKey: "prompt-panel-width",
  });

  // Init local state once note loads
  const [inited, setInited] = useState(false);
  if (note && !inited) {
    setTitle(note.title ?? "");
    // 若已是 HTML（含 <p> 或 <strong>）直接用，否则把纯文本换行转为 <p>
    const rawBody = note.body ?? "";
    const isHtml = /<[a-z][\s\S]*>/i.test(rawBody);
    setBody(isHtml ? rawBody : rawBody.split(/\n+/).filter(Boolean).map((l) => `<p>${l}</p>`).join("") || "");
    setTagsInput(note.tags.join(" "));
    setNoteType((note.note_type as "text" | "image" | "video") || "text");
    setInited(true);
  }

  // Debounce 自动保存
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleAutoSave(newTitle: string, newBody: string, newTags: string) {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(async () => {
      const tags = newTags.split(/[\s,，#]+/).map((t) => t.trim()).filter(Boolean);
      try {
        await api.patch(`/api/content/${noteId}`, {
          title: newTitle,
          body: htmlToPlainText(newBody),
          tags,
          note_type: noteType,
        });
        setAutoSaved(true);
        setTimeout(() => setAutoSaved(false), 2000);
        qc.invalidateQueries({ queryKey: ["notes"] });
      } catch {/* silently ignore */}
    }, AUTOSAVE_DELAY);
  }

  // 清理 timer
  useEffect(() => () => { autoSaveTimer.current && clearTimeout(autoSaveTimer.current); }, []);

  async function save() {
    setSaving(true);
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    try {
      const tags = tagsInput.split(/[\s,，#]+/).map((t) => t.trim()).filter(Boolean);
      // 存纯文本，兼容现有 body 字段和导出逻辑
      await api.patch(`/api/content/${noteId}`, { title, body: htmlToPlainText(body), tags, note_type: noteType });
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["note", noteId] });
      toast("已保存", "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function markReady() {
    try {
      await api.patch(`/api/content/${noteId}/status`, { status: "ready" });
      qc.invalidateQueries({ queryKey: ["note", noteId] });
      qc.invalidateQueries({ queryKey: ["notes"] });
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    }
  }

  async function copyMarkdown() {
    try {
      const res = await api.get(`/api/content/${noteId}/export`);
      await navigator.clipboard.writeText(res.markdown);
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

  /** AIPanel 点击「应用到编辑器」时，将文本追加到正文（转为 HTML 段落） */
  function handleAIApply(text: string) {
    // 把纯文本换行转为 <p> 段落，拼入现有 HTML
    const paragraphs = text.split(/\n+/).filter(Boolean).map((l) => `<p>${l}</p>`).join("");
    const newHtml = body ? body + paragraphs : paragraphs;
    setBody(newHtml);
    scheduleAutoSave(title, newHtml, tagsInput);
  }

  if (isLoading) return <Spinner />;
  if (!note) return <div className="p-6 text-zinc-400">笔记不存在</div>;

  return (
    <div className="flex h-full">
      {/* Left: Phone Preview + Editor */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-100 bg-white">
          <button
            onClick={() => navigate("/notes")}
            className="text-zinc-400 hover:text-zinc-700 text-sm"
          >
            ← 返回
          </button>
          <StatusBadge status={note.status} />
          {autoSaved && (
            <span className="text-xs text-zinc-400 animate-pulse">已自动保存</span>
          )}
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => { setShowAI((v) => !v); setShowPrompt(false); }}
              className={`flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-lg transition-colors ${
                showAI
                  ? "bg-[#fff0f2] border-[#ff2442] text-[#ff2442]"
                  : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
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
              className="flex items-center gap-1.5 text-xs border border-zinc-200 px-3 py-1.5 rounded-lg hover:bg-zinc-50"
            >
              <Copy size={13} />
              {copied ? "已复制!" : "复制 MD"}
            </button>
            {note.status === "draft" && (
              <button
                onClick={markReady}
                className="text-xs bg-amber-500 text-white px-3 py-1.5 rounded-lg hover:bg-amber-600"
              >
                标记待发
              </button>
            )}
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1.5 text-xs bg-[#ff2442] text-white px-3 py-1.5 rounded-lg hover:bg-[#e01f3a] disabled:opacity-50"
            >
              <Save size={13} />
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>

        {/* Editor body: two-column on wide screens, stacked on narrow */}
        <div className="flex-1 overflow-hidden">
          <div className="flex gap-0 h-full">
            {/* Phone-style preview card */}
            <NoteImagePanel
              itemIds={note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : [])}
              title={title}
            />

            {/* Text editor */}
            <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
              {/* 图片缩略条（仿小红书发布页，标题上方） */}
              <div className="px-6 pt-6 shrink-0">
                <NoteImageStrip
                  itemIds={note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : [])}
                  noteId={noteId}
                  onItemIdsChange={(_ids) => qc.invalidateQueries({ queryKey: ["note", noteId] })}
                />

                {/* Title */}
                <input
                  type="text"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    scheduleAutoSave(e.target.value, body, tagsInput);
                  }}
                  placeholder="笔记标题..."
                  className="w-full text-xl font-semibold text-zinc-900 outline-none bg-transparent placeholder:text-zinc-300 mb-3"
                />
              </div>

              {/* Body — RichBodyEditor 填满剩余空间 */}
              <RichBodyEditor
                value={body}
                onChange={(html) => {
                  setBody(html);
                  scheduleAutoSave(title, html, tagsInput);
                }}
                className="flex-1 min-h-0"
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
                  placeholder="#出租屋改造 #租房好物 ..."
                  className="w-full text-xs text-[#ff2442] outline-none bg-transparent placeholder:text-zinc-300 leading-snug"
                />
              </div>

              {/* 发布类型选择 */}
              <div className="shrink-0 border-t border-zinc-100 px-6 py-2.5 flex items-center gap-3">
                <span className="text-[11px] text-zinc-400 shrink-0">发布类型</span>
                <div className="flex gap-1.5">
                  {([
                    { key: "text",  label: "文字配图", icon: "📝" },
                    { key: "image", label: "图文多图",  icon: "🖼️" },
                    { key: "video", label: "视频",     icon: "🎬" },
                  ] as const).map(({ key, label, icon }) => (
                    <button
                      key={key}
                      onClick={async () => {
                        setNoteType(key);
                        try {
                          await api.patch(`/api/content/${noteId}`, { note_type: key });
                          qc.invalidateQueries({ queryKey: ["note", noteId] });
                        } catch {/* ignore */}
                      }}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                        noteType === key
                          ? "bg-[#ff2442] text-white"
                          : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                      }`}
                    >
                      <span>{icon}</span>{label}
                    </button>
                  ))}
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
          onApply={handleAIApply}
          onApplyTitle={(t) => {
            setTitle(t);
            scheduleAutoSave(t, body, tagsInput);
          }}
          onApplyTags={(tags) => {
            setTagsInput(tags);
            scheduleAutoSave(title, body, tags);
          }}
          onApplyBody={(html, mode) => {
            const newBody = mode === "replace" ? html : body + html;
            setBody(newBody);
            scheduleAutoSave(title, newBody, tagsInput);
          }}
          onClose={() => setShowAI(false)}
        />
      )}
      {showPrompt && prompt && (
        <div
          className="border-l border-zinc-100 bg-white flex flex-col shrink-0 relative select-none"
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
            <button onClick={() => setShowPrompt(false)} className="text-zinc-400 hover:text-zinc-700 text-xs">
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
                    <img
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
// 仿小红书编辑页左侧图片区：顶部多图缩略条 + 大图预览 + 正文占位

function NoteImagePanel({ itemIds, title }: {
  itemIds: number[];
  title: string;
}) {
  const { imgStyle } = useHDRSetting();
  const results = useQueries({
    queries: itemIds.map((id) => ({
      queryKey: ["item", id],
      queryFn: () => api.get(`/api/library/${id}`) as Promise<Item>,
      enabled: !!id,
    })),
  });
  const images = results
    .map((r) => r.data)
    .filter((d): d is Item => !!d);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const safeIdx = Math.min(selectedIdx, Math.max(images.length - 1, 0));
  void setSelectedIdx; // 左侧预览暂无切换交互，保留 state 供后续扩展

  return (
    <div className="w-[220px] shrink-0 border-r border-zinc-100 bg-zinc-50 flex flex-col items-center py-6 px-4 gap-3">

      {/* ── 仿小红书发布页手机卡片 ── */}
      <div className="w-full rounded-2xl overflow-hidden shadow-lg border border-zinc-200 bg-white flex flex-col">

        {/* 大图预览区（无顶部缩略条） */}
        <div className="relative w-full aspect-[3/4] bg-zinc-100 overflow-hidden">
          {images.length > 0 ? (
            <img
              src={`${API_BASE}/api/library/${images[safeIdx]?.id}/image`}
              alt={images[safeIdx]?.title}
              style={imgStyle()}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-zinc-300">
              <ImagePlus size={28} />
              <span className="text-xs">暂无关联图片</span>
            </div>
          )}
          {images.length > 1 && (
            <div className="absolute bottom-2 right-2 bg-black/40 text-white text-[10px] px-1.5 py-0.5 rounded-full">
              {safeIdx + 1}/{images.length}
            </div>
          )}
        </div>

        {/* 标题 + 正文占位条 */}
        <div className="px-2.5 py-2.5 space-y-1.5">
          {title ? (
            <p className="text-[11px] font-semibold text-zinc-800 leading-snug line-clamp-2">{title}</p>
          ) : (
            <div className="h-2.5 w-4/5 rounded bg-zinc-100" />
          )}
          <div className="h-2 w-full rounded bg-zinc-100" />
          <div className="h-2 w-3/4 rounded bg-zinc-100" />
          <div className="h-2 w-1/2 rounded bg-zinc-100 mt-0.5" />
          <div className="flex gap-1 mt-1.5">
            <div className="h-2 w-8 rounded-full bg-[#ff2442]/15" />
            <div className="h-2 w-10 rounded-full bg-[#ff2442]/15" />
            <div className="h-2 w-8 rounded-full bg-[#ff2442]/15" />
          </div>
        </div>
      </div>

      {/* 物品信息（多图时显示数量） */}
      {images.length > 0 && (
        <div className="w-full text-center space-y-0.5">
          {images.length === 1 ? (
            <>
              <p className="text-xs font-medium text-zinc-700 truncate">{images[0].title}</p>
              {images[0].style && <p className="text-xs text-zinc-400 truncate">{images[0].style}</p>}
            </>
          ) : (
            <p className="text-xs font-medium text-zinc-700">{images.length} 张图片</p>
          )}
        </div>
      )}

      <p className="text-xs text-zinc-400 text-center leading-relaxed">
        在右侧填写标题和正文<br />完成后复制发布到小红书
      </p>
    </div>
  );
}

// ── NoteImageStrip ────────────────────────────────────────────────────────────
// 右侧编辑区标题上方的横向图片缩略条，仿小红书发布页多图选择器

function NoteImageStrip({ itemIds, noteId, onItemIdsChange }: {
  itemIds: number[];
  noteId: number;
  onItemIdsChange: (ids: number[]) => void;
}) {
  const { imgStyle } = useHDRSetting();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const results = useQueries({
    queries: itemIds.map((id) => ({
      queryKey: ["item", id],
      queryFn: () => api.get(`/api/library/${id}`) as Promise<Item>,
      enabled: !!id,
    })),
  });
  const images = results.map((r) => r.data).filter((d): d is Item => !!d);

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
          <div key={img.id} className="relative shrink-0 group">
            <div
              className="w-[120px] h-[120px] rounded-xl overflow-hidden border-2 border-[#ff2442] shadow-sm cursor-zoom-in"
              onClick={() => setLightboxIdx(idx)}
            >
              <img
                src={`${API_BASE}/api/library/${img.id}/image`}
                alt={img.title}
                style={imgStyle()}
                className="w-full h-full object-cover"
              />
              <span className="absolute top-1 right-1 min-w-[18px] h-[18px] rounded-full bg-black/50 text-white text-[10px] font-bold flex items-center justify-center px-1 leading-none">
                {idx + 1}
              </span>
            </div>
            <button
              onClick={async () => {
                const newIds = itemIds.filter((id) => id !== img.id);
                try {
                  await api.patch(`/api/content/${noteId}`, { item_ids: newIds });
                  onItemIdsChange(newIds);
                } catch (e: unknown) { toast((e as Error).message, "error"); }
              }}
              className="absolute -top-1 -right-1 z-10 w-5 h-5 rounded-full bg-zinc-800 text-white text-[10px] items-center justify-center hidden group-hover:flex hover:bg-red-500 transition-colors"
            >✕</button>
          </div>
        ))}
        {images.length < 9 && (
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
              await api.patch(`/api/content/${noteId}`, { item_ids: merged });
              onItemIdsChange(merged);
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

        <img
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
