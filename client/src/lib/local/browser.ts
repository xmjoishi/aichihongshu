import { invoke } from "@tauri-apps/api/core";

import { requireTauri } from "./runtime";

import type {
  LocalInspirationCreate,
  LocalInspirationDraftResult,
  LocalInspirationReferenceAccountResult,
  LocalInspirationReferenceSummary,
  LocalInspirationSummary,
  LocalInspirationTargetKind,
  LocalItemSummary,
  LocalReferenceAccountCreate,
  LocalReferenceAccountUpdate,
} from "../localTypes";

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

export function attachBrowserCaptureAssets(id: string, accountPoolId: number, itemIds: number[]): Promise<void> {
  requireTauri();
  return invoke<void>("attach_browser_capture_assets", { id, accountPoolId, itemIds });
}

export function saveBrowserCapturePayload(id: string, accountPoolId: number, payloadJson: string): Promise<void> {
  requireTauri();
  return invoke<void>("save_browser_capture_payload", { id, accountPoolId, payloadJson });
}

export function readBrowserCollectionImage(
  id: string,
  accountPoolId: number,
  position: number,
  thumbnail: boolean,
): Promise<string> {
  requireTauri();
  return invoke<string>("read_browser_collection_image", { id, accountPoolId, position, thumbnail });
}

export interface CollectionImageDownloadOutcome {
  position: number;
  status: "ready" | "failed";
  error?: string | null;
}

export function downloadBrowserCollectionImage(
  id: string,
  accountPoolId: number,
  position: number,
): Promise<CollectionImageDownloadOutcome> {
  requireTauri();
  return invoke<CollectionImageDownloadOutcome>("download_browser_collection_image", { id, accountPoolId, position });
}

export function updateLocalInspirationDetails(
  id: string,
  accountPoolId: number,
  note: string,
  tags: string[],
): Promise<void> {
  requireTauri();
  return invoke<void>("update_local_inspiration_details", { id, accountPoolId, note, tags });
}

export function removeLocalInspiration(id: string, accountPoolId: number): Promise<void> {
  requireTauri();
  return invoke<void>("remove_local_inspiration", { id, accountPoolId });
}

export function createDraftFromLocalInspiration(id: string, accountPoolId: number): Promise<LocalInspirationDraftResult> {
  requireTauri();
  return invoke<LocalInspirationDraftResult>("create_draft_from_local_inspiration", { id, accountPoolId });
}

export function linkLocalInspirationToTarget(
  id: string,
  accountPoolId: number,
  targetKind: LocalInspirationTargetKind,
  targetId: string,
): Promise<LocalInspirationReferenceSummary> {
  requireTauri();
  return invoke<LocalInspirationReferenceSummary>("link_local_inspiration_to_target", { id, accountPoolId, targetKind, targetId });
}

export function unlinkLocalInspirationFromTarget(
  id: string,
  accountPoolId: number,
  targetKind: LocalInspirationTargetKind,
  targetId: string,
): Promise<boolean> {
  requireTauri();
  return invoke<boolean>("unlink_local_inspiration_from_target", { id, accountPoolId, targetKind, targetId });
}

export function readLocalInspirationReferences(id: string, accountPoolId: number): Promise<LocalInspirationReferenceSummary[]> {
  requireTauri();
  return invoke<LocalInspirationReferenceSummary[]>("read_local_inspiration_references", { id, accountPoolId });
}

export function promoteLocalInspirationToReferenceAccount(id: string, accountPoolId: number): Promise<LocalInspirationReferenceAccountResult> {
  requireTauri();
  return invoke<LocalInspirationReferenceAccountResult>("promote_local_inspiration_to_reference_account", { id, accountPoolId });
}

export function addBrowserCollectionImageToLibrary(
  id: string,
  accountPoolId: number,
  position: number,
): Promise<LocalItemSummary> {
  requireTauri();
  return invoke<LocalItemSummary>("add_browser_collection_image_to_library", { id, accountPoolId, position });
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
  captureDetails?: import("../browserCapture").BrowserCaptureDetails;
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
  channel: "dev" | "prod";
  workspaceId: string;
  appVersion: string;
  extensionVersion: string | null;
  extensionDir: string;
  extensionId: string | null;
  hostManifestPath: string;
  hostInstalled: boolean;
  hostManifestMatches: boolean;
  hostInstalledEdge: boolean;
  hostManifestMatchesEdge: boolean;
  browsers: string[];
  lastReportedExtensionVersion: string | null;
  lastReportedChannel: "dev" | "prod" | null;
  lastReportedStep: string | null;
  lastReportedErrorCode: string | null;
  lastReportedDurationMs: number | null;
  lastReportedAtMs: number | null;
}

export function browserCaptureStatus(): Promise<BrowserCaptureStatus> {
  requireTauri();
  return invoke<BrowserCaptureStatus>("browser_capture_status");
}

export interface BrowserWorkerSessionStatus {
  status: "running" | "stopped" | "launched" | "opened" | "closed" | "cleared" | "cancelled" | "not_found";
  accountId: number;
  url?: string;
  targetRequestId?: string;
}

export function browserWorkerSessionStatus(accountId: number): Promise<BrowserWorkerSessionStatus> {
  requireTauri();
  return invoke<BrowserWorkerSessionStatus>("browser_worker_status", { accountId });
}

export function openBrowserWorkerSession(accountId: number): Promise<BrowserWorkerSessionStatus> {
  requireTauri();
  return invoke<BrowserWorkerSessionStatus>("open_browser_worker_session", { accountId });
}

export function openBrowserWorkerUrl(accountId: number, url: string): Promise<BrowserWorkerSessionStatus> {
  requireTauri();
  return invoke<BrowserWorkerSessionStatus>("open_browser_worker_url", { accountId, url });
}

export interface LocalProfileRefreshResult {
  state: "complete" | "partial";
  displayName?: string | null;
  profileRefreshed: boolean;
  profileNotesImported: number;
  profileNotesUpdated: number;
  profileNotesComplete: boolean;
}

export function refreshLocalProfile(
  accountPoolId: number,
  xhsAccountId: string,
): Promise<LocalProfileRefreshResult> {
  requireTauri();
  return invoke<LocalProfileRefreshResult>("refresh_local_profile", { accountPoolId, xhsAccountId });
}

export function refreshLocalReferenceProfile(
  accountPoolId: number,
  xhsAccountId: string,
): Promise<LocalProfileRefreshResult> {
  requireTauri();
  return invoke<LocalProfileRefreshResult>("refresh_local_reference_profile", { accountPoolId, xhsAccountId });
}

export function closeBrowserWorkerSession(accountId: number): Promise<BrowserWorkerSessionStatus> {
  requireTauri();
  return invoke<BrowserWorkerSessionStatus>("close_browser_worker_session", { accountId });
}

export function clearBrowserWorkerSession(accountId: number): Promise<BrowserWorkerSessionStatus> {
  requireTauri();
  return invoke<BrowserWorkerSessionStatus>("clear_browser_worker_session", { accountId });
}

export function cancelBrowserWorkerTask(
  accountId: number,
  targetRequestId: string,
): Promise<BrowserWorkerSessionStatus> {
  requireTauri();
  return invoke<BrowserWorkerSessionStatus>("cancel_browser_worker_task", { accountId, targetRequestId });
}
