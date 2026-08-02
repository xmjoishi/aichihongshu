/**
 * AI 服务层
 *
 * 支持的 Provider：
 *  - minimax   : MiniMax（VL-01 图片分析 / M3 文本）
 *  - deepseek  : DeepSeek（OpenAI 兼容接口，仅文本）
 *  - openai    : OpenAI 官方接口（gpt-4o 等，仅文本）
 *  - custom    : 用户自定义 OpenAI 兼容端点
 *
 * 图片分析固定走 MiniMax VL-01（其他 provider 没有免费多模态）。
 * 文本生成走用户选定的默认 provider + model。
 */
import * as SecureStore from 'expo-secure-store';

// ── Provider / Model 目录 ────────────────────────────────────────
export type ProviderId = 'minimax' | 'deepseek' | 'openai' | 'custom';

export interface ModelDef {
  id: string;        // API model name
  label: string;     // 展示名
  vision: boolean;   // 支持图片
}

export interface ProviderDef {
  id: ProviderId;
  label: string;
  baseUrl: string;         // chat completions endpoint base
  chatPath: string;        // path after baseUrl
  models: ModelDef[];
  keyPlaceholder: string;
  keyHint: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    chatPath: '/v1/messages',
    keyPlaceholder: 'eyJ...',
    keyHint: '前往 Token Plan 获取订阅 Key',
    models: [
      { id: 'MiniMax-M3', label: 'MiniMax M3', vision: false },
      { id: 'MiniMax-VL-01', label: 'MiniMax VL-01（图文）', vision: true },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    chatPath: '/chat/completions',          // 官方路径，无 /v1 前缀
    keyPlaceholder: 'sk-...',
    keyHint: '前往 platform.deepseek.com 获取',
    models: [
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash（推荐）', vision: false },
      { id: 'deepseek-v4-pro',   label: 'DeepSeek V4 Pro（高质量）', vision: false },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    chatPath: '/v1/chat/completions',
    keyPlaceholder: 'sk-...',
    keyHint: '前往 platform.openai.com 获取',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini（快速经济）', vision: true },
      { id: 'gpt-4o',      label: 'GPT-4o（高质量）', vision: true },
    ],
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    chatPath: '/v1/chat/completions',
    keyPlaceholder: 'sk-...',
    keyHint: '填写你的 API Key',
    models: [
      { id: 'custom-model', label: 'custom-model', vision: false },
    ],
  },
];

// ── SecureStore keys ────────────────────────────────────────────
const KEY_PREFIX = 'ai_key_';
const KEY_CONFIG  = 'ai_config';

export interface AiConfig {
  providerId: ProviderId;
  modelId: string;
  customBaseUrl?: string; // 仅 custom provider 使用
}

const DEFAULT_CONFIG: AiConfig = {
  providerId: 'minimax',
  modelId: 'MiniMax-M3',
};

