/**
 * RichBodyEditor — 基于 Tiptap 的小红书风格正文编辑器
 *
 * 支持：加粗、斜体、硬换行（Shift+Enter）、段落换行（Enter）
 * 保存：通过 onChange 回调输出 HTML 字符串（存入 body 字段）
 * 字数：通过 CharacterCount 扩展统计，右下角展示 当前/上限
 */

import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import CharacterCount from "@tiptap/extension-character-count";
import { Bold, Italic } from "lucide-react";

const CHAR_LIMIT = 1000;

interface Props {
  value: string;          // HTML 字符串（或纯文本）
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
}

export default function RichBodyEditor({ value, onChange, placeholder, className }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // 禁用不需要的扩展，保持轻量
        heading: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        strike: false,
      }),
      CharacterCount.configure({ limit: CHAR_LIMIT }),
    ],
    content: value || "",
    onUpdate({ editor }) {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: "outline-none w-full h-full",
        spellcheck: "false",
      },
    },
  });

  // 当外部 value 变化时（如 AI 填充），同步更新编辑器内容
  useEffect(() => {
    if (!editor) return;
    // 只在内容真正不同时才更新，避免光标跳动
    const current = editor.getHTML();
    if (current !== value && value !== undefined) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [value, editor]);

  if (!editor) return null;

  const charCount = editor.storage.characterCount.characters() as number;
  const isOverLimit = charCount >= CHAR_LIMIT;

  return (
    <div className={`flex flex-col min-h-0 ${className ?? ""}`}>
      {/* 工具栏 */}
      <div className="flex items-center gap-1 px-6 py-1.5 border-b border-zinc-100 shrink-0">
        <ToolbarButton
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="加粗 (⌘B)"
        >
          <Bold size={13} />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="斜体 (⌘I)"
        >
          <Italic size={13} />
        </ToolbarButton>
        <div className="w-px h-4 bg-zinc-200 mx-1" />
        <span className="text-[10px] text-zinc-300 select-none">Enter 换行 · ⌘B 加粗 · ⌘I 斜体</span>
      </div>

      {/* 编辑区 */}
      <div className="relative flex-1 min-h-0 overflow-y-auto px-6 py-3">
        {/* placeholder */}
        {editor.isEmpty && (
          <span className="absolute top-3 left-6 text-sm text-zinc-300 pointer-events-none select-none">
            {placeholder ?? "正文内容...（支持小红书换行风格）"}
          </span>
        )}
        <EditorContent
          editor={editor}
          className="text-sm text-zinc-700 leading-relaxed h-full [&_.ProseMirror]:h-full [&_.ProseMirror]:outline-none"
        />
      </div>

      {/* 字数统计 */}
      <div className="shrink-0 flex justify-end px-6 py-1">
        <span className={`text-[11px] tabular-nums ${isOverLimit ? "text-red-500 font-medium" : "text-zinc-300"}`}>
          {charCount} / {CHAR_LIMIT}
        </span>
      </div>
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault(); // 防止编辑器失焦
        onClick();
      }}
      className={`w-6 h-6 rounded flex items-center justify-center transition-colors
        ${active
          ? "bg-zinc-900 text-white"
          : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
        }`}
    >
      {children}
    </button>
  );
}
