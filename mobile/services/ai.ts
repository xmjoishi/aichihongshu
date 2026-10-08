/**
 * AI 服务层
 *
 * 支持的 Provider：
 *  - minimax   : MiniMax（M3 等多模态模型，图文）
 *  - deepseek  : DeepSeek（OpenAI 兼容接口，仅文本）
 *  - openai    : OpenAI 官方接口（gpt-4o 等，仅文本）
 *  - custom    : 用户自定义 OpenAI 兼容端点
 *
 * 图片分析与文本生成都走用户选定的默认 provider + model；
 * 带图时要求所选模型支持视觉（如 MiniMax-M3），否则回退同供应商视觉模型。
 */
import * as SecureStore from 'expo-secure-store';
import { fetch as streamingFetch } from 'expo/fetch';
import { DEFAULT_WRITING_EXPERIENCE, MOBILE_OUTPUT_RULES } from './writingRules';
import { sniffImageMimeFromBase64 } from './media';

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
      { id: 'MiniMax-M3', label: 'MiniMax M3', vision: true },
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

function resolveModelId(provider: ProviderDef, config: AiConfig, messages: ChatMessage[]): string {
  const wantsVision = messages.some((m) => (m.images?.length ?? 0) > 0);
  const current = provider.models.find((m) => m.id === config.modelId);
  // 优先用用户已选模型；仅当带图且所选模型不支持视觉时才回退到同供应商视觉模型
  if (!wantsVision || current?.vision) return config.modelId;
  const vision = provider.models.find((m) => m.vision);
  return vision?.id ?? config.modelId;
}

function getEndpoint(provider: ProviderDef, config: AiConfig): string {
  const base = config.providerId === 'custom' && config.customBaseUrl
    ? config.customBaseUrl.replace(/\/$/, '')
    : provider.baseUrl;
  return `${base}${provider.chatPath}`;
}

// ── 图片分析（走用户选定的多模态模型，如 MiniMax-M3）────────────────
export async function analyzeImage(base64: string): Promise<string> {
  const raw = base64.replace(/^data:image\/\w+;base64,/, '');
  const result = await chat(
    [
      {
        role: 'user',
        content:
          '请描述图片中明确可见的物品、颜色、布局和场景，用于后续创作小红书内容。不要推断材质、价格、安装方式、产品性能或使用体验；不确定的信息不要写成事实。50-100字。',
        images: [raw],
      },
    ],
    '你是家居软装领域的图片分析助手，只输出图片内容描述，不要寒暄或额外说明。'
  );
  const text = result.trim();
  if (!text) {
    throw new Error('图片分析返回为空，请在「设置 → AI 模型配置」检查模型是否支持识图（如 MiniMax-M3）后重试');
  }
  return text;
}

// ── 文本对话（走用户选定的 provider）────────────────────────────
export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  /** 仅 user 消息可带图；有图时走多模态 */
  images?: string[];
};

function buildChatContent(message: ChatMessage, format: 'anthropic' | 'openai' = 'openai') {
  const images = message.images?.filter(Boolean) ?? [];
  if (message.role !== 'user' || images.length === 0) return message.content;
  const blocks: any[] = images.map((base64) => {
    const raw = base64.replace(/^data:image\/[\w.+-]+;base64,/, '');
    // 按真实字节标注 MIME；HEIC 等已在 readBase64* 转成 JPEG
    const mime = sniffImageMimeFromBase64(raw) ?? 'image/jpeg';
    if (format === 'anthropic') {
      // Anthropic Messages API：image + source.base64
      return {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: mime, data: raw },
      };
    }
    return {
      type: 'image_url' as const,
      image_url: { url: `data:${mime};base64,${raw}` },
    };
  });
  blocks.push({ type: 'text' as const, text: message.content || '请根据图片内容创作小红书笔记。' });
  return blocks;
}

