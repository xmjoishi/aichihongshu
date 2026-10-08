import { useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  useWorkspaceActive,
  useWorkspaceEffect,
  useWorkspaceQuery as useQuery,
} from "../../lib/workspaceActivity";
import { api, API_BASE } from "../../lib/api";
import { IS_TAURI_RUNTIME, type LocalWorkspaceSnapshot } from "../../lib/local";
import type { Item } from "../../lib/types";
import LocalImage from "../../components/LocalImage";
import { ChevronRight, ImagePlus } from "lucide-react";
import { useHDRSetting } from "../../hooks/useHDRSetting";
import { useToast } from "../../components/Toast";
import LibraryPickerModal from "./LibraryPickerModal";

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

export function NoteImagePanel({ itemIds, title, body, tags, localItems, localProfile }: {
  itemIds: number[];
  title: string;
  body: string;
  tags: string[];
  localItems?: Item[];
  localProfile?: LocalWorkspaceSnapshot["profile"];
}) {
  const { imgStyle } = useHDRSetting();
  const localItemsById = useMemo(() => new Map((localItems ?? []).map((item) => [item.id, item])), [localItems]);
  const workspaceActive = useWorkspaceActive();
  const results = useQueries({
    queries: itemIds.map((id) => ({
      queryKey: ["item", id],
      queryFn: () => api.get(`/api/library/${id}`) as Promise<Item>,
      enabled: workspaceActive && !!id && !IS_TAURI_RUNTIME && !localItemsById.has(id),
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
    enabled: !IS_TAURI_RUNTIME,
  });
  const displayName = localProfile?.displayName || profile?.display_name || "账号名称";
  const avatarUrl = localProfile?.avatarUrl || profile?.avatar_url || "";

  const [tab, setTab] = useState<"note" | "cover">("note");
  const [imgIdx, setImgIdx] = useState(0);
  const safeIdx = Math.min(imgIdx, Math.max(images.length - 1, 0));

  // 封面图（第一张）
  const coverImg = images[0];

  return (
    <div data-page-scroll="note-preview" className="note-preview-panel w-[230px] shrink-0 border-r border-zinc-100 bg-zinc-50 flex flex-col items-center py-4 px-3 gap-3 overflow-y-auto">

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

export function NoteImageStrip({ itemIds, noteId, localItems, onItemIdsChange, readOnly = false, allowAdd = true }: {
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
  const localItemsById = useMemo(() => new Map((localItems ?? []).map((item) => [item.id, item])), [localItems]);
  async function persistItemIds(nextItemIds: number[]) {
    await onItemIdsChange(nextItemIds);
  }
  const workspaceActive = useWorkspaceActive();
  const results = useQueries({
    queries: itemIds.map((id) => ({
      queryKey: ["item", id],
      queryFn: () => api.get(`/api/library/${id}`) as Promise<Item>,
      enabled: workspaceActive && !!id && !IS_TAURI_RUNTIME && !localItemsById.has(id),
    })),
  });
  const images = itemIds
    .map((id, index) => localItemsById.get(id) ?? results[index]?.data)
    .filter((d): d is Item => !!d);

  // ESC 关闭灯箱
  useWorkspaceEffect(() => {
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
              className="w-[120px] h-[120px] rounded-xl overflow-hidden border border-[#ff2442] shadow-sm cursor-grab active:cursor-grabbing"
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
