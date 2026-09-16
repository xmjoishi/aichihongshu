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

export interface LocalItemSummary {
  id: number;
  title: string;
  imagePath: string;
  tags: string[];
  style?: string;
  material?: string;
  scene?: string;
  color?: string;
  analysisRaw?: string;
  noteCount: number;
  createdAt?: string;
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
  noteCount: number;
  noteStatusCounts: Record<string, number>;
  notes: LocalNoteSummary[];
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

export function readLocalWorkspaceSnapshot(): Promise<LocalWorkspaceSnapshot> {
  requireTauri();
  return invoke<LocalWorkspaceSnapshot>("read_status");
}

export function readLocalImageData(itemId: number): Promise<string | null> {
  requireTauri();
  return invoke<string | null>("read_local_image", { itemId });
}

export function createLocalDraft(title: string): Promise<LocalNoteSummary> {
  requireTauri();
  return invoke<LocalNoteSummary>("create_local_draft", { title });
}

export function readLocalAccountPool(): Promise<LocalAccountPoolSnapshot> {
  requireTauri();
  return invoke<LocalAccountPoolSnapshot>("read_account_pool");
}

export function activateLocalAccount(accountId: number): Promise<LocalActiveAccount> {
  requireTauri();
  return invoke<LocalActiveAccount>("activate_local_account", { accountId });
}

export function localItemToItem(item: LocalItemSummary): Item {
  return {
    id: item.id,
    title: item.title,
    image_path: item.imagePath,
    style: item.style,
    material: item.material,
    scene: item.scene,
    color: item.color,
    tags: item.tags,
    analysis_raw: item.analysisRaw,
    note_count: item.noteCount,
    created_at: item.createdAt,
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
