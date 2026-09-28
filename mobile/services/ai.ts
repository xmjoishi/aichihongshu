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
          '请描述这张家居图片的内容，包括物品名称、颜色、风格、材质、使用场景等，用于后续创作小红书内容。50-100字。',
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

  const provider = getProvider('minimax');
  const endpoint = getEndpoint(provider, config);
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
      stream: true,
      system: systemPrompt,
      messages: messages.map((message) => ({
        role: message.role,
        content: buildChatContent(message, 'anthropic'),
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

请根据用户诉求，生成可直接发布到小红书的标题和正文（不是聊天回复）。

标题：吸引眼球，包含数字或痛点，20字以内。
正文：就是发布出去的文案本体，分段清晰，用 emoji，结尾加 5-8 个话题标签，200-500字。

硬性输出格式（小红书编辑器不识别 Markdown，必须纯文本）：
1. 禁止任何 Markdown 标记：**加粗**、# 标题、- 或 1. 列表、\`代码\`、> 引用、表格、[链接](url)、分隔线 ---
2. 禁止会话/元信息，不要出现：「谁懂啊」「今天给大家分享」「希望对你有帮助」「标题：」「正文：」「废话不多说」等任何解说或过场
3. 不要在正文里重复写一遍标题
4. 格式固定为两行块：
   第一行：标题本身
   空一行
   然后：正文内容（直接开始写要点/体验/避坑，不要开场白）
${analysisText}`;
}
