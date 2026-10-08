import { useRef } from "react";
import { AtSign } from "lucide-react";

export interface QuickAction {
  key: string;
  label: string;
  prompt: string;
  enabled: number | boolean;
}

export interface AIReferenceOption {
  id: string;
  token: string;
  /** 发送给模型的可读引用文本；token 仍保留在菜单中作为稳定标识。 */
  displayToken?: string;
  label: string;
  detail?: string;
  group: string;
}

export interface AICommandOption {
  id: string;
  label: string;
  detail?: string;
}

export function AIReferencePicker({
  options,
  search,
  onSearch,
  onSelect,
  onClose,
}: {
  options: AIReferenceOption[];
  search: string;
  onSearch: (value: string) => void;
  onSelect: (option: AIReferenceOption) => void;
  onClose: () => void;
}) {
  let previousGroup = "";
  return (
    <div className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-80 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2">
        <AtSign size={13} className="text-[#ff2442]" />
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="引用当前页、笔记、素材、灵感或榜样…"
          autoFocus
          className="ai-composer-search h-8 min-w-0 flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 text-xs text-zinc-700 outline-none transition-colors focus:border-zinc-300 focus:outline-none focus-visible:outline-none focus:ring-0 placeholder:text-zinc-300"
          onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        />
        <span className="text-[10px] text-zinc-300">结构化引用</span>
      </div>
      <div className="max-h-64 overflow-y-auto p-1">
        {options.length === 0 ? <p className="px-3 py-5 text-center text-xs text-zinc-400">没有匹配的引用</p> : options.map((option) => {
          const showGroup = option.group !== previousGroup;
          previousGroup = option.group;
          return (
            <div key={option.id}>
              {showGroup && <p className="px-2.5 pb-1 pt-2 text-[10px] font-medium text-zinc-400">{option.group}</p>}
              <button type="button" onClick={() => onSelect(option)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-[#fff0f2]">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-[10px] text-zinc-500">@</span>
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-700">{option.label}</span>
                {option.detail && <span className="max-w-[35%] truncate text-[10px] text-zinc-400">{option.detail}</span>}
                <code className="shrink-0 text-[10px] text-zinc-300">{option.token}</code>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AICommandPalette({
  options,
  search,
  onSearch,
  onSelect,
  onClose,
}: {
  options: AICommandOption[];
  search: string;
  onSearch: (value: string) => void;
  onSelect: (option: AICommandOption) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-80 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2">
        <span className="font-mono text-sm text-[#ff2442]">/</span>
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="选择当前页命令…"
          autoFocus
          className="ai-composer-search h-8 min-w-0 flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 text-xs text-zinc-700 outline-none transition-colors focus:border-zinc-300 focus:outline-none focus-visible:outline-none focus:ring-0 placeholder:text-zinc-300"
          onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        />
        <span className="text-[10px] text-zinc-300">页面能力</span>
      </div>
      <div className="max-h-64 overflow-y-auto p-1">
        {options.length === 0 ? <p className="px-3 py-5 text-center text-xs text-zinc-400">当前页没有匹配命令</p> : options.map((option) => (
          <button key={option.id} type="button" onClick={() => onSelect(option)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-[#fff0f2]">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#fff0f2] font-mono text-xs text-[#ff2442]">/</span>
            <span className="min-w-0 flex-1 truncate text-xs text-zinc-700">{option.label}</span>
            <span className="text-[10px] text-zinc-400">{option.detail}</span>
            <code className="shrink-0 text-[10px] text-zinc-300">/{option.id}</code>
          </button>
        ))}
      </div>
    </div>
  );
}



// ── 常驻快捷操作栏 ─────────────────────────────────────────────────
export function QuickActionBar({
  actions,
  onSend,
  loading,
}: {
  actions: QuickAction[];
  onSend: (prompt: string) => void;
  loading: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 鼠标拖拽横向滚动
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragScrollLeft = useRef(0);

  function onMouseDown(e: React.MouseEvent) {
    if (!scrollRef.current) return;
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragScrollLeft.current = scrollRef.current.scrollLeft;
    scrollRef.current.style.cursor = "grabbing";
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!dragging.current || !scrollRef.current) return;
    const dx = e.clientX - dragStartX.current;
    scrollRef.current.scrollLeft = dragScrollLeft.current - dx;
  }

  function onMouseUp() {
    dragging.current = false;
    if (scrollRef.current) scrollRef.current.style.cursor = "grab";
  }

  if (actions.length === 0) return null;

  return (
    <div className="border-t border-zinc-100 shrink-0 py-2 px-2">
      <div
        ref={scrollRef}
        className="flex gap-1.5 overflow-x-auto scrollbar-hide"
        style={{ cursor: "grab", WebkitOverflowScrolling: "touch" }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        {actions.map((a) => (
          <button
            key={a.key}
            onClick={() => onSend(a.prompt)}
            disabled={loading}
            className="text-xs bg-zinc-50 hover:bg-[#ff2442]/10 hover:text-[#ff2442] text-zinc-600
                       px-2.5 py-1.5 rounded-full border border-zinc-200 hover:border-[#ff2442]/30
                       transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 select-none"
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
