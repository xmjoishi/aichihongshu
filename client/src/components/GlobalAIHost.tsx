import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Sparkles } from "lucide-react";
import AIHost from "./AIHost";
import { getPageAIContext, publishPageAIContext, type PageAIContext } from "../lib/pageAIContext";

export const GLOBAL_AI_EVENT = "aichihongshu:open-global-ai";

export function openGlobalAI(context?: Partial<PageAIContext>) {
  if (typeof window !== "undefined") {
    if (context) publishPageAIContext({ ...getPageAIContext(), ...context });
    window.dispatchEvent(new Event(GLOBAL_AI_EVENT));
  }
}

/** Global floating Copilot launcher. Page-specific panels remain available. */
export default function GlobalAIHost() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const agentWorkspace = location.pathname === "/assistant";

  useEffect(() => {
    const handler = () => {
      if (window.location.pathname === "/assistant") return;
      setOpen(true);
    };
    window.addEventListener(GLOBAL_AI_EVENT, handler);
    return () => window.removeEventListener(GLOBAL_AI_EVENT, handler);
  }, []);

  useEffect(() => {
    if (agentWorkspace) setOpen(false);
  }, [agentWorkspace]);

  // The independent AI workspace already owns the full page presentation.
  // Keep the global launcher out of that route and restore it when leaving.
  if (agentWorkspace) return null;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="打开 AI 助手"
          title="打开 AI 助手"
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full border border-white/70 bg-[#ff2442] text-white shadow-[0_10px_28px_rgba(255,36,66,0.32)] transition hover:scale-105 hover:bg-[#e91f3c] active:scale-95"
        >
          <Sparkles size={23} strokeWidth={2.2} />
          <span className="sr-only">AI 助手</span>
        </button>
      )}
      {open && (
        <div className="pointer-events-none fixed inset-0 z-50">
          <AIHost mode="floating" onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
