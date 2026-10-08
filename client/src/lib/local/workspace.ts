import { invoke } from "@tauri-apps/api/core";

import { requireTauri } from "./runtime";

import type {
  LocalRuntimeStatus,
  LocalItemSummary,
  LocalNoteSummary,
  LocalNoteUpdate,
  LocalNoteStatusUpdate,
  LocalPublishOutboxPrepare,
  LocalPublishOutboxUpdate,
  LocalPublishOutboxSummary,
  LocalStagedImagesSummary,
  LocalVideoImportChunk,
  LocalVideoImportResult,
  LocalNoteItemsUpdate,
  LocalImageImportRequest,
  LocalImageRepairRequest,
  LocalItemMetadataUpdate,
  LocalWorkspaceSnapshot,
} from "../localTypes";

export function readLocalRuntimeStatus(): Promise<LocalRuntimeStatus> {
  requireTauri();
  return invoke<LocalRuntimeStatus>("runtime_status");
}

export function readLocalWorkspaceSnapshot(accountPoolId?: number, section: "workspace" | "library" | "notes" | "profile" | "references" | "summary" | "all" = "workspace"): Promise<LocalWorkspaceSnapshot> {
  requireTauri();
  return invoke<LocalWorkspaceSnapshot>("read_status", { accountPoolId, section });
}

export function readLocalImageData(itemId: number, accountPoolId?: number, variant: "original" | "thumbnail" = "original"): Promise<string | null> {
  requireTauri();
  return invoke<string | null>("read_local_image", { itemId, accountPoolId, variant });
}

export function analyzeLocalItem(itemId: number, accountPoolId?: number): Promise<LocalItemSummary> {
  requireTauri();
  return invoke<LocalItemSummary>("analyze_local_item", { itemId, accountPoolId });
}

export function createLocalDraft(title: string, accountPoolId?: number): Promise<LocalNoteSummary> {
  requireTauri();
  return invoke<LocalNoteSummary>("create_local_draft", { title, accountPoolId });
}

export function updateLocalNote(update: LocalNoteUpdate): Promise<LocalNoteSummary> {
  requireTauri();
  return invoke<LocalNoteSummary>("update_local_note", { update });
}

export function updateLocalNoteStatus(update: LocalNoteStatusUpdate): Promise<LocalNoteSummary> {
  requireTauri();
  return invoke<LocalNoteSummary>("update_local_note_status", { update });
}

export function prepareLocalPublish(
  preparation: LocalPublishOutboxPrepare,
): Promise<LocalPublishOutboxSummary> {
  requireTauri();
  return invoke<LocalPublishOutboxSummary>("prepare_local_publish", { preparation });
}

export function updateLocalPublish(
  update: LocalPublishOutboxUpdate,
): Promise<LocalPublishOutboxSummary> {
  requireTauri();
  return invoke<LocalPublishOutboxSummary>("update_local_publish", { update });
}

export function readLocalPublishOutbox(
  accountPoolId?: number,
  noteId?: number,
): Promise<LocalPublishOutboxSummary[]> {
  requireTauri();
  return invoke<LocalPublishOutboxSummary[]>("read_local_publish_outbox", {
    accountPoolId,
    noteId,
  });
}

/** 用户主动为当前发布快照创建 30 分钟有效的单条浏览器文字填充任务。 */
export function requestLocalPublishFill(attemptId: string, accountPoolId: number): Promise<LocalPublishOutboxSummary> {
  requireTauri();
  return invoke<LocalPublishOutboxSummary>("request_local_publish_fill", {
    attemptId,
    accountPoolId,
  });
}

/** 把笔记关联素材按上传顺序复制到本地暂存目录，返回带序号的文件清单。 */
export function stageLocalNoteImages(
  noteId: number,
  accountPoolId?: number,
): Promise<LocalStagedImagesSummary> {
  requireTauri();
  return invoke<LocalStagedImagesSummary>("stage_local_note_images", {
    noteId,
    accountPoolId,
  });
}

export function importLocalVideoChunk(request: LocalVideoImportChunk): Promise<LocalVideoImportResult> {
  requireTauri();
  return invoke<LocalVideoImportResult>("import_local_video_chunk", { request });
}

export function abortLocalVideoUpload(uploadId: string, accountPoolId: number): Promise<void> {
  requireTauri();
  return invoke<void>("abort_local_video_upload", { uploadId, accountPoolId });
}

export async function importLocalVideoFile(
  noteId: number,
  accountPoolId: number,
  expectedVersion: number,
  file: File,
  onProgress?: (received: number, total: number) => void,
): Promise<LocalNoteSummary> {
  requireTauri();
  if (file.size < 1 || file.size > 500 * 1024 * 1024) {
    throw new Error("视频大小必须在 1B 到 500MiB 之间");
  }
  const extension = file.name.split(".").pop()?.toLowerCase();
  const mimeType = ({ mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm" } as Record<string, string>)[extension ?? ""];
  if (!mimeType) throw new Error("视频仅支持 MP4、MOV、M4V 或 WebM 文件");
  const uploadId = crypto.randomUUID();
  const chunkBytes = 96 * 1024;
  const encodeBase64 = (bytes: Uint8Array) => {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
    }
    return btoa(binary);
  };
  try {
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      const end = Math.min(offset + chunkBytes, file.size);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      const result = await invoke<LocalVideoImportResult>("import_local_video_chunk", {
        request: {
          noteId,
          accountPoolId,
          expectedVersion,
          uploadId,
          filename: file.name,
          mimeType,
          totalBytes: file.size,
          offset,
          dataBase64: encodeBase64(bytes),
          done: end === file.size,
        } satisfies LocalVideoImportChunk,
      });
      onProgress?.(result.receivedBytes, result.totalBytes);
      if (end === file.size) {
        if (!result.completed || !result.note) throw new Error("视频暂存完成但没有返回已更新的笔记");
        return result.note;
      }
      if (result.completed) throw new Error("视频分块任务提前结束");
    }
  } catch (error) {
    await abortLocalVideoUpload(uploadId, accountPoolId).catch(() => {});
    throw error;
  }
  throw new Error("视频文件为空");
}

