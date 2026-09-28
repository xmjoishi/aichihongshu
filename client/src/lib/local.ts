import { invoke } from "@tauri-apps/api/core";
import type { Item, Note, Profile, ReferenceAccount } from "./types";

export const IS_TAURI_RUNTIME =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface LocalRuntimeStatus {
  runtime: "tauri-rust";
  pythonBackend: boolean;
  database: "ready" | string;
  databasePath: string;
}

export interface LocalActiveAccount {
  id: number;
  alias: string;
  role: string;
  status: string;
}

export interface LocalPoolAccount {
  id: number;
  alias: string;
  role: string;
  displayName?: string;
  isActive: boolean;
  status: string;
}

export interface LocalAccountPoolSnapshot {
  items: LocalPoolAccount[];
}

export interface LocalAccountCreate {
  alias: string;
  role: "operation" | "assistant";
}

export interface LocalAccountUpdate {
  accountId: number;
  alias: string;
  role: "operation" | "assistant";
  displayName?: string | null;
  status: "active" | "banned" | "suspended" | "retired";
}

export interface LocalProfileUpdate {
  accountPoolId: number;
  accountId?: string | null;
  displayName?: string | null;
  niche?: string | null;
  targetAudience?: string | null;
  contentPillars: string[];
  personaName?: string | null;
  personaBio?: string | null;
  personaTone?: string | null;
  personaTaboos: string[];
  preferredStyles: string[];
  preferredScenes: string[];
  hashtagPool: string[];
  postingRhythm?: string | null;
}

export interface LocalProfileSummary {
  id: number;
  accountPoolId: number;
  accountId?: string;
  displayName?: string;
  niche?: string;
  targetAudience?: string;
  contentPillars: string[];
  personaName?: string;
  personaBio?: string;
  personaTone?: string;
  personaTaboos: string[];
  followers: number;
  totalNotes: number;
  totalLikes: number;
  totalCollects: number;
  avgLikes: number;
  avgComments: number;
  avgCollects: number;
  preferredStyles: string[];
  preferredScenes: string[];
  hashtagPool: string[];
  postingRhythm?: string;
  avatarUrl?: string;
  xhsBio?: string;
  xhsFollows: number;
  ipLocation?: string;
  xhsTags: string[];
  crawledAt?: string;
  updatedAt?: string;
}

export type MaterialType = "note_material" | "profile_material" | "web_material";

export const LOCAL_INSPIRATIONS_UPDATED_EVENT = "aichihongshu-local-inspirations-updated";

export interface LocalInspirationCreate {
  id: string;
  accountPoolId: number;
  title: string;
  sourceUrl: string;
  body: string;
  observedAt: string;
  reason: string;
  dedupeKey?: string;
  materialType?: MaterialType;
  author?: string;
  captureModules?: string[];
}

export interface LocalInspirationSummary extends LocalInspirationCreate {
  status: "saved" | "converted";
  noteId?: number;
  materialType: MaterialType;
  author: string;
  captureModules: string[];
}

export interface LocalReferenceAccountCreate {
  accountPoolId: number;
  accountId: string;
  name?: string | null;
  followers: number;
}

export interface LocalReferenceAccountUpdate extends LocalReferenceAccountCreate {
  id: number;
  contentStyle?: string | null;
}

export interface LocalKnowledgePreferences {
  accountPoolId: number;
  disabledRuleKeys: string[];
  useMySamples: boolean;
  useReferenceSamples: boolean;
  useInspirations: boolean;
  updatedAt?: string;
}

export interface LocalKnowledgePreferencesUpdate {
  accountPoolId: number;
  disabledRuleKeys: string[];
  useMySamples: boolean;
  useReferenceSamples: boolean;
  useInspirations: boolean;
}

export interface LocalPromptConfig {
  key: string;
  label: string;
  prompt: string;
  sortOrder: number;
  enabled: boolean;
}

export interface LocalPromptConfigUpsert extends LocalPromptConfig {
  accountPoolId: number;
}

export type MemoryOrigin = "pc" | "mobile";
export type MemoryKind =
  | "positioning"
  | "expression"
  | "fact"
  | "event"
  | "content_history";
