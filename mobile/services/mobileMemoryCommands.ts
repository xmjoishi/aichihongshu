import { DeviceEventEmitter } from 'react-native';
import {
  createMemoryEntry,
  deleteExperiencePrompt,
  deleteMemoryEntry,
  listExperiencePrompts,
  listMemoryEntries,
  setMemoryEntryEnabled,
  syncMemoryWithPc,
  updateMemoryEntry,
  upsertExperiencePrompt,
  type ExperiencePromptInput,
  type MemoryEntryInput,
  type MobileExperiencePrompt,
  type MobileMemoryEntry,
} from './memory';
import {
  createPcHarnessClientFromConfig,
  getPcHarnessConfig,
  savePcHarnessConfig,
  type PcHarnessMemoryCommand,
  type PcHarnessMemoryCommandResult,
  type PcHarnessConfig,
} from './pcHarness';

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式无效`);
  }
  return value as RecordValue;
}

function numberValue(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label}无效`);
  return result;
}

function sameEntrySnapshot(actual: MobileMemoryEntry, value: unknown): boolean {
  const expected = asRecord(value, '手机缓存版本');
  return actual.kind === expected.kind
    && actual.content === expected.content
    && actual.subject === (expected.subject ?? '')
    && actual.source === (expected.source ?? '')
    && actual.sourceType === expected.sourceType
    && actual.occurredAt === (expected.occurredAt ?? null)
    && actual.confirmStatus === expected.confirmStatus
    && actual.validStatus === expected.validStatus
    && actual.enabled === expected.enabled;
}

function samePromptSnapshot(actual: MobileExperiencePrompt, value: unknown): boolean {
  const expected = asRecord(value, '手机缓存版本');
  return actual.title === expected.title
    && actual.content === expected.content
    && actual.enabled === expected.enabled
    && actual.applyScope === expected.applyScope
    && actual.applyTarget === expected.applyTarget
    && actual.sortOrder === expected.sortOrder;
}

async function rejectStalePcView(entity: string): Promise<never> {
  try {
    await syncMemoryWithPc();
  } catch {
    // The phone remains the source of truth even if the cache refresh fails.
  }
  throw new Error(`手机${entity}已在本地变化。PC 缓存已尝试刷新，请重新检查后再操作`);
}

async function findEntry(config: PcHarnessConfig, remoteId: number): Promise<MobileMemoryEntry> {
  const entry = (await listMemoryEntries()).find(
    (item) => item.remoteId === remoteId && item.remoteServer === config.baseUrl,
  );
  if (!entry) throw new Error('手机本地找不到该记忆，先在手机端同步后再试');
  return entry;
}

async function findPrompt(config: PcHarnessConfig, remoteId: number): Promise<MobileExperiencePrompt> {
  const prompt = (await listExperiencePrompts()).find(
    (item) => item.remoteId === remoteId && item.remoteServer === config.baseUrl,
  );
  if (!prompt) throw new Error('手机本地找不到该经验提示词，先在手机端同步后再试');
  return prompt;
}

