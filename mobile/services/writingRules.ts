/** 手机出稿规则与记忆页展示共用同一来源，不覆盖用户保存的经验。 */
export const EXPERIENCE_CONTENT_LIMIT = 5000;
export const countPromptCharacters = (text: string): number => Array.from(text).length;

export const DEFAULT_WRITING_EXPERIENCE = `先判断当篇意图：好物分享、晒成果/求夸、吐槽避坑、求助讨论、生活记录或主题投稿，按素材选择结构，不固定套优缺点清单。
保留价格、时间、数量、尺寸、场景、动机、过程与结果；只合并重复、调整顺序，不将具体经历泛化为空话。
不编造经历、产品性能、效果、情绪或他人反应。图片只补充明确可见的信息，不推断价格、材质、安装方式和实际体验；关键歧义需核实。
语气生活化，可以开心、吐槽、自嘲、小得意；用户原话中的“嘿嘿、谁懂、绝了、求夸夸”可自然保留，不机械添加或禁用。情绪跟随素材，不擅自拔高为血泪、封神。
标题选真实事件中的具体反差、问题或共鸣点，不夸大。未指定标题时尽量写18–20字，不超过20字，不为凑字添加空话。
短段落，必要时分点、适量emoji；篇幅随素材和当篇要求决定，不强制200–500字，不删除关键细节或凑长度。严格遵守“只讲某部分”的范围。
互动围绕真正想讨论的问题。求助帖保留未解决状态，不编造尝试、不自动改成教程；可以用结果、吐槽、求夸或具体问题收尾，不每篇强行提问、求赞收藏或升华。
家居好物类默认结尾加“我会持续分享家居好物”，其他题材不硬加；用户当篇要求或自定义经验可覆盖此默认偏好。话题与内容相关，不堆无关热词。
总结偏好以用户原始输入、明确要求和修改意见为依据；未经用户认可的AI文案不算用户偏好。区分长期经验、当篇要求、事实与推测，笔记主题不扩散为全局经验。
出稿前检查新增事实、遗漏细节、偏离意图、夸大情绪和规则冲突。`;

export const MOBILE_OUTPUT_RULES = `根据用户本次任务输出对应字段：仅标题时只输出一个标题，仅正文时只输出正文，整篇时第一行为标题、空一行后为正文。
输出可直接发布的纯文本，不添加Markdown标题、加粗、代码块、链接语法或“标题：”“正文：”字段前缀；话题标签可使用#。
不在正文重复标题，不混入“要不要我再帮你”等助手话术。
规则优先级：真实素材与事实边界始终保留；本次明确要求优先于已启用用户经验，用户经验优先于默认写作风格。当前字段输出格式必须遵守。`;


/** Returned by the running phone, never reconstructed from PC defaults. */
export function readMobileSystemRulesSnapshot(accountId: number) {
  return {
    origin: 'mobile' as const,
    accountId,
    source: 'mobile/services/writingRules.ts',
    version: '2026-10-03.1',
    readAt: new Date().toISOString(),
    editable: false as const,
    defaultExperience: DEFAULT_WRITING_EXPERIENCE,
    outputRules: MOBILE_OUTPUT_RULES,
  };
}
