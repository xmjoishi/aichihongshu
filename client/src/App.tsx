import { lazy, Suspense, type MouseEvent, useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { PanelLeft } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Sidebar, { requestSidebarToggle } from "./components/Sidebar";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import ActiveAccountSwitcher from "./components/ActiveAccountSwitcher";
import LocalRuntimeStatus from "./components/LocalRuntimeStatus";
import GlobalSearchHost, { openGlobalSearch } from "./components/GlobalSearchHost";
import { IS_TAURI_RUNTIME } from "./lib/local";

// 页面按路由拆包，桌面端启动时只加载当前壳层和首屏所需资源，避免把
// 发布、素材、数据复盘等重页面全部塞进启动模块，减少白屏等待时间。
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Library = lazy(() => import("./pages/Library"));
const NoteList = lazy(async () => ({ default: (await import("./pages/Notes")).NoteList }));
const NoteEditor = lazy(async () => ({ default: (await import("./pages/Notes")).NoteEditor }));
const AccountPool = lazy(() => import("./pages/AccountPool"));
const ProfilePage = lazy(() => import("./pages/Profile"));
const Data = lazy(() => import("./pages/Data"));
const Settings = lazy(() => import("./pages/Settings"));
const Inspire = lazy(() => import("./pages/Inspire"));
const Assistant = lazy(() => import("./pages/Assistant"));
const GlobalAIHost = lazy(() => import("./components/GlobalAIHost"));

/* 滚动条静默浮现：全局委托监听（捕获式、被动），
   1) scroll —— 给正在滚动的容器临时加 .is-scrolling，静止约 1s 后移除，让滑块淡出；
   2) pointerover/pointerout —— 给指针所在的可滚动容器加 .is-scrollbar-hover（悬停浮现）。
   覆盖惯性滚动、键盘与程序滚动；引擎不支持宿主状态重绘滑块样式（WebKit、Chromium 的
   :hover 行为不一致），因此显隐一律由类名驱动。无 React 状态、不触发重渲染。 */
const SCROLL_IDLE_MS = 900;

function LegacySearchRedirect() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const query = new URLSearchParams(location.search).get("q") ?? undefined;
    navigate("/", { replace: true });
    // Defer until the global host has observed the route transition. This
    // keeps /search compatible for bookmarks and older in-app links.
    window.setTimeout(() => openGlobalSearch(query), 0);
  }, [location.search, navigate]);

  return null;
}

function findVerticalScrollable(start: Element): Element | null {
  let node: Element | null = start;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function useScrollbarRevealOnScroll() {
  useEffect(() => {
    const idleTimers = new Map<Element, number>();
    let hoveredScroller: Element | null = null;

    const handleScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const pending = idleTimers.get(target);
      if (pending !== undefined) window.clearTimeout(pending);
      target.classList.add("is-scrolling");
      idleTimers.set(
        target,
        window.setTimeout(() => {
          target.classList.remove("is-scrolling");
          idleTimers.delete(target);
        }, SCROLL_IDLE_MS)
      );
    };

    const handlePointerOver = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const scroller = findVerticalScrollable(target);
      if (scroller === hoveredScroller) return;
      if (hoveredScroller) hoveredScroller.classList.remove("is-scrollbar-hover");
      hoveredScroller = scroller;
      if (scroller) scroller.classList.add("is-scrollbar-hover");
    };

    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null && hoveredScroller) {
        hoveredScroller.classList.remove("is-scrollbar-hover");
        hoveredScroller = null;
      }
    };

    window.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    window.addEventListener("pointerover", handlePointerOver, { capture: true, passive: true });
    window.addEventListener("pointerout", handlePointerOut, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll, { capture: true });
      window.removeEventListener("pointerover", handlePointerOver, { capture: true });
      window.removeEventListener("pointerout", handlePointerOut, { capture: true });
      idleTimers.forEach((timer, element) => {
        window.clearTimeout(timer);
        element.classList.remove("is-scrolling");
      });
      idleTimers.clear();
      if (hoveredScroller) hoveredScroller.classList.remove("is-scrollbar-hover");
    };
  }, []);
}

function isTopbarInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(
    target.closest("button,a,input,select,textarea,[role='button'],[data-no-drag='true']")
  );
}

function handleTopbarMouseDown(event: MouseEvent<HTMLDivElement>): void {
  if (!IS_TAURI_RUNTIME || event.button !== 0 || event.detail !== 1) return;
  if (isTopbarInteractiveTarget(event.target)) return;
  void getCurrentWindow().startDragging().catch(() => {
    console.warn("[aichihongshu] window dragging is unavailable");
  });
}

function handleTopbarDoubleClick(event: MouseEvent<HTMLDivElement>): void {
  if (!IS_TAURI_RUNTIME || event.button !== 0) return;
  if (isTopbarInteractiveTarget(event.target)) return;
  void getCurrentWindow().toggleMaximize().catch(() => {
    console.warn("[aichihongshu] window maximize toggle is unavailable");
  });
}

export default function App() {
  useScrollbarRevealOnScroll();
  return (
    <ToastProvider>
      <ErrorBoundary>
        <div className="flex h-screen flex-col overflow-hidden bg-[var(--color-canvas)] text-[var(--color-text-primary)]">
          <div
            data-tauri-drag-region="deep"
            onMouseDown={handleTopbarMouseDown}
            onDoubleClick={handleTopbarDoubleClick}
            className="app-topbar flex h-10 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] pl-24 pr-4"
          >
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={requestSidebarToggle}
                aria-label="收起或展开侧栏"
                title="收起或展开侧栏"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]"
              >
                <PanelLeft size={17} />
              </button>
              <span className="h-5 w-px shrink-0 bg-[var(--color-border)]" aria-hidden="true" />
              <ActiveAccountSwitcher />
            </div>
            <div className="min-w-0 shrink overflow-hidden">
              <LocalRuntimeStatus />
            </div>
          </div>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <Sidebar />
            <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
              <div className="app-route-shell flex min-h-0 flex-1 overflow-hidden flex-col">
                <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-canvas)]"><div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-brand)] border-t-transparent" role="status" aria-label="正在加载页面" /></div>}>
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/library" element={<Library />} />
                    <Route path="/notes" element={<NoteList />} />
                    <Route path="/notes/:id" element={<NoteEditor />} />
                    <Route path="/publish" element={<Navigate to="/notes?view=publish" replace />} />
                    <Route path="/data" element={<Data />} />
                    <Route path="/accounts" element={<Navigate to="/inspire?tab=references" replace />} />
                    <Route path="/accounts/pool" element={<AccountPool />} />
                    <Route path="/profile" element={<ProfilePage />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/assistant" element={<Assistant />} />
                    <Route path="/inspire" element={<Inspire />} />
                    <Route path="/search" element={<LegacySearchRedirect />} />
                  </Routes>
                </Suspense>
              </div>
            </main>
          </div>
          <GlobalSearchHost />
          <Suspense fallback={null}><GlobalAIHost /></Suspense>
        </div>
      </ErrorBoundary>
    </ToastProvider>
  );
}