async function applyCommand(command: PcHarnessMemoryCommand, config: PcHarnessConfig): Promise<number | null> {
  const payload = asRecord(command.payload, '手机记忆命令');
  let addedExampleCount: number | null = null;
  switch (command.operation) {
    case 'createEntry': {
      const input = asRecord(payload.entry, '记忆') as unknown as MemoryEntryInput;
      await createMemoryEntry(input);
      break;
    }
    case 'updateEntry': {
      const remoteId = numberValue(payload.remoteId, '记忆 id');
      const entry = await findEntry(config, remoteId);
      if (!sameEntrySnapshot(entry, payload.expected)) {
        await rejectStalePcView('记忆');
      }
      const input = asRecord(payload.entry, '记忆') as unknown as MemoryEntryInput;
      await updateMemoryEntry(entry.id, input);
      break;
    }
    case 'setEntryEnabled': {
      const remoteId = numberValue(payload.remoteId, '记忆 id');
      const entry = await findEntry(config, remoteId);
      if (!sameEntrySnapshot(entry, payload.expected)) {
        await rejectStalePcView('记忆');
      }
      if (typeof payload.enabled !== 'boolean') throw new Error('启用状态无效');
      await setMemoryEntryEnabled(entry.id, payload.enabled);
      break;
    }
    case 'deleteEntry': {
      const remoteId = numberValue(payload.remoteId, '记忆 id');
      const entry = await findEntry(config, remoteId);
      if (!sameEntrySnapshot(entry, payload.expected)) {
        await rejectStalePcView('记忆');
      }
      await deleteMemoryEntry(entry.id);
      break;
    }
    case 'createPrompt': {
      const input = asRecord(payload.prompt, '经验提示词') as unknown as ExperiencePromptInput;
      await upsertExperiencePrompt(input);
      break;
    }
    case 'updatePrompt': {
      const remoteId = numberValue(payload.remoteId, '经验提示词 id');
      const prompt = await findPrompt(config, remoteId);
      if (!samePromptSnapshot(prompt, payload.expected)) {
        await rejectStalePcView('经验提示词');
      }
      const input = asRecord(payload.prompt, '经验提示词') as unknown as ExperiencePromptInput;
      await upsertExperiencePrompt({ ...input, id: prompt.id });
      break;
    }
    case 'setPromptEnabled': {
      const remoteId = numberValue(payload.remoteId, '经验提示词 id');
      const prompt = await findPrompt(config, remoteId);
      if (!samePromptSnapshot(prompt, payload.expected)) {
        await rejectStalePcView('经验提示词');
      }
      if (typeof payload.enabled !== 'boolean') throw new Error('启用状态无效');
      await upsertExperiencePrompt({ ...prompt, id: prompt.id, enabled: payload.enabled });
      break;
    }
    case 'deletePrompt': {
      const remoteId = numberValue(payload.remoteId, '经验提示词 id');
      const prompt = await findPrompt(config, remoteId);
      if (!samePromptSnapshot(prompt, payload.expected)) {
        await rejectStalePcView('经验提示词');
      }
      await deleteExperiencePrompt(prompt.id);
      break;
    }
    case 'seedExamples': {
      if (payload.section === 'prompts') {
        if (!Array.isArray(payload.prompts) || payload.prompts.length === 0 || payload.prompts.length > 10) {
          throw new Error('经验提示词示例格式无效');
        }
        const prompts = payload.prompts.map((value) => {
          const item = asRecord(value, '经验提示词示例');
          if (typeof item.title !== 'string' || typeof item.content !== 'string') {
            throw new Error('经验提示词示例格式无效');
          }
          if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
            throw new Error('经验提示词启用状态无效');
          }
          if (item.applyScope !== undefined && item.applyScope !== 'global' && item.applyScope !== 'account') {
            throw new Error('经验提示词适用范围无效');
          }
          if (item.applyTarget !== undefined && !['all', 'compose', 'chat'].includes(String(item.applyTarget))) {
            throw new Error('经验提示词适用场景无效');
          }
          if (item.sortOrder !== undefined && (!Number.isSafeInteger(item.sortOrder) || Number(item.sortOrder) < 0)) {
            throw new Error('经验提示词排序无效');
          }
          return {
            title: item.title,
            content: item.content,
            enabled: item.enabled as boolean | undefined,
            applyScope: item.applyScope as ExperiencePromptInput['applyScope'],
            applyTarget: item.applyTarget as ExperiencePromptInput['applyTarget'],
            sortOrder: item.sortOrder as number | undefined,
          } satisfies ExperiencePromptInput;
        });
        const existing = await listExperiencePrompts();
        const missing = prompts.filter((sample) => !existing.some(
          (item) => item.title === sample.title && item.content === sample.content
            && item.applyScope === (sample.applyScope ?? 'account')
            && item.applyTarget === (sample.applyTarget ?? 'all'),
        ));
        let enabledSlots = Math.max(0, 10 - existing.filter((item) => item.enabled).length);
        for (const prompt of missing) {
          const enabled = prompt.enabled !== false && enabledSlots > 0;
          if (enabled) enabledSlots -= 1;
          await upsertExperiencePrompt({ ...prompt, enabled });
        }
        addedExampleCount = missing.length;
        break;
      }
      if (payload.section === 'entries') {
        if (!Array.isArray(payload.entries) || payload.entries.length === 0 || payload.entries.length > 20) {
          throw new Error('记忆示例格式无效');
        }
        const entries = payload.entries.map((value) => {
          const item = asRecord(value, '记忆示例');
          if (typeof item.content !== 'string' || !['positioning', 'expression', 'fact', 'event', 'content_history'].includes(String(item.kind))) {
            throw new Error('记忆示例格式无效');
          }
          if (item.subject !== undefined && typeof item.subject !== 'string') throw new Error('记忆主体格式无效');
          if (item.source !== undefined && typeof item.source !== 'string') throw new Error('记忆来源格式无效');
          if (item.sourceType !== undefined && !['user', 'ai_draft', 'import', 'sync'].includes(String(item.sourceType))) {
            throw new Error('记忆来源类型无效');
          }
          if (item.occurredAt !== undefined && item.occurredAt !== null && typeof item.occurredAt !== 'string') {
            throw new Error('记忆发生时间格式无效');
          }
          if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error('记忆启用状态无效');
          return {
            kind: item.kind as MemoryEntryInput['kind'],
            content: item.content,
            subject: item.subject as string | undefined,
            source: item.source as string | undefined,
            sourceType: item.sourceType as MemoryEntryInput['sourceType'],
            occurredAt: item.occurredAt as string | null | undefined,
            enabled: item.enabled as boolean | undefined,
          } satisfies MemoryEntryInput;
        });
        const existing = await listMemoryEntries();
        const missing = entries.filter((sample) => !existing.some(
          (item) => item.kind === sample.kind && item.content === sample.content
            && item.subject === (sample.subject ?? ''),
        ));
        for (const entry of missing) await createMemoryEntry(entry);
        addedExampleCount = missing.length;
        break;
      }
      throw new Error('示例分区无效');
    }
    default:
      throw new Error('手机端不支持此记忆操作');
  }
  return addedExampleCount;
}

