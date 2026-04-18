import { useState, useEffect, useRef } from "react";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { api, API_BASE } from "../lib/api";
import { Note, Item } from "../lib/types";
import { Spinner, Empty, StatusBadge } from "../components/ui";
import { Save, Copy, ChevronRight, Sparkles, ImagePlus, Hash } from "lucide-react";
import AIPanel from "../components/AIPanel";
import { useToast } from "../components/Toast";
import { useHDRSetting } from "../hooks/useHDRSetting";

const AUTOSAVE_DELAY = 1500; // ms

// ── Note List ────────────────────────────────────────────────────────────────

export function NoteList() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const { imgStyle } = useHDRSetting();

  const { data: notes = [], isLoading } = useQuery<Note[]>({
    queryKey: ["notes", statusFilter],
    queryFn: () =>
      api.get(`/api/content/${statusFilter ? `?status=${statusFilter}` : ""}`),
  });

  const tabs = [
    { key: "", label: "全部" },
    { key: "draft", label: "草稿" },
    { key: "ready", label: "待发" },
    { key: "published", label: "已发" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex gap-1 px-6 py-4 border-b border-zinc-100 bg-white">
        <h1 className="text-lg font-semibold text-zinc-900 mr-4">笔记草稿</h1>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatusFilter(t.key)}
            className={`text-sm px-3 py-1 rounded-lg transition-colors ${
              statusFilter === t.key
                ? "bg-[#ff2442] text-white"
                : "text-zinc-500 hover:bg-zinc-100"
            }`}
          >
            {t.label}
          </button>
        ))}
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
                onClick={() => navigate(`/notes/${note.id}`)}
                className="bg-white rounded-xl p-4 border border-zinc-100 hover:border-zinc-300 cursor-pointer transition-colors group"
              >
                <div className="flex items-start gap-3">
                  {/* Thumbnail */}
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
                  <ChevronRight size={16} className="text-zinc-300 group-hover:text-zinc-500 mt-1 shrink-0" />
                </div>
                {note.status === "published" && (
                  <div className="flex gap-4 mt-2 text-xs text-zinc-400 border-t border-zinc-50 pt-2 ml-[68px]">
                    <span>❤ {note.likes}</span>
                    <span>💬 {note.comments}</span>
                    <span>⭐ {note.collects}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
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
  const [body, setBody] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [autoSaved, setAutoSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showAI, setShowAI] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Init local state once note loads
  const [inited, setInited] = useState(false);
  if (note && !inited) {
    setTitle(note.title ?? "");
    setBody(note.body ?? "");
    setTagsInput(note.tags.join(" "));
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
          body: newBody,
          tags,
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
      await api.patch(`/api/content/${noteId}`, { title, body, tags });
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

  /** AIPanel 点击「应用到编辑器」时，将文本追加到正文 */
  function handleAIApply(text: string) {
    setBody((prev) => (prev ? prev + "\n\n" + text : text));
    scheduleAutoSave(title, (body ? body + "\n\n" + text : text), tagsInput);
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
              onClick={() => setShowAI((v) => !v)}
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
                onClick={loadPrompt}
                className="text-xs text-zinc-500 border border-zinc-200 px-3 py-1.5 rounded-lg hover:bg-zinc-50"
              >
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
        <div className="flex-1 overflow-y-auto">
          <div className="flex gap-0 h-full">
            {/* Phone-style preview card */}
            <NoteImagePanel itemIds={note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : [])} />

            {/* Text editor */}
            <div className="flex-1 p-6 min-w-0">
              {/* 图片缩略条（仿小红书发布页，标题上方） */}
              <NoteImageStrip itemIds={note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : [])} />

              {/* Title */}
              <input
                type="text"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  scheduleAutoSave(e.target.value, body, tagsInput);
                }}
                placeholder="笔记标题..."
                className="w-full text-xl font-semibold text-zinc-900 outline-none bg-transparent placeholder:text-zinc-300 mb-4"
              />

              {/* Body */}
              <textarea
                ref={bodyRef}
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  scheduleAutoSave(title, e.target.value, tagsInput);
                }}
                placeholder="正文内容...（支持小红书换行风格）"
                className="w-full min-h-64 text-sm text-zinc-700 outline-none bg-transparent resize-none placeholder:text-zinc-300 leading-relaxed"
              />

              <div className="border-t border-zinc-100 pt-4 mt-4">
                <div className="flex items-center gap-1.5 mb-1">
                  <Hash size={12} className="text-zinc-400" />
                  <label className="text-xs text-zinc-400">话题标签（空格或#分隔）</label>
                </div>
                <input
                  type="text"
                  value={tagsInput}
                  onChange={(e) => {
                    setTagsInput(e.target.value);
                    scheduleAutoSave(title, body, e.target.value);
                  }}
                  placeholder="#出租屋改造 #租房好物 ..."
                  className="w-full text-sm text-[#ff2442] outline-none bg-transparent placeholder:text-zinc-300"
                />
              </div>

              {/* Prompt panel */}
              {showPrompt && prompt && (
                <div className="mt-4 bg-zinc-50 rounded-xl p-4 border border-zinc-200">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-zinc-600">创作 Prompt</span>
                    <button onClick={() => setShowPrompt(false)} className="text-xs text-zinc-400">收起</button>
                  </div>
                  <pre className="text-xs text-zinc-600 whitespace-pre-wrap leading-relaxed">{prompt}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Right: AI Panel */}
      {showAI && (
        <AIPanel
          noteId={noteId}
          itemId={note.item_id}
          onApply={handleAIApply}
          onClose={() => setShowAI(false)}
        />
      )}
    </div>
  );
}

