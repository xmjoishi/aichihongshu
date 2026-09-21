import { useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import Dashboard from "./pages/Dashboard";
import Library from "./pages/Library";
import { NoteList, NoteEditor } from "./pages/Notes";
import Accounts from "./pages/Accounts";
import AccountPool from "./pages/AccountPool";
import ProfilePage from "./pages/Profile";
import Settings from "./pages/Settings";
import Data from "./pages/Data";
import Inspire from "./pages/Inspire";
import WorkspaceSearch from "./pages/WorkspaceSearch";
import Publish from "./pages/Publish";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import ActiveAccountSwitcher from "./components/ActiveAccountSwitcher";
import LocalRuntimeStatus from "./components/LocalRuntimeStatus";

/* 滚动条静默浮现：全局委托监听（捕获式、被动），
   1) scroll —— 给正在滚动的容器临时加 .is-scrolling，静止约 1s 后移除，让滑块淡出；
   2) pointerover/pointerout —— 给指针所在的可滚动容器加 .is-scrollbar-hover（悬停浮现）。
   覆盖惯性滚动、键盘与程序滚动；引擎不支持宿主状态重绘滑块样式（WebKit、Chromium 的
   :hover 行为不一致），因此显隐一律由类名驱动。无 React 状态、不触发重渲染。 */
const SCROLL_IDLE_MS = 900;

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

export default function App() {
  useScrollbarRevealOnScroll();
  return (
    <ToastProvider>
      <ErrorBoundary>
        <div className="flex h-screen overflow-hidden bg-[var(--color-canvas)] text-[var(--color-text-primary)]">
            <Sidebar />
            <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
              <div className="app-topbar flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6">
                <LocalRuntimeStatus />
                <ActiveAccountSwitcher />
              </div>
              <div className="app-route-shell flex min-h-0 flex-1 overflow-hidden flex-col">
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/library" element={<Library />} />
                  <Route path="/notes" element={<NoteList />} />
                  <Route path="/notes/:id" element={<NoteEditor />} />
                  <Route path="/publish" element={<Publish />} />
                  <Route path="/data" element={<Data />} />
                  <Route path="/accounts" element={<Accounts />} />
                  <Route path="/accounts/pool" element={<AccountPool />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/inspire" element={<Inspire />} />
                  <Route path="/search" element={<WorkspaceSearch />} />
                </Routes>
              </div>
            </main>
        </div>
      </ErrorBoundary>
    </ToastProvider>
  );
}
