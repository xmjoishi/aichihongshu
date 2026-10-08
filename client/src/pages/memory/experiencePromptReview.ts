export type ExperiencePromptReviewInput = {
  id: number | string;
  title: string;
  content: string;
  enabled: boolean;
  applyScope?: "global" | "account";
  applyTarget?: "all" | "compose" | "chat";
  accountPoolId?: number;
};

export type ExperiencePromptReviewEvidence = {
  promptId: number | string;
  title: string;
  excerpt: string;
};

export type ExperiencePromptReviewFinding = {
  id: string;
  kind: "duplicate" | "conflict";
  label: string;
  reason: string;
  suggestion: string;
  evidence: ExperiencePromptReviewEvidence[];
};

type RulePolarity = {
  label: string;
  positive: RegExp;
  negative: RegExp;
  positiveMeaning: string;
  negativeMeaning: string;
};

const REVIEW_SUGGESTION = "请人工检查这几条是否需要同时保留；可自行编辑或停用。检查不会修改任何内容。";

const RULES: RulePolarity[] = [
  {
    label: "Emoji 使用偏好",
    positive: /(?:适当|适量|多|少量)?(?:使用|加入|加上|添加|带上|用)\s*(?:emoji|表情符号)|(?:emoji|表情符号)\s*(?:可以|可用|需要|要用|必须|适量|适当|多用|使用)/iu,
    negative: /(?:不(?:要|用|使用|加|需要|可以)|别(?:用|加|使用)|避免|禁止|拒绝|无需)\s*(?:(?:使用|添加|加入|加上|用|带上)\s*)?(?:emoji|表情符号)|(?:emoji|表情符号)\s*(?:不要(?:使用|用|加)?|不(?:用|使用|需要|可以)|别(?:用|加)|禁止|禁用|不能用|无需)/iu,
    positiveMeaning: "明确要求使用 Emoji",
    negativeMeaning: "明确要求不使用 Emoji",
  },
  {
    label: "小标题偏好",
    positive: /(?:使用|加上|添加|保留|设置|安排|需要|必须|要有|每节|各部分).{0,6}(?:小标题|分级标题|小节标题)|(?:小标题|分级标题|小节标题).{0,6}(?:要有|需要|保留|使用|添加|加上|必须)/iu,
    negative: /(?:不要|不使用|不用|别加|避免|禁止|不需要|不加)\s*(?:(?:再|继续|用|使用|加|添加|加上|设置|保留)\s*)?(?:小标题|分级标题|小节标题)|(?:小标题|分级标题|小节标题)\s*(?:不要|不需要|不用|无需|禁用)/iu,
    positiveMeaning: "明确要求使用小标题",
    negativeMeaning: "明确要求不使用小标题",
  },
  {
    label: "分段偏好",
    positive: /(?:分段(?:排版|清晰|明确)|段落分明|换行分段|短段落|段落之间(?:空一行|留空行)|每段.{0,5}(?:简短|留空行))/iu,
    negative: /(?:不要|不必|无需|别)\s*(?:再\s*)?(?:分段|换行)|(?:一段到底|一整段|单段写完|不要分段|不要换行|不换行|连续成段|全部写成一段)/iu,
    positiveMeaning: "明确要求分段或段落间留空行",
    negativeMeaning: "明确要求不分段或整篇写成一段",
  },
  {
    label: "列表偏好",
    positive: /(?:分点列出|分条列出|列点说明|项目符号|无序列表|编号列表|使用列表|用列表|列表形式|要点列表)/iu,
    negative: /(?:不要|不需要|不使用|不用|别用|避免|禁止)(?:再|继续|使用|用|采用)?\s*(?:列表|项目符号|分点|列点|编号列表)|(?:不要分点|不分点|不要列点|只写自然段)/iu,
    positiveMeaning: "明确要求使用列表或分点列出",
    negativeMeaning: "明确要求不使用列表或分点列出",
  },
];

function normalizeContent(content: string): string {
  return content.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

function readRulePolarity(content: string, rule: RulePolarity): { polarity: "positive" | "negative"; excerpt: string } | null {
  // Check the negative form first so phrases such as “不要使用 Emoji” cannot
  // also be treated as a positive match on the substring “使用 Emoji”.
  const negative = content.match(rule.negative);
  if (negative) return { polarity: "negative", excerpt: negative[0].trim() };
  const positive = content.match(rule.positive);
  if (positive) return { polarity: "positive", excerpt: positive[0].trim() };
  return null;
}

function targetsOverlap(a: ExperiencePromptReviewInput, b: ExperiencePromptReviewInput): boolean {
  const targetA = a.applyTarget ?? "all";
  const targetB = b.applyTarget ?? "all";
  return targetA === "all" || targetB === "all" || targetA === targetB;
}

function scopesOverlap(a: ExperiencePromptReviewInput, b: ExperiencePromptReviewInput): boolean {
  if (a.applyScope !== "account" || b.applyScope !== "account") return true;
  return a.accountPoolId == null || b.accountPoolId == null || a.accountPoolId === b.accountPoolId;
}

function pairKey(a: ExperiencePromptReviewInput, b: ExperiencePromptReviewInput): string {
  return [String(a.id), String(b.id)].sort().join(":");
}

/**
 * Return review-only suggestions for duplicate prompt text and a small set of
 * explicit, mechanically recognizable preference opposites. This function
 * does not call a model or mutate the supplied prompts.
 */
export function reviewExperiencePrompts(
  prompts: readonly ExperiencePromptReviewInput[],
): ExperiencePromptReviewFinding[] {
  const findings: ExperiencePromptReviewFinding[] = [];
  const normalized = prompts.map((prompt) => normalizeContent(prompt.content));

  for (let left = 0; left < prompts.length; left += 1) {
    const a = prompts[left];
    if (!normalized[left]) continue;
    for (let right = left + 1; right < prompts.length; right += 1) {
      const b = prompts[right];
      if (String(a.id) === String(b.id) || !normalized[right]) continue;
      const ids = pairKey(a, b);

      if (normalized[left] === normalized[right]) {
        findings.push({
          id: `duplicate:${ids}`,
          kind: "duplicate",
          label: "内容重复",
          reason: "两条经验提示词在统一全半角、大小写和空白后，正文完全相同。",
          suggestion: REVIEW_SUGGESTION,
          evidence: [a, b].map((prompt) => ({
            promptId: prompt.id,
            title: prompt.title,
            excerpt: prompt.content.trim(),
          })),
        });
      }

      if (!a.enabled || !b.enabled || !targetsOverlap(a, b) || !scopesOverlap(a, b)) continue;
      for (const rule of RULES) {
        const stateA = readRulePolarity(a.content, rule);
        const stateB = readRulePolarity(b.content, rule);
        if (!stateA || !stateB || stateA.polarity === stateB.polarity) continue;
        const positive = stateA.polarity === "positive" ? { prompt: a, state: stateA } : { prompt: b, state: stateB };
        const negative = stateA.polarity === "negative" ? { prompt: a, state: stateA } : { prompt: b, state: stateB };
        findings.push({
          id: `conflict:${ids}:${rule.label}`,
          kind: "conflict",
          label: rule.label,
          reason: `${positive.prompt.title}中“${positive.state.excerpt}”与${negative.prompt.title}中“${negative.state.excerpt}”是相反的明确要求。`,
          suggestion: REVIEW_SUGGESTION,
          evidence: [positive, negative].map(({ prompt, state }) => ({
            promptId: prompt.id,
            title: prompt.title,
            excerpt: state.excerpt,
          })),
        });
      }
    }
  }

  return findings;
}