export type MemoryConfirmStatus =
  | "candidate"
  | "confirmed"
  | "rejected"
  | "outdated";
export type MemorySourceType = "user" | "ai_draft" | "import" | "sync";

export interface LocalMemoryEntry {
  id: number;
  accountPoolId: number;
  origin: MemoryOrigin;
  kind: MemoryKind;
  content: string;
  subject: string;
  scope: string;
  source: string;
  sourceType: MemorySourceType;
  occurredAt?: string | null;
  confirmStatus: MemoryConfirmStatus;
  validStatus: "valid" | "invalid";
  enabled: boolean;
  replacedBy?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface LocalMemoryEntryCreate {
  accountPoolId: number;
  origin: MemoryOrigin;
  kind: MemoryKind;
  content: string;
  subject?: string;
  scope?: string;
  source?: string;
  sourceType?: MemorySourceType;
  occurredAt?: string | null;
  confirmStatus?: Extract<MemoryConfirmStatus, "candidate" | "confirmed">;
  /** 默认 true；AI 来源建议 false，由用户启用 */
  enabled?: boolean;
}

export interface LocalMemoryEntryUpdate {
  id: number;
  accountPoolId: number;
  kind: MemoryKind;
  content: string;
  subject?: string;
  scope?: string;
  source?: string;
  sourceType?: MemorySourceType;
  occurredAt?: string | null;
}

export interface LocalMemoryEntryTransition {
  id: number;
  accountPoolId: number;
  nextStatus: MemoryConfirmStatus;
  replacedBy?: number | null;
}

export interface LocalMemoryEntryFilter {
  accountPoolId?: number;
  origin?: MemoryOrigin;
  kind?: MemoryKind;
  confirmStatus?: MemoryConfirmStatus;
  enabled?: boolean;
}

export interface LocalExperiencePrompt {
  id: number;
  accountPoolId: number;
  origin: MemoryOrigin;
  title: string;
  content: string;
  enabled: boolean;
  applyScope: "global" | "account";
  applyTarget: "all" | "compose" | "chat";
  source: "user" | "from_memory";
  sortOrder: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface LocalExperiencePromptUpsert {
  accountPoolId: number;
  origin: MemoryOrigin;
  /** 空表示新建 */
  id?: number | null;
  title: string;
  content: string;
  enabled: boolean;
  applyScope?: "global" | "account";
  applyTarget?: "all" | "compose" | "chat";
  source?: "user" | "from_memory";
  sortOrder?: number;
}

export interface LocalMemorySystemRules {
  l0: string;
  l1Default: string;
  l1Active: string;
  l1IsOverride: boolean;
}

export interface LocalNoteStatsUpdate {
  noteId: number;
  accountPoolId: number;
  expectedVersion: number;
  field: "likes" | "comments" | "collects";
  value: number;
}

export type LocalAIRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface LocalAIRunUpsert {
  runId: string;
  accountPoolId?: number | null;
  noteId?: number;
  itemId?: number;
  provider: string;
  startedAt: string;
  status: LocalAIRunStatus;
  finishedAt?: string | null;
  error?: string | null;
}

export interface LocalAIRunUpdate {
  runId: string;
  accountPoolId?: number | null;
  status: LocalAIRunStatus;
  finishedAt?: string | null;
  error?: string | null;
}

export interface LocalAIRunSummary extends LocalAIRunUpsert {
  accountPoolId: number | null;
  status: LocalAIRunStatus;
}

export interface LocalAIRunArtifactCreate {
  runId: string;
  accountPoolId?: number | null;
  noteId?: number;
  itemId?: number;
  kind: "assistant_text";
  content: string;
}

export interface LocalAIRunArtifactSummary extends LocalAIRunArtifactCreate {
  id: number;
  runId: string;
  createdAt?: string;
}

export interface LocalItemSummary {
  id: number;
  title: string;
  imagePath: string;
  thumbnailPath?: string;
  tags: string[];
  style?: string;
  material?: string;
  scene?: string;
  color?: string;
  analysisRaw?: string;
  noteCount: number;
  createdAt?: string;
  imageVersion: number;
  contentHash?: string;
  metadataVersion: number;
}

export interface LocalNoteSummary {
  id: number;
  itemId?: number;
  itemIds: number[];
  title?: string;
  body?: string;
  tags: string[];
  status: "draft" | "ready" | "published" | string;
  noteType: "text" | "image" | "video" | "article" | string;
  likes: number;
  comments: number;
  collects: number;
  publishedAt?: string;
  noteUrl?: string;
  accountRef?: string;
  coverDesc?: string;
  promptUsed?: string;
  createdAt?: string;
  updatedAt?: string;
  contentVersion: number;
  deletedAt?: string;
}

export interface LocalNoteUpdate {
  noteId: number;
  accountPoolId: number;
  expectedVersion: number;
  title: string;
  body: string;
  tags: string[];
  noteType: Note["note_type"];
  itemIds: number[];
}

export interface LocalNoteStatusUpdate {
  noteId: number;
  accountPoolId: number;
  expectedVersion: number;
  status: Note["status"];
  noteUrl?: string;
}

export type LocalPublishOutboxStatus = "prepared" | "submitted" | "confirmed" | "failed" | "unknown";

export interface LocalPublishOutboxPrepare {
  attemptId: string;
  accountPoolId: number;
  noteId: number;
  snapshotKey: string;
  contentVersion: number;
  snapshotJson: string;
}

export interface LocalPublishOutboxUpdate {
  attemptId: string;
  accountPoolId: number;
  status: LocalPublishOutboxStatus;
  platformUrl?: string | null;
  error?: string | null;
}

export interface LocalPublishOutboxSummary extends LocalPublishOutboxPrepare {
  status: LocalPublishOutboxStatus;
  platformUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalStagedImageFile {
  index: number;
  filename: string;
  itemId: number;
  title: string;
}

export interface LocalStagedImagesSummary {
  noteId: number;
  stageDir: string;
  files: LocalStagedImageFile[];
}

export interface LocalNoteItemsUpdate {
  noteId: number;
  accountPoolId: number;
  expectedVersion: number;
  itemIds: number[];
}

export interface LocalImageImportRequest {
  accountPoolId: number;
  fileName: string;
  mimeType?: string;
  dataBase64: string;
  thumbnailDataBase64?: string;
}

export interface LocalImageRepairRequest extends LocalImageImportRequest {
  itemId: number;
  expectedImageVersion: number;
}

export interface LocalItemMetadataUpdate {
  itemId: number;
  accountPoolId: number;
  expectedMetadataVersion: number;
  title: string;
  tags: string[];
  style?: string;
  material?: string;
  scene?: string;
  color?: string;
}

export interface LocalReferenceNote {
  title: string;
  likes: number;
  url?: string;
}

export interface LocalReferenceAccountSummary {
  id: number;
  accountId: string;
  name?: string;
  followers: number;
  totalLikes: number;
  noteCount: number;
  avgLikes: number;
  avgComments: number;
  avgCollects: number;
  contentStyle?: string;
  topNotes: LocalReferenceNote[];
  rawData?: string;
  crawledAt?: string;
  analyzedAt?: string;
  insights?: string;
  insightsAt?: string;
}

export interface LocalWorkspaceSnapshot {
  databasePath: string;
  activeAccount: LocalActiveAccount;
  profile: LocalProfileSummary | null;
  itemCount: number;
  items: LocalItemSummary[];
  trashItems: LocalItemSummary[];
  missingImageIds: number[];
  noteCount: number;
  noteStatusCounts: Record<string, number>;
  notes: LocalNoteSummary[];
  trashNotes: LocalNoteSummary[];
  referenceAccounts: LocalReferenceAccountSummary[];
}

function requireTauri() {
  if (!IS_TAURI_RUNTIME) {
    throw new Error("本地 Rust command 仅在 Tauri 桌面端可用");
  }
}

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

export function readLocalAccountPool(): Promise<LocalAccountPoolSnapshot> {
  requireTauri();
  return invoke<LocalAccountPoolSnapshot>("read_account_pool");
}

export function activateLocalAccount(accountId: number): Promise<LocalActiveAccount> {
  requireTauri();
  return invoke<LocalActiveAccount>("activate_local_account", { accountId });
}

export function createLocalAccount(account: LocalAccountCreate): Promise<void> {
  requireTauri();
  return invoke<void>("create_local_account", { account });
}

export function updateLocalAccount(account: LocalAccountUpdate): Promise<void> {
  requireTauri();
  return invoke<void>("update_local_account", { account });
}

export function retireLocalAccount(accountId: number): Promise<void> {
  requireTauri();
  return invoke<void>("retire_local_account", { accountId });
}

export function updateLocalProfile(update: LocalProfileUpdate): Promise<void> {
  requireTauri();
  return invoke<void>("update_local_profile", { update });
}

export function readLocalInspirations(accountPoolId?: number): Promise<LocalInspirationSummary[]> {
  requireTauri();
  return invoke<LocalInspirationSummary[]>("read_local_inspirations", { accountPoolId });
}

export function saveLocalInspiration(inspiration: LocalInspirationCreate): Promise<void> {
  requireTauri();
  return invoke<void>("save_local_inspiration", {
    inspiration: {
      id: inspiration.id,
      accountPoolId: inspiration.accountPoolId,
      title: inspiration.title,
      sourceUrl: inspiration.sourceUrl,
      body: inspiration.body,
      observedAt: inspiration.observedAt,
      reason: inspiration.reason,
      dedupeKey: inspiration.dedupeKey,
      materialType: inspiration.materialType ?? "web_material",
      author: inspiration.author ?? "",
      captureModules: inspiration.captureModules ?? [],
    },
  });
}

export function convertLocalInspiration(id: string, accountPoolId: number, noteId: number): Promise<LocalInspirationSummary> {
  requireTauri();
  return invoke<LocalInspirationSummary>("convert_local_inspiration", { id, accountPoolId, noteId });
}

export function createLocalReferenceAccount(account: LocalReferenceAccountCreate): Promise<void> {
  requireTauri();
  return invoke<void>("create_local_reference_account", { account });
}

export function updateLocalReferenceAccount(account: LocalReferenceAccountUpdate): Promise<void> {
  requireTauri();
  return invoke<void>("update_local_reference_account", { account });
}

export function deleteLocalReferenceAccount(id: number, accountPoolId: number): Promise<void> {
  requireTauri();
  return invoke<void>("delete_local_reference_account", { id, accountPoolId });
}

export type PageSnapshotKind = "note_snapshot" | "ref_snapshot" | "clip";

export interface PageSnapshotMetrics {
  like: number | null;
  collect: number | null;
  comment: number | null;
  followers?: number | null;
  noteCount?: number | null;
}

export interface PageSnapshotCreate {
  accountPoolId: number;
  kind: PageSnapshotKind;
  sourceUrl: string;
  title: string;
  author: string;
  bodyExcerpt: string;
  metrics: PageSnapshotMetrics;
  referenceAccountId?: number | null;
  requestId?: string;
  observedAt: string;
}

export interface PageSnapshotSummary {
  id: number;
  accountPoolId: number;
  kind: PageSnapshotKind;
  sourceUrl: string;
  title: string;
  author: string;
  bodyExcerpt: string;
  likeCount: number | null;
  collectCount: number | null;
  commentCount: number | null;
  metricsJson: string;
  noteId: number | null;
  referenceAccountId: number | null;
  requestId: string | null;
  observedAt: string;
  createdAt: string;
}

export function savePageSnapshot(snapshot: PageSnapshotCreate): Promise<PageSnapshotSummary> {
  requireTauri();
  return invoke<PageSnapshotSummary>("save_page_snapshot", { snapshot });
}

export function listPageSnapshots(
  sourceUrl: string,
  accountPoolId?: number,
  limit?: number,
): Promise<PageSnapshotSummary[]> {
  requireTauri();
  return invoke<PageSnapshotSummary[]>("list_page_snapshots", {
    accountPoolId: accountPoolId ?? null,
    sourceUrl,
    limit: limit ?? null,
  });
}

export function installBrowserCaptureHost(browser: "chrome" | "edge"): Promise<string> {
  requireTauri();
  return invoke<string>("install_browser_capture_host", { browser });
}

export function copyBrowserExtensionDir(): Promise<string> {
  requireTauri();
  return invoke<string>("copy_browser_extension_dir");
}

export function copyBrowserExtensionPath(): Promise<string> {
  requireTauri();
  return invoke<string>("copy_browser_extension_path");
}

export function openBrowserExtensionDir(): Promise<string> {
  requireTauri();
  return invoke<string>("open_browser_extension_dir");
}

export function testBrowserCaptureLink(): Promise<Array<[string, boolean, string]>> {
  requireTauri();
  return invoke<Array<[string, boolean, string]>>("test_browser_capture_link");
}

export function openBrowserExtensionsPage(browser: "chrome" | "edge" = "chrome"): Promise<string> {
  requireTauri();
  return invoke<string>("open_browser_extensions_page", { browser });
}

export function detectCaptureBrowsers(): Promise<string[]> {
  requireTauri();
  return invoke<string[]>("detect_capture_browsers");
}

export interface BrowserCaptureStatus {
  protocolVersion: number;
  extensionVersion: string | null;
  extensionDir: string;
  extensionId: string | null;
  hostManifestPath: string;
  hostInstalled: boolean;
  hostManifestMatches: boolean;
  hostInstalledEdge: boolean;
  browsers: string[];
}

export function browserCaptureStatus(): Promise<BrowserCaptureStatus> {
  requireTauri();
  return invoke<BrowserCaptureStatus>("browser_capture_status");
}

export function readLocalKnowledgePreferences(accountPoolId?: number): Promise<LocalKnowledgePreferences> {
  requireTauri();
  return invoke<LocalKnowledgePreferences>("read_local_knowledge_preferences", { accountPoolId });
}

export function saveLocalKnowledgePreferences(preferences: LocalKnowledgePreferencesUpdate): Promise<LocalKnowledgePreferences> {
  requireTauri();
  return invoke<LocalKnowledgePreferences>("save_local_knowledge_preferences", { preferences });
}

export function listPromptConfigs(accountPoolId?: number): Promise<LocalPromptConfig[]> {
  requireTauri();
  return invoke<LocalPromptConfig[]>("list_prompt_configs", { accountPoolId });
}

export function upsertPromptConfig(config: LocalPromptConfigUpsert): Promise<LocalPromptConfig[]> {
  requireTauri();
  return invoke<LocalPromptConfig[]>("upsert_prompt_config", {
    payload: {
      accountPoolId: config.accountPoolId,
      key: config.key,
      label: config.label,
      prompt: config.prompt,
      sortOrder: config.sortOrder,
      enabled: config.enabled,
    },
  });
}

export function deletePromptConfig(key: string, accountPoolId: number): Promise<LocalPromptConfig[]> {
  requireTauri();
  return invoke<LocalPromptConfig[]>("delete_prompt_config", { key, accountPoolId });
}

export function listMemoryEntries(filter: LocalMemoryEntryFilter = {}): Promise<LocalMemoryEntry[]> {
  requireTauri();
  return invoke<LocalMemoryEntry[]>("list_memory_entries", {
    filter: {
      accountPoolId: filter.accountPoolId,
      origin: filter.origin,
      kind: filter.kind,
      confirmStatus: filter.confirmStatus,
      enabled: filter.enabled,
    },
  });
}

export function createMemoryEntry(entry: LocalMemoryEntryCreate): Promise<LocalMemoryEntry> {
  requireTauri();
  return invoke<LocalMemoryEntry>("create_memory_entry", { entry });
}

export function updateMemoryEntry(entry: LocalMemoryEntryUpdate): Promise<LocalMemoryEntry> {
  requireTauri();
  return invoke<LocalMemoryEntry>("update_memory_entry", { entry });
}

export function deleteMemoryEntry(id: number, accountPoolId: number): Promise<void> {
  requireTauri();
  return invoke<void>("delete_memory_entry", { id, accountPoolId });
}

export function setMemoryEntryEnabled(
  id: number,
  accountPoolId: number,
  enabled: boolean,
): Promise<LocalMemoryEntry> {
  requireTauri();
  return invoke<LocalMemoryEntry>("set_memory_entry_enabled", { id, accountPoolId, enabled });
}

export function transitionMemoryEntryStatus(
  transition: LocalMemoryEntryTransition,
): Promise<LocalMemoryEntry> {
  requireTauri();
  return invoke<LocalMemoryEntry>("transition_memory_entry_status", { transition });
}

export function listExperiencePrompts(
  accountPoolId?: number,
  origin?: MemoryOrigin,
): Promise<LocalExperiencePrompt[]> {
  requireTauri();
  return invoke<LocalExperiencePrompt[]>("list_experience_prompts", { accountPoolId, origin });
}

export function upsertExperiencePrompt(
  prompt: LocalExperiencePromptUpsert,
): Promise<LocalExperiencePrompt[]> {
  requireTauri();
  return invoke<LocalExperiencePrompt[]>("upsert_experience_prompt", { prompt });
}

export function deleteExperiencePrompt(
  id: number,
  accountPoolId: number,
  origin: MemoryOrigin,
): Promise<LocalExperiencePrompt[]> {
  requireTauri();
  return invoke<LocalExperiencePrompt[]>("delete_experience_prompt", { id, accountPoolId, origin });
}

export function readMemorySystemRules(): Promise<LocalMemorySystemRules> {
  requireTauri();
  return invoke<LocalMemorySystemRules>("read_memory_system_rules");
}

export function saveMemoryL1Override(content: string): Promise<LocalMemorySystemRules> {
  requireTauri();
  return invoke<LocalMemorySystemRules>("save_memory_l1_override", { content });
}

export function resetMemoryL1Override(): Promise<LocalMemorySystemRules> {
  requireTauri();
  return invoke<LocalMemorySystemRules>("reset_memory_l1_override");
}

export function updateLocalNoteStats(update: LocalNoteStatsUpdate): Promise<LocalNoteSummary> {
  requireTauri();
  return invoke<LocalNoteSummary>("update_local_note_stats", {
    update: {
      noteId: update.noteId,
      accountPoolId: update.accountPoolId,
      expectedVersion: update.expectedVersion,
      field: update.field,
      value: update.value,
    },
  });
}

export function saveLocalAIRun(run: LocalAIRunUpsert): Promise<LocalAIRunSummary> {
  requireTauri();
  return invoke<LocalAIRunSummary>("save_local_ai_run", { run });
}

export function updateLocalAIRun(run: LocalAIRunUpdate): Promise<LocalAIRunSummary> {
  requireTauri();
  return invoke<LocalAIRunSummary>("update_local_ai_run", { run });
}

export function readLocalAIRun(
  accountPoolId: number | null | undefined,
  noteId?: number,
  itemId?: number,
): Promise<LocalAIRunSummary | null> {
  requireTauri();
  return invoke<LocalAIRunSummary | null>("read_local_ai_run", {
    accountPoolId: accountPoolId ?? null,
    noteId: noteId ?? null,
    itemId: itemId ?? null,
  });
}

export function saveLocalAIRunArtifact(artifact: LocalAIRunArtifactCreate): Promise<LocalAIRunArtifactSummary> {
  requireTauri();
  return invoke<LocalAIRunArtifactSummary>("save_local_ai_artifact", { artifact });
}

export function readLocalAIRunArtifacts(
  accountPoolId: number | null | undefined,
  noteId?: number,
  itemId?: number,
): Promise<LocalAIRunArtifactSummary[]> {
  requireTauri();
  return invoke<LocalAIRunArtifactSummary[]>("read_local_ai_artifacts", {
    accountPoolId: accountPoolId ?? null,
    noteId: noteId ?? null,
    itemId: itemId ?? null,
  });
}

export interface LocalPcHarnessStatus {
  running: boolean;
  bindAddress?: string | null;
  lanAddresses: string[];
  port: number;
  pairingToken?: string | null;
  protocolVersion: string;
  activeAccountId?: number | null;
  mobileConnected: boolean;
}

export type MobileMemoryCommandOperation =
  | "createEntry"
  | "updateEntry"
  | "setEntryEnabled"
  | "deleteEntry"
  | "createPrompt"
  | "updatePrompt"
  | "setPromptEnabled"
  | "deletePrompt"
  | "seedExamples";

export interface MobileMemoryCommandReceipt {
  cacheSynced: boolean;
  message?: string | null;
}

export function readPcHarnessStatus(): Promise<LocalPcHarnessStatus> {
  return invoke("pc_harness_status");
}

export function readPcHarnessMobileConnection(): Promise<boolean> {
  return invoke("pc_harness_mobile_connection");
}

export function startPcHarness(): Promise<LocalPcHarnessStatus> {
  return invoke("start_pc_harness");
}

export function stopPcHarness(): Promise<LocalPcHarnessStatus> {
  return invoke("stop_pc_harness");
}

export function rotatePcHarnessToken(): Promise<LocalPcHarnessStatus> {
  return invoke("rotate_pc_harness_token");
}

export function writeMobileMemoryCommand(
  operation: MobileMemoryCommandOperation,
  payload: unknown,
): Promise<MobileMemoryCommandReceipt> {
  requireTauri();
  return invoke("pc_harness_mobile_memory_command", { operation, payload });
}

export function localItemToItem(item: LocalItemSummary): Item {
  return {
    id: item.id,
    title: item.title,
    image_path: item.imagePath,
    thumbnail_path: item.thumbnailPath,
    style: item.style,
    material: item.material,
    scene: item.scene,
    color: item.color,
    tags: item.tags,
    analysis_raw: item.analysisRaw,
    note_count: item.noteCount,
    created_at: item.createdAt,
    image_version: item.imageVersion,
    content_hash: item.contentHash,
    metadata_version: item.metadataVersion,
  };
}

export function localNoteToNote(note: LocalNoteSummary): Note {
  return {
    id: note.id,
    item_id: note.itemId,
    item_ids: note.itemIds,
    title: note.title,
    body: note.body,
    tags: note.tags,
    status: note.status as Note["status"],
    note_type: note.noteType as Note["note_type"],
    likes: note.likes,
    comments: note.comments,
    collects: note.collects,
    published_at: note.publishedAt,
    note_url: note.noteUrl,
    account_ref: note.accountRef,
    cover_desc: note.coverDesc,
    prompt_used: note.promptUsed,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
    content_version: note.contentVersion,
    deleted_at: note.deletedAt,
  };
}

export function localProfileToProfile(profile: LocalProfileSummary): Profile {
  return {
    id: profile.id,
    account_id: profile.accountId,
    display_name: profile.displayName,
    niche: profile.niche,
    target_audience: profile.targetAudience,
    content_pillars: profile.contentPillars,
    persona_name: profile.personaName,
    persona_bio: profile.personaBio,
    persona_tone: profile.personaTone,
    persona_taboos: profile.personaTaboos,
    followers: profile.followers,
    total_notes: profile.totalNotes,
    total_likes: profile.totalLikes,
    total_collects: profile.totalCollects,
    avg_likes: profile.avgLikes,
    avg_comments: profile.avgComments,
    avg_collects: profile.avgCollects,
    preferred_styles: profile.preferredStyles,
    preferred_scenes: profile.preferredScenes,
    hashtag_pool: profile.hashtagPool,
    posting_rhythm: profile.postingRhythm,
    avatar_url: profile.avatarUrl,
    xhs_bio: profile.xhsBio,
    xhs_follows: profile.xhsFollows,
    ip_location: profile.ipLocation,
    xhs_tags: profile.xhsTags,
    crawled_at: profile.crawledAt,
    updated_at: profile.updatedAt,
  };
}

export function localReferenceAccountToReferenceAccount(
  account: LocalReferenceAccountSummary,
): ReferenceAccount {
  return {
    id: account.id,
    account_id: account.accountId,
    name: account.name,
    followers: account.followers,
    total_likes: account.totalLikes,
    note_count: account.noteCount,
    avg_likes: account.avgLikes,
    avg_comments: account.avgComments,
    avg_collects: account.avgCollects,
    content_style: account.contentStyle,
    top_notes: account.topNotes,
    raw_data: account.rawData,
    crawled_at: account.crawledAt,
    analyzed_at: account.analyzedAt,
    insights: account.insights,
    insights_at: account.insightsAt,
  };
}
