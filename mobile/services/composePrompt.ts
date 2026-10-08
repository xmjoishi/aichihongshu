import { buildSystemPrompt, getAiConfig, PROVIDERS } from './ai';
import { buildMobileMemoryPrompt } from './memory';

export type ComposeProfile = Parameters<typeof buildSystemPrompt>[0];

export type ComposePromptSnapshot = {
  clientLabel: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  endpointLabel: string;
  personaPrompt: string;
  theme: string;
  experiencePrompt: string;
  systemPrompt: string;
  userPrompt: string;
  combinedPrompt: string;
};

/**
 * Shared prompt assembly for the editor's rules preview and generation request.
 * API keys are deliberately not read here.
 */
export async function buildComposePromptSnapshot(input: {
  profile: ComposeProfile | null | undefined;
  analyses?: string[];
  theme?: string;
  taskPrompt: string;
  hasImages?: boolean;
}): Promise<ComposePromptSnapshot> {
  const [memoryPrompt, config] = await Promise.all([
    buildMobileMemoryPrompt('compose'),
    getAiConfig(),
  ]);
  const provider = PROVIDERS.find((candidate) => candidate.id === config.providerId) ?? PROVIDERS[0];
  const selectedModel = provider.models.find((candidate) => candidate.id === config.modelId);
  const effectiveModel = input.hasImages && !selectedModel?.vision
    ? provider.models.find((candidate) => candidate.vision) ?? selectedModel
    : selectedModel;
  const systemBase = buildSystemPrompt(input.profile ?? {}, input.analyses ?? []);
  const systemPrompt = [systemBase, memoryPrompt].filter(Boolean).join('\n\n');
  const personaPrompt = systemBase.split('\n\n【默认写作经验】')[0];
  const theme = input.theme?.trim() ?? '';
  const themePrompt = theme
    ? `本篇主题与用户要求（所有重新生成都须保持）：\n${theme}\n\n`
    : '';
  const userPrompt = `${themePrompt}${input.taskPrompt}`;
  const baseUrl = config.providerId === 'custom' && config.customBaseUrl
    ? config.customBaseUrl
    : provider.baseUrl;

  return {
    clientLabel: '手机端',
    providerLabel: provider.label,
    modelId: effectiveModel?.id ?? config.modelId,
    modelLabel: effectiveModel?.label ?? config.modelId,
    endpointLabel: describeEndpointHost(baseUrl),
    personaPrompt,
    theme,
    experiencePrompt: memoryPrompt,
    systemPrompt,
    userPrompt,
    combinedPrompt: `【系统提示词】\n${systemPrompt}\n\n【用户提示词】\n${userPrompt}`,
  };
}

/** Exposes only the endpoint host; userinfo, URL paths, query values, and fragments stay hidden. */
function describeEndpointHost(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '自定义接口地址不可读取';
  }
}
