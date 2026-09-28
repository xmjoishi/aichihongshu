import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Sparkles } from "lucide-react";
import AIHost from "./AIHost";
import { getPageAIContext, publishPageAIContext, type PageAIContext } from "../lib/pageAIContext";
import { getOpenPageAISidebarSources, GLOBAL_AI_EVENT, makeAISessionKey, PAGE_AI_SIDEBAR_EVENT, type AIHostMode } from "../lib/aiHost";
import { useAccountContext } from "../lib/accountContext";

export { GLOBAL_AI_EVENT };

export function openGlobalAI(context?: Partial<PageAIContext>) {
  if (typeof window !== "undefined") {
    if (context) publishPageAIContext({ ...getPageAIContext(), ...context });
    window.dispatchEvent(new Event(GLOBAL_AI_EVENT));
  }
}

/** Global floating Copilot launcher. Page-specific panels remain available. */
export default function GlobalAIHost() {
  const location = useLocation();
  const { accountId } = useAccountContext();
  const accountIdRef = useRef(accountId);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AIHostMode>("floating");
  const [requestedSession, setRequestedSession] = useState<{ sessionKey: string; historyKey: string | null } | null>(null);
  const [sidebarSources, setSidebarSources] = useState<Set<string>>(() => new Set());
  const agentWorkspace = location.pathname === "/assistant";

  useEffect(() => {
    accountIdRef.current = accountId;
  }, [accountId]);

  function makeDefaultSession() {
    const pageContext = getPageAIContext();
    const sessionKey = makeAISessionKey(
      { accountId: pageContext.accountId ?? accountIdRef.current },
      `${window.location.pathname}:${pageContext.objectId ?? "workspace"}`,
    );
    return { sessionKey, historyKey: sessionKey };
  }

  useEffect(() => {
    const handler = (event: Event) => {
      if (window.location.pathname === "/assistant") return;
      const request = (event as CustomEvent<{ sessionKey?: string; historyKey?: string | null }>).detail;
      setRequestedSession(request?.sessionKey ? {
        sessionKey: request.sessionKey,
        historyKey: request.historyKey === null ? null : request.historyKey ?? request.sessionKey,
      } : makeDefaultSession());
      setMode("floating");
      setOpen(true);
    };
    const sidebarHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string; open?: boolean }>).detail;
      if (!detail?.source) return;
      setSidebarSources((current) => {
        const next = new Set(current);
        if (detail.open) next.add(detail.source!);
        else next.delete(detail.source!);
        return next;
      });
    };
    window.addEventListener(GLOBAL_AI_EVENT, handler);
    window.addEventListener(PAGE_AI_SIDEBAR_EVENT, sidebarHandler);
    setSidebarSources(new Set(getOpenPageAISidebarSources()));
    return () => {
      window.removeEventListener(GLOBAL_AI_EVENT, handler);
      window.removeEventListener(PAGE_AI_SIDEBAR_EVENT, sidebarHandler);
    };
  }, []);

  useEffect(() => {
    if (agentWorkspace) setOpen(false);
  }, [agentWorkspace]);

  // The independent AI workspace already owns the full page presentation.
  // Keep the global launcher out of that route and restore it when leaving.
  if (agentWorkspace) return null;

  function closeHost() {
    setOpen(false);
    setMode("floating");
    setRequestedSession(null);
  }

  return (
    <>
      {!open && sidebarSources.size === 0 && (
        <button
          type="button"
          onClick={() => {
            setRequestedSession(makeDefaultSession());
            setMode("floating");
            setOpen(true);
          }}
          aria-label="打开 AI 助手"
          title="打开 AI 助手"
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full border border-white/70 bg-[#ff2442] text-white shadow-[0_10px_28px_rgba(255,36,66,0.32)] transition hover:scale-105 hover:bg-[#e91f3c] active:scale-95"
        >
          <Sparkles size={23} strokeWidth={2.2} />
          <span className="sr-only">AI 助手</span>
        </button>
      )}
      {open && (
        <div className={mode === "sidebar"
          ? "pointer-events-auto fixed bottom-0 right-0 top-10 z-50 w-[min(460px,calc(100vw-24px))] border-l border-zinc-200 bg-white shadow-xl"
          : "pointer-events-none fixed inset-0 z-50"}>
          <AIHost
            mode={mode}
            fillHost={mode === "sidebar"}
            onModeChange={setMode}
            sessionKey={requestedSession?.sessionKey}
            historyKey={requestedSession?.historyKey}
            onSelectSession={(sessionId) => setRequestedSession({ sessionKey: sessionId, historyKey: sessionId })}
            onClose={closeHost}
          />
        </div>
      )}
    </>
  );
}
