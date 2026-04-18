import { useState, useRef, useEffect, useCallback } from "react";
import { Sparkles, X, RotateCcw, StopCircle, Send, Copy, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAIStream } from "../hooks/useAIStream";

interface AIPanelProps {
  noteId?: number;
  itemId?: number;
  systemExtra?: string;
  onApply?: (text: string) => void;
  onClose?: () => void;
}

// 快捷操作列表
const QUICK_ACTIONS = [
  { label: "生成标题", prompt: "请为这篇笔记生成 5 个吸引人的标题，每行一个，不超过 20 字。" },
  { label: "优化正文", prompt: "请帮我优化这篇笔记的正文，保持口语化，短句换行，突出卖点。" },
  { label: "生成标签", prompt: "请为这篇笔记生成 8 个小红书标签，以 # 开头，贴合内容垂类。" },
  { label: "写封面描述", prompt: "请为这篇笔记写一段封面图文字，不超过 15 字，有视觉冲击力。" },
];

// ── Markdown 渲染组件（带代码块复制按钮）─────────────────────────
function MdContent({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  async function copyCode(code: string) {
    await navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 1500);
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // 段落
        p: ({ children }) => (
          <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>
        ),
        // 标题
        h1: ({ children }) => <p className="font-bold text-sm mb-1">{children}</p>,
        h2: ({ children }) => <p className="font-bold text-xs mb-1 text-zinc-600">{children}</p>,
        h3: ({ children }) => <p className="font-semibold text-xs mb-0.5">{children}</p>,
        // 列表
        ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 mb-1.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 mb-1.5">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        // 行内代码
        code: ({ children, className }) => {
          const isBlock = className?.includes("language-");
          if (isBlock) {
            const code = String(children).replace(/\n$/, "");
            const isCopied = copiedCode === code;
            return (
              <div className="relative group/code my-2">
                <pre className="bg-zinc-900 text-zinc-100 rounded-lg px-3 py-2.5 text-[10px] leading-relaxed overflow-x-auto font-mono">
                  <code>{code}</code>
                </pre>
                <button
                  onClick={() => copyCode(code)}
                  className="absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100
                             transition-opacity p-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-300"
                  title="复制代码"
                >
                  {isCopied ? <Check size={10} /> : <Copy size={10} />}
                </button>
              </div>
            );
          }
          return (
            <code className="bg-zinc-200 text-zinc-800 rounded px-1 py-0.5 font-mono text-[10px]">
              {children}
            </code>
          );
        },
        // 引用
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-zinc-300 pl-2 text-zinc-500 italic my-1">
            {children}
          </blockquote>
        ),
        // 分割线
        hr: () => <hr className="border-zinc-200 my-2" />,
        // 粗体/斜体
        strong: ({ children }) => <strong className="font-semibold text-zinc-800">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        // 链接（不跳转）
        a: ({ children, href }) => (
          <span className="text-[#ff2442] underline cursor-default" title={href}>{children}</span>
        ),
      }}
    >
      {streaming ? content + "▍" : content}
    </ReactMarkdown>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────
export default function AIPanel({ noteId, itemId, systemExtra, onApply, onClose }: AIPanelProps) {
  const { messages, streaming, loading, error, send, clear, abort } = useAIStream({
    noteId,
    itemId,
    systemExtra,
  });
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── 拖拽调整宽度 ──────────────────────────────────────────────
  const [width, setWidth] = useState(320); // 默认 320px
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - ev.clientX; // 向左拖 → 变宽
      const newW = Math.min(600, Math.max(240, dragRef.current.startW + delta));
      setWidth(newW);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [width]);

  // 有新消息/流式更新时自动滚到底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  function handleSend() {
    if (!input.trim()) return;
    send(input);
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function copyText(text: string, idx: number) {
    await navigator.clipboard.writeText(text);
    setCopied(idx);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div
      className="flex flex-col h-full bg-white border-l border-zinc-100 relative shrink-0"
      style={{ width }}
    >
      {/* 左侧拖拽条 */}
      <div
        onMouseDown={onDragStart}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10
                   hover:bg-[#ff2442]/30 active:bg-[#ff2442]/50 transition-colors"
        title="拖动调整宽度"
      />
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-[#ff2442]" />
          <span className="text-sm font-semibold text-zinc-800">AI 助手</span>
        </div>
        <div className="flex gap-1">
          {messages.length > 0 && (
            <button
              onClick={clear}
              title="清空对话"
              className="p-1 text-zinc-400 hover:text-zinc-600 rounded transition-colors"
            >
              <RotateCcw size={13} />
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 text-zinc-400 hover:text-zinc-600 rounded transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* 快捷操作（首屏无消息时显示） */}
      {messages.length === 0 && !streaming && (
        <div className="p-3 border-b border-zinc-100 shrink-0">
          <p className="text-xs text-zinc-400 mb-2">快捷操作</p>
          <div className="grid grid-cols-2 gap-1.5">
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a.label}
                onClick={() => send(a.prompt)}
                disabled={loading}
                className="text-xs bg-zinc-50 hover:bg-zinc-100 text-zinc-700 px-2 py-1.5 rounded-lg
                           transition-colors text-left truncate disabled:opacity-40"
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 对话区 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "user" ? (
              /* 用户气泡：纯文本，右对齐 */
              <div className="max-w-[85%] bg-[#ff2442] text-white rounded-2xl rounded-tr-sm px-3 py-2 text-xs leading-relaxed">
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
            ) : (
              /* AI 气泡：Markdown 渲染，左对齐 */
              <div className="max-w-[92%] group">
                <div className="bg-zinc-50 border border-zinc-100 rounded-2xl rounded-tl-sm px-3 py-2.5 text-xs text-zinc-700">
                  <MdContent content={msg.content} />
                </div>
                {/* 操作按钮（hover 显示） */}
                <div className="flex gap-2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity px-1">
                  <button
                    onClick={() => copyText(msg.content, i)}
                    className="flex items-center gap-0.5 text-zinc-400 hover:text-zinc-600 text-[10px]"
                  >
                    {copied === i ? <Check size={10} /> : <Copy size={10} />}
                    {copied === i ? "已复制" : "复制"}
                  </button>
                  {onApply && (
                    <button
                      onClick={() => onApply(msg.content)}
                      className="text-[10px] text-[#ff2442] hover:underline"
                    >
                      应用到编辑器
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* 流式输出中（实时 Markdown 渲染 + 光标） */}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[92%] bg-zinc-50 border border-zinc-100 rounded-2xl rounded-tl-sm px-3 py-2.5 text-xs text-zinc-700">
              <MdContent content={streaming} streaming />
            </div>
          </div>
        )}

        {/* 等待第一个 chunk 的加载动画 */}
        {loading && !streaming && (
          <div className="flex justify-start">
            <div className="bg-zinc-50 border border-zinc-100 rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex gap-1 items-center">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

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
            <button
              onClick={abort}
              className="p-2 text-zinc-400 hover:text-red-500 transition-colors shrink-0"
              title="停止生成"
            >
              <StopCircle size={18} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="p-2 bg-[#ff2442] text-white rounded-xl hover:bg-[#e01f3a]
                         disabled:opacity-30 transition-colors shrink-0"
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
