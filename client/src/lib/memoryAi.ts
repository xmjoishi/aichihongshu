import {
  probeLocalAIProviders,
  streamLocalAI,
  streamModelApi,
} from "./localAi";
import { readModelApiSettings } from "./modelApi";

function collect(): {
  push: (text: string) => void;
  text: () => string;
} {
  let value = "";
  return {
    push: (text: string) => {
      value += text;
    },
    text: () => value,
  };
}

/**
 * 一次性的记忆 AI 辅助调用（生成/润色）。
 * 优先本地 CLI，其次 Model API；没有可用接入时抛出可读错误。
 */
export function runMemoryAi(
  prompt: string,
  onChunk?: (text: string) => void,
): { promise: Promise<string>; abort: () => void } {
  const buffer = collect();
  let controller: AbortController | null = null;
  const promise = (async () => {
    const providers = await probeLocalAIProviders();
    const local = providers.find((p) => p.state === "present");
    const runId = `memory-ai-${Date.now()}`;
    if (local) {
      return await new Promise<string>((resolve, reject) => {
        controller = streamLocalAI(
          runId,
          local.id,
          prompt,
          (chunk) => {
            buffer.push(chunk);
            onChunk?.(chunk);
          },
          () => resolve(buffer.text().trim()),
          reject,
        );
      });
    }
    const settings = await readModelApiSettings();
    const configured = settings.providers.filter((p) => p.configured);
    const provider = configured.find((p) => p.id === settings.defaultProviderId) ?? configured[0];
    if (!provider) {
      throw new Error("未配置可用的 AI：请先在设置里配置 Model API 或安装本地 CLI");
    }
    return await new Promise<string>((resolve, reject) => {
      controller = streamModelApi(
        runId,
        provider.id,
        provider.model,
        prompt,
        (chunk) => {
          buffer.push(chunk);
          onChunk?.(chunk);
        },
        () => resolve(buffer.text().trim()),
        reject,
      );
    });
  })();
  return {
    promise,
    abort: () => controller?.abort(),
  };
}

export function polishMemoryPrompt(content: string, kindLabel: string): string {
  return [
    "你是记忆条目润色助手。把下面这段「记忆」改写得简洁、具体、可复用，去掉口语赘余和营销腔，不要扩写不存在的事实。",
    `类型：${kindLabel}`,
    `原文：${content.trim()}`,
    "只输出改写后的记忆正文，不要解释。",
  ].join("\n");
}

export function generateMemoryPrompt(brief: string, kindLabel: string): string {
  return [
    "你是记忆条目生成助手。根据要点写一条可长期复用的记忆，客观、具体，不编造未给出的事实。",
    `类型：${kindLabel}`,
    `要点：${brief.trim()}`,
    "只输出记忆正文，不要解释。",
  ].join("\n");
}
