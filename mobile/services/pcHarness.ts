/**
 * PC Harness companion contract.
 *
 * The desktop side is the source of truth for tasks, assets and notes.
 * Mobile memory is owned by the phone; the PC may issue foreground write-
 * through commands, and the phone persists them before refreshing its cache.
 * Every request carries a pairing token; this module does not start a listener
 * or expose an unauthenticated local service.
 *
 * Task creation uses JSON + base64 photos (not multipart) so React Native and
 * the PC Harness HTTP service share one explicit contract.
 */
import * as SecureStore from 'expo-secure-store';

const CONFIG_KEY = 'pc_harness_connection_v1';
const API_PREFIX = '/api/mobile/v1';

export type PcHarnessConfig = {
  baseUrl: string;
  pairingToken: string;
  deviceName?: string;
  accountId?: number;
};

export type PcHarnessHealth = {
  ok: boolean;
  service: 'pc-harness';
  protocolVersion: string;
  accountId?: number;
};

export type PcHarnessMemoryCommand = {
  id: string;
  accountId: number;
  operation: string;
  payload: unknown;
};

export type PcHarnessMemoryCommandResult = {
  success: boolean;
  cacheSynced: boolean;
  message?: string;
};

export type CompanionTaskStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled';

export type CompanionTask = {
  taskId: string;
  status: CompanionTaskStatus;
  accountId?: number;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
  clientTaskId?: string;
  topic?: string;
  noteId?: number;
  itemIds?: number[];
  publishStatus?: string;
  publishNoteUrl?: string;
  publishMessage?: string;
};

export type CompanionPhoto = {
  uri: string;
  filename?: string;
  mimeType?: string;
};

export type CreateCompanionTaskInput = {
  photos: CompanionPhoto[];
  topic?: string;
  accountId?: number;
  clientTaskId?: string;
};

export type CreateCompanionTaskBody = {
  topic?: string;
  accountId?: number;
  clientTaskId?: string;
  photos: Array<{
    filename: string;
    mimeType: string;
    dataBase64: string;
  }>;
};

export type CompanionDraft = {
  taskId: string;
  noteId?: number;
  title: string;
  body: string;
  tags: string[];
  itemIds?: number[];
  version?: number;
  source?: 'pc-harness';
};

export type PublishReceipt = {
  status: 'prepared' | 'submitted' | 'confirmed' | 'unknown' | 'failed';
  noteUrl?: string;
  message?: string;
  occurredAt?: string;
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

async function blobToBase64(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取照片失败'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function assertConfig(config: PcHarnessConfig): PcHarnessConfig {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error('PC Harness 地址必须以 http:// 或 https:// 开头');
  }
  if (!config.pairingToken.trim()) {
    throw new Error('请填写 PC Harness 配对令牌');
  }
  return { ...config, baseUrl, pairingToken: config.pairingToken.trim() };
}

function isPrivateIpv4Address(hostname: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split('.').map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
}

/** Parse a PC-generated QR pairing code and reject public or malformed destinations. */
export function parsePcHarnessPairingCode(raw: string): PcHarnessConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('这不是有效的 PC Harness 配对码');
  }
  if (!value || typeof value !== 'object') throw new Error('这不是有效的 PC Harness 配对码');

  const payload = value as Record<string, unknown>;
  if (
    payload.type !== 'aichihongshu-pc-harness'
    || payload.version !== 1
    || typeof payload.protocolVersion !== 'string'
    || payload.protocolVersion !== '1'
    || typeof payload.baseUrl !== 'string'
    || typeof payload.pairingToken !== 'string'
  ) {
    throw new Error('配对码不受支持，请更新 PC 与手机应用后重试');
  }

  const config = assertConfig({ baseUrl: payload.baseUrl, pairingToken: payload.pairingToken });
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error('配对码里的 PC 地址无效');
  }
  const hostname = url.hostname.toLowerCase();
  const isLocalName = hostname.endsWith('.local');
  if (
    !['http:', 'https:'].includes(url.protocol)
    || !url.port
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
    || (!isLocalName && !isPrivateIpv4Address(hostname))
  ) {
    throw new Error('配对码必须指向局域网或本地域名地址');
  }
  if (!/^[a-f\d]{48,128}$/i.test(config.pairingToken)) {
    throw new Error('配对码中的令牌格式无效');
  }
  return config;
}

export async function getPcHarnessConfig(): Promise<PcHarnessConfig | null> {
  try {
    const raw = await SecureStore.getItemAsync(CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PcHarnessConfig>;
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.pairingToken !== 'string') return null;
    return assertConfig({
      baseUrl: parsed.baseUrl,
      pairingToken: parsed.pairingToken,
      ...(typeof parsed.deviceName === 'string' ? { deviceName: parsed.deviceName } : {}),
      ...(typeof parsed.accountId === 'number' ? { accountId: parsed.accountId } : {}),
    });
  } catch {
    return null;
  }
}

