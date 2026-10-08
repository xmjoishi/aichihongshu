import { useState } from "react";
import { Check } from "lucide-react";
import { MdContent } from "../MdContent";
import type { AIAction } from "../../lib/pageAIContext";
import type { AIResponseBlock } from "../../lib/aiResponse";

export type NoteDraftFieldActions = {
  title?: AIAction;
  bodyReplace?: AIAction;
  bodyAppend?: AIAction;
  tags?: AIAction;
};

export function AIResponseBlocks({
  blocks,
  noteDraftActions,
  onNoteDraftAction,
}: {
  blocks: AIResponseBlock[];
  noteDraftActions?: NoteDraftFieldActions;
  onNoteDraftAction?: (action: AIAction, block: Extract<AIResponseBlock, { type: "note-draft" }>) => boolean;
}) {
  const [appliedActions, setAppliedActions] = useState<Record<string, string>>({});

  function fieldAction(action: AIAction | undefined, fieldLabel: string, buttonLabel: string, block: Extract<AIResponseBlock, { type: "note-draft" }>) {
    if (!action || !onNoteDraftAction) return null;
    const appliedLabel = appliedActions[action.id];
    return (
      <button
        type="button"
        onClick={() => {
          if (onNoteDraftAction(action, block)) {
            setAppliedActions((current) => ({ ...current, [action.id]: buttonLabel === "追加" ? "已追加" : "已替换" }));
          }
        }}
        title={appliedLabel ? "内容已立即写入笔记，自动保存已开始" : action.description ?? `${fieldLabel}${buttonLabel}到当前笔记`}
        aria-label={appliedLabel ? `${fieldLabel}：${appliedLabel}` : `${fieldLabel}：${buttonLabel}`}
        className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${appliedLabel ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-zinc-200 bg-white text-zinc-500 hover:border-[#ff2442]/40 hover:bg-[#fff5f6] hover:text-[#c81d36]"}`}
      >
        {appliedLabel && <Check size={11} />}
        {appliedLabel ?? buttonLabel}
      </button>
    );
  }

  return (
    <div className="space-y-2.5">
      {blocks.map((block, index) => {
        if (block.type === "markdown") return <MdContent key={index} content={block.content} />;
        if (block.type === "note-draft") return (
          <section key={index} className="space-y-2 rounded-xl border border-zinc-200 bg-white p-3">
            {block.title && <div><div className="mb-1 flex items-center justify-between gap-2"><div className="text-[10px] font-medium text-zinc-400">标题</div>{fieldAction(noteDraftActions?.title, "标题", "替换", block)}</div><div className="font-medium text-zinc-800">{block.title}</div></div>}
            {block.body && <div><div className="mb-1 flex items-center justify-between gap-2"><div className="text-[10px] font-medium text-zinc-400">正文</div><div className="flex shrink-0 items-center gap-1.5">{fieldAction(noteDraftActions?.bodyReplace, "正文", "替换", block)}{fieldAction(noteDraftActions?.bodyAppend, "正文", "追加", block)}</div></div><div className="whitespace-pre-wrap leading-relaxed text-zinc-700">{block.body}</div></div>}
            {block.tags.length > 0 && <div><div className="mb-1 flex items-center justify-between gap-2"><div className="text-[10px] font-medium text-zinc-400">标签</div>{fieldAction(noteDraftActions?.tags, "标签", "替换", block)}</div><div className="flex flex-wrap gap-1">{block.tags.map((tag, tagIndex) => <span key={`${tag}-${tagIndex}`} className="rounded-full bg-[#fff0f2] px-2 py-0.5 text-[10px] text-[#d21f3a]">#{tag}</span>)}</div></div>}
          </section>
        );
        if (block.type === "metrics") return (
          <div key={index} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {block.items.map((item, itemIndex) => <div key={`${item.label}-${itemIndex}`} className="rounded-lg border border-zinc-200 bg-white px-2.5 py-2"><div className="text-[10px] text-zinc-400">{item.label}</div><div className="mt-0.5 font-semibold text-zinc-800">{item.value}</div>{item.detail && <div className="mt-0.5 text-[10px] text-zinc-500">{item.detail}</div>}</div>)}
          </div>
        );
        if (block.type === "table") return (
          <div key={index} className="overflow-x-auto rounded-lg border border-zinc-200 bg-white"><table className="min-w-full text-left text-[11px]"><thead className="bg-zinc-50 text-zinc-500"><tr>{block.columns.map((column, columnIndex) => <th key={`${column}-${columnIndex}`} className="px-2.5 py-2 font-medium">{column}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-t border-zinc-100">{block.columns.map((_, columnIndex) => <td key={columnIndex} className="px-2.5 py-2 text-zinc-700">{row[columnIndex] ?? "—"}</td>)}</tr>)}</tbody></table></div>
        );
        if (block.type === "persona-fields") return <dl key={index} className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white px-3">{block.fields.map((field, fieldIndex) => <div key={`${field.label}-${fieldIndex}`} className="grid grid-cols-[minmax(5rem,0.35fr)_1fr] gap-3 py-2"><dt className="text-zinc-400">{field.label}</dt><dd className="whitespace-pre-wrap text-zinc-700">{field.value}</dd></div>)}</dl>;
        if (block.type === "diff") return <div key={index} className="space-y-2">{block.items.map((item, itemIndex) => <div key={`${item.label}-${itemIndex}`} className="rounded-lg border border-zinc-200 bg-white p-2.5"><div className="mb-1 font-medium text-zinc-700">{item.label}</div>{item.before != null && <div className="whitespace-pre-wrap text-zinc-500"><span className="mr-1 text-[10px] text-zinc-400">原内容</span>{item.before}</div>}{item.after != null && <div className="mt-1 whitespace-pre-wrap text-zinc-800"><span className="mr-1 text-[10px] text-[#ff2442]">建议</span>{item.after}</div>}</div>)}</div>;
        if (block.type === "checklist") return <ul key={index} className="space-y-1.5">{block.items.map((item, itemIndex) => <li key={`${item.label}-${itemIndex}`} className="flex gap-2"><span className={item.done ? "text-emerald-600" : "text-zinc-300"}>{item.done ? "✓" : "○"}</span><span className="whitespace-pre-wrap">{item.label}</span></li>)}</ul>;
        return null;
      })}
    </div>
  );
}
