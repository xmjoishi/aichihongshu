import type { Note, Profile, ReferenceAccount } from "./types";
import type { LocalInspirationSummary, LocalKnowledgePreferences } from "./local";
import { computeRulesFromNotes } from "../selectors/knowledge";

export interface LocalKnowledgeContext {
  summary: string;
  prompt: string;
}

const RULE_LABELS: Record<string, string> = {
  title_length: "标题字数",
  best_hour: "发布时段",
  top_tag: "高赞标签",
  collect_ratio: "收藏率",
};

function clip(value: string | undefined | null, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

/**
 * Build a bounded, account-scoped prompt block from local data. The function
 * deliberately accepts already-scoped records so it cannot silently fall
 * back to another account or fetch an external source.
 */
export function buildLocalKnowledgeContext(input: {
  notes: Note[];
  profile?: Profile;
  references: ReferenceAccount[];
  inspirations: LocalInspirationSummary[];
  preferences?: LocalKnowledgePreferences;
}): LocalKnowledgeContext {
  const preferences = input.preferences ?? {
    accountPoolId: 0,
    disabledRuleKeys: [],
    useMySamples: true,
    useReferenceSamples: true,
    useInspirations: true,
  };
  const disabled = new Set(preferences.disabledRuleKeys);
  const rules = computeRulesFromNotes(input.notes)
    .filter((rule) => !disabled.has(rule.key))
    .slice(0, 5);
  const published = input.notes
    .filter((note) => note.status === "published")
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 3);
  const referenceSamples = input.references
    .flatMap((account) => (account.top_notes ?? []).slice(0, 2).map((note) => ({
      account: account.name || account.account_id,
      title: note.title,
      likes: note.likes,
      style: account.content_style,
    })))
    .slice(0, 3);
  const inspirations = input.inspirations.slice(0, 3);
  const profile = input.profile;
  const hasProfile = Boolean(profile && (
    profile.niche || profile.target_audience || profile.persona_tone ||
    profile.persona_taboos?.length || profile.preferred_styles?.length || profile.preferred_scenes?.length
  ));

  const summaryParts: string[] = [];
  if (hasProfile) summaryParts.push("1 份人设偏好");
  if (rules.length) summaryParts.push(`${rules.length} 条规律`);
  if (preferences.useMySamples && published.length) summaryParts.push(`${published.length} 篇高赞样本`);
  if (preferences.useReferenceSamples && referenceSamples.length) summaryParts.push(`${referenceSamples.length} 篇榜样参考`);
  if (preferences.useInspirations && inspirations.length) summaryParts.push(`${inspirations.length} 条灵感`);
  if (!summaryParts.length) return { summary: "", prompt: "" };

  const lines: string[] = [
    "## 当前账号本地经验库（仅作创作参考，不要照抄）",
  ];
  if (hasProfile && profile) {
    lines.push("账号人设偏好：");
    if (profile.niche) lines.push(`- 领域：${clip(profile.niche, 160)}`);
    if (profile.target_audience) lines.push(`- 受众：${clip(profile.target_audience, 160)}`);
    if (profile.persona_tone) lines.push(`- 语气：${clip(profile.persona_tone, 160)}`);
    if (profile.preferred_styles?.length) lines.push(`- 偏好风格：${profile.preferred_styles.slice(0, 8).map((value) => clip(value, 60)).join("、")}`);
    if (profile.preferred_scenes?.length) lines.push(`- 偏好场景：${profile.preferred_scenes.slice(0, 8).map((value) => clip(value, 60)).join("、")}`);
    if (profile.persona_taboos?.length) lines.push(`- 禁忌：${profile.persona_taboos.slice(0, 8).map((value) => clip(value, 60)).join("、")}`);
  }
  if (rules.length) {
    lines.push("互动规律：");
    for (const rule of rules) {
      lines.push(`- ${RULE_LABELS[rule.key] ?? rule.key}：${clip(rule.desc || rule.value, 360)}`);
    }
  }
  if (preferences.useMySamples && published.length) {
    lines.push("我的高赞样本：");
    for (const note of published) {
      lines.push(`- 《${clip(note.title, 120)}》（赞 ${note.likes}）${clip(note.body, 220)}`.trim());
    }
  }
  if (preferences.useReferenceSamples && referenceSamples.length) {
    lines.push("榜样笔记参考：");
    for (const sample of referenceSamples) {
      const style = clip(sample.style, 180);
      lines.push(`- [${clip(sample.account, 80)}]《${clip(sample.title, 120)}》（赞 ${sample.likes}）${style ? `风格：${style}` : ""}`.trim());
    }
  }
  if (preferences.useInspirations && inspirations.length) {
    lines.push("选题灵感：");
    for (const inspiration of inspirations) {
      const detail = clip(inspiration.body || inspiration.reason, 180);
      lines.push(`- ${clip(inspiration.title, 140)}${detail ? `：${detail}` : ""}`);
    }
  }
  lines.push("使用这些资料总结方法和方向，避免编造数据、泄露来源链接或复述整篇样本。");
  return { summary: `经验库已注入：${summaryParts.join(" · ")}`, prompt: lines.join("\n") };
}
