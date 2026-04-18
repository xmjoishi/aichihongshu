import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, API_BASE } from "../lib/api";
import { Item } from "../lib/types";
import { Spinner, Tag } from "../components/ui";
import {
  Upload, Plus, X, FileText, ChevronLeft, ChevronRight,
  LayoutGrid, Grid2x2, Grid3x3, Sparkles, Trash2, FolderOpen,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useNavigate } from "react-router-dom";
import { useToast } from "../components/Toast";
import { useHDRSetting } from "../hooks/useHDRSetting";

// 列数 → Tailwind grid class
const COLS_CLASS: Record<number, string> = {
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
  7: "grid-cols-7",
  8: "grid-cols-8",
};

const PAGE_SIZE = 40;

// 解析 analysis_raw JSON 字符串，安全返回
function parseAnalysis(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export default function Library() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { imgStyle } = useHDRSetting();
  const [selected, setSelected] = useState<Item | null>(null);
  const [multiSelected, setMultiSelected] = useState<Set<number>>(new Set());
  const [draftingMulti, setDraftingMulti] = useState(false);
  const [filterTag, setFilterTag] = useState("");
  const [uploading, setUploading] = useState(false);
  const [page, setPage] = useState(0);
  const [cols, setCols] = useState(8); // 默认小图8列
  const [analyzingIds, setAnalyzingIds] = useState<Set<number>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: items = [], isLoading } = useQuery<Item[]>({
    queryKey: ["items", filterTag, page],
    queryFn: () =>
      api.get(
        `/api/library/?offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}${
          filterTag ? `&tag=${encodeURIComponent(filterTag)}` : ""
        }`
      ),
    // 如果有正在分析的图片，每 3 秒轮询一次
    refetchInterval: analyzingIds.size > 0 ? 3000 : false,
  });

  // 轮询时检查哪些图片已完成分析，移除 analyzingIds
  useEffect(() => {
    if (analyzingIds.size === 0) return;
    setAnalyzingIds((prev) => {
      const next = new Set(prev);
      for (const item of items) {
        if (next.has(item.id) && item.analysis_raw) {
          next.delete(item.id);
        }
      }
      return next;
    });
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  // 导入后追踪哪些图片需要等待 AI 分析
  async function handleUpload(files: FileList | File[] | null) {
    if (!files || !files.length) return;
    setUploading(true);
    try {
      const newIds: number[] = [];
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("analyze", "true");
        const item: Item = await api.upload("/api/library/", fd);
        newIds.push(item.id);
      }
      // 标记这批图片为分析中
      setAnalyzingIds((prev) => {
        const next = new Set(prev);
        newIds.forEach((id) => next.add(id));
        return next;
      });
      qc.invalidateQueries({ queryKey: ["items"] });
      toast(`已导入 ${files.length} 张图片，AI 识别中...`, "success");
    } catch (e: unknown) {
      console.error("[Library] upload error:", e);
      toast((e as Error).message, "error");
    } finally {
      setUploading(false);
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    await handleUpload(e.dataTransfer.files);
  }

  async function draftNote() {
    if (!selected) return;
    try {
      const res = await api.post("/api/content/draft", { item_id: selected.id, save: true });
      navigate(`/notes/${res.note_id}`);
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    }
  }

  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletingMulti, setDeletingMulti] = useState(false);
  const [deleteMultiConfirm, setDeleteMultiConfirm] = useState(false);

  async function deleteItem() {
    if (!selected) return;
    setDeleting(true);
    try {
      await api.delete(`/api/library/${selected.id}`);
      toast("已删除", "success");
      setSelected(null);
      setDeleteConfirm(false);
      qc.invalidateQueries({ queryKey: ["items"] });
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setDeleting(false);
    }
  }

  async function deleteMulti() {
    if (multiSelected.size === 0) return;
    setDeletingMulti(true);
    const ids = Array.from(multiSelected);
    let failed = 0;
    for (const id of ids) {
      try {
        await api.delete(`/api/library/${id}`);
      } catch {
        failed++;
      }
    }
    setDeletingMulti(false);
    setDeleteMultiConfirm(false);
    setMultiSelected(new Set());
    qc.invalidateQueries({ queryKey: ["items"] });
    if (failed === 0) {
      toast(`已删除 ${ids.length} 张图片`, "success");
    } else {
      toast(`删除完成，${failed} 张失败`, "error");
    }
  }

  async function draftMulti() {
    if (multiSelected.size === 0) return;
    setDraftingMulti(true);
    try {
      const res = await api.post("/api/content/draft/multi", {
        item_ids: Array.from(multiSelected),
      });
      navigate(`/notes/${res.note_id}`);
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setDraftingMulti(false);
    }
  }

  function handleCardClick(item: Item, e: React.MouseEvent) {
    // Ctrl/Cmd + 单击 → 切换多选
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setMultiSelected((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) {
          next.delete(item.id);
        } else {
          next.add(item.id);
        }
        return next;
      });
      return;
    }
    // 普通单击 → 打开详情
    setSelected(item);
    setDeleteConfirm(false);
  }

  // 收集所有标签（仅当前页，做标签过滤）
  const allTags = Array.from(new Set(items.flatMap((i) => i.tags)));
  const hasPrev = page > 0;
  const hasNext = items.length === PAGE_SIZE;

  function changeFilter(tag: string) {
    setFilterTag(tag);
    setPage(0);
  }

  // 粘贴入库：监听全局 paste 事件，提取图片文件
  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      // 如果焦点在输入框内则跳过，不干扰文字粘贴
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      const items = Array.from(e.clipboardData?.items ?? []);
      console.log("[Library] paste event, clipboardData items:", items.map(i => `${i.kind}/${i.type}`));

      const imageFiles = items
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);

      console.log("[Library] image files found:", imageFiles.length, imageFiles.map(f => f.name || f.type));

      if (imageFiles.length > 0) {
        e.preventDefault();
        handleUpload(imageFiles);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uploading],
  );

  useEffect(() => {
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [handlePaste]);

  return (
    <div className="flex h-full">
      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* 第一行：操作栏 */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-100 bg-white">
          <h1 className="text-lg font-semibold text-zinc-900">图库</h1>
          <div className="ml-auto flex items-center gap-3">
            {/* 尺寸调节 */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setCols(3)}
                title="大图"
                className={`p-1.5 rounded-lg transition-colors ${cols <= 3 ? "bg-zinc-100 text-zinc-800" : "text-zinc-400 hover:bg-zinc-50"}`}
              >
                <Grid2x2 size={15} />
              </button>
              <button
                onClick={() => setCols(5)}
                title="中图"
                className={`p-1.5 rounded-lg transition-colors ${cols === 5 ? "bg-zinc-100 text-zinc-800" : "text-zinc-400 hover:bg-zinc-50"}`}
              >
                <Grid3x3 size={15} />
              </button>
              <button
                onClick={() => setCols(8)}
                title="小图"
                className={`p-1.5 rounded-lg transition-colors ${cols >= 8 ? "bg-zinc-100 text-zinc-800" : "text-zinc-400 hover:bg-zinc-50"}`}
              >
                <LayoutGrid size={15} />
              </button>
              <input
                type="range"
                min={2}
                max={8}
                step={1}
                value={cols}
                onChange={(e) => setCols(Number(e.target.value))}
                className="w-20 accent-[#ff2442] cursor-pointer"
                title={`${cols} 列`}
              />
              <span className="text-xs text-zinc-400 w-6 text-center">{cols}</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              onChange={(e) => handleUpload(e.target.files)}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 text-sm bg-[#ff2442] text-white px-3 py-1.5 rounded-lg hover:bg-[#e01f3a] transition-colors disabled:opacity-50"
            >
              {uploading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Plus size={15} />
              )}
              导入图片
            </button>
            <span className="text-xs text-zinc-300 hidden lg:block">或 ⌘V 粘贴</span>
          </div>
        </div>

        {/* 第二行：标签过滤 */}
        <div className="px-6 py-2 border-b border-zinc-100 bg-white">
          <div className={`flex gap-2 flex-wrap ${tagsExpanded ? "" : "max-h-8 overflow-hidden"}`}>
            <button
              onClick={() => changeFilter("")}
              className={`text-xs px-3 py-1 rounded-full transition-colors shrink-0 ${
                filterTag === "" ? "bg-[#ff2442] text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
              }`}
            >全部</button>
            {allTags.map((t) => (
              <button key={t}
                onClick={() => changeFilter(filterTag === t ? "" : t)}
                className={`text-xs px-3 py-1 rounded-full transition-colors shrink-0 ${
                  filterTag === t ? "bg-[#ff2442] text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                }`}
              >#{t}</button>
            ))}
          </div>
          {allTags.length > 6 && (
            <button
              onClick={() => setTagsExpanded((v) => !v)}
              className="mt-1 text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
            >
              {tagsExpanded ? "收起 ▲" : `展开全部 ${allTags.length} 个标签 ▼`}
            </button>
          )}
        </div>

        {/* Drop zone + Grid */}
        <div
          className="flex-1 overflow-y-auto p-6 relative"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          {isLoading ? <Spinner /> : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-zinc-200 rounded-2xl gap-3 text-zinc-400">
              <Upload size={32} />
              <p className="text-sm">拖拽图片到此处，或点击「导入图片」</p>
              <p className="text-xs text-zinc-300">也可直接 Ctrl+V / ⌘+V 粘贴截图</p>
            </div>
          ) : (
            <>
              <div className={`grid ${COLS_CLASS[cols] ?? "grid-cols-4"} gap-4`}>
                {items.map((item) => {
                  const isMulti = multiSelected.has(item.id);
                  const isSingle = selected?.id === item.id;
                  return (
                    <div
                      key={item.id}
                      onClick={(e) => handleCardClick(item, e)}
                      className={`group cursor-pointer rounded-xl overflow-hidden border-2 transition-all relative ${
                        isSingle
                          ? "border-[#ff2442] shadow-md"
                          : isMulti
                          ? "border-transparent"
                          : "border-transparent hover:border-zinc-200"
                      } bg-white`}
                    >
                      {/* 多选遮罩 + 勾选 */}
                      {isMulti && (
                        <>
                          <div className="absolute inset-0 z-10 bg-zinc-900/30 rounded-xl pointer-events-none" />
                          <div className="absolute top-1.5 right-1.5 z-20 w-5 h-5 bg-[#ff2442] rounded-full flex items-center justify-center shadow">
                            <span className="text-white text-xs font-bold">✓</span>
                          </div>
                        </>
                      )}
                      <div className="aspect-square bg-zinc-100 overflow-hidden relative">
                        <img
                          src={`${API_BASE}/api/library/${item.id}/image`}
                          alt={item.title}
                          loading="lazy"
                          style={imgStyle()}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          onError={(e) => {
                            (e.target as HTMLImageElement).src =
                              "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect fill='%23f4f4f5' width='100' height='100'/%3E%3C/svg%3E";
                          }}
                        />
                        {/* AI 识别标识 */}
                        <div className={`absolute bottom-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight ${
                          item.analysis_raw
                            ? "bg-black/50 text-white"
                            : "bg-zinc-800/60 text-zinc-300"
                        }`}>
                          {item.analysis_raw ? "AI ✓" : "未识别"}
                        </div>
                      </div>
                      <div className="p-2">
                        <p className="text-xs font-medium text-zinc-800 truncate">{item.title}</p>
                        {item.style && (
                          <p className="text-xs text-zinc-400 truncate">{item.style}</p>
                        )}
                        {item.note_count > 0 && (
                          <p className="text-xs text-[#ff2442] mt-0.5">
                            <FileText size={10} className="inline mr-0.5" />
                            {item.note_count} 篇笔记
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 分页 */}
              {(hasPrev || hasNext) && (
                <div className="flex items-center justify-center gap-3 mt-6">
                  <button
                    onClick={() => setPage((p) => p - 1)}
                    disabled={!hasPrev}
                    className="p-1.5 rounded-lg border border-zinc-200 text-zinc-500 disabled:opacity-30 hover:bg-zinc-50"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="text-xs text-zinc-500">第 {page + 1} 页</span>
                  <button
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!hasNext}
                    className="p-1.5 rounded-lg border border-zinc-200 text-zinc-500 disabled:opacity-30 hover:bg-zinc-50"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}
              {/* 多选提示 */}
              <p className="text-xs text-zinc-400 text-center mt-4">
                按住 <kbd className="px-1 py-0.5 bg-zinc-100 rounded text-zinc-500">⌘</kbd> / <kbd className="px-1 py-0.5 bg-zinc-100 rounded text-zinc-500">Ctrl</kbd> 单击可多选物品，合并生成一篇笔记
              </p>
            </>
          )}
        </div>

        {/* 多选底部浮出操作栏 */}
        {multiSelected.size > 0 && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2">
            {deleteMultiConfirm && (
              <div className="flex items-center gap-2 bg-red-600 text-white px-4 py-2.5 rounded-2xl shadow-2xl border border-red-500 text-sm">
                <span>确认删除 {multiSelected.size} 张图片？</span>
                <button
                  onClick={deleteMulti}
                  disabled={deletingMulti}
                  className="bg-white text-red-600 text-xs font-semibold px-3 py-1 rounded-xl hover:bg-red-50 disabled:opacity-50 transition-colors"
                >
                  {deletingMulti ? "删除中..." : "确认"}
                </button>
                <button
                  onClick={() => setDeleteMultiConfirm(false)}
                  className="text-red-200 hover:text-white transition-colors"
                >
                  <X size={15} />
                </button>
              </div>
            )}
            <div className="flex items-center gap-3 bg-zinc-900 text-white px-5 py-3 rounded-2xl shadow-2xl border border-zinc-700">
              <span className="text-sm font-medium">已选 {multiSelected.size} 张</span>
              <div className="w-px h-4 bg-zinc-600" />
              <button
                onClick={draftMulti}
                disabled={draftingMulti}
                className="flex items-center gap-1.5 text-sm bg-[#ff2442] text-white px-3.5 py-1.5 rounded-xl hover:bg-[#e01f3a] transition-colors disabled:opacity-50 font-medium"
              >
                {draftingMulti ? (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                合并生成草稿
              </button>
              <button
                onClick={() => setDeleteMultiConfirm(true)}
                disabled={deletingMulti}
                className="flex items-center gap-1.5 text-sm text-zinc-300 hover:text-red-400 px-2 py-1.5 rounded-xl hover:bg-zinc-800 transition-colors disabled:opacity-50"
                title="批量删除"
              >
                <Trash2 size={14} />
                删除
              </button>
              <button
                onClick={() => { setMultiSelected(new Set()); setDeleteMultiConfirm(false); }}
                className="text-zinc-400 hover:text-white transition-colors"
                title="取消多选"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="w-72 border-l border-zinc-100 bg-white flex flex-col overflow-y-auto">
          <div className="flex items-center justify-between p-4 border-b border-zinc-100">
            <span className="text-sm font-semibold">物品详情</span>
            <button onClick={() => setSelected(null)} className="text-zinc-400 hover:text-zinc-700">
              <X size={16} />
            </button>
          </div>

          <img
            src={`${API_BASE}/api/library/${selected.id}/image`}
            alt={selected.title}
            style={imgStyle()}
            className="w-full aspect-square object-cover"
          />

          <div className="p-4 space-y-3 flex-1">
            <InfoRow label="名称" value={selected.title} bold />
            {selected.style && <InfoRow label="风格" value={selected.style} />}
            {selected.scene && <InfoRow label="场景" value={selected.scene} />}
            {selected.color && <InfoRow label="主色调" value={selected.color} />}
            {selected.material && <InfoRow label="材质" value={selected.material} />}

            {selected.tags.length > 0 && (
              <div>
                <p className="text-xs text-zinc-400 mb-1">标签</p>
                <div className="flex flex-wrap gap-1">
                  {selected.tags.map((t) => <Tag key={t} label={t} />)}
                </div>
              </div>
            )}

            {/* 分析结果扩展字段 */}
            <AnalysisExtra raw={selected.analysis_raw} />
          </div>

          <div className="p-4 border-t border-zinc-100 space-y-2">
            <button
              onClick={draftNote}
              className="w-full bg-[#ff2442] text-white text-sm py-2.5 rounded-xl hover:bg-[#e01f3a] transition-colors font-medium"
            >
              ✨ 生成笔记草稿
            </button>

            {/* 重新 AI 分析 */}
            <button
              onClick={async () => {
                if (!selected) return;
                try {
                  await api.post(`/api/library/${selected.id}/analyze`, {});
                  setAnalyzingIds((prev) => new Set(prev).add(selected.id));
                  toast("AI 识别已触发，稍后自动刷新", "success");
                } catch (e: unknown) {
                  toast((e as Error).message, "error");
                }
              }}
              disabled={analyzingIds.has(selected.id)}
              className="w-full flex items-center justify-center gap-1.5 text-sm text-zinc-400
                         py-2 rounded-xl hover:bg-zinc-50 hover:text-zinc-600 transition-colors disabled:opacity-50"
            >
              {analyzingIds.has(selected.id) ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-zinc-400 border-t-transparent rounded-full animate-spin" />
                  AI 识别中...
                </>
              ) : (
                <>
                  <Sparkles size={13} />
                  {selected.analysis_raw ? "重新 AI 识别" : "触发 AI 识别"}
                </>
              )}
            </button>

            {!deleteConfirm ? (
              <div className="flex gap-2">
                <button
                  onClick={() => selected?.image_path && revealItemInDir(selected.image_path)}
                  className="flex-1 flex items-center justify-center gap-1.5 text-sm text-zinc-400
                             py-2 rounded-xl hover:bg-zinc-50 hover:text-zinc-600 transition-colors"
                >
                  <FolderOpen size={13} />
                  在文件夹中显示
                </button>
                <button
                  onClick={() => setDeleteConfirm(true)}
                  className="flex-1 flex items-center justify-center gap-1.5 text-sm text-zinc-400
                             py-2 rounded-xl hover:bg-zinc-50 hover:text-red-500 transition-colors"
                >
                  <Trash2 size={13} />
                  删除物品
                </button>
              </div>
            ) : (
              <div className="bg-red-50 rounded-xl p-3 space-y-2">
                <p className="text-xs text-red-600 text-center">确认删除「{selected.title}」？</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setDeleteConfirm(false)}
                    className="flex-1 text-xs py-1.5 rounded-lg border border-zinc-200 text-zinc-500 hover:bg-white transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={deleteItem}
                    disabled={deleting}
                    className="flex-1 text-xs py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
                  >
                    {deleting ? "删除中..." : "确认删除"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 子组件 ─────────────────────────────────────────────────────────

function InfoRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div>
      <p className="text-xs text-zinc-400">{label}</p>
      <p className={`text-sm text-zinc-700 ${bold ? "font-medium text-zinc-900" : ""}`}>{value}</p>
    </div>
  );
}

function AnalysisExtra({ raw }: { raw?: string }) {
  const data = parseAnalysis(raw);

  // 健壮地将字段转为 string[]，避免字符串/null 等意外类型
  function toStringArray(val: unknown): string[] {
    if (!val) return [];
    if (Array.isArray(val)) return val.filter((v) => typeof v === "string");
    if (typeof val === "string") return val.split("\n").map((s) => s.trim()).filter(Boolean);
    return [];
  }

  const selling = toStringArray(data.xhs_selling_points);
  const pairing = toStringArray(data.pairing_suggestions);
  const desc = typeof data.description === "string" ? data.description : undefined;

  if (!selling.length && !pairing.length && !desc) return null;

  return (
    <>
      {desc && (
        <div>
          <p className="text-xs text-zinc-400 mb-1">物品描述</p>
          <p className="text-xs text-zinc-600 leading-relaxed">{desc}</p>
        </div>
      )}
      {selling.length > 0 && (
        <div>
          <p className="text-xs text-zinc-400 mb-1">小红书卖点</p>
          <ul className="space-y-1">
            {selling.map((s, i) => (
              <li key={i} className="text-xs text-zinc-700 flex gap-1.5">
                <span className="text-[#ff2442] shrink-0">✦</span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
      {pairing.length > 0 && (
        <div>
          <p className="text-xs text-zinc-400 mb-1">搭配建议</p>
          <ul className="space-y-1">
            {pairing.map((s, i) => (
              <li key={i} className="text-xs text-zinc-600 flex gap-1.5">
                <span className="text-zinc-300 shrink-0">•</span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
