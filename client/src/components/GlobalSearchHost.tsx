import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import WorkspaceSearch from "../pages/WorkspaceSearch";

export const GLOBAL_SEARCH_EVENT = "aichihongshu:open-global-search";

type OpenSearchDetail = { query?: string };

export function openGlobalSearch(query?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenSearchDetail>(GLOBAL_SEARCH_EVENT, {
    detail: query ? { query } : undefined,
  }));
}

/**
 * Global search stays mounted outside the page route so it can be opened from
 * every workspace view without creating a separate navigation destination.
 * The legacy /search route uses the same host and is handled by App.tsx.
 */
export default function GlobalSearchHost() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const openedPathRef = useRef<string | null>(null);
  const previousSearchRef = useRef<string | null>(null);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenSearchDetail>).detail;
      openedPathRef.current = window.location.pathname;
      previousSearchRef.current = window.location.search;
      if (detail?.query) {
        const params = new URLSearchParams(window.location.search);
        params.set("q", detail.query);
        navigate(`${window.location.pathname}?${params.toString()}`, { replace: true });
      }
      setOpen(true);
    };
    window.addEventListener(GLOBAL_SEARCH_EVENT, handleOpen);
    return () => window.removeEventListener(GLOBAL_SEARCH_EVENT, handleOpen);
  }, [navigate]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openGlobalSearch();
      }
      if (event.key === "Escape" && open) setOpen(false);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [open]);

  // Clicking a result navigates to its target. Close the overlay as soon as
  // the route changes, while allowing WorkspaceSearch to update only q on the
  // current route as the user types.
  useEffect(() => {
    if (open && openedPathRef.current && location.pathname !== openedPathRef.current) {
      setOpen(false);
    }
  }, [location.pathname, open]);

  function close() {
    setOpen(false);
    const originalSearch = previousSearchRef.current;
    if (originalSearch !== null && window.location.search !== originalSearch) {
      navigate(`${window.location.pathname}${originalSearch}`, { replace: true });
    }
    openedPathRef.current = null;
    previousSearchRef.current = null;
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 p-6" role="dialog" aria-modal="true" aria-label="全局搜索">
      <button type="button" aria-label="关闭全局搜索" className="absolute inset-0 cursor-default" onClick={close} />
      <div className="relative z-10 flex h-[min(720px,calc(100vh-3rem))] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-canvas)] shadow-2xl">
        <button
          type="button"
          onClick={close}
          aria-label="关闭全局搜索"
          title="关闭 (Esc)"
          className="absolute right-4 top-4 z-20 rounded-lg p-1.5 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]"
        >
          <X size={18} />
        </button>
        <WorkspaceSearch />
      </div>
    </div>
  );
}
