/**
 * AI 创作会话历史 — 按 JSON 文件存本地文档目录，无需建表。
 */
import * as FileSystem from 'expo-file-system/legacy';

export type ChatMsg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
};

export type ChatSession = {
  id: string;
  title: string;
  noteId?: number | null;
  updatedAt: string;
  messages: ChatMsg[];
};

const DIR = `${FileSystem.documentDirectory}chatSessions/`;

async function ensureDir() {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
  }
}

function fileOf(id: string) {
  return `${DIR}${id}.json`;
}

export async function listChatSessions(): Promise<ChatSession[]> {
  try {
    await ensureDir();
    const names = await FileSystem.readDirectoryAsync(DIR);
    const sessions: ChatSession[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await FileSystem.readAsStringAsync(`${DIR}${name}`);
        const s = JSON.parse(raw) as ChatSession;
        if (s?.id && Array.isArray(s.messages)) sessions.push(s);
      } catch {}
    }
    sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return sessions;
  } catch {
    return [];
  }
}

export async function saveChatSession(session: Omit<ChatSession, 'updatedAt'> & { updatedAt?: string }): Promise<ChatSession> {
  await ensureDir();
  const full: ChatSession = {
    ...session,
    title: session.title?.trim() || session.messages.find((m) => m.role === 'user')?.content?.slice(0, 20) || '未命名会话',
    updatedAt: session.updatedAt ?? new Date().toISOString(),
    messages: session.messages.map(({ streaming: _s, ...m }) => m as ChatMsg),
  };
  await FileSystem.writeAsStringAsync(fileOf(full.id), JSON.stringify(full));
  return full;
}

export async function deleteChatSession(id: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(fileOf(id), { idempotent: true });
  } catch {}
}

export function newChatSessionId(): string {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