export async function chat(
  messages: ChatMessage[],
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
        model: resolveModelId(provider, config, messages),
        max_tokens: 2000,
        system: systemPrompt,
        messages: messages.map((message) => ({
          role: message.role,
          content: buildChatContent(message, 'anthropic'),
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
      model: resolveModelId(provider, config, messages),
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((message) => ({
          role: message.role,
          content: buildChatContent(message, 'openai'),
        })),
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI 对话失败: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

export async function chatStream(
  messages: ChatMessage[],
  systemPrompt: string,
  onDelta: (delta: string, fullText: string) => void,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const checkCancelled = () => {
    if (options.signal?.aborted) throw new Error('生成已取消');
  };
  const checkFinishReason = (reason: unknown) => {
    if (reason && !['stop', 'end_turn', 'stop_sequence'].includes(String(reason))) {
      throw new Error('AI 输出未完整结束，请重试；原稿已保留');
    }
  };
  checkCancelled();
  const config = await getAiConfig();
  const anthropic = config.providerId === 'minimax';
  const key = (await getApiKey(config.providerId)) ?? (anthropic ? await legacyMiniMaxKey() : null);
  const provider = getProvider(config.providerId);
  if (!key) throw new Error(`请先在 AI 模型设置中配置 ${provider.label} API Key`);
  checkCancelled();
  const res = await streamingFetch(getEndpoint(provider, config), {
    method: 'POST',
    signal: options.signal,
    headers: anthropic
      ? { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: resolveModelId(provider, config, messages),
      stream: true,
      ...(anthropic ? { max_tokens: 4000, system: systemPrompt } : {}),
      messages: [
        ...(!anthropic ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages.map((message) => ({
          role: message.role,
          content: buildChatContent(message, anthropic ? 'anthropic' : 'openai'),
        })),
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI 对话失败: ${await res.text()}`);
  // Some compatible providers ignore stream. Consume this response rather than issuing a second request.
  if (res.headers.get('content-type')?.includes('application/json')) {
    const data = await res.json();
    checkCancelled();
    if (data.error) throw new Error(data.error.message || 'AI 生成失败');
    checkFinishReason(anthropic ? data.stop_reason : data.choices?.[0]?.finish_reason);
    const full = anthropic
      ? (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('\n')
      : data.choices?.[0]?.message?.content ?? '';
    if (typeof full !== 'string' || !full.trim()) throw new Error('AI 未返回正文内容，请重试');
    onDelta(full, full);
    return full;
  }
  if (!res.body) throw new Error('当前模型未返回可读取的生成内容，请重试或更换模型');
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';
  let completed = false;
  const consumeLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') { completed = true; return; }
    let event: any;
    try { event = JSON.parse(payload); } catch { throw new Error('AI 返回了损坏的数据，请重试'); }
    if (event.error || event.type === 'error') throw new Error(event.error?.message || 'AI 流式生成失败');
    const finishReason = anthropic ? event.delta?.stop_reason : event.choices?.[0]?.finish_reason;
    checkFinishReason(finishReason);
    if (finishReason || event.type === 'message_stop') completed = true;
    const delta = anthropic
      ? (event.delta?.text ?? event.content_block?.text ?? '')
      : (event.choices?.[0]?.delta?.content ?? '');
    if (typeof delta === 'string' && delta) {
      fullText += delta;
      onDelta(delta, fullText);
    }
  };
  try {
    while (true) {
      checkCancelled();
      const { value, done } = await reader.read();
      checkCancelled();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
      if (done) { if (buffer) consumeLine(buffer); break; }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  checkCancelled();
  if (!completed) throw new Error('AI 连接中断，内容未完成，请重试；原稿已保留');
  if (!fullText.trim()) throw new Error('AI 未返回正文内容，请重试');
  return fullText.trim();
}

// ── System Prompt 组装 ──────────────────────────────────────────
export function buildSystemPrompt(profile: {
  personaName?: string | null;
  niche?: string | null;
  personaTone?: string | null;
  taboos?: string | null;
}, itemAnalyses: string[]): string {
  let tabooList = '';
  if (profile.taboos) {
    try {
      const parsed = JSON.parse(profile.taboos);
      tabooList = Array.isArray(parsed) ? parsed.join('、') : profile.taboos;
    } catch { tabooList = profile.taboos; }
  }
  return [
    `你是小红书内容创作助手。领域：${profile.niche || '按用户素材判断'}。人设名称：${profile.personaName || '博主'}。`,
    `账号语气偏好：${profile.personaTone || '真实、自然、具体'}。禁忌词：${tabooList || '无'}。`,
    `【默认写作经验】\n${DEFAULT_WRITING_EXPERIENCE}`,
    `【输出规则与优先级】\n${MOBILE_OUTPUT_RULES}`,
    ...(itemAnalyses.length ? [`【图片描述（辅助素材，不代表已确认的使用体验）】\n${itemAnalyses.map((a, i) => `图${i + 1}：${a}`).join('\n')}`] : []),
  ].join('\n\n');
}
