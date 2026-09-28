/**
 * 手机记忆池（origin=mobile）本地维护。
 * 手机只维护自己的记忆池；PC 记忆池不下发到手机。
 * 手机是唯一事实源；PC 在线修改也由手机落本地库后再同步更新 PC 缓存。
 */
import { initDb, sqlAll, sqlRun } from './db';
import {
  createPcHarnessClientFromConfig,
  getPcHarnessConfig,
  savePcHarnessConfig,
} from './pcHarness';

export type MemoryKind =
  | 'positioning'
  | 'expression'
  | 'fact'
  | 'event'
  | 'content_history';
export type MemoryConfirmStatus = 'candidate' | 'confirmed' | 'rejected' | 'outdated';
export type MemorySourceType = 'user' | 'ai_draft' | 'import' | 'sync';

export type MobileMemoryEntry = {
  id: number;
  remoteId: number | null;
  remoteServer: string;
  kind: MemoryKind;
  content: string;
  subject: string;
  source: string;
  sourceType: string;
  occurredAt: string | null;
  confirmStatus: MemoryConfirmStatus;
  validStatus: 'valid' | 'invalid';
  enabled: boolean;
  updatedAt: string;
};

export type MobileExperiencePrompt = {
  id: number;
  remoteId: number | null;
  remoteServer: string;
  title: string;
  content: string;
  enabled: boolean;
  applyScope: 'global' | 'account';
  applyTarget: 'all' | 'compose' | 'chat';
  sortOrder: number;
  updatedAt: string;
};

export type MemoryEntryInput = {
  kind: MemoryKind;
  content: string;
  subject?: string;
  source?: string;
  sourceType?: MemorySourceType;
  occurredAt?: string | null;
  confirmStatus?: 'candidate' | 'confirmed';
  enabled?: boolean;
};

export type ExperiencePromptInput = {
  title: string;
  content: string;
  enabled?: boolean;
  applyScope?: 'global' | 'account';
  applyTarget?: 'all' | 'compose' | 'chat';
  sortOrder?: number;
};

async function ready() {
  await initDb();
}

function mapEntry(row: any): MobileMemoryEntry {
  return {
    id: row.id,
    remoteId: row.remote_id ?? null,
    remoteServer: row.remote_server ?? '',
    kind: row.kind,
    content: row.content,
    subject: row.subject ?? '',
    source: row.source ?? '',
    sourceType: row.source_type ?? 'user',
    occurredAt: row.occurred_at ?? null,
    confirmStatus: row.confirm_status,
    validStatus: row.valid_status,
    enabled: row.enabled !== 0,
    updatedAt: row.updated_at,
  };
}

function mapPrompt(row: any): MobileExperiencePrompt {
  return {
    id: row.id,
    remoteId: row.remote_id ?? null,
    remoteServer: row.remote_server ?? '',
    title: row.title,
    content: row.content,
    enabled: row.enabled !== 0,
    applyScope: row.apply_scope === 'global' ? 'global' : 'account',
    applyTarget: row.apply_target === 'compose' || row.apply_target === 'chat' ? row.apply_target : 'all',
    sortOrder: row.sort_order ?? 0,
    updatedAt: row.updated_at,
  };
}

export async function listMemoryEntries(filter?: {
  confirmStatus?: MemoryConfirmStatus | 'all';
}): Promise<MobileMemoryEntry[]> {
  await ready();
  const sql =
    filter?.confirmStatus && filter.confirmStatus !== 'all'
      ? `SELECT * FROM memory_entries WHERE confirm_status = ? ORDER BY updated_at DESC, id DESC`
      : `SELECT * FROM memory_entries ORDER BY updated_at DESC, id DESC`;
  const rows =
    filter?.confirmStatus && filter.confirmStatus !== 'all'
      ? sqlAll(sql, [filter.confirmStatus])
      : sqlAll(sql);
  return rows.map(mapEntry);
}

export async function createMemoryEntry(input: MemoryEntryInput): Promise<MobileMemoryEntry> {
  await ready();
  const content = input.content.trim();
  if (!content) throw new Error('记忆内容不能为空');
  if (content.length > 1000) throw new Error('记忆内容最多 1000 字');
  const confirmStatus = input.confirmStatus ?? 'candidate';
  if (confirmStatus !== 'candidate' && confirmStatus !== 'confirmed') {
    throw new Error('新建记忆只能是候选或已确认');
  }
  sqlRun(
    `INSERT INTO memory_entries (kind, content, subject, source, source_type, occurred_at, confirm_status, valid_status, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'valid', ?)`,
    [
      input.kind,
      content,
      input.subject?.trim() ?? '',
      input.source?.trim() ?? '',
      input.sourceType ?? (input.source?.trim().startsWith('AI') ? 'ai_draft' : 'user'),
      input.occurredAt ?? null,
      confirmStatus,
      input.enabled === false ? 0 : 1,
    ],
  );
  const rows = sqlAll(`SELECT * FROM memory_entries ORDER BY id DESC LIMIT 1`);
  return mapEntry(rows[0]);
}

