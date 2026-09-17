import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutGrid, FileText, Users, User, BarChart2, Settings, TrendingUp, Sparkles,
  ShieldCheck, PanelLeftClose, PanelLeftOpen, Search, Send,
} from "lucide-react";

// 顶部：当前运营账号上下文（跟着激活账号切换）
const accountNav = [
  { to: "/", icon: BarChart2, label: "看板" },
  { to: "/library", icon: LayoutGrid, label: "图库" },
  { to: "/notes", icon: FileText, label: "笔记" },
  { to: "/publish", icon: Send, label: "发布" },
  { to: "/inspire", icon: Sparkles, label: "灵感" },
  { to: "/search", icon: Search, label: "搜索" },
  { to: "/data", icon: TrendingUp, label: "数据" },
  { to: "/accounts", icon: Users, label: "榜样" },
  { to: "/profile", icon: User, label: "账号" },
];

// 底部：全局（与运营账号无关）
const globalNav = [
  { to: "/accounts/pool", icon: ShieldCheck, label: "账号池" },
  { to: "/settings", icon: Settings, label: "设置" },
];

const SIDEBAR_COLLAPSED_KEY = "aichihongshu.sidebar.collapsed.v1";
const SIDEBAR_WIDTH_KEY = "aichihongshu.sidebar.width.v1";
const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 288;
const SIDEBAR_DEFAULT_WIDTH = 176;

function readCollapsedPreference() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function readSidebarWidth() {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (!raw) return SIDEBAR_DEFAULT_WIDTH;
    const stored = Number(raw);
    return Number.isFinite(stored)
      ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, stored))
      : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

const itemClass = ({ isActive, collapsed }: { isActive: boolean; collapsed: boolean }) =>
  `group flex w-full items-center rounded-xl py-2.5 text-left transition-colors ${collapsed ? "justify-center px-2" : "gap-1.5 px-2"}
   ${isActive
     ? "bg-[var(--color-selected)] text-[var(--color-brand)]"
     : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]"}`;

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(readCollapsedPreference);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(sidebarWidth);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    widthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (!resizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      const start = resizeRef.current;
      if (!start) return;
      const next = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, start.startWidth + event.clientX - start.startX),
      );
      widthRef.current = next;
      setSidebarWidth(next);
    };
    const handlePointerUp = () => {
      resizeRef.current = null;
      setResizing(false);
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(widthRef.current));
      } catch {
        // The current session remains usable when storage is unavailable.
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [resizing]);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        // The current session remains usable when storage is unavailable.
      }
      return next;
    });
  }

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    if (collapsed) return;
    event.preventDefault();
    resizeRef.current = { startX: event.clientX, startWidth: sidebarWidth };
    setResizing(true);
  }

  function resizeWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if (collapsed) return;
    const step = event.shiftKey ? 24 : 8;
    let next = sidebarWidth;
    if (event.key === "ArrowRight") next += step;
    if (event.key === "ArrowLeft") next -= step;
    if (event.key === "Home") next = SIDEBAR_MIN_WIDTH;
    if (event.key === "End") next = SIDEBAR_MAX_WIDTH;
    if (next === sidebarWidth) return;
    event.preventDefault();
    next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next));
    widthRef.current = next;
    setSidebarWidth(next);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
    } catch {
      // The current session remains usable when storage is unavailable.
    }
  }

  return (
    <aside
      className={`group/sidebar relative flex shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-4 ${resizing ? "transition-none" : "transition-[width] duration-200"} ${collapsed ? "w-16" : ""}`}
      style={{ width: collapsed ? 64 : sidebarWidth }}
    >
      <div className={`mb-5 flex items-center ${collapsed ? "flex-col gap-3" : "justify-between gap-1 px-0"}`}>
        <div className={`flex min-w-0 items-center ${collapsed ? "justify-center" : "gap-1.5"}`}>
          <img
            src="/logo.png"
            alt="爱吃红薯"
            className="hdr-ignore h-8 w-8 shrink-0 rounded-xl border border-[var(--color-border)] object-contain shadow-sm"
          />
          {!collapsed && <div className="w-[4.5rem] shrink-0 whitespace-nowrap">
            <p className="text-sm font-bold text-[var(--color-text-primary)]">爱吃红薯</p>
            <p className="text-[11px] text-[var(--color-text-secondary)]">AI 吃红书</p>
          </div>}
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "展开菜单" : "收起菜单"}
          aria-expanded={!collapsed}
          title={collapsed ? "展开菜单" : "收起菜单"}
          className="rounded-lg p-1 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]"
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>

      {/* 顶部：账号上下文区 */}
      {accountNav.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/" || to === "/accounts"}
          title={collapsed ? label : undefined}
          className={({ isActive }) => itemClass({ isActive, collapsed })}
        >
          <Icon size={20} />
          <span className={collapsed ? "sr-only" : "whitespace-nowrap text-sm font-medium"}>{label}</span>
        </NavLink>
      ))}

      {/* 弹簧把全局区压到底部 */}
      <div className="flex-1" />

      {/* 分隔线：上=账号上下文，下=全局 */}
      <div className="my-3 h-px w-full bg-[var(--color-border)]" />

      {/* 底部：全局区 */}
      {globalNav.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/accounts/pool"}
          title={collapsed ? label : undefined}
          className={({ isActive }) => itemClass({ isActive, collapsed })}
        >
          <Icon size={20} />
          <span className={collapsed ? "sr-only" : "whitespace-nowrap text-sm font-medium"}>{label}</span>
        </NavLink>
      ))}

      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={resizeWithKeyboard}
          className="absolute inset-y-0 right-0 z-20 w-2 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-[var(--color-brand)]/30 focus:bg-[var(--color-brand)]/30 focus:outline-none"
        />
      )}
    </aside>
  );
}
