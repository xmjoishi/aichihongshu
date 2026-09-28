import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { ArrowLeft, Plus } from "lucide-react";
import AIHost from "../components/AIHost";
import { useAccountContext } from "../lib/accountContext";
import { createAgentSession, readAgentSessions, rememberLastAgentSession, subscribeAgentSessions, type AgentSessionMetadata } from "../lib/aiWorkspace";

/** Independent AI workspace. The conversation remains scoped to the active account. */
export default function Assistant() {
  const { accountId } = useAccountContext();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const assistantRouteActive = location.pathname === "/assistant";
  const routeSessionId = assistantRouteActive ? searchParams.get("session") : null;
  const [lastSessionId, setLastSessionId] = useState<string | null>(routeSessionId);
  const sessionId = routeSessionId ?? lastSessionId;
  const requestedMode = assistantRouteActive && searchParams.get("mode") === "agent" ? "agent" : undefined;
  const [session, setSession] = useState<AgentSessionMetadata | null>(null);
  const compatSessionRef = useRef<AgentSessionMetadata | null>(null);
  const [compatSession, setCompatSession] = useState<AgentSessionMetadata | null>(null);

  useEffect(() => {
    if (routeSessionId) setLastSessionId(routeSessionId);
  }, [routeSessionId]);

  // Keep direct /assistant links working without rewriting the URL during the
  // first render. Normal navigation comes from Sidebar with a session query;
  // this fallback is intentionally transient until the first message promotes
  // it into the persisted session list.
  useEffect(() => {
    if (!assistantRouteActive) return;
    if (sessionId) {
      compatSessionRef.current = null;
      setCompatSession(null);
      return;
    }
    if (!compatSessionRef.current || compatSessionRef.current.accountId !== accountId) {
      compatSessionRef.current = createAgentSession(accountId);
    }
    setCompatSession(compatSessionRef.current);
  }, [accountId, assistantRouteActive, sessionId]);

  const effectiveSessionId = sessionId ?? (compatSession?.accountId === accountId ? compatSession.id : null);

  useEffect(() => {
    if (assistantRouteActive && effectiveSessionId) {
      rememberLastAgentSession(accountId, effectiveSessionId);
    }
  }, [accountId, assistantRouteActive, effectiveSessionId]);

  useEffect(() => {
    if (!effectiveSessionId) {
      setSession(null);
      return;
    }
    const existing = readAgentSessions(accountId).find((item) => item.id === effectiveSessionId);
    setSession(existing ?? (compatSession?.id === effectiveSessionId ? compatSession : createAgentSession(accountId, { id: effectiveSessionId })));
  }, [accountId, compatSession, effectiveSessionId]);

  useEffect(() => {
    const refresh = () => {
      if (!effectiveSessionId) {
        setSession(null);
        return;
      }
      const existing = readAgentSessions(accountId).find((item) => item.id === effectiveSessionId);
      setSession(existing ?? (compatSession?.id === effectiveSessionId ? compatSession : null));
    };
    return subscribeAgentSessions(refresh);
  }, [accountId, compatSession, effectiveSessionId]);

  function createNewSession() {
    const created = createAgentSession(accountId);
    setSearchParams({ session: created.id });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-canvas)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
        <Link to="/" className="rounded-md p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]" aria-label="返回概览">
          <ArrowLeft size={15} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{session?.title ?? "AI 工作区"}</h1>
        </div>
        <button type="button" onClick={createNewSession} className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--color-brand)] hover:text-[var(--color-brand)]">
          <Plus size={12} /> 新建
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {effectiveSessionId ? <AIHost mode="page" sessionKey={effectiveSessionId} historyKey={effectiveSessionId} assistantMode={requestedMode} /> : <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">正在创建会话…</div>}
      </div>
    </div>
  );
}
