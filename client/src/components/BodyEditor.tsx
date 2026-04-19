/**
 * BodyEditor — 小红书风格纯文本正文编辑器
 *
 * - 纯文本 textarea（小红书发布页不支持富文本）
 * - 支持插入小红书表情标记（如 [开心R]）
 * - 字数统计（上限 1000）
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { Smile } from "lucide-react";

const CHAR_LIMIT = 1000;

// 小红书常用表情（文本标记形式，与创作者中心一致）
const XHS_EMOJIS: { label: string; text: string }[] = [
  { label: "开心", text: "[开心R]" },
  { label: "哭泣", text: "[哭泣R]" },
  { label: "愤怒", text: "[愤怒R]" },
  { label: "惊喜", text: "[惊喜R]" },
  { label: "害羞", text: "[害羞R]" },
  { label: "委屈", text: "[委屈R]" },
  { label: "疑惑", text: "[疑惑R]" },
  { label: "无语", text: "[无语R]" },
  { label: "思考", text: "[思考R]" },
  { label: "捂脸", text: "[捂脸R]" },
  { label: "滑稽", text: "[滑稽R]" },
  { label: "打脸", text: "[打脸R]" },
  { label: "鼓掌", text: "[鼓掌R]" },
  { label: "呲牙", text: "[呲牙R]" },
  { label: "调皮", text: "[调皮R]" },
  { label: "色色", text: "[色色R]" },
  { label: "偷看", text: "[偷看R]" },
  { label: "发财", text: "[发财R]" },
  { label: "嘿嘿", text: "[嘿嘿R]" },
  { label: "doge", text: "[doge]" },
  // 通用 Unicode 表情（也可直接输入）
  { label: "✨", text: "✨" },
  { label: "🔥", text: "🔥" },
  { label: "💕", text: "💕" },
  { label: "😍", text: "😍" },
  { label: "😭", text: "😭" },
  { label: "🤔", text: "🤔" },
  { label: "👀", text: "👀" },
  { label: "💡", text: "💡" },
  { label: "📦", text: "📦" },
  { label: "🛋️", text: "🛋️" },
  { label: "🪴", text: "🪴" },
  { label: "🏠", text: "🏠" },
  { label: "💰", text: "💰" },
  { label: "👇", text: "👇" },
  { label: "⬆️", text: "⬆️" },
  { label: "❗", text: "❗" },
  { label: "✅", text: "✅" },
  { label: "🎯", text: "🎯" },
  { label: "💪", text: "💪" },
  { label: "🙈", text: "🙈" },
];

interface Props {
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  className?: string;
  tagsLength?: number;   // 标签字数，计入总字数统计
}

export default function BodyEditor({ value, onChange, placeholder, className, tagsLength = 0 }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭表情面板
  useEffect(() => {
    if (!showEmoji) return;
    function handler(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowEmoji(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showEmoji]);

  const insertEmoji = useCallback((text: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const newValue = value.slice(0, start) + text + value.slice(end);
    onChange(newValue);
    // 恢复光标到插入点之后
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
    setShowEmoji(false);
  }, [value, onChange]);

  const charCount = value.length + tagsLength;
  const isOverLimit = charCount > CHAR_LIMIT;

  return (
    <div className={`flex flex-col min-h-0 relative ${className ?? ""}`}>
      {/* 工具栏 */}
      <div className="flex items-center gap-1 px-6 py-1.5 border-b border-zinc-100 shrink-0">
        <div className="relative" ref={pickerRef}>
          <button
            type="button"
            title="插入表情"
            onClick={() => setShowEmoji((v) => !v)}
            className={`w-6 h-6 rounded flex items-center justify-center transition-colors
              ${showEmoji ? "bg-[#ff2442]/10 text-[#ff2442]" : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"}`}
          >
            <Smile size={13} />
          </button>

          {/* 表情面板 */}
          {showEmoji && (
            <div className="absolute left-0 top-8 z-50 bg-white rounded-xl shadow-lg border border-zinc-100 p-2 w-72">
              <p className="text-[10px] text-zinc-400 px-1 pb-1.5">小红书表情</p>
              <div className="grid grid-cols-8 gap-0.5">
                {XHS_EMOJIS.map((e) => (
                  <button
                    key={e.text}
                    type="button"
                    title={e.label}
                    onClick={() => insertEmoji(e.text)}
                    className="h-8 w-8 rounded-lg text-sm hover:bg-zinc-100 flex items-center justify-center transition-colors"
                  >
                    {/* Unicode emoji 直接渲染，[xx] 标记显示中文缩写 */}
                    {e.text.startsWith("[") ? (
                      <span className="text-[9px] text-zinc-600 leading-none text-center px-0.5">{e.label}</span>
                    ) : (
                      <span>{e.text}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="w-px h-4 bg-zinc-200 mx-1" />
        <span className="text-[10px] text-zinc-300 select-none">纯文本 · Enter 换行</span>
      </div>

      {/* 编辑区 */}
      <div className="relative flex-1 min-h-0">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "正文内容..."}
          spellCheck={false}
          className="absolute inset-0 w-full h-full resize-none outline-none text-sm text-zinc-700 leading-relaxed px-6 py-3 bg-transparent placeholder:text-zinc-300"
        />
      </div>

      {/* 字数统计 */}
      <div className="shrink-0 flex justify-end items-center gap-1.5 px-6 py-1">
        {tagsLength > 0 && (
          <span className="text-[10px] text-zinc-300">正文 {value.length} + 标签 {tagsLength}</span>
        )}
        <span className={`text-[11px] tabular-nums ${isOverLimit ? "text-red-500 font-medium" : "text-zinc-300"}`}>
          {charCount} / {CHAR_LIMIT}
        </span>
      </div>
    </div>
  );
}
