import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import AIPanel from "./AIPanel";
import { useAccountContext } from "../lib/accountContext";
import { makeAISessionKey, readAISettings, saveAISettings, type AIHostMode } from "../lib/aiHost";
import { usePageAIContext, type PageAIContext } from "../lib/pageAIContext";
import { createAgentSession, readAgentSessions } from "../lib/aiWorkspace";

export interface AIHostProps {
  noteId?: number;
  itemId?: number;
  accountId?: number | null;
  systemExtra?: string;
  onClose?: () => void;
  /** Optional host override used by the independent page and global launcher. */
  mode?: AIHostMode;
  /** Make a shell-owned sidebar fill its host instead of using the resizable page pane width. */
  fillHost?: boolean;
  onModeChange?: (mode: AIHostMode) => void;
  /** Explicit context is useful for embedded hosts; defaults to the current route registry. */
  pageContext?: PageAIContext;
  /** Optional stable Agent session identity. */
  sessionKey?: string;
  /** Select a previously saved session in hosts managed by the app shell. */
  onSelectSession?: (sessionId: string) => void;
  /** `null` preserves the legacy unkeyed page history when moving an embedded panel. */
  historyKey?: string | null;
  assistantMode?: "ask" | "agent";
}

/**
 * Shared host for future top-level wiring. Existing page integrations can
 * continue rendering AIPanel directly; this component gives the desktop shell
 * one stable entry point for floating/sidebar/page presentations.
 */
export default function AIHost(props: AIHostProps) {
  const { scopeKey, accountId: contextAccountId } = useAccountContext();
  const location = useLocation();
  const registeredPageContext = usePageAIContext(location.pathname);
  const pageContext = props.pageContext ?? registeredPageContext;
  const effectiveAccountId = props.accountId ?? pageContext.accountId ?? contextAccountId;
  const initial = useMemo(() => readAISettings(scopeKey), [scopeKey]);
  const [mode, setMode] = useState<AIHostMode>(props.mode ?? initial.defaultHostMode);
  useEffect(() => {
    setMode(props.mode ?? readAISettings(scopeKey).defaultHostMode);
  }, [props.mode, scopeKey]);
  const sessionKey = props.sessionKey ?? makeAISessionKey(
    { accountId: effectiveAccountId, noteId: props.noteId, itemId: props.itemId },
    `${pageContext.route}:${pageContext.objectId ?? "workspace"}`,
  );
  const historyKey = props.historyKey === null ? undefined : props.historyKey ?? (props.mode === "floating" ? sessionKey : undefined);

  useEffect(() => {
    if (effectiveAccountId == null || (props.mode !== "floating" && !props.historyKey)) return;
    if (readAgentSessions(effectiveAccountId).some((session) => session.id === sessionKey)) return;
    createAgentSession(effectiveAccountId, {
      id: sessionKey,
      title: `${pageContext.page}会话`,
    });
  }, [effectiveAccountId, pageContext.page, props.historyKey, props.mode, sessionKey]);

  function changeMode(next: AIHostMode) {
    setMode(next);
    const settings = readAISettings(scopeKey);
    saveAISettings(scopeKey, { ...settings, defaultHostMode: next });
    props.onModeChange?.(next);
  }

  return (
    <div className={mode === "floating" ? "pointer-events-auto fixed bottom-5 right-5 z-50" : "pointer-events-auto h-full w-full"}>
      <AIPanel
        {...props}
        accountId={effectiveAccountId}
        pageContext={{ ...pageContext, accountId: effectiveAccountId, route: location.pathname }}
        hostMode={mode}
        onHostModeChange={changeMode}
        fillHost={props.fillHost}
        sessionKey={sessionKey}
        historyKey={historyKey}
        onSelectSession={props.onSelectSession}
        assistantMode={props.assistantMode}
      />
    </div>
  );
}
