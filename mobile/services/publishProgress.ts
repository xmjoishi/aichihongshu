import * as SecureStore from 'expo-secure-store';

const KEY_PREFIX = 'publish_progress_';

export type PublishProgress = {
  copiedTitle: boolean;
  copiedBody: boolean;
  copiedFull: boolean;
  exported: boolean;
  exportedAt?: string;
  shareAttemptAt?: string;
  /** System share UI outcome only; the note's published status requires an explicit user action. */
  lastShareResult?: 'preparing' | 'shared' | 'dismissed' | 'failed';
};

export const EMPTY_PROGRESS: PublishProgress = {
  copiedTitle: false,
  copiedBody: false,
  copiedFull: false,
  exported: false,
};

function keyOf(noteId: number) {
  return `${KEY_PREFIX}${noteId}`;
}

export async function getPublishProgress(noteId: number): Promise<PublishProgress> {
  try {
    const raw = await SecureStore.getItemAsync(keyOf(noteId));
    if (!raw) return EMPTY_PROGRESS;
    return { ...EMPTY_PROGRESS, ...JSON.parse(raw) };
  } catch {
    return EMPTY_PROGRESS;
  }
}

export async function setPublishProgress(noteId: number, next: Partial<PublishProgress>) {
  const current = await getPublishProgress(noteId);
  const merged = { ...current, ...next };
  await SecureStore.setItemAsync(keyOf(noteId), JSON.stringify(merged));
  return merged;
}

export async function clearPublishProgress(noteId: number) {
  await SecureStore.deleteItemAsync(keyOf(noteId));
}

export function getPublishProgressStage(progress: PublishProgress): 'none' | 'copied' | 'exported' {
  const copied = progress.copiedFull || (progress.copiedTitle && progress.copiedBody);
  if (progress.exported) return 'exported';
  if (copied) return 'copied';
  return 'none';
}