async function resolveConfig(): Promise<PcHarnessConfig | null> {
  let config = await getPcHarnessConfig();
  if (!config) return null;
  if (config.accountId == null) {
    const health = await createPcHarnessClientFromConfig(config).health();
    if (health.accountId == null) return null;
    config = await savePcHarnessConfig({ ...config, accountId: health.accountId });
  }
  return config;
}

/** Poll once while the app is foregrounded; the phone applies and persists the command. */
export async function processNextPcMemoryCommand(): Promise<void> {
  const config = await resolveConfig();
  if (!config || config.accountId == null) return;
  const client = createPcHarnessClientFromConfig(config);
  const { command } = await client.nextMobileMemoryCommand(config.accountId);
  if (!command) return;

  let result: PcHarnessMemoryCommandResult;
  if (command.accountId !== config.accountId) {
    result = { success: false, cacheSynced: false, message: '配对账号与命令账号不一致' };
  } else {
    try {
      const addedExampleCount = await applyCommand(command, config);
      DeviceEventEmitter.emit('mobile-memory-changed');
      try {
        await syncMemoryWithPc();
        result = {
          success: true,
          cacheSynced: true,
          ...(addedExampleCount === null
            ? {}
            : { message: addedExampleCount > 0 ? `已添加 ${addedExampleCount} 条示例` : '手机已包含全部示例' }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = {
          success: true,
          cacheSynced: false,
          message: `手机已保存，但 PC 缓存同步失败：${message}`,
        };
      }
    } catch (error) {
      result = {
        success: false,
        cacheSynced: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  await client.completeMobileMemoryCommand(command.id, config.accountId, result);
}
