import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";

export function MdContent({ content, streaming = false }: { content: string; streaming?: boolean }) {
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
        p: ({ children }) => <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>,
        h1: ({ children }) => <p className="font-bold text-sm mb-1">{children}</p>,
        h2: ({ children }) => <p className="font-bold text-xs mb-1 text-zinc-600">{children}</p>,
        h3: ({ children }) => <p className="font-semibold text-xs mb-0.5">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 mb-1.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 mb-1.5">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
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
                  className="absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100 transition-opacity p-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-300"
                >
                  {isCopied ? <Check size={10} /> : <Copy size={10} />}
                </button>
              </div>
            );
          }
          return <code className="bg-zinc-200 text-zinc-800 rounded px-1 py-0.5 font-mono text-[10px]">{children}</code>;
        },
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-zinc-300 pl-2 text-zinc-500 italic my-1">{children}</blockquote>
        ),
        hr: () => <hr className="border-zinc-200 my-2" />,
        strong: ({ children }) => <strong className="font-semibold text-zinc-800">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        a: ({ children, href }) => (
          <span className="text-[#ff2442] underline cursor-default" title={href}>{children}</span>
        ),
      }}
    >
      {streaming ? content + "▍" : content}
    </ReactMarkdown>
  );
}
