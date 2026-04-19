import { useState, useRef, useEffect } from "react";
import { Sparkles, X, RotateCcw, StopCircle, Send, Copy, Check } from "lucide-react";
import { useAIStream } from "../hooks/useAIStream";
import { MdContent } from "./MdContent";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { usePanelResize } from "../hooks/usePanelResize";

interface AIPanelProps {
  noteId?: number;
  itemId?: number;
  systemExtra?: string;
  onApply?: (text: string) => void;
  onApplyTitle?: (title: string) => void;
  onApplyTags?: (tags: string) => void;
  onApplyBody?: (html: string, mode: "replace" | "append") => void;
  onClose?: () => void;
}

interface QuickAction {
  key: string;
  label: string;
  prompt: string;
  enabled: number;
}

// ── 检测 AI 输出类型 ─────────────────────────────────────────────
type OutputType = "titles" | "tags" | "body" | "generic";

function detectOutputType(content: string): OutputType {
  // 标题列表：编号 / 情绪型 / 场景型 / 问题型 开头的多行
  const titlePatterns = [
    /^\d+[.、]\s+.{4,}/m,
    /^(情绪型|问题型|场景型)[：:]/m,
  ];
  if (titlePatterns.some((p) => p.test(content))) return "titles";

  // 标签：3 个以上 #标签
  if ((content.match(/#[\u4e00-\u9fa5\w]+/g) || []).length >= 3) return "tags";

  // 正文：字数足够多（> 50 字）且没有被识别为标题/标签
  const plain = content.replace(/<[^>]+>/g, "").replace(/\s/g, "");
  if (plain.length > 50) return "body";

  return "generic";
}

/** 从 AI 回复中提取候选标题列表 */
function extractTitles(content: string): string[] {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const titles: string[] = [];
  for (const line of lines) {
    // 1. 标题  /  情绪型：标题  /  - 标题
    const m =
      line.match(/^\d+[.、]\s*(.+)/) ||
      line.match(/^(?:情绪型|问题型|场景型)[：:]\s*(.+)/) ||
      line.match(/^[-•]\s+(.+)/);
    if (m) {
      const t = m[1].replace(/[（(].*?[)）]/g, "").trim();
      if (t.length >= 4 && t.length <= 30) titles.push(t);
    }
  }
  return titles;
}

/** 从 AI 回复中提取标签列表 */
function extractTags(content: string): string[] {
  return (content.match(/#[\u4e00-\u9fa5\w]+/g) || []);
}

// ── 结构化输出卡片 ─────────────────────────────────────────────────
function StructuredOutput({
  content,
  outputType,
  onApplyTitle,
  onApplyTags,
  onApplyBody,
  onRegenerate,
}: {
  content: string;
  outputType: OutputType;
  onApplyTitle?: (t: string) => void;
  onApplyTags?: (t: string) => void;
  onApplyBody?: (html: string, mode: "replace" | "append") => void;
  onRegenerate?: () => void;
}) {
  const [usedIdx, setUsedIdx] = useState<number | null>(null);
  const [bodyApplied, setBodyApplied] = useState<"replace" | "append" | null>(null);

  if (outputType === "titles") {
    const titles = extractTitles(content);
    if (titles.length === 0) return null;
    return (
      <div className="mt-2 space-y-1">
        <p className="text-[10px] text-zinc-400 font-medium">点击直接使用：</p>
        {titles.map((t, i) => (
          <button
            key={i}
            onClick={() => { onApplyTitle?.(t); setUsedIdx(i); }}
            className={`w-full text-left text-xs px-2.5 py-1.5 rounded-lg border transition-all flex items-center justify-between gap-2 ${
              usedIdx === i
                ? "border-[#ff2442] ring-1 ring-[#ff2442] text-zinc-800 bg-[#fff0f2]"
                : "border-zinc-200 hover:border-[#ff2442] hover:bg-[#fff0f2] text-zinc-700"
            }`}
          >
            <span>{t}</span>
            {usedIdx === i && (
              <span className="shrink-0 text-[10px] text-[#ff2442] font-medium">已使用</span>
            )}
          </button>
        ))}
      </div>
    );
  }

  if (outputType === "tags") {
    const tags = extractTags(content);
    if (tags.length === 0) return null;
    const tagsStr = tags.join(" ");
    return (
      <div className="mt-2">
        <p className="text-[10px] text-zinc-400 font-medium mb-1.5">点击一键填入话题栏：</p>
        <div className="flex flex-wrap gap-1 mb-2">
          {tags.map((tag, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 bg-[#ff2442]/10 text-[#ff2442] rounded-full">{tag}</span>
          ))}
        </div>
        <button
          onClick={() => onApplyTags?.(tagsStr)}
          className="text-xs text-[#ff2442] hover:underline flex items-center gap-1"
        >
          <Check size={10} /> 全部填入话题栏
        </button>
      </div>
    );
  }

  if (outputType === "body") {
    // 把纯文本段落转成 HTML，供 Tiptap 接收
    const toHtml = (text: string) =>
      text
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((para) =>
          `<p>${para
            .split(/\n/)
            .join("<br>")
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/\*(.+?)\*/g, "<em>$1</em>")
          }</p>`
        )
        .join("");

    return (
      <div className="mt-2.5 pt-2.5 border-t border-zinc-200 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-zinc-400">采纳到正文：</span>
        <button
          onClick={() => {
            onApplyBody?.(toHtml(content), "replace");
            setBodyApplied("replace");
          }}
          className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border transition-all ${
            bodyApplied === "replace"
              ? "bg-[#ff2442] text-white border-[#ff2442]"
              : "border-zinc-200 hover:border-[#ff2442] hover:bg-[#fff0f2] text-zinc-700"
          }`}
        >
          {bodyApplied === "replace"
            ? <><Check size={10} /> 已替换</>
            : "替换正文"}
        </button>
        <button
          onClick={() => {
            onApplyBody?.(toHtml(content), "append");
            setBodyApplied("append");
          }}
          className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border transition-all ${
            bodyApplied === "append"
              ? "bg-zinc-700 text-white border-zinc-700"
              : "border-zinc-200 hover:border-zinc-400 hover:bg-zinc-50 text-zinc-600"
          }`}
        >
          {bodyApplied === "append"
            ? <><Check size={10} /> 已追加</>
            : "追加到末尾"}
        </button>
        {onRegenerate && (
          <button
            onClick={() => { setBodyApplied(null); onRegenerate(); }}
            className="text-[10px] text-zinc-400 hover:text-zinc-600 ml-auto flex items-center gap-0.5 transition-colors"
          >
            <RotateCcw size={10} /> 重新生成
          </button>
        )}
      </div>
    );
  }

  return null;
}

// ── 主组件 ────────────────────────────────────────────────────────
export default function AIPanel({
  noteId, itemId, systemExtra,
  onApply, onApplyTitle, onApplyTags, onApplyBody, onClose,
}: AIPanelProps) {
  const { messages, streaming, loading, error, send, clear, abort } = useAIStream({ noteId, itemId, systemExtra });
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 从后端加载快捷操作
  const { data: quickActions = [] } = useQuery<QuickAction[]>({
    queryKey: ["quick-actions"],
    queryFn: () => api.get("/api/settings/prompts"),
    staleTime: 30_000,
  });
  const enabledActions = quickActions.filter((a) => a.enabled);

  // 经验库注入状态（轻量轮询，staleTime 长）
  const { data: knowledgeRules = [] } = useQuery<{ enabled: boolean }[]>({
    queryKey: ["knowledge-rules"],
    queryFn: () => api.get("/api/knowledge/rules"),
    staleTime: 60_000,
  });
  const { data: knowledgeSamples = [] } = useQuery<{ use_as_reference: boolean }[]>({
    queryKey: ["knowledge-my-samples"],
    queryFn: () => api.get("/api/knowledge/my-samples"),
    staleTime: 60_000,
  });
  const { data: knowledgeRefGroups = [] } = useQuery<{ notes: unknown[] }[]>({
    queryKey: ["knowledge-ref-samples"],
    queryFn: () => api.get("/api/knowledge/ref-samples"),
    staleTime: 60_000,
  });
  const knowledgeSummary = (() => {
    const nRules = knowledgeRules.filter((r) => r.enabled).length;
    const nMy = knowledgeSamples.filter((s) => s.use_as_reference).length;
    const nRef = knowledgeRefGroups.reduce((s: number, g) => s + g.notes.length, 0);
    const parts: string[] = [];
    if (nRules) parts.push(`${nRules} 条规律`);
    if (nMy) parts.push(`${nMy} 篇高赞样本`);
    if (nRef) parts.push(`${nRef} 篇榜样参考`);
    return parts.length ? `经验库已注入：${parts.join(" · ")}` : "";
  })();

  // ── 拖拽调整宽度
  const { width, dragging, onDragStart } = usePanelResize({
    defaultWidth: 320,
    min: 240,
    max: 640,
    direction: "left",
    storageKey: "ai-panel-width",
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  function handleSend() {
    if (!input.trim()) return;
    send(input);
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  async function copyText(text: string, idx: number) {
    await navigator.clipboard.writeText(text);
    setCopied(idx);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div
      className="flex flex-col h-full bg-white border-l border-zinc-100 relative shrink-0 select-none"
      style={{ width, cursor: dragging ? "col-resize" : undefined }}
    >
      {/* 左侧拖拽条：视觉 4px，热区 12px（负 margin 扩展左侧） */}
      <div
        onMouseDown={onDragStart}
        className={`absolute left-0 top-0 bottom-0 z-10 flex items-center justify-center
                    group cursor-col-resize`}
        style={{ width: 12, marginLeft: -4 }}
        title="拖动调整宽度"
      >
        {/* 视觉指示线 */}
        <div
          className={`w-[3px] h-full rounded-full transition-colors duration-150
            ${dragging ? "bg-[#ff2442]" : "bg-transparent group-hover:bg-[#ff2442]/40"}`}
        />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-[#ff2442]" />
          <span className="text-sm font-semibold text-zinc-800">AI 助手</span>
        </div>
        <div className="flex gap-1">
          {messages.length > 0 && (
            <button onClick={clear} title="清空对话" className="p-1 text-zinc-400 hover:text-zinc-600 rounded transition-colors">
              <RotateCcw size={13} />
            </button>
          )}
          {onClose && (
            <button onClick={onClose} className="p-1 text-zinc-400 hover:text-zinc-600 rounded transition-colors">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* 经验库注入状态 */}
      {knowledgeSummary && (
        <div className="px-4 py-1.5 bg-[#ff2442]/5 border-b border-[#ff2442]/10 shrink-0">
          <p className="text-[10px] text-[#ff2442]/70 leading-relaxed">{knowledgeSummary}</p>
        </div>
      )}

      {/* 对话区 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((msg, i) => {
          const isLast = i === messages.length - 1;
          const outputType = msg.role === "assistant" ? detectOutputType(msg.content) : "generic";
          return (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              {msg.role === "user" ? (
                <div className="max-w-[85%] bg-[#ff2442] text-white rounded-2xl rounded-tr-sm px-3 py-2 text-xs leading-relaxed">
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
              ) : (
                <div className="max-w-[92%] group">
                  <div className="bg-zinc-50 border border-zinc-100 rounded-2xl rounded-tl-sm px-3 py-2.5 text-xs text-zinc-700">
                    <MdContent content={msg.content} />
                    {/* 结构化操作区 —— 仅最后一条 AI 消息显示 */}
                    {isLast && !streaming && (
                      <StructuredOutput
                        content={msg.content}
                        outputType={outputType}
                        onApplyTitle={onApplyTitle}
                        onApplyTags={onApplyTags}
                        onApplyBody={onApplyBody}
                        onRegenerate={() => {
                          // 找到最后一条用户消息重发
                          const lastUser = [...messages].reverse().find((m) => m.role === "user");
                          if (lastUser) send(lastUser.content);
                        }}
                      />
                    )}
                  </div>
                  {/* hover 操作栏 */}
                  <div className="flex gap-2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity px-1">
                    <button
                      onClick={() => copyText(msg.content, i)}
                      className="flex items-center gap-0.5 text-zinc-400 hover:text-zinc-600 text-[10px]"
                    >
                      {copied === i ? <Check size={10} /> : <Copy size={10} />}
                      {copied === i ? "已复制" : "复制"}
                    </button>
                    {onApply && (
                      <button onClick={() => onApply(msg.content)} className="text-[10px] text-[#ff2442] hover:underline">
                        应用到编辑器
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* 流式输出中 */}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[92%] bg-zinc-50 border border-zinc-100 rounded-2xl rounded-tl-sm px-3 py-2.5 text-xs text-zinc-700">
              <MdContent content={streaming} streaming />
            </div>
          </div>
        )}

        {/* 等待第一个 chunk */}
        {loading && !streaming && (
          <div className="flex justify-start">
            <div className="bg-zinc-50 border border-zinc-100 rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex gap-1 items-center">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 150}ms` }} />
                ))}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* 快捷操作 — 常驻横向滚动，位于输入框上方 */}
      {enabledActions.length > 0 && (
        <QuickActionBar actions={enabledActions} onSend={send} loading={loading} hasMessages={messages.length > 0} />
      )}

      {/* 输入框 */}
      <div className="border-t border-zinc-100 p-3 shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入指令… (Enter 发送，Shift+Enter 换行)"
            rows={2}
            className="flex-1 border border-zinc-200 rounded-xl px-3 py-2 text-xs resize-none
                       focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442]
                       placeholder:text-zinc-300 leading-relaxed"
          />
          {loading ? (
            <button onClick={abort} className="p-2 text-zinc-400 hover:text-red-500 transition-colors shrink-0" title="停止生成">
              <StopCircle size={18} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="p-2 bg-[#ff2442] text-white rounded-xl hover:bg-[#e01f3a] disabled:opacity-30 transition-colors shrink-0"
            >
              <Send size={15} />
            </button>
          )}
        </div>
        <p className="text-[10px] text-zinc-300 mt-1.5 text-right">SSE 流式 · Markdown 渲染</p>
      </div>
    </div>
  );
}

// ── 常驻快捷操作栏 ─────────────────────────────────────────────────
function QuickActionBar({
  actions,
  onSend,
  loading,
}: {
  actions: QuickAction[];
  onSend: (prompt: string) => void;
  loading: boolean;
  hasMessages: boolean;
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