// ── Config 读写 ─────────────────────────────────────────────────
export async function getAiConfig(): Promise<AiConfig> {
  try {
    const raw = await SecureStore.getItemAsync(KEY_CONFIG);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_CONFIG;
}

export async function setAiConfig(config: AiConfig) {
  await SecureStore.setItemAsync(KEY_CONFIG, JSON.stringify(config));
}

// ── 每个 provider 的 API Key ────────────────────────────────────
export async function getApiKey(providerId?: ProviderId): Promise<string | null> {
  const id = providerId ?? (await getAiConfig()).providerId;
  return SecureStore.getItemAsync(`${KEY_PREFIX}${id}`);
}

export async function setApiKey(key: string, providerId?: ProviderId) {
  const id = providerId ?? (await getAiConfig()).providerId;
  await SecureStore.setItemAsync(`${KEY_PREFIX}${id}`, key);
}

export async function deleteApiKey(providerId?: ProviderId) {
  const id = providerId ?? (await getAiConfig()).providerId;
  await SecureStore.deleteItemAsync(`${KEY_PREFIX}${id}`);
}

// 向后兼容：旧 key 'minimax_api_key'
async function legacyMiniMaxKey(): Promise<string | null> {
  return SecureStore.getItemAsync('minimax_api_key');
}

// ── 内部：解析 provider 信息 ────────────────────────────────────
function getProvider(id: ProviderId): ProviderDef {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

function getEndpoint(provider: ProviderDef, config: AiConfig): string {
  const base = config.providerId === 'custom' && config.customBaseUrl
    ? config.customBaseUrl.replace(/\/$/, '')
    : provider.baseUrl;
  return `${base}${provider.chatPath}`;
}

// ── 图片分析（固定 MiniMax VL-01）────────────────────────────────
export async function analyzeImage(base64: string): Promise<string> {
  const key = (await getApiKey('minimax')) ?? (await legacyMiniMaxKey());
  if (!key) throw new Error('请先在设置中配置 MiniMax API Key（用于图片分析）');

  const endpoint = 'https://api.minimaxi.com/v1/text/chatcompletion_v2';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'MiniMax-VL-01',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: 'text', text: '请描述这张家居图片的内容，包括物品名称、颜色、风格、材质、使用场景等，用于后续创作小红书内容。50-100字。' },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`图片分析失败: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── 文本对话（走用户选定的 provider）────────────────────────────
export async function chat(
  messages: { role: 'user' | 'assistant'; content: string }[],
  systemPrompt: string
): Promise<string> {
  const config = await getAiConfig();
  const key = (await getApiKey(config.providerId))
    ?? (config.providerId === 'minimax' ? await legacyMiniMaxKey() : null);
  if (!key) throw new Error(`请先在 AI 模型设置中配置 ${getProvider(config.providerId).label} API Key`);

  const provider = getProvider(config.providerId);
  const endpoint = getEndpoint(provider, config);

  if (config.providerId === 'minimax') {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.modelId,
        max_tokens: 2000,
        system: systemPrompt,
        messages: messages.map((message) => ({
          role: message.role,
          content: [{ type: 'text', text: message.content }],
        })),
      }),
    });
    if (!res.ok) throw new Error(`AI 对话失败: ${await res.text()}`);
    const data = await res.json();
    const textBlocks = (data.content ?? []).filter((block: any) => block?.type === 'text');
    return textBlocks.map((block: any) => block.text ?? '').join('\n').trim();
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: config.modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI 对话失败: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

export async function chatStream(
  messages: { role: 'user' | 'assistant'; content: string }[],
  systemPrompt: string,
  onDelta: (delta: string, fullText: string) => void
): Promise<string> {
  const config = await getAiConfig();
  if (config.providerId !== 'minimax') {
    const full = await chat(messages, systemPrompt);
    if (full) onDelta(full, full);
    return full;
  }

  const key = (await getApiKey('minimax')) ?? (await legacyMiniMaxKey());
  if (!key) throw new Error('请先在 AI 模型设置中配置 MiniMax API Key');

  const endpoint = getEndpoint(getProvider('minimax'), config);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.modelId,
      max_tokens: 2000,
      stream: true,
      system: systemPrompt,
      messages: messages.map((message) => ({
        role: message.role,
        content: [{ type: 'text', text: message.content }],
      })),
    }),
  });

  if (!res.ok) throw new Error(`AI 对话失败: ${await res.text()}`);
  if (!res.body) {
    const fallback = await chat(messages, systemPrompt);
    if (fallback) onDelta(fallback, fallback);
    return fallback;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const event = JSON.parse(payload);
        const delta =
          event?.delta?.text
          ?? event?.delta?.partial_json
          ?? event?.content_block?.text
          ?? event?.content?.[0]?.text
          ?? '';

        if (delta) {
          fullText += delta;
          onDelta(delta, fullText);
        }
      } catch {
        // ignore malformed SSE chunks and keep reading
      }
    }
  }

  return fullText.trim();
}

// ── System Prompt 组装 ──────────────────────────────────────────
export function buildSystemPrompt(profile: {
  personaName?: string | null;
  niche?: string | null;
  personaTone?: string | null;
  taboos?: string | null;
}, itemAnalyses: string[]): string {
  const tabooList = profile.taboos ? JSON.parse(profile.taboos).join('、') : '';
  const analysisText = itemAnalyses.length
    ? `\n\n【图片内容】\n${itemAnalyses.map((a, i) => `图${i + 1}：${a}`).join('\n')}`
    : '';

  return `你是一个小红书内容创作助手，专注于${profile.niche ?? '家居软装'}垂类。
人设名称：${profile.personaName ?? '博主'}
内容语气：${profile.personaTone ?? '真实、接地气，短句换行，先痛点后解法'}
禁忌词：${tabooList || '无'}

请根据用户诉求，生成适合小红书发布的标题和正文。
标题：吸引眼球，包含数字或痛点，20字以内。
正文：分段清晰，使用emoji，加话题标签，200-500字。
${analysisText}`;
}
