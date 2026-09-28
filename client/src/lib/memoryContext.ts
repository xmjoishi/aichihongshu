import type {
  LocalExperiencePrompt,
  LocalMemoryEntry,
  MemoryOrigin,
} from "./local";

export interface MemoryContextInput {
  entries: LocalMemoryEntry[];
  prompts: LocalExperiencePrompt[];
  /** 当前端：决定默认注入哪一池。 */
  origin: MemoryOrigin;
  /** "compose"=出稿，"chat"=对话；为 all 条目都注入。 */
  target: "compose" | "chat";
  /** 是否允许注入手机池条目（PC 默认 false，不串池）。 */
  includeMobilePool?: boolean;
}

export interface MemoryContext {
  summary: string;
  prompt: string;
}

const KIND_LABELS: Record<string, string> = {
  positioning: "定位与表达",
  expression: "表达偏好",
  fact: "生活事实",
  event: "事件",
  content_history: "内容历史",
};

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 按注入顺序拼接 L2 经验提示词 + L3 事实记忆。
 * 默认只注入本端池；未确认（候选）与已失效条目不注入。
 */
export function buildMemoryContext(input: MemoryContextInput): MemoryContext {
  const allowedOrigin = input.includeMobilePool ? null : input.origin;
  const prompts = input.prompts
    .filter((prompt) => prompt.enabled)
    .filter((prompt) => prompt.applyTarget === "all" || prompt.applyTarget === input.target)
    .filter((prompt) => !allowedOrigin || prompt.origin === allowedOrigin)
    .slice(0, 10);
  const entries = input.entries
    .filter((entry) => entry.enabled && entry.confirmStatus === "confirmed" && entry.validStatus === "valid")
    .filter((entry) => !allowedOrigin || entry.origin === allowedOrigin)
    .slice(0, 20);

  if (!prompts.length && !entries.length) return { summary: "", prompt: "" };

  const lines: string[] = ["## 经验提示词与有效记忆（创作时遵守；不要照抄原文）"];
  if (prompts.length) {
    lines.push("经验提示词：");
    for (const prompt of prompts) {
      lines.push(`- [${clip(prompt.title, 40)}] ${clip(prompt.content, 300)}`);
    }
  }
  if (entries.length) {
    lines.push("有效记忆：");
    for (const entry of entries) {
      const kind = KIND_LABELS[entry.kind] ?? entry.kind;
      const subject = entry.subject ? `（${clip(entry.subject, 40)}）` : "";
      const when = entry.occurredAt ? ` @${clip(entry.occurredAt, 24)}` : "";
      lines.push(`- [${kind}]${subject}${when} ${clip(entry.content, 240)}`);
    }
  }
  const parts: string[] = [];
  if (prompts.length) parts.push(`${prompts.length} 条经验提示词`);
  if (entries.length) parts.push(`${entries.length} 条有效记忆`);
  return {
    summary: `记忆已注入：${parts.join(" · ")}`,
    prompt: lines.join("\n"),
  };
}