// ── NoteImagePanel ────────────────────────────────────────────────────────────
// 仿小红书编辑页左侧图片区：顶部多图缩略条 + 大图预览 + 正文占位

function NoteImagePanel({ itemIds }: { itemIds: number[] }) {
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

  return (
    <div className="w-[240px] shrink-0 border-r border-zinc-100 bg-zinc-50 flex flex-col items-center py-6 px-4 gap-3">

      {/* ── 仿小红书发布页手机卡片 ── */}
      <div className="w-full max-w-[200px] rounded-2xl overflow-hidden shadow-lg border border-zinc-200 bg-white flex flex-col">

        {/* 顶部多图缩略条 */}
        <div className="px-2 pt-2.5 pb-1.5 bg-white border-b border-zinc-50">
          <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
            {images.length > 0 ? (
              images.map((img, idx) => (
                <button
                  key={img.id}
                  onClick={() => setSelectedIdx(idx)}
                  className={`relative shrink-0 w-[52px] h-[52px] rounded-lg overflow-hidden border-2 transition-all ${
                    safeIdx === idx
                      ? "border-[#ff2442] shadow-sm"
                      : "border-transparent opacity-70 hover:opacity-100"
                  }`}
                >
                  <img
                    src={`${API_BASE}/api/library/${img.id}/image`}
                    alt={img.title}
                    style={imgStyle()}
                    className="w-full h-full object-cover"
                  />
                  <span className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/40 text-white text-[9px] font-bold flex items-center justify-center leading-none">
                    {idx + 1}
                  </span>
                </button>
              ))
            ) : (
              <div className="shrink-0 w-[52px] h-[52px] rounded-lg border-2 border-dashed border-zinc-200 flex items-center justify-center text-zinc-300">
                <ImagePlus size={16} />
              </div>
            )}
            {images.length > 0 && images.length < 9 && (
              <div className="shrink-0 w-[52px] h-[52px] rounded-lg border-2 border-dashed border-zinc-200 flex items-center justify-center text-zinc-300 cursor-default">
                <ImagePlus size={14} />
              </div>
            )}
          </div>
        </div>

        {/* 大图预览区 */}
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

        {/* 正文占位条 */}
        <div className="px-2.5 py-2.5 space-y-1.5">
          <div className="h-2.5 w-4/5 rounded bg-zinc-100" />
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

function NoteImageStrip({ itemIds }: { itemIds: number[] }) {
  const { imgStyle } = useHDRSetting();
  const results = useQueries({
    queries: itemIds.map((id) => ({
      queryKey: ["item", id],
      queryFn: () => api.get(`/api/library/${id}`) as Promise<Item>,
      enabled: !!id,
    })),
  });
  const images = results.map((r) => r.data).filter((d): d is Item => !!d);

  if (itemIds.length === 0) return null;

  return (
    <div className="flex gap-2 mb-5 overflow-x-auto scrollbar-none pb-0.5">
      {images.map((img, idx) => (
        <div
          key={img.id}
          className="relative shrink-0 w-[72px] h-[72px] rounded-xl overflow-hidden border-2 border-[#ff2442] shadow-sm"
        >
          <img
            src={`${API_BASE}/api/library/${img.id}/image`}
            alt={img.title}
            style={imgStyle()}
            className="w-full h-full object-cover"
          />
          <span className="absolute top-1 right-1 min-w-[16px] h-4 rounded-full bg-black/50 text-white text-[9px] font-bold flex items-center justify-center px-1 leading-none">
            {idx + 1}
          </span>
        </div>
      ))}
      <div className="shrink-0 w-[72px] h-[72px] rounded-xl border-2 border-dashed border-zinc-200 flex flex-col items-center justify-center gap-1 text-zinc-300 cursor-default">
        <ImagePlus size={18} />
        <span className="text-[10px]">添加图片</span>
      </div>
    </div>
  );
}
