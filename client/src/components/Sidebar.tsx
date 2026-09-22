import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutGrid, FileText, User, BarChart2, ChartNoAxesCombined, Settings, Sparkles,
  ShieldCheck, Search, Plus, MessageSquare, Pin, BriefcaseBusiness,
} from "lucide-react";
import { openGlobalSearch } from "./GlobalSearchHost";
import { useAccountContext } from "../lib/accountContext";
import { createAgentSession, readAgentSessions, subscribeAgentSessions, type AgentSessionMetadata } from "../lib/aiWorkspace";

// 顶部：当前运营账号上下文（跟着激活账号切换）
const accountNav = [
  { to: "/", icon: BarChart2, label: "概览" },
  { to: "/library", icon: LayoutGrid, label: "素材库" },
  { to: "/notes", icon: FileText, label: "笔记" },
  { to: "/inspire", icon: Sparkles, label: "灵感" },
  { to: "/profile", icon: User, label: "账号" },
  { to: "/data", icon: ChartNoAxesCombined, label: "数据与复盘" },
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
export const SIDEBAR_TOGGLE_EVENT = "aichihongshu:toggle-sidebar";

export function requestSidebarToggle() {
  window.dispatchEvent(new Event(SIDEBAR_TOGGLE_EVENT));
}

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
  `group flex w-full items-center text-left transition-colors ${collapsed ? "mx-auto h-10 w-10 justify-center rounded-xl p-0" : "rounded-xl py-2.5 gap-1.5 px-2"}
   ${isActive
     ? "bg-[var(--color-selected)] text-[var(--color-brand)]"
     : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]"}`;

const LAST_OPERATIONS_PATH_KEY = "aichihongshu.last-operations-path.v1";

function AgentSessions({ collapsed, accountId }: { collapsed: boolean; accountId: number | null }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<AgentSessionMetadata[]>(() => readAgentSessions(accountId));
  const [query, setQuery] = useState("");

  useEffect(() => {
    const refresh = () => setSessions(readAgentSessions(accountId));
    refresh();
    return subscribeAgentSessions(refresh);
  }, [accountId]);

  function newSession() {
    const session = createAgentSession(accountId);
    navigate(`/assistant?session=${encodeURIComponent(session.id)}`);
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredSessions = normalizedQuery
    ? sessions.filter((session) => `${session.title} ${session.lastMessagePreview ?? ""}`.toLocaleLowerCase().includes(normalizedQuery))
    : sessions;

  if (collapsed) {
    return (
      <button type="button" onClick={newSession} title="新建 AI 会话" aria-label="新建 AI 会话" className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl p-0 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-brand)]">
        <Plus size={19} />
      </button>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-1">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-[var(--color-text-primary)]">
          <MessageSquare size={15} className="shrink-0 text-[var(--color-text-secondary)]" />
          <span className="truncate">对话记录</span>
        </div>
        <button
          type="button"
          onClick={newSession}
          title="新建 AI 会话"
          aria-label="新建 AI 会话"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-brand)]"
        >
          <Plus size={16} />
        </button>
      </div>

      <label className="relative mb-2 block">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索会话标题或内容"
          aria-label="搜索会话标题或内容"
          className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-2 text-xs text-[var(--color-text-primary)] outline-none transition placeholder:text-[var(--color-text-secondary)] focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/15"
        />
      </label>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {filteredSessions.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-[var(--color-text-secondary)]">
            {normalizedQuery ? "没有匹配的会话" : "还没有会话，从浮窗提问或新建一条 AI 会话。"}
          </p>
        ) : filteredSessions.map((session) => {
          const active = new URLSearchParams(location.search).get("session") === session.id;
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => navigate(`/assistant?session=${encodeURIComponent(session.id)}`)}
              className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition ${active ? "bg-[var(--color-selected)] text-[var(--color-brand)]" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]"}`}
              title={session.lastMessagePreview || session.title}
            >
              {session.pinned ? <Pin size={12} className="mt-0.5 shrink-0" /> : <MessageSquare size={12} className="mt-0.5 shrink-0 opacity-60" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{session.title}</span>
                {session.lastMessagePreview && <span className="mt-0.5 block truncate text-[10px] opacity-70">{session.lastMessagePreview}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <button type="button" onClick={newSession} className="mt-2 flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-text-primary)] transition hover:border-[var(--color-brand)] hover:text-[var(--color-brand)]">
        <Plus size={16} />
        新建会话
      </button>
    </div>
  );
}

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { accountId } = useAccountContext();
  const [collapsed, setCollapsed] = useState(readCollapsedPreference);
  const [compactViewport, setCompactViewport] = useState(() => (
    typeof window !== "undefined" && window.matchMedia("(max-width: 959px)").matches
  ));
  // 窄窗口下的展开只作为当前会话的临时覆盖，不污染桌面端的折叠偏好。
  const [compactExpanded, setCompactExpanded] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const [lastOperationsPath, setLastOperationsPath] = useState("/");
  const widthRef = useRef(sidebarWidth);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const compact = compactViewport ? !compactExpanded : collapsed;
  const agentWorkspace = location.pathname === "/assistant";

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(LAST_OPERATIONS_PATH_KEY);
      if (saved?.startsWith("/")) setLastOperationsPath(saved);
    } catch {
      // The current session remains usable when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    if (location.pathname === "/assistant") return;
    const path = `${location.pathname}${location.search}`;
    setLastOperationsPath(path);
    try { sessionStorage.setItem(LAST_OPERATIONS_PATH_KEY, path); } catch { /* optional */ }
  }, [location.pathname, location.search]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 959px)");
    const update = () => setCompactViewport(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (!compactViewport) setCompactExpanded(false);
  }, [compactViewport]);

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
    if (compactViewport) {
      setCompactExpanded((current) => !current);
      return;
    }
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

  function openAgentWorkspace() {
    // Create the transient session before navigation so Assistant mounts with
    // its stable identity and does not need a second URL update on entry.
    const session = createAgentSession(accountId);
    navigate(`/assistant?session=${encodeURIComponent(session.id)}`);
  }

  useEffect(() => {
    const handleToggle = () => toggleCollapsed();
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, handleToggle);
    return () => window.removeEventListener(SIDEBAR_TOGGLE_EVENT, handleToggle);
  }, [compactViewport]);

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    if (compact) return;
    event.preventDefault();
    resizeRef.current = { startX: event.clientX, startWidth: sidebarWidth };
    setResizing(true);
  }

  function resizeWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if (compact) return;
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
      className={`app-sidebar group/sidebar relative flex shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-4 ${resizing ? "transition-none" : "transition-[width] duration-200"} ${compact ? "w-16" : ""}`}
      style={{ width: compact ? 64 : sidebarWidth }}
    >
      <div className={`mb-3 flex items-center rounded-xl ${compact ? "flex-col gap-1 bg-[var(--color-surface-2)] p-0" : "gap-1 bg-[var(--color-surface-2)] p-1"}`} role="tablist" aria-label="工作区">
        <button
          type="button"
          role="tab"
          aria-selected={!agentWorkspace}
          onClick={() => navigate(lastOperationsPath)}
          title="运营工作区"
          className={`flex items-center justify-center gap-1.5 text-xs font-medium transition ${compact ? "h-10 w-10 flex-none rounded-xl p-0" : "flex-1 rounded-lg py-1.5"} ${!agentWorkspace ? `${compact ? "border border-[var(--color-brand)]" : ""} bg-white text-[var(--color-brand)] shadow-sm` : "border border-transparent bg-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"}`}
        >
          <BriefcaseBusiness size={16} />
          {!compact && "运营"}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={agentWorkspace}
          onClick={openAgentWorkspace}
          title="AI 工作区"
          className={`flex items-center justify-center gap-1.5 text-xs font-medium transition ${compact ? "h-10 w-10 flex-none rounded-xl p-0" : "flex-1 rounded-lg py-1.5"} ${agentWorkspace ? `${compact ? "border border-[var(--color-brand)]" : ""} bg-white text-[var(--color-brand)] shadow-sm` : "border border-transparent bg-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"}`}
        >
          <Sparkles size={16} />
          {!compact && "AI"}
        </button>
      </div>

      {agentWorkspace ? (
        <AgentSessions collapsed={compact} accountId={accountId} />
      ) : (
        <>
          <button
            type="button"
            onClick={() => openGlobalSearch()}
            title={compact ? "全局搜索 (⌘K)" : undefined}
            aria-label="全局搜索"
            className={itemClass({ isActive: false, collapsed: compact })}
          >
            <Search size={20} />
            <span className={compact ? "sr-only" : "flex min-w-0 flex-1 items-center justify-between whitespace-nowrap text-sm font-medium"}>
              <span>全局搜索</span>
              {!compact && <kbd className="ml-2 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-normal text-[var(--color-text-secondary)]">⌘K</kbd>}
            </span>
          </button>

          {/* 顶部：账号上下文区 */}
          {accountNav.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/" || to === "/accounts"}
              title={compact ? label : undefined}
              className={({ isActive }) => itemClass({ isActive, collapsed: compact })}
            >
              <Icon size={20} />
              <span className={compact ? "sr-only" : "whitespace-nowrap text-sm font-medium"}>{label}</span>
            </NavLink>
          ))}
          <div className="flex-1" />
        </>
      )}

      {/* 分隔线：上=账号上下文，下=全局 */}
      <div className="my-3 h-px w-full bg-[var(--color-border)]" />

      {/* 底部：全局区 */}
      {globalNav.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/accounts/pool"}
          title={compact ? label : undefined}
          className={({ isActive }) => itemClass({ isActive, collapsed: compact })}
        >
          <Icon size={20} />
          <span className={compact ? "sr-only" : "whitespace-nowrap text-sm font-medium"}>{label}</span>
        </NavLink>
      ))}

      {!compact && (
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
          className="sidebar-resize-handle absolute inset-y-0 right-0 z-20 w-2 cursor-col-resize touch-none select-none bg-transparent focus:outline-none"
        />
      )}
    </aside>
  );
}