export async function savePcHarnessConfig(config: PcHarnessConfig): Promise<PcHarnessConfig> {
  const normalized = assertConfig(config);
  const previous = await getPcHarnessConfig();
  if (
    previous &&
    (previous.baseUrl !== normalized.baseUrl || previous.pairingToken !== normalized.pairingToken)
  ) {
    delete normalized.accountId;
  }
  await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function clearPcHarnessConfig(): Promise<void> {
  await SecureStore.deleteItemAsync(CONFIG_KEY);
}

function makeClient(config: PcHarnessConfig) {
  const safeConfig = assertConfig(config);

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${safeConfig.pairingToken}`);
    const response = await fetch(`${safeConfig.baseUrl}${path}`, { ...init, headers });
    const raw = await response.text();
    let payload: unknown = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = raw;
    }
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'message' in payload
          ? String((payload as { message?: unknown }).message)
          : `PC Harness 请求失败（${response.status}）`;
      throw new Error(message);
    }
    return payload as T;
  }

  return {
    health: () => request<PcHarnessHealth>(`${API_PREFIX}/health`),

    reconcileMobileMemoryCache: (snapshot: { entryIds: number[]; promptIds: number[] }) =>
      request<{ deletedEntries: number; deletedPrompts: number }>(`${API_PREFIX}/memory/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      }),

    nextMobileMemoryCommand: (accountId: number) =>
      request<{ command: PcHarnessMemoryCommand | null }>(`${API_PREFIX}/memory/commands/next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      }),

    completeMobileMemoryCommand: (
      commandId: string,
      accountId: number,
      result: PcHarnessMemoryCommandResult,
    ) =>
      request<{ accepted: boolean }>(
        `${API_PREFIX}/memory/commands/${encodeURIComponent(commandId)}/result`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId, ...result }),
        },
      ),

    async createTask(input: CreateCompanionTaskInput): Promise<CompanionTask> {
      if (!input.photos.length && !input.topic?.trim()) {
        throw new Error('至少提供一张照片或一段主题文字');
      }
      const photos = await Promise.all(
        input.photos.map(async (photo, index) => {
          const response = await fetch(photo.uri);
          const blob = await response.blob();
          const dataBase64 = await blobToBase64(blob);
          return {
            filename: photo.filename ?? `photo-${index + 1}.jpg`,
            mimeType: photo.mimeType ?? 'image/jpeg',
            dataBase64,
          };
        }),
      );
      const body: CreateCompanionTaskBody = {
        photos,
        ...(input.topic?.trim() ? { topic: input.topic.trim() } : {}),
        ...(input.accountId != null ? { accountId: input.accountId } : {}),
        ...(input.clientTaskId ? { clientTaskId: input.clientTaskId } : {}),
      };
      return request<CompanionTask>(`${API_PREFIX}/companion/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },

    getTask: (taskId: string) =>
      request<CompanionTask>(`${API_PREFIX}/companion/tasks/${encodeURIComponent(taskId)}`),

    createMobileMemoryEntry: (body: {
      kind: string;
      content: string;
      subject?: string;
      source?: string;
      sourceType?: string;
      occurredAt?: string | null;
      confirmStatus?: string;
      validStatus?: string;
      enabled?: boolean;
    }) =>
      request<{ id: number }>(`${API_PREFIX}/memory/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, origin: 'mobile' }),
      }),

    updateMobileMemoryEntry: (
      id: number,
      body: {
        kind: string;
        content: string;
        subject?: string;
        source?: string;
        sourceType?: string;
        occurredAt?: string | null;
        confirmStatus?: string;
        validStatus?: string;
        enabled?: boolean;
      },
    ) =>
      request<{ id: number }>(`${API_PREFIX}/memory/entries/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, origin: 'mobile' }),
      }),

    createMobileExperiencePrompt: (body: {
      title: string;
      content: string;
      enabled?: boolean;
      applyScope?: string;
      applyTarget?: string;
      sortOrder?: number;
    }) =>
      request<{ id: number }>(`${API_PREFIX}/memory/prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, origin: 'mobile' }),
      }),

    updateMobileExperiencePrompt: (
      id: number,
      body: {
        title: string;
        content: string;
        enabled?: boolean;
        applyScope?: string;
        applyTarget?: string;
        sortOrder?: number;
      },
    ) =>
      request<{ id: number }>(`${API_PREFIX}/memory/prompts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, origin: 'mobile' }),
      }),

    deleteMobileMemoryEntry: (id: number) =>
      request<{ deleted: boolean }>(`${API_PREFIX}/memory/entries/${id}`, { method: 'DELETE' }),

    deleteMobileExperiencePrompt: (id: number) =>
      request<{ deleted: boolean }>(`${API_PREFIX}/memory/prompts/${id}`, { method: 'DELETE' }),

    getDraft: (taskId: string) =>
      request<CompanionDraft>(`${API_PREFIX}/companion/tasks/${encodeURIComponent(taskId)}/draft`),

    recordPublishReceipt: (taskId: string, receipt: PublishReceipt) =>
      request<CompanionTask>(
        `${API_PREFIX}/companion/tasks/${encodeURIComponent(taskId)}/publish-receipt`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(receipt),
        },
      ),

    async waitForTask(
      taskId: string,
      options: { timeoutMs?: number; intervalMs?: number; signal?: { cancelled: boolean } } = {},
    ): Promise<CompanionTask> {
      const timeoutMs = options.timeoutMs ?? 60_000;
      const intervalMs = options.intervalMs ?? 1_200;
      const started = Date.now();
      for (;;) {
        if (options.signal?.cancelled) {
          throw new Error('已停止等待 PC 任务');
        }
        const task = await this.getTask(taskId);
        if (task.status === 'ready' || task.status === 'failed' || task.status === 'cancelled') {
          return task;
        }
        if (Date.now() - started > timeoutMs) {
          throw new Error('等待 PC 任务超时，请到 PC 端查看任务状态');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
  };
}

export type PcHarnessClient = ReturnType<typeof makeClient>;

export async function createPcHarnessClient(): Promise<PcHarnessClient | null> {
  const config = await getPcHarnessConfig();
  return config ? makeClient(config) : null;
}

export function createPcHarnessClientFromConfig(config: PcHarnessConfig): PcHarnessClient {
  return makeClient(config);
}
