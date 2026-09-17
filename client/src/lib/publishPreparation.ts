import type { Note } from "./types";

export type PublishIssueCode = "TITLE_REQUIRED" | "BODY_REQUIRED" | "MEDIA_REQUIRED";

export interface PublishIssue {
  code: PublishIssueCode;
  message: string;
}

export interface PublishPreparation {
  noteId: number;
  accountId: number | null;
  contentVersion: number;
  title: string;
  body: string;
  tags: string[];
  itemIds: number[];
  snapshotKey: string;
  issues: PublishIssue[];
  ready: boolean;
}

export type PublishAttemptStatus = "prepared" | "submitted" | "confirmed" | "failed" | "unknown";

export interface PublishAttempt {
  id: string;
  noteId: number;
  accountId: number | null;
  snapshotKey: string;
  status: PublishAttemptStatus;
  createdAt: string;
}

export function preparePublish(note: Note, accountId: number | null): PublishPreparation {
  const title = note.title?.trim() ?? "";
  const body = note.body?.trim() ?? "";
  const itemIds = Array.from(new Set(note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : [])));
  const issues: PublishIssue[] = [];
  if (!title) issues.push({ code: "TITLE_REQUIRED", message: "请先填写标题" });
  if (!body) issues.push({ code: "BODY_REQUIRED", message: "请先填写正文" });
  if (note.note_type !== "text" && itemIds.length === 0) issues.push({ code: "MEDIA_REQUIRED", message: "当前发布类型需要至少一项素材" });
  const contentVersion = note.content_version ?? 1;
  return {
    noteId: note.id,
    accountId,
    contentVersion,
    title,
    body,
    tags: [...note.tags],
    itemIds,
    snapshotKey: `${accountId ?? "unresolved"}:note:${note.id}:v${contentVersion}`,
    issues,
    ready: issues.length === 0,
  };
}

export function createPublishAttempt(preparation: PublishPreparation): PublishAttempt {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
  return {
    id: `publish-${preparation.noteId}-${preparation.contentVersion}-${suffix}`,
    noteId: preparation.noteId,
    accountId: preparation.accountId,
    snapshotKey: preparation.snapshotKey,
    status: "prepared",
    createdAt: new Date().toISOString(),
  };
}

export function canSubmitPublishAttempt(attempt: PublishAttempt): boolean {
  return attempt.status === "prepared" || attempt.status === "failed";
}
