import { useState } from "react";
import { Dialog, primaryButtonClass, secondaryButtonClass } from "./ui";
import {
  createMemoryEntry,
  upsertExperiencePrompt,
  type MemoryKind,
  type MemoryOrigin,
} from "../lib/local";
import { useAccountContext } from "../lib/accountContext";

const KIND_LABELS: Record<MemoryKind, string> = {
  positioning: "定位与表达",
  expression: "表达偏好",
  fact: "生活事实",
  event: "事件",
  content_history: "内容历史",
};

export type MemorySaveDraft = {
  mode: "entry" | "prompt";
  title?: string;
  content: string;
  kind?: MemoryKind;
  subject?: string;
  source?: string;
};

const inputClass =
  "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]/50 focus:ring-2 focus:ring-[#ff2442]/10";

/**
 * 全局可用的「存为记忆 / 存为经验」弹窗。
 * 在任意页面的 AI 会话结束后，把本轮经验一键落库（默认停用，确认后启用）。
 */
export function MemorySaveDialog({
  draft,
  origin = "pc",
  onClose,
  onSaved,
}: {
  draft: MemorySaveDraft;
  origin?: MemoryOrigin;
  onClose: () => void;
  onSaved?: (mode: "entry" | "prompt") => void;
}) {
  const { accountId } = useAccountContext();
  const isPrompt = draft.mode === "prompt";
  const [title, setTitle] = useState(draft.title ?? "");
  const [content, setContent] = useState(draft.content);
  const [kind, setKind] = useState<MemoryKind>(draft.kind ?? "expression");
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [source, setSource] = useState(draft.source ?? "AI 会话");
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    setError("");
    try {
      if (isPrompt) {
        await upsertExperiencePrompt({
          accountPoolId: accountId ?? 1,
          origin,
          title: title.trim() || "会话经验",
          content,
          enabled,
          applyScope: "account",
          applyTarget: "all",
          source: "from_memory",
        });
      } else {
        await createMemoryEntry({
          accountPoolId: accountId ?? 1,
          origin,
          kind,
          content,
          subject: subject.trim() || undefined,
          source: source.trim() || "AI 会话",
          sourceType: "ai_draft",
          enabled,
        });
      }
      onSaved?.(draft.mode);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={isPrompt ? "存为经验提示词" : "存为记忆"}
      description={isPrompt ? "把希望 AI 遵守的写法/偏好存下来，下次出稿自动带上。" : "把事实/事件/偏好存入记忆；默认停用，确认无误再启用。"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>取消</button>
          <button type="button" className={primaryButtonClass} onClick={submit} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {isPrompt ? (
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">标题</span>
            <input
              className={inputClass}
              placeholder="如：口吻偏好"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="block sm:w-44">
              <span className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">类型</span>
              <select
                className={inputClass}
                value={kind}
                onChange={(e) => setKind(e.target.value as MemoryKind)}
              >
                {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABELS[k]}</option>
                ))}
              </select>
            </label>
            <label className="block flex-1">
              <span className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">主体（可选）</span>
              <input
                className={inputClass}
                placeholder="如：口吻 / 门后置物架"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </label>
          </div>
        )}
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">内容</span>
          <textarea
            className={`${inputClass} min-h-[120px]`}
            placeholder="可直接编辑后再保存"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
        {!isPrompt && (
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">来源（可选）</span>
            <input
              className={inputClass}
              placeholder="如：AI 会话 / 用户口述"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
        )}
        <button
          type="button"
          onClick={() => setEnabled(!enabled)}
          className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]"
        >
          <span
            className={`inline-flex h-4 w-4 items-center justify-center rounded border ${
              enabled ? "border-[#ff2442] bg-[#ff2442] text-white" : "border-[var(--color-border)]"
            }`}
          >
            {enabled ? "✓" : ""}
          </span>
          保存后立即启用（默认停用，建议先在记忆页核对）
        </button>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    </Dialog>
  );
}
