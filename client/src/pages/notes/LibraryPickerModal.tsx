import { useState } from "react";
import { useWorkspaceQuery as useQuery } from "../../lib/workspaceActivity";
import { api, API_BASE } from "../../lib/api";
import type { Item } from "../../lib/types";
import { Spinner } from "../../components/ui";
import LocalImage from "../../components/LocalImage";
import { X } from "lucide-react";
import { useHDRSetting } from "../../hooks/useHDRSetting";
import { IS_TAURI_RUNTIME } from "../../lib/local";

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

export default function LibraryPickerModal({
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
    enabled: !IS_TAURI_RUNTIME,
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
            className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#ff2442]/30 focus:border-[#ff2442]"
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
                    className={`relative rounded-xl overflow-hidden border transition-all aspect-square ${
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