export async function updateMemoryEntry(
  id: number,
  input: MemoryEntryInput,
): Promise<MobileMemoryEntry> {
  await ready();
  const content = input.content.trim();
  if (!content) throw new Error('记忆内容不能为空');
  sqlRun(
    `UPDATE memory_entries SET kind = ?, content = ?, subject = ?, source = ?, source_type = COALESCE(?, source_type), occurred_at = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [
      input.kind,
      content,
      input.subject?.trim() ?? '',
      input.source?.trim() ?? '',
      input.sourceType ?? null,
      input.occurredAt ?? null,
      id,
    ],
  );
  const rows = sqlAll(`SELECT * FROM memory_entries WHERE id = ?`, [id]);
  if (!rows.length) throw new Error('记忆条目不存在');
  return mapEntry(rows[0]);
}

export async function deleteMemoryEntry(id: number): Promise<void> {
  await ready();
  const rows = sqlAll(`SELECT remote_id, remote_server FROM memory_entries WHERE id = ?`, [id]);
  if (!rows.length) throw new Error('记忆条目不存在');
  await queueRemoteDeletion('entry', rows[0].remote_id, rows[0].remote_server);
  const result = sqlRun(`DELETE FROM memory_entries WHERE id = ?`, [id]);
  if ((result.changes ?? 0) === 0) throw new Error('记忆条目不存在');
}

export async function setMemoryEntryEnabled(id: number, enabled: boolean): Promise<void> {
  await ready();
  const result = sqlRun(
    `UPDATE memory_entries SET enabled = ?, updated_at = datetime('now') WHERE id = ?`,
    [enabled ? 1 : 0, id],
  );
  if (result.changes === 0) throw new Error('记忆条目不存在');
}

export async function transitionMemoryEntryStatus(
  id: number,
  next: MemoryConfirmStatus,
): Promise<MobileMemoryEntry> {
  await ready();
  const rows = sqlAll(`SELECT * FROM memory_entries WHERE id = ?`, [id]);
  if (!rows.length) throw new Error('记忆条目不存在');
  const current = rows[0].confirm_status as MemoryConfirmStatus;
  const allowed =
    (current === 'candidate' && (next === 'confirmed' || next === 'rejected')) ||
    (current === 'confirmed' && next === 'outdated');
  if (!allowed) throw new Error(`不允许从 ${current} 迁移到 ${next}`);
  const validStatus = next === 'rejected' || next === 'outdated' ? 'invalid' : rows[0].valid_status;
  sqlRun(
    `UPDATE memory_entries SET confirm_status = ?, valid_status = ?, updated_at = datetime('now') WHERE id = ?`,
    [next, validStatus, id],
  );
  return mapEntry(sqlAll(`SELECT * FROM memory_entries WHERE id = ?`, [id])[0]);
}

export async function listExperiencePrompts(): Promise<MobileExperiencePrompt[]> {
  await ready();
  return sqlAll(`SELECT * FROM experience_prompts ORDER BY sort_order, id`).map(mapPrompt);
}

export async function upsertExperiencePrompt(
  input: ExperiencePromptInput & { id?: number | null },
): Promise<MobileExperiencePrompt> {
  await ready();
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title) throw new Error('标题不能为空');
  if (title.length > 40) throw new Error('标题最多 40 字');
  if (!content) throw new Error('内容不能为空');
  if (content.length > 300) throw new Error('内容最多 300 字');
  const enabled = input.enabled !== false ? 1 : 0;
  if (enabled) {
    const rows = sqlAll(
      input.id
        ? `SELECT COUNT(*) AS c FROM experience_prompts WHERE enabled = 1 AND id != ?`
        : `SELECT COUNT(*) AS c FROM experience_prompts WHERE enabled = 1`,
      input.id ? [input.id] : [],
    );
    if ((rows[0]?.c ?? 0) >= 10) throw new Error('启用中的经验提示词最多 10 条');
  }
  if (input.id) {
    sqlRun(
      `UPDATE experience_prompts SET title = ?, content = ?, enabled = ?, apply_scope = ?, apply_target = ?, sort_order = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        title,
        content,
        enabled,
        input.applyScope ?? 'account',
        input.applyTarget ?? 'all',
        input.sortOrder ?? 0,
        input.id,
      ],
    );
    return mapPrompt(sqlAll(`SELECT * FROM experience_prompts WHERE id = ?`, [input.id])[0]);
  }
  sqlRun(
    `INSERT INTO experience_prompts (title, content, enabled, apply_scope, apply_target, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      title,
      content,
      enabled,
      input.applyScope ?? 'account',
      input.applyTarget ?? 'all',
      input.sortOrder ?? 0,
    ],
  );
  return mapPrompt(sqlAll(`SELECT * FROM experience_prompts ORDER BY id DESC LIMIT 1`)[0]);
}

export async function deleteExperiencePrompt(id: number): Promise<void> {
  await ready();
  const rows = sqlAll(`SELECT remote_id, remote_server FROM experience_prompts WHERE id = ?`, [id]);
  if (!rows.length) throw new Error('经验提示词不存在');
  await queueRemoteDeletion('prompt', rows[0].remote_id, rows[0].remote_server);
  const result = sqlRun(`DELETE FROM experience_prompts WHERE id = ?`, [id]);
  if ((result.changes ?? 0) === 0) throw new Error('经验提示词不存在');
}

/** 构造场景化记忆块（仅已确认、有效、启用条目及适用该场景的提示词）。 */
export async function buildMobileMemoryPrompt(target: 'compose' | 'chat'): Promise<string> {
  const prompts = (await listExperiencePrompts())
    .filter((p) => p.enabled && (p.applyTarget === 'all' || p.applyTarget === target))
    .slice(0, 10);
  const entries = (await listMemoryEntries()).filter(
    (e) => e.enabled && e.confirmStatus === 'confirmed' && e.validStatus === 'valid',
  ).slice(0, 20);
  if (!prompts.length && !entries.length) return '';
  const lines = ['## 有效记忆与经验提示词（遵守，不要照抄原文）'];
  for (const prompt of prompts) {
    lines.push(`- [${prompt.title}] ${prompt.content}`);
  }
  for (const entry of entries) {
    lines.push(`- ${entry.subject ? `（${entry.subject}）` : ''}${entry.content}`);
  }
  return lines.join('\n');
}

export type MemorySyncResult = {
  pushedEntries: number;
  pushedPrompts: number;
  deletedEntries: number;
  deletedPrompts: number;
};

let memorySyncQueue: Promise<void> = Promise.resolve();

/** 单向镜像手机池到 PC 缓存；同步任务串行，避免 tombstone 与快照交叉。 */
export function syncMemoryWithPc(): Promise<MemorySyncResult> {
  const sync = memorySyncQueue.then(performMemorySyncWithPc);
  memorySyncQueue = sync.then(() => undefined, () => undefined);
  return sync;
}

async function performMemorySyncWithPc(): Promise<MemorySyncResult> {
  const config = await getPcHarnessConfig();
  if (!config) throw new Error('尚未配置 PC Harness，请先在「PC Harness」里连接');
  const client = createPcHarnessClientFromConfig(config);
  const serverUrl = config.baseUrl;
  const health = await client.health();
  if (health.accountId == null) throw new Error('PC Harness 当前没有可同步的账号');
  if (config.accountId != null && health.accountId !== config.accountId) {
    throw new Error('PC 当前账号与手机配对账号不一致，请切换到配对账号后再同步');
  }
  if (config.accountId == null) {
    await savePcHarnessConfig({ ...config, accountId: health.accountId });
  }
  const entries = await listMemoryEntries();
  const prompts = await listExperiencePrompts();
  let pushedEntries = 0;
  let pushedPrompts = 0;
  let deletedEntries = 0;
  let deletedPrompts = 0;
  const currentRemoteEntryIds = new Set<number>();
  const currentRemotePromptIds = new Set<number>();

  // 配对目标变化时不把旧 PC 的远端 id 用在新 PC，并保留旧缓存删除记录。
  for (const entry of entries) {
    if (entry.remoteId && entry.remoteServer && entry.remoteServer !== serverUrl) {
      await enqueueDeletion('entry', entry.remoteId, entry.remoteServer);
      await clearEntryRemoteId(entry.id);
      entry.remoteId = null;
      entry.remoteServer = '';
    }
  }
  for (const prompt of prompts) {
    if (prompt.remoteId && prompt.remoteServer && prompt.remoteServer !== serverUrl) {
      await enqueueDeletion('prompt', prompt.remoteId, prompt.remoteServer);
      await clearPromptRemoteId(prompt.id);
      prompt.remoteId = null;
      prompt.remoteServer = '';
    }
  }

  // 离线期间在手机删除的项目，以 tombstone 清理对应 PC 缓存；失败则保留重试。
  const deletions = sqlAll<{ id: number; server_url: string; entity_type: 'entry' | 'prompt'; remote_id: number }>(
    `SELECT id, server_url, entity_type, remote_id FROM memory_sync_deletions WHERE server_url = ? ORDER BY id`,
    [serverUrl],
  );
  for (const deletion of deletions) {
    if (deletion.entity_type === 'entry') {
      await client.deleteMobileMemoryEntry(deletion.remote_id);
      deletedEntries += 1;
    } else {
      await client.deleteMobileExperiencePrompt(deletion.remote_id);
      deletedPrompts += 1;
    }
    await ready();
    sqlRun(`DELETE FROM memory_sync_deletions WHERE id = ?`, [deletion.id]);
  }

  for (const entry of entries) {
    const body = {
      kind: entry.kind,
      content: entry.content,
      subject: entry.subject,
      source: entry.source,
      sourceType: entry.sourceType,
      occurredAt: entry.occurredAt,
      confirmStatus: entry.confirmStatus,
      validStatus: entry.validStatus,
      enabled: entry.enabled,
    };
    const remote = entry.remoteId
      ? await pushWithRecovery(
          () => client.updateMobileMemoryEntry(entry.remoteId!, body),
          () => client.createMobileMemoryEntry(body),
        )
      : await client.createMobileMemoryEntry(body);
    await setEntryRemoteId(entry.id, remote.id, serverUrl);
    currentRemoteEntryIds.add(remote.id);
    pushedEntries += 1;
  }
  for (const prompt of prompts) {
    const body = {
      title: prompt.title,
      content: prompt.content,
      enabled: prompt.enabled,
      applyScope: prompt.applyScope,
      applyTarget: prompt.applyTarget,
      sortOrder: prompt.sortOrder,
    };
    const remote = prompt.remoteId
      ? await pushWithRecovery(
          () => client.updateMobileExperiencePrompt(prompt.remoteId!, body),
          () => client.createMobileExperiencePrompt(body),
        )
      : await client.createMobileExperiencePrompt(body);
    await setPromptRemoteId(prompt.id, remote.id, serverUrl);
    currentRemotePromptIds.add(remote.id);
    pushedPrompts += 1;
  }

  // 本手机是该 PC 账号手机池的唯一来源。成功推送完整本地快照后，要求
  // PC 清除快照中没有的旧缓存；只上送保留 ID，不从 PC 拉取任何记忆内容。
  const reconciled = await client.reconcileMobileMemoryCache({
    entryIds: [...currentRemoteEntryIds],
    promptIds: [...currentRemotePromptIds],
  });
  deletedEntries += reconciled.deletedEntries;
  deletedPrompts += reconciled.deletedPrompts;

  return { pushedEntries, pushedPrompts, deletedEntries, deletedPrompts };
}

async function pushWithRecovery<T>(update: () => Promise<T>, create: () => Promise<T>): Promise<T> {
  try {
    return await update();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/不存在|不属于当前账号/.test(message)) throw error;
    return create();
  }
}

async function setEntryRemoteId(localId: number, remoteId: number, serverUrl: string) {
  await ready();
  sqlRun(`UPDATE memory_entries SET remote_id = ?, remote_server = ? WHERE id = ?`, [remoteId, serverUrl, localId]);
}

async function setPromptRemoteId(localId: number, remoteId: number, serverUrl: string) {
  await ready();
  sqlRun(`UPDATE experience_prompts SET remote_id = ?, remote_server = ? WHERE id = ?`, [remoteId, serverUrl, localId]);
}

async function clearEntryRemoteId(localId: number) {
  await ready();
  sqlRun(`UPDATE memory_entries SET remote_id = NULL, remote_server = '' WHERE id = ?`, [localId]);
}

async function clearPromptRemoteId(localId: number) {
  await ready();
  sqlRun(`UPDATE experience_prompts SET remote_id = NULL, remote_server = '' WHERE id = ?`, [localId]);
}

async function queueRemoteDeletion(entity: 'entry' | 'prompt', remoteId: number | null, remoteServer: string) {
  if (remoteId == null) return;
  const config = await getPcHarnessConfig();
  const serverUrl = remoteServer || config?.baseUrl || '';
  if (!serverUrl) return;
  await enqueueDeletion(entity, remoteId, serverUrl);
}

async function enqueueDeletion(entity: 'entry' | 'prompt', remoteId: number, serverUrl: string) {
  await ready();
  sqlRun(
    `INSERT OR IGNORE INTO memory_sync_deletions (server_url, entity_type, remote_id) VALUES (?, ?, ?)`,
    [serverUrl, entity, remoteId],
  );
}
