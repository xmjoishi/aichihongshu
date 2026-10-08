import type { Note } from "./types";

export interface LocalRuntimeStatus {
  runtime: "tauri-rust";
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
  followers?: number | null;
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

export type MaterialType = "note_material" | "profile_material" | "web_material" | "image_material";


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
  capturePayload?: string;
}

export interface LocalInspirationSummary extends LocalInspirationCreate {
  status: "saved" | "converted";
  noteId?: number;
  /** Normalized collection category; older rows are inferred from materialType. */
  clipKind?: "account" | "note" | "material";
  materialType: MaterialType;
  author: string;
  captureModules: string[];
  capturePayload: string;
  collectionTags: string[];
  collectionImages: BrowserCollectionImageSummary[];
}

export type LocalInspirationTargetKind = "topic" | "reference_account" | "inspiration" | "note" | "item";

export interface LocalInspirationReferenceSummary {
  inspirationId: string;
  accountPoolId: number;
  targetKind: LocalInspirationTargetKind;
  targetId: string;
  targetExists: boolean;
  created: boolean;
}

export interface LocalInspirationReferenceAccountResult {
  inspirationId: string;
  accountPoolId: number;
  referenceAccountId: number;
  platformAccountId: string;
  name?: string | null;
  linkCreated: boolean;
}

export interface LocalInspirationDraftResult {
  inspiration: LocalInspirationSummary;
  note: LocalNoteSummary;
}

export interface BrowserCollectionImageSummary {
  position: number;
  sourceUrl: string;
  sourceKind: "legacy_url" | "extension_bytes";
  status: "pending" | "downloading" | "ready" | "failed" | string;
  byteSize?: number | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  error?: string | null;
  originalAvailable: boolean;
  thumbnailAvailable: boolean;
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

export interface LocalKnowledgeMySample {
  id: number;
  title?: string;
  body?: string;
  tags: string[];
  likes: number;
  comments: number;
  collects: number;
  publishedAt?: string;
  noteUrl?: string;
  bodyPreview: string;
  useAsReference: boolean;
}

export interface LocalKnowledgeReferenceSample {
  title: string;
  body: string;
  likes: number;
  noteUrl?: string;
}

export interface LocalKnowledgeReferenceGroup {
  accountId: string;
  name: string;
  notes: LocalKnowledgeReferenceSample[];
}

export interface LocalKnowledgeReferenceSampleSaveResult {
  duplicate: boolean;
  count: number;
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
  videoPath?: string;
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
  videoPath?: string;
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
  fillStatus: "not_requested" | "queued" | "claimed" | "partial" | "filled" | "cancelled" | "expired";
  fillExpiresAt?: string | null;
  fillResultJson: string;
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

export interface LocalVideoImportChunk {
  noteId: number;
  accountPoolId: number;
  expectedVersion: number;
  uploadId: string;
  filename: string;
  mimeType: string;
  totalBytes: number;
  offset: number;
  dataBase64: string;
  done: boolean;
}

export interface LocalVideoImportResult {
  completed: boolean;
  receivedBytes: number;
  totalBytes: number;
  note?: LocalNoteSummary;
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