/** 在系统文件管理器中打开笔记暂存目录，返回目录路径。 */
export function openLocalStageDir(
  noteId: number,
  accountPoolId?: number,
): Promise<string> {
  requireTauri();
  return invoke<string>("open_local_stage_dir", {
    noteId,
    accountPoolId,
  });
}

/** 确认发布后清理笔记暂存目录。 */
export function clearLocalNoteStage(
  noteId: number,
  accountPoolId?: number,
): Promise<void> {
  requireTauri();
  return invoke<void>("clear_local_note_stage", {
    noteId,
    accountPoolId,
  });
}

export function updateLocalNoteItems(update: LocalNoteItemsUpdate): Promise<LocalNoteSummary> {
  requireTauri();
  return invoke<LocalNoteSummary>("update_local_note_items", { update });
}

export function deleteLocalNote(noteId: number, accountPoolId: number): Promise<LocalNoteSummary> {
  requireTauri();
  return invoke<LocalNoteSummary>("delete_local_note", { noteId, accountPoolId });
}

export function restoreLocalNote(noteId: number, accountPoolId: number): Promise<LocalNoteSummary> {
  requireTauri();
  return invoke<LocalNoteSummary>("restore_local_note", { noteId, accountPoolId });
}

export function importLocalImage(request: LocalImageImportRequest): Promise<LocalItemSummary> {
  requireTauri();
  return invoke<LocalItemSummary>("import_local_image", {
    import: {
      accountPoolId: request.accountPoolId,
      fileName: request.fileName,
      mimeType: request.mimeType,
      dataBase64: request.dataBase64,
      thumbnailDataBase64: request.thumbnailDataBase64,
    },
  });
}

export function repairLocalImage(request: LocalImageRepairRequest): Promise<LocalItemSummary> {
  requireTauri();
  return invoke<LocalItemSummary>("repair_local_image", {
    repair: {
      itemId: request.itemId,
      accountPoolId: request.accountPoolId,
      expectedImageVersion: request.expectedImageVersion,
      fileName: request.fileName,
      mimeType: request.mimeType,
      dataBase64: request.dataBase64,
      thumbnailDataBase64: request.thumbnailDataBase64,
    },
  });
}

export function deleteLocalItem(itemId: number, accountPoolId: number): Promise<void> {
  requireTauri();
  return invoke<void>("delete_local_item", { itemId, accountPoolId });
}

export function restoreLocalItem(itemId: number, accountPoolId: number): Promise<LocalItemSummary> {
  requireTauri();
  return invoke<LocalItemSummary>("restore_local_item", { itemId, accountPoolId });
}

export interface PurgeLocalItemsResult {
  purgedIds: number[];
  cleanupWarnings: string[];
}

export function purgeLocalItems(itemIds: number[], accountPoolId: number): Promise<PurgeLocalItemsResult> {
  requireTauri();
  return invoke<PurgeLocalItemsResult>("purge_local_items", { itemIds, accountPoolId });
}

export function updateLocalItemMetadata(update: LocalItemMetadataUpdate): Promise<LocalItemSummary> {
  requireTauri();
  return invoke<LocalItemSummary>("update_local_item_metadata", {
    update: {
      itemId: update.itemId,
      accountPoolId: update.accountPoolId,
      expectedMetadataVersion: update.expectedMetadataVersion,
      title: update.title,
      tags: update.tags,
      style: update.style,
      material: update.material,
      scene: update.scene,
      color: update.color,
    },
  });
}

export function createLocalDraftFromItems(itemIds: number[], accountPoolId?: number): Promise<LocalNoteSummary> {
  requireTauri();
  return invoke<LocalNoteSummary>("create_local_draft_from_items", {
    itemIds,
    accountPoolId,
  });
}

export function createLocalPromptDraftFromItems(
  itemIds: number[],
  accountPoolId?: number,
  accountRef?: string,
): Promise<LocalNoteSummary> {
  requireTauri();
  return invoke<LocalNoteSummary>("create_local_prompt_draft_from_items", {
    itemIds,
    accountPoolId,
    accountRef: accountRef ?? null,
  });
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** 生成受限尺寸的 JPEG 缩略图；失败时由 Rust 回退使用原图。 */
export async function fileToThumbnailBase64(file: File, maxSide = 512): Promise<string | undefined> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return undefined;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return undefined;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const encoded = canvas.toDataURL("image/jpeg", 0.82);
    return encoded.startsWith("data:image/jpeg;base64,") ? encoded.slice("data:image/jpeg;base64,".length) : undefined;
  } catch {
    return undefined;
  }
}
