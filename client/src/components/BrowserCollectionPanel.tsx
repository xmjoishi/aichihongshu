import { useWorkspaceEffect } from "../lib/workspaceActivity";
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BookmarkPlus, ChevronLeft, ChevronRight, ExternalLink, FileText, Globe2, Image as ImageIcon, LoaderCircle, Maximize2, Plus, RefreshCw, RotateCw, Search, Sparkles, Tag, Trash2, UserRound, X } from "lucide-react";
import { useToast } from "./Toast";
import { useAccountContext } from "../lib/accountContext";
import {
  IS_TAURI_RUNTIME,
  LOCAL_INSPIRATIONS_UPDATED_EVENT,
  addBrowserCollectionImageToLibrary,
  createDraftFromLocalInspiration,
  downloadBrowserCollectionImage,
  linkLocalInspirationToTarget,
  promoteLocalInspirationToReferenceAccount,
  readBrowserCollectionImage,
  readLocalInspirationReferences,
  readLocalInspirations,
  readLocalWorkspaceSnapshot,
  removeLocalInspiration,
  saveBrowserCapturePayload,
  saveLocalInspiration,
  unlinkLocalInspirationFromTarget,
  updateLocalInspirationDetails,
  type LocalInspirationCreate,
  type LocalInspirationReferenceSummary,
  type LocalInspirationSummary,
  type LocalInspirationTargetKind,
} from "../lib/local";
import {
  BROWSER_CAPTURE_QUEUE_UPDATED_EVENT,
  markBrowserCaptureFailed,
  markBrowserCaptureSaving,
  removeBrowserCaptureQueueEntry,
  readBrowserCaptureQueue,
  serializeBrowserCapturePayload,
  validateBrowserCapture,
  type BrowserCaptureEnvelope,
  type ValidatedBrowserCapture,
} from "../lib/browserCapture";
import { listInspirations, type Inspiration } from "../lib/inspirationCapture";

type ClippingKind = "account" | "note" | "material";
type ClippingFilter = "all" | ClippingKind;
type ClippingReferenceTarget = { key: string; kind: LocalInspirationTargetKind; id: string; label: string };

function referenceTargetKey(kind: LocalInspirationTargetKind, id: string): string {
  return JSON.stringify([kind, id]);
}

function isXhsAuthorProfile(item: LocalInspirationSummary): boolean {
  try {
    const url = new URL(item.sourceUrl);
    return url.protocol === "https:"
      && url.hostname === "www.xiaohongshu.com"
      && /^\/user\/profile\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname);
  } catch {
    return false;
  }
}

const FILTERS: Array<[ClippingFilter, string]> = [
  ["all", "全部"],
  ["account", "账号剪藏"],
  ["note", "笔记剪藏"],
  ["material", "素材剪藏"],
];

function legacyInspirationToLocal(item: Inspiration): LocalInspirationCreate {
  return {
    id: item.id,
    accountPoolId: item.accountId,
    title: item.title,
    sourceUrl: item.sourceUrl,
    body: item.body,
    observedAt: item.observedAt,
    reason: item.reason,
    dedupeKey: item.dedupeKey,
    materialType: item.materialType ?? "web_material",
    author: item.author ?? "",
    captureModules: item.captureModules ?? [],
  };
}

function captureToLocal(capture: ValidatedBrowserCapture, id: string, accountPoolId: number): LocalInspirationCreate {
  return {
    id,
    accountPoolId,
    title: capture.title,
    sourceUrl: capture.sourceUrl,
    body: capture.modules.collect.titleBody ? capture.body : "",
    observedAt: capture.observedAt,
    reason: capture.reason,
    dedupeKey: capture.dedupeKey,
    materialType: capture.materialType,
    author: capture.modules.collect.authorSource ? capture.author : "",
    capturePayload: serializeBrowserCapturePayload(capture),
    captureModules: [
      ...(capture.modules.collect.titleBody ? ["titleBody"] : []),
      ...(capture.modules.collect.authorSource ? ["authorSource"] : []),
      ...(capture.modules.data.metrics ? ["metrics"] : []),
    ],
  };
}

async function saveCaptureToLocal(capture: ValidatedBrowserCapture, id: string, accountPoolId: number) {
  const inspiration = captureToLocal(capture, id, accountPoolId);
  await saveLocalInspiration(inspiration);
  if (inspiration.capturePayload) await saveBrowserCapturePayload(id, accountPoolId, inspiration.capturePayload);
}

function bodyWithoutRepeatedTitle(body: string, title: string): string {
  const trimmedBody = body.trimStart();
  const trimmedTitle = title.trim();
  if (!trimmedTitle || !trimmedBody.startsWith(trimmedTitle)) return body;
  return trimmedBody.slice(trimmedTitle.length).replace(/^[\s:：，,。.!！?？、—-]+/u, "").trim();
}

function sourceLabel(sourceUrl: string): string {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./i, "");
    return host.includes("xiaohongshu") ? "小红书 · 打开原文" : `${host} · 打开原文`;
  } catch {
    return "打开原文";
  }
}

type CapturePayload = {
  comments?: Array<{ author?: string; text?: string; likes?: number | null; truncated?: boolean }>;
  importedItemIds?: number[];
  tags?: string[];
  metrics?: Partial<Record<"like" | "collect" | "comment" | "share" | "followers" | "follows" | "noteCount", number | null>>;
  profile?: {
    avatarUrl?: string | null;
    bio?: string;
    follows?: number | null;
    ipLocation?: string;
    tags?: string[];
  };
  publishedAt?: string | null;
  publishedLocation?: string | null;
};

function parseCapturePayload(raw?: string): CapturePayload {
  try {
    const value = JSON.parse(raw || "{}") as CapturePayload;
    return {
      comments: Array.isArray(value.comments) ? value.comments.slice(0, 20) : [],
      importedItemIds: Array.isArray(value.importedItemIds) ? value.importedItemIds.filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 12) : [],
      tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 30) : [],
      metrics: value.metrics && typeof value.metrics === "object" ? value.metrics : {},
      profile: value.profile && typeof value.profile === "object" ? value.profile : {},
      publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : null,
      publishedLocation: typeof value.publishedLocation === "string" ? value.publishedLocation : null,
    };
  } catch {
    return {};
  }
}

function clippingKind(item: LocalInspirationSummary): ClippingKind {
  if (item.clipKind === "account" || item.materialType === "profile_material") return "account";
  if (item.clipKind === "material" || item.materialType === "image_material") return "material";
  return "note";
}

function clipTypeLabel(item: LocalInspirationSummary): string {
  const kind = clippingKind(item);
  if (kind === "account") return "账号剪藏";
  if (kind === "material") return "素材剪藏";
  let host = "";
  try { host = new URL(item.sourceUrl).hostname.toLowerCase(); } catch { /* keep a generic label */ }
  return host.includes("xiaohongshu.com") || host.endsWith("xhslink.com") ? "小红书笔记" : "网页文章";
}

function kindIcon(item: LocalInspirationSummary) {
  const kind = clippingKind(item);
  if (kind === "account") return <UserRound size={13} />;
  if (kind === "material") return <ImageIcon size={13} />;
  return item.materialType === "note_material" ? <FileText size={13} /> : <Globe2 size={13} />;
}

function metricText(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat("zh-CN").format(value) : "未知";
}

function CollectionThumbnail({
  item,
  position,
  className,
}: {
  item: LocalInspirationSummary;
  position: number;
  className?: string;
}) {
  const [src, setSrc] = useState("");
  const [readError, setReadError] = useState("");
  const attachment = item.collectionImages.find((image) => image.position === position);
  useEffect(() => {
    let active = true;
    setSrc("");
    setReadError("");
    if (attachment?.status === "ready" && attachment.thumbnailAvailable) {
      void readBrowserCollectionImage(item.id, item.accountPoolId, position, true)
        .then((image) => { if (active) setSrc(image); })
        .catch((error) => { if (active) { setSrc(""); setReadError(error instanceof Error ? error.message : String(error)); } });
    }
    return () => { active = false; };
  }, [attachment?.status, attachment?.thumbnailAvailable, item.accountPoolId, item.id, position]);
  if (!src) return <div className={`${className ?? ""} flex flex-col items-center justify-center gap-1 bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]`} title={readError || undefined}><ImageIcon size={22} />{readError && <span className="px-2 text-center text-[10px]">本地缩略图读取失败</span>}</div>;
  return <img src={src} alt="剪藏图片封面" className={`${className ?? ""} object-contain`} />;
}

export default function BrowserCollectionPanel({ hideAccountLabel = false }: { hideAccountLabel?: boolean } = {}) {
  const { toast } = useToast();
  const { accountId, accountAlias, databaseIdentity } = useAccountContext();
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const [filter, setFilter] = useState<ClippingFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateRangeEnabled, setDateRangeEnabled] = useState(false);
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest" | "title">("newest");
  const [inspirations, setInspirations] = useState<LocalInspirationSummary[]>([]);
  const [captureFailures, setCaptureFailures] = useState<BrowserCaptureEnvelope[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [activeDetail, setActiveDetail] = useState<LocalInspirationSummary | null>(null);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [originalImageData, setOriginalImageData] = useState("");
  const [originalImageError, setOriginalImageError] = useState("");
  const [zoomedImage, setZoomedImage] = useState(false);
  const [detailNote, setDetailNote] = useState("");
  const [detailTags, setDetailTags] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busyImages, setBusyImages] = useState<Record<string, boolean>>({});
  const [backfillProgress, setBackfillProgress] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [backfillReport, setBackfillReport] = useState<{ attempted: number; failed: number } | null>(null);
  const [activeReferences, setActiveReferences] = useState<LocalInspirationReferenceSummary[]>([]);
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [referenceTargets, setReferenceTargets] = useState<ClippingReferenceTarget[]>([]);
  const [referenceTargetsAccount, setReferenceTargetsAccount] = useState<number | null>(null);
  const [referenceTargetsLoading, setReferenceTargetsLoading] = useState(false);
  const [referenceTargetSelection, setReferenceTargetSelection] = useState("");
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [promotingAccount, setPromotingAccount] = useState(false);
  const detailPanelRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useWorkspaceEffect(() => {
    if (!IS_TAURI_RUNTIME || accountId === null) {
      setCaptureFailures([]);
      return;
    }
    const refresh = () => setCaptureFailures(readBrowserCaptureQueue(databaseIdentity, accountId).filter((entry) => entry.status === "failed"));
    refresh();
    window.addEventListener(BROWSER_CAPTURE_QUEUE_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(BROWSER_CAPTURE_QUEUE_UPDATED_EVENT, refresh);
  }, [accountId, databaseIdentity]);

  useEffect(() => {
    if (!IS_TAURI_RUNTIME || accountId === null) {
      setInspirations([]);
      return;
    }
    let active = true;
    setLoading(true);
    void (async () => {
      let items = await readLocalInspirations(accountId);
      // Migrate pre-SQLite manually saved bookmarks once, only when the local
      // table is empty. This preserves existing captures without duplicate rewrites.
      if (items.length === 0) {
        const legacy = listInspirations(databaseIdentity, accountId);
        for (const item of legacy) {
          try { await saveLocalInspiration(legacyInspirationToLocal(item)); }
          catch { /* Skip an invalid old entry and keep migrating the rest. */ }
        }
        if (legacy.length > 0) items = await readLocalInspirations(accountId);
      }

      // Upgrade pending captures from the previous confirmation-queue flow.
      // Persist them into SQLite and remove their transient envelopes only
      // after the database confirms the write.
      const oldCaptures = readBrowserCaptureQueue(databaseIdentity, accountId);
      for (const entry of oldCaptures) {
        if (entry.status === "saved") {
          removeBrowserCaptureQueueEntry(databaseIdentity, accountId, entry.envelopeId);
          continue;
        }
        try {
          await saveCaptureToLocal(entry.capture, entry.envelopeId, accountId);
          removeBrowserCaptureQueueEntry(databaseIdentity, accountId, entry.envelopeId);
        } catch (error) {
          markBrowserCaptureFailed(databaseIdentity, accountId, entry.envelopeId, error instanceof Error ? error.message : String(error));
        }
      }
      items = await readLocalInspirations(accountId);
      if (active) {
        setInspirations(items);
        setCaptureFailures(readBrowserCaptureQueue(databaseIdentity, accountId).filter((entry) => entry.status === "failed"));
      }
    })()
      .catch((error) => {
        if (active) toast(`读取剪藏失败：${(error as Error).message}`, "error");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [accountId, databaseIdentity, toast]);

  useWorkspaceEffect(() => {
    if (!IS_TAURI_RUNTIME || accountId === null) return;
    let visible = true;
    const onUpdated = (event?: Event) => {
      const updatedAccount = (event as CustomEvent<{ accountPoolId?: number }> | undefined)?.detail?.accountPoolId;
      if (updatedAccount !== undefined && updatedAccount !== accountId) return;
      void readLocalInspirations(accountId).then((items) => {
        if (!visible) return;
        setInspirations(items);
        setActiveDetail((current) => current ? items.find((item) => item.id === current.id) ?? null : null);
      }).catch((error) => {
        if (visible) toast(`刷新剪藏失败：${(error as Error).message}`, "error");
      });
    };
    // Catch up on captures received while this retained page was hidden.
    onUpdated();
    window.addEventListener(LOCAL_INSPIRATIONS_UPDATED_EVENT, onUpdated);
    return () => { visible = false; window.removeEventListener(LOCAL_INSPIRATIONS_UPDATED_EVENT, onUpdated); };
  }, [accountId, toast]);

  useWorkspaceEffect(() => {
    if (!IS_TAURI_RUNTIME || accountId === null) return;
    let unlisten: (() => void) | undefined;
    void listen<{ accountPoolId?: number; inspirationId?: string }>("aichihongshu-collection-images-updated", (event) => {
      if (event.payload.accountPoolId !== undefined && event.payload.accountPoolId !== accountId) return;
      void readLocalInspirations(accountId).then((items) => {
        setInspirations(items);
        if (event.payload.inspirationId) {
          const refreshed = items.find((item) => item.id === event.payload.inspirationId);
          if (refreshed) setActiveDetail(refreshed);
        }
      }).catch((error) => toast(`刷新剪藏图片状态失败：${(error as Error).message}`, "error"));
    }).then((stop) => { unlisten = stop; });
    return () => { unlisten?.(); };
  }, [accountId, toast]);

  useWorkspaceEffect(() => {
    if (activeDetail) {
      detailPanelRef.current?.focus();
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (zoomedImage) setZoomedImage(false);
          else closeDetail();
        } else if (event.key === "ArrowRight" && activeDetail.collectionImages.length > 1 && !zoomedImage) {
          event.preventDefault();
          setActiveImageIndex((index) => (index + 1) % activeDetail.collectionImages.length);
        } else if (event.key === "ArrowLeft" && activeDetail.collectionImages.length > 1 && !zoomedImage) {
          event.preventDefault();
          setActiveImageIndex((index) => (index - 1 + activeDetail.collectionImages.length) % activeDetail.collectionImages.length);
        } else if (event.key === "Tab" && detailPanelRef.current) {
          const focusable = [...detailPanelRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]',
          )].filter((element) => !element.hasAttribute("hidden"));
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }
    if (!createOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCreateOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDetail, createOpen, zoomedImage]);

  useEffect(() => {
    let active = true;
    const attachment = activeDetail?.collectionImages[activeImageIndex];
    setOriginalImageData("");
    setOriginalImageError("");
    if (attachment?.status === "ready" && attachment.originalAvailable && activeDetail) {
      void readBrowserCollectionImage(activeDetail.id, activeDetail.accountPoolId, attachment.position, false)
        .then((image) => { if (active) setOriginalImageData(image); })
        .catch((error) => { if (active) { setOriginalImageData(""); setOriginalImageError(error instanceof Error ? error.message : String(error)); } });
    }
    return () => { active = false; };
  }, [activeDetail?.id, activeDetail?.accountPoolId, activeDetail?.collectionImages, activeImageIndex]);

  useWorkspaceEffect(() => {
    if (!IS_TAURI_RUNTIME || !activeDetail || accountId !== activeDetail.accountPoolId) {
      setActiveReferences([]);
      setReferencesLoading(false);
      return;
    }
    let active = true;
    setReferencesLoading(true);
    setActiveReferences([]);
    void readLocalInspirationReferences(activeDetail.id, activeDetail.accountPoolId)
      .then((references) => { if (active) setActiveReferences(references); })
      .catch((error) => { if (active) toast(`读取剪藏引用失败：${error instanceof Error ? error.message : String(error)}`, "error"); })
      .finally(() => { if (active) setReferencesLoading(false); });
    return () => { active = false; };
  }, [accountId, activeDetail?.accountPoolId, activeDetail?.id, toast]);

  const matchingInspirations = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase();
    if (!query) return inspirations;
    return inspirations.filter((item) => {
      const payload = parseCapturePayload(item.capturePayload);
      return [item.title, item.body, item.author, item.sourceUrl, item.reason, ...(payload.profile?.bio ? [payload.profile.bio] : []), ...item.collectionTags, ...(payload.tags ?? []), ...(payload.profile?.tags ?? [])]
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [inspirations, searchTerm]);
  const availableSources = useMemo(() => [...new Set(inspirations.map((item) => {
    try { return new URL(item.sourceUrl).hostname.replace(/^www\./i, ""); } catch { return "手动剪藏"; }
  }).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN")), [inspirations]);
  const availableTags = useMemo(() => [...new Set(inspirations.flatMap((item) => {
    const payload = parseCapturePayload(item.capturePayload);
    return [...item.collectionTags, ...(payload.tags ?? []), ...(payload.profile?.tags ?? [])];
  }))].sort((a, b) => a.localeCompare(b, "zh-CN")), [inspirations]);
  const incompleteImages = useMemo(() => inspirations.flatMap((item) => item.collectionImages
    .filter((image) => image.sourceKind === "legacy_url" && (image.status === "pending" || image.status === "failed"))
    .map((image) => ({ item, position: image.position }))), [inspirations]);
  const visibleInspirations = useMemo(() => {
    const filtered = matchingInspirations.filter((item) => {
      if (filter !== "all" && clippingKind(item) !== filter) return false;
      const host = (() => { try { return new URL(item.sourceUrl).hostname.replace(/^www\./i, ""); } catch { return "手动剪藏"; } })();
      if (sourceFilter !== "all" && sourceFilter !== host) return false;
      if (tagFilter !== "all") {
        const payload = parseCapturePayload(item.capturePayload);
        if (![...item.collectionTags, ...(payload.tags ?? []), ...(payload.profile?.tags ?? [])].includes(tagFilter)) return false;
      }
      const timestamp = Date.parse(item.observedAt);
      if (dateRangeEnabled && dateFrom && timestamp < Date.parse(`${dateFrom}T00:00:00`)) return false;
      if (dateRangeEnabled && dateTo && timestamp >= Date.parse(`${dateTo}T00:00:00`) + 86_400_000) return false;
      return true;
    });
    return filtered.sort((left, right) => {
      if (sortOrder === "title") return left.title.localeCompare(right.title, "zh-CN");
      const leftTime = Date.parse(left.observedAt) || 0;
      const rightTime = Date.parse(right.observedAt) || 0;
      return sortOrder === "newest" ? rightTime - leftTime : leftTime - rightTime;
    });
  }, [dateFrom, dateRangeEnabled, dateTo, filter, matchingInspirations, sortOrder, sourceFilter, tagFilter]);
  async function refreshInspirations() {
    if (accountId === null) return;
    const items = await readLocalInspirations(accountId);
    setInspirations(items);
    if (activeDetail) setActiveDetail(items.find((item) => item.id === activeDetail.id) ?? null);
  }

  function openDetail(item: LocalInspirationSummary, trigger: HTMLElement) {
    returnFocusRef.current = trigger;
    setActiveDetail(item);
    setActiveImageIndex(0);
    setDetailNote(item.reason);
    setDetailTags(item.collectionTags.join("，"));
    setReferenceTargetSelection("");
    setConfirmRemove(false);
    setZoomedImage(false);
  }

  function closeDetail() {
    setActiveDetail(null);
    setZoomedImage(false);
    setConfirmRemove(false);
    requestAnimationFrame(() => returnFocusRef.current?.focus());
  }

  async function downloadCollectionImage(item: LocalInspirationSummary, position: number) {
    const image = item.collectionImages.find((candidate) => candidate.position === position);
    if (!image || image.sourceKind !== "legacy_url") {
      toast("新剪藏图片由扩展直接保存在本地，不能通过旧 URL 补图", "info");
      return;
    }
    if (accountId !== item.accountPoolId || busyImages[`${item.id}:${position}`]) {
      if (accountId !== item.accountPoolId) toast("当前账号已变化，请切回原剪藏账号后重试", "error");
      return;
    }
    const key = `${item.id}:${position}`;
    setBusyImages((current) => ({ ...current, [key]: true }));
    try {
      const outcome = await downloadBrowserCollectionImage(item.id, item.accountPoolId, position);
      await refreshInspirations();
      if (outcome.status === "ready") toast("图片已保存到本地", "success");
      else toast(outcome.error || "图片下载失败；文字剪藏仍已保存", "warning");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusyImages((current) => ({ ...current, [key]: false }));
    }
  }

  async function retryFailedImages(item: LocalInspirationSummary) {
    for (const image of item.collectionImages.filter((candidate) => candidate.sourceKind === "legacy_url" && (candidate.status === "failed" || candidate.status === "pending"))) {
      await downloadCollectionImage(item, image.position);
    }
  }

  async function backfillIncompleteImages() {
    if (accountId === null || backfillProgress) return;
    const batch = incompleteImages.slice(0, 50);
    if (!batch.length) return;
    setBackfillReport(null);
    setBackfillProgress({ done: 0, total: batch.length, failed: 0 });
    let failed = 0;
    for (const { item, position } of batch) {
      if (accountId !== item.accountPoolId) {
        failed += 1;
      } else {
        try {
          const outcome = await downloadBrowserCollectionImage(item.id, item.accountPoolId, position);
          if (outcome.status !== "ready") failed += 1;
        } catch {
          failed += 1;
        }
      }
      setBackfillProgress((current) => current ? { ...current, done: current.done + 1, failed } : current);
    }
    await refreshInspirations();
    setBackfillProgress(null);
    setBackfillReport({ attempted: batch.length, failed });
    toast(failed ? `本次处理 ${batch.length} 张图片，${failed} 张仍需重试` : `已完成 ${batch.length} 张本地图片`, failed ? "warning" : "success");
  }

  async function saveDetailChanges() {
    if (!activeDetail || accountId !== activeDetail.accountPoolId || savingDetails) return;
    const tags = detailTags.split(/[，,\n]/u).map((tag) => tag.trim()).filter(Boolean);
    setSavingDetails(true);
    try {
      await updateLocalInspirationDetails(activeDetail.id, activeDetail.accountPoolId, detailNote, tags);
      await refreshInspirations();
      toast("备注和标签已保存", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSavingDetails(false);
    }
  }

  async function addImageToLibrary(item: LocalInspirationSummary, position: number) {
    if (accountId !== item.accountPoolId) {
      toast("当前账号已变化，请切回原剪藏账号后再加入素材", "error");
      return;
    }
    try {
      const asset = await addBrowserCollectionImageToLibrary(item.id, item.accountPoolId, position);
      await refreshInspirations();
      toast(`已加入创作素材：${asset.title}`, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function loadReferenceTargets(item: LocalInspirationSummary, force = false) {
    if ((!force && referenceTargetsAccount === item.accountPoolId) || referenceTargetsLoading) return;
    setReferenceTargetsLoading(true);
    try {
      const snapshot = await readLocalWorkspaceSnapshot(item.accountPoolId, "all");
      const targets: ClippingReferenceTarget[] = [
        ...snapshot.notes.filter((note) => !note.deletedAt).map((note) => ({
          kind: "note" as const,
          id: String(note.id),
          label: `笔记 · ${note.title?.trim() || `笔记 ${note.id}`}`,
        })),
        ...snapshot.items.map((asset) => ({
          kind: "item" as const,
          id: String(asset.id),
          label: `素材 · ${asset.title?.trim() || `素材 ${asset.id}`}`,
        })),
        ...snapshot.referenceAccounts.map((account) => ({
          kind: "reference_account" as const,
          id: account.accountId,
          label: `榜样 · ${account.name?.trim() || account.accountId}`,
        })),
        ...inspirations.filter((candidate) => candidate.id !== item.id && candidate.accountPoolId === item.accountPoolId).map((candidate) => ({
          kind: "inspiration" as const,
          id: candidate.id,
          label: `${clipTypeLabel(candidate)} · ${candidate.title || candidate.id}`,
        })),
        ...availableTags.filter((tag) => tag.trim()).map((tag) => ({ kind: "topic" as const, id: tag.trim(), label: `话题 · ${tag.trim()}` })),
      ].map((target) => ({ ...target, key: referenceTargetKey(target.kind, target.id) }));
      setReferenceTargets(targets);
      setReferenceTargetsAccount(item.accountPoolId);
    } catch (error) {
      toast(`读取可引用对象失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setReferenceTargetsLoading(false);
    }
  }

  async function refreshReferenceList(item: LocalInspirationSummary) {
    const references = await readLocalInspirationReferences(item.id, item.accountPoolId);
    setActiveReferences(references);
    return references;
  }

  async function addClipReference(item: LocalInspirationSummary) {
    if (accountId !== item.accountPoolId || referenceBusy) return;
    const target = referenceTargets.find((candidate) => candidate.key === referenceTargetSelection);
    if (!target) return;
    setReferenceBusy(true);
    try {
      const result = await linkLocalInspirationToTarget(item.id, item.accountPoolId, target.kind, target.id);
      await refreshReferenceList(item);
      setReferenceTargetSelection("");
      toast(result.created ? `已关联：${target.label}` : `已有关联：${target.label}`, result.created ? "success" : "info");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setReferenceBusy(false);
    }
  }

  async function removeClipReference(item: LocalInspirationSummary, reference: LocalInspirationReferenceSummary) {
    if (accountId !== item.accountPoolId || referenceBusy) return;
    setReferenceBusy(true);
    try {
      await unlinkLocalInspirationFromTarget(item.id, item.accountPoolId, reference.targetKind, reference.targetId);
      await refreshReferenceList(item);
      toast("已取消这条剪藏关联；剪藏、引用目标与本地文件均保留", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setReferenceBusy(false);
    }
  }

  async function promoteClippedAccount(item: LocalInspirationSummary) {
    if (accountId !== item.accountPoolId || promotingAccount) return;
    setPromotingAccount(true);
    try {
      const result = await promoteLocalInspirationToReferenceAccount(item.id, item.accountPoolId);
      await refreshReferenceList(item);
      toast(result.linkCreated ? `已加入榜样：${result.name || item.author || result.platformAccountId}` : "该榜样账号已关联此剪藏", result.linkCreated ? "success" : "info");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setPromotingAccount(false);
    }
  }

  async function cancelCollection() {
    if (!activeDetail || accountId !== activeDetail.accountPoolId) return;
    try {
      await removeLocalInspiration(activeDetail.id, activeDetail.accountPoolId);
      await refreshInspirations();
      toast("已从剪藏移除；本地图片文件保留", "success");
      closeDetail();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function retryCaptureSave(envelope: BrowserCaptureEnvelope) {
    if (!IS_TAURI_RUNTIME || accountId === null) return;
    if (envelope.targetAccountId !== accountId) {
      toast("当前账号已变化，请切回原账号后重试", "error");
      return;
    }
    if (envelope.status === "saving") return;
    const saving = markBrowserCaptureSaving(databaseIdentity, accountId, envelope.envelopeId);
    if (!saving) {
      toast("旧剪藏记录已变化，请刷新后重试", "error");
      return;
    }
    try {
      await saveCaptureToLocal(saving.capture, saving.envelopeId, accountId);
      removeBrowserCaptureQueueEntry(databaseIdentity, accountId, envelope.envelopeId);
      await refreshInspirations();
      toast("旧剪藏已迁入本地剪藏", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markBrowserCaptureFailed(databaseIdentity, accountId, envelope.envelopeId, message);
      toast(`${message}；可以点击重试`, "error");
    }
  }

  async function saveManualCapture() {
    if (!IS_TAURI_RUNTIME || accountId === null || savingManual) return;
    const validated = validateBrowserCapture({
      title,
      sourceUrl,
      body,
      reason,
      targetAccountId: accountId,
      transport: "manual",
    }, accountId);
    if (!validated.ok) {
      toast(validated.message, "error");
      return;
    }
    try {
      setSavingManual(true);
      const capture = validated.value;
      await saveCaptureToLocal(capture, `manual:${crypto.randomUUID()}`, accountId);
      setTitle("");
      setSourceUrl("");
      setBody("");
      setReason("");
      setCreateOpen(false);
      await refreshInspirations();
      toast("剪藏已保存", "success");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setSavingManual(false);
    }
  }

  async function convertToDraft(item: LocalInspirationSummary) {
    if (!IS_TAURI_RUNTIME || accountId === null || item.status === "converted") return;
    try {
      const result = await createDraftFromLocalInspiration(item.id, accountId);
      await refreshInspirations();
      toast(`已转为笔记草稿：${result.note.title || item.title}`, "success");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-canvas)] p-6">
      <div className="mx-auto w-full max-w-[1600px] space-y-5 pb-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="sr-only">剪藏内容</h2>
          <div className="flex items-center gap-3">
            {!hideAccountLabel && <span className="text-xs text-[var(--color-text-secondary)]">{accountId === null ? "等待当前账号就绪" : `保存到 ${accountAlias || "当前账号"}`}</span>}
            {IS_TAURI_RUNTIME && <button type="button" onClick={() => setCreateOpen(true)} disabled={accountId === null} className="inline-flex items-center gap-1.5 rounded-xl bg-[#ff2442] px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-[#e61f3b] disabled:opacity-50"><Plus size={16} />新增笔记剪藏</button>}
          </div>
        </div>

        {!IS_TAURI_RUNTIME ? (
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-text-secondary)]">
            剪藏内容保存在桌面端本地数据库，请在桌面应用中查看。
          </div>
        ) : (
          <>
            {captureFailures.length > 0 && (
              <section className="rounded-2xl border border-red-200 bg-red-50/70 p-4">
                <div className="mb-3 flex items-center justify-between text-sm font-medium text-red-800">
                  <span>旧剪藏迁入失败 · {captureFailures.length}</span>
                  <span className="text-xs font-normal">重试成功后会直接出现在剪藏卡片中</span>
                </div>
                <div className="space-y-2">
                  {captureFailures.map((entry) => (
                    <div key={entry.envelopeId} className="flex flex-wrap items-center gap-2 rounded-lg border border-red-100 bg-white px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{entry.capture.title}</span>
                      <span className="text-xs text-red-600">保存失败</span>
                      {entry.error && <span className="max-w-[220px] truncate text-xs text-red-500" title={entry.error}>{entry.error}</span>}
                      <button type="button" disabled={entry.status === "saving"} onClick={() => void retryCaptureSave(entry)} className="shrink-0 rounded-md border border-[#ff2442] px-2.5 py-1 text-xs text-[#ff2442] disabled:opacity-40">重试入库</button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text-primary)]"><Sparkles size={16} className="text-[#ff2442]" />已剪藏</div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <label className="flex h-9 min-w-[220px] items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[var(--color-text-secondary)] focus-within:border-[#ff2442]">
                  <Search size={14} />
                  <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="搜索标题、正文、作者、来源" className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-secondary)]" />
                </label>
                <select aria-label="剪藏排序" value={sortOrder} onChange={(event) => setSortOrder(event.target.value as "newest" | "oldest" | "title")} className="h-9 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs text-[var(--color-text-secondary)] outline-none focus:border-[#ff2442]">
                  <option value="newest">最近采集</option>
                  <option value="oldest">最早采集</option>
                  <option value="title">标题排序</option>
                </select>
                <div role="group" aria-label="按剪藏类型筛选" className="flex flex-wrap gap-1.5">
                  {FILTERS.map(([key, label]) => (
                    <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={`rounded-full border bg-[var(--color-surface)] px-3 py-1.5 text-xs transition-colors ${filter === key ? "border-[#ff2442] text-[#ff2442]" : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"}`}>
                      {label}{key === "all" ? ` · ${matchingInspirations.length}` : ` · ${matchingInspirations.filter((item) => clippingKind(item) === key).length}`}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
              <label className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">来源
                <select aria-label="按来源筛选剪藏" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} className="h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text-primary)]">
                  <option value="all">全部来源</option>
                  {availableSources.map((source) => <option key={source} value={source}>{source}</option>)}
                </select>
              </label>
                <label className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">采集时间
                <select aria-label="采集时间范围" value={dateRangeEnabled ? "range" : "all"} onChange={(event) => { const enabled = event.target.value === "range"; setDateRangeEnabled(enabled); if (!enabled) { setDateFrom(""); setDateTo(""); } }} className="h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text-primary)]">
                  <option value="all">全部时间</option>
                  <option value="range">自定义范围</option>
                </select>
                {dateRangeEnabled && <><input aria-label="采集起始日期" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text-primary)]" /><span>至</span><input aria-label="采集结束日期" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text-primary)]" /></>}
              </label>
              <label className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]"><Tag size={12} />标签
                <select aria-label="按剪藏标签筛选" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} className="h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text-primary)]">
                  <option value="all">全部标签</option>
                  {availableTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
                </select>
              </label>
              {(sourceFilter !== "all" || tagFilter !== "all" || dateRangeEnabled) && <button type="button" onClick={() => { setSourceFilter("all"); setTagFilter("all"); setDateFrom(""); setDateTo(""); setDateRangeEnabled(false); }} className="ml-auto rounded-md px-2 py-1 text-xs text-[#ff2442] hover:bg-[var(--color-surface-2)]">清除筛选</button>}
            </div>
            {(incompleteImages.length > 0 || backfillProgress || backfillReport) && <section className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
              <span>{backfillProgress ? `旧剪藏图片补全 ${backfillProgress.done}/${backfillProgress.total}，失败 ${backfillProgress.failed} 张` : backfillReport ? `最近一次旧图补全：处理 ${backfillReport.attempted} 张，${backfillReport.failed} 张仍需重试` : `旧剪藏中的 URL 图片待补全 ${incompleteImages.length} 张；新剪藏图片由扩展直接落到本地`}</span>
              {incompleteImages.length > 0 && <button type="button" disabled={Boolean(backfillProgress)} onClick={() => void backfillIncompleteImages()} className="rounded-lg border border-amber-400 bg-white px-2.5 py-1.5 font-medium disabled:opacity-50">{backfillProgress ? "正在补全…" : `补全旧剪藏图片（最多 50 张）`}</button>}
            </section>}
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--color-text-secondary)]"><RefreshCw size={15} className="animate-spin" />正在读取剪藏…</div>
              ) : visibleInspirations.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-12 text-center text-sm text-[var(--color-text-secondary)]">
                  {searchTerm.trim() || sourceFilter !== "all" || tagFilter !== "all" || dateFrom || dateTo
                    ? "没有找到符合当前条件的剪藏。"
                    : `这里还没有${filter === "all" ? "剪藏内容" : FILTERS.find(([key]) => key === filter)?.[1]}。使用浏览器插件剪藏，或点击「新增笔记剪藏」。`}
                </div>
              ) : (
                <div className="clipping-masonry">
                  {visibleInspirations.map((item) => {
                    const kind = clippingKind(item);
                    const payload = parseCapturePayload(item.capturePayload);
                    const profile = payload.profile ?? {};
                    const body = bodyWithoutRepeatedTitle(kind === "account" ? profile.bio || item.body : item.body, item.title);
                    const readyCount = item.collectionImages.filter((image) => image.status === "ready" && image.thumbnailAvailable).length;
                    const failedCount = item.collectionImages.filter((image) => image.status === "failed").length;
                    const pendingCount = item.collectionImages.filter((image) => image.status === "pending").length;
                    const downloadingCount = item.collectionImages.filter((image) => image.status === "downloading").length;
                    const retryableCount = item.collectionImages.filter((image) => image.sourceKind === "legacy_url" && (image.status === "pending" || image.status === "failed")).length;
                    const extensionFailedCount = item.collectionImages.filter((image) => image.sourceKind === "extension_bytes" && image.status === "failed").length;
                    const cover = item.collectionImages.find((image) => image.status === "ready" && image.thumbnailAvailable);
                    let host = "手动剪藏";
                    try { host = new URL(item.sourceUrl).hostname.replace(/^www\./i, ""); } catch { /* use the manual label */ }
                    const timestamp = Date.parse(item.observedAt);
                    return <article key={item.id} className="clipping-card overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                      <button type="button" aria-label={`打开${clipTypeLabel(item)}：${item.title || "未命名剪藏"}`} onClick={(event) => openDetail(item, event.currentTarget)} className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff2442]">
                        {item.collectionImages.length > 0 && <div className={`relative flex items-center justify-center overflow-hidden bg-[var(--color-surface-2)] ${cover ? "max-h-[380px]" : "min-h-[68px] max-h-24"}`}>
                          {cover
                            ? <CollectionThumbnail item={item} position={cover.position} className="max-h-[380px] max-w-full" />
                            : <div className="flex flex-col items-center gap-1.5 px-4 py-3 text-center text-xs text-[var(--color-text-secondary)]"><ImageIcon size={20} /><span>{downloadingCount ? `图片正在保存 · 本地完成 ${readyCount}/${item.collectionImages.length}` : extensionFailedCount ? `扩展图片未能保存在本地 · 请重新剪藏` : retryableCount ? `旧剪藏图片等待补全 · 本地完成 ${readyCount}/${item.collectionImages.length}` : pendingCount ? `等待扩展图片落地 · 本地完成 ${readyCount}/${item.collectionImages.length}` : `图片未完成 · 本地完成 ${readyCount}/${item.collectionImages.length}`}</span></div>}
                          {item.collectionImages.length > 1 && <span className="absolute bottom-3 right-3 rounded-full bg-black/65 px-2.5 py-1 text-[10px] text-white">{item.collectionImages.length} 张图片</span>}
                          {failedCount > 0 && <span className="absolute left-3 top-3 rounded-full bg-red-600/90 px-2.5 py-1 text-[10px] text-white">{failedCount} 张失败</span>}
                        </div>}
                        <div className="space-y-2.5 p-4">
                          <div className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-2)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-text-secondary)]">{kindIcon(item)}{clipTypeLabel(item)}</div>
                          <h3 className="line-clamp-2 text-[15px] font-semibold leading-6 text-[var(--color-text-primary)]">{item.title || "未命名剪藏"}</h3>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-secondary)]">
                            {item.author && <span className="max-w-[45%] truncate font-medium text-[var(--color-text-primary)]">{item.author}</span>}
                            <span className="max-w-[45%] truncate">{host}</span>
                            <span>·</span>
                            <time dateTime={item.observedAt}>{Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString() : "时间未知"}</time>
                          </div>
                          {body ? <p className="line-clamp-3 whitespace-pre-line text-xs leading-5 text-[var(--color-text-secondary)]">{body}</p> : <p className="text-xs text-[var(--color-text-secondary)]">暂无正文摘录</p>}
                          {kind === "account" && <p className="text-[10px] text-[var(--color-text-secondary)]">粉丝 {metricText(payload.metrics?.followers)} · 关注 {metricText(profile.follows)} · 笔记 {metricText(payload.metrics?.noteCount)}</p>}
                          {kind === "note" && <p className="text-[10px] text-[var(--color-text-secondary)]">赞 {metricText(payload.metrics?.like)} · 收藏 {metricText(payload.metrics?.collect)} · 评论 {metricText(payload.metrics?.comment)} · 转发 {metricText(payload.metrics?.share)}</p>}
                          {item.collectionImages.length > 0 && <p className={`text-[10px] ${failedCount ? "text-amber-700" : "text-[var(--color-text-secondary)]"}`}>
                            {`本地图片 ${readyCount}/${item.collectionImages.length}${downloadingCount ? " · 保存中" : retryableCount ? ` · 旧图待补全 ${retryableCount}` : extensionFailedCount ? ` · 扩展保存失败 ${extensionFailedCount}` : pendingCount ? " · 等待本地写入" : failedCount ? ` · 保存失败 ${failedCount}` : " · 已完成"}`}
                          </p>}
                          {item.collectionImages.find((image) => image.error)?.error && <p className="line-clamp-1 text-[10px] text-amber-700" title={item.collectionImages.find((image) => image.error)?.error || undefined}>{item.collectionImages.find((image) => image.error)?.error}</p>}
                          {item.collectionTags.length > 0 && <div className="flex flex-wrap gap-1.5">{item.collectionTags.slice(0, 5).map((tag) => <span key={tag} className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">#{tag}</span>)}</div>}
                          {item.status === "converted" && <span className="inline-block text-[10px] text-emerald-700">已转为草稿</span>}
                        </div>
                      </button>
                    </article>
                  })}
                </div>
              )}
          </>
        )}
      </div>
      {activeDetail && IS_TAURI_RUNTIME && (() => {
        const images = activeDetail.collectionImages;
        const currentImage = images[activeImageIndex];
        const payload = parseCapturePayload(activeDetail.capturePayload);
        const kind = clippingKind(activeDetail);
        const profile = payload.profile ?? {};
        const metrics = payload.metrics ?? {};
        const comments = payload.comments ?? [];
        const roleModelReference = activeReferences.find((reference) => reference.targetKind === "reference_account");
        const detailBody = kind === "account" ? profile.bio || activeDetail.body : activeDetail.body;
        const clipTags = Array.from(new Set([...activeDetail.collectionTags, ...(payload.tags ?? []), ...(kind === "account" ? profile.tags ?? [] : [])]));
        const retryable = images.filter((image) => image.sourceKind === "legacy_url" && (image.status === "failed" || image.status === "pending"));
        const downloading = images.filter((image) => image.status === "downloading").length;
        const extensionFailed = images.filter((image) => image.sourceKind === "extension_bytes" && image.status === "failed").length;
        const ready = images.filter((image) => image.status === "ready" && image.originalAvailable);
        const countLabel = images.length > 0
          ? `本地图片 ${ready.length}/${images.length}${downloading ? ` · 保存中 ${downloading}` : retryable.length ? ` · 旧图待补全 ${retryable.length}` : extensionFailed ? ` · 扩展保存失败 ${extensionFailed}` : " · 已完成"}`
          : kind === "account" ? "仅保存主页资料" : "仅保存文字内容";
        const imageBusy = currentImage ? busyImages[`${activeDetail.id}:${currentImage.position}`] : false;
        return <>
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-3 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDetail(); }}>
            <section ref={detailPanelRef} role="dialog" aria-modal="true" aria-labelledby="collection-detail-title" tabIndex={-1} className="grid max-h-[94vh] w-full max-w-6xl grid-cols-1 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl outline-none lg:grid-cols-[1.08fr_0.92fr]">
              <div className="flex min-h-0 flex-col overflow-y-auto bg-[var(--color-surface-2)] p-3 sm:p-5">
                {currentImage ? <div className="relative flex min-h-[220px] flex-1 items-center justify-center overflow-hidden rounded-xl bg-black/5">
                  {originalImageData
                    ? <img src={originalImageData} alt={`剪藏图片 ${activeImageIndex + 1}`} onClick={() => setZoomedImage(true)} className="max-h-[72vh] max-w-full cursor-zoom-in object-contain" />
                    : <div className="flex flex-col items-center gap-3 px-6 text-center text-sm text-[var(--color-text-secondary)]">
                        {currentImage.status === "downloading" || imageBusy ? <LoaderCircle size={24} className="animate-spin" /> : <ImageIcon size={26} />}
                        <span>{currentImage.status === "downloading" || imageBusy ? "正在保存图片到本地…" : currentImage.status === "failed" ? currentImage.sourceKind === "extension_bytes" ? "扩展图片未能落地，请重新剪藏" : "这张旧剪藏图片没有保存在本地" : currentImage.sourceKind === "extension_bytes" ? "图片等待扩展保存到本地" : "旧剪藏图片等待补全"}</span>
                        {originalImageError && <span className="max-w-sm break-words text-xs text-amber-800">本地原图读取失败：{originalImageError}</span>}
                      </div>}
                  {originalImageData && <button type="button" onClick={() => setZoomedImage(true)} aria-label="放大图片" className="absolute right-3 top-3 rounded-full bg-black/65 p-2 text-white hover:bg-black/80"><Maximize2 size={15} /></button>}
                  {images.length > 1 && <>
                    <button type="button" onClick={() => setActiveImageIndex((index) => (index - 1 + images.length) % images.length)} aria-label="上一张图片" className="absolute left-3 top-1/2 rounded-full bg-black/65 p-2 text-white hover:bg-black/80"><ChevronLeft size={20} /></button>
                    <button type="button" onClick={() => setActiveImageIndex((index) => (index + 1) % images.length)} aria-label="下一张图片" className="absolute right-3 top-1/2 rounded-full bg-black/65 p-2 text-white hover:bg-black/80"><ChevronRight size={20} /></button>
                  </>}
                </div> : kind === "account" ? <section className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-4 rounded-xl bg-[var(--color-surface)] p-6 text-center">
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--color-selected)] text-2xl font-semibold text-[var(--color-brand)]">{(activeDetail.author || activeDetail.title || "账").trim().slice(0, 1)}</div>
                  <div>
                    <p className="text-base font-semibold text-[var(--color-text-primary)]">{activeDetail.author || activeDetail.title || "外部作者账号"}</p>
                    <p className="mt-1 text-xs text-[var(--color-text-secondary)]">外部作者主页 · 保存到 {accountAlias || "当前本地账号"}</p>
                  </div>
                </section> : <div className="flex min-h-[240px] flex-1 items-center justify-center rounded-xl bg-[var(--color-surface)] text-sm text-[var(--color-text-secondary)]">这条剪藏没有图片</div>}

                {images.length > 0 && <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-[var(--color-text-secondary)]">{activeImageIndex + 1} / {images.length} · {countLabel}</span>
                  {retryable.length > 0 && <button type="button" disabled={Boolean(backfillProgress) || retryable.some((image) => busyImages[`${activeDetail.id}:${image.position}`])} onClick={() => void retryFailedImages(activeDetail)} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 px-2.5 py-1.5 text-xs text-amber-800 disabled:opacity-50"><RotateCw size={13} />补全旧剪藏图片（{retryable.length}）</button>}
                </div>}

                {images.length > 1 && <nav aria-label="剪藏图片缩略图" className="mt-3 flex gap-2 overflow-x-auto pb-1">
                  {images.map((image, index) => <button key={image.position} type="button" aria-label={`查看第 ${index + 1} 张图片，${image.status === "ready" ? "已保存" : image.status === "failed" ? "失败" : image.status === "downloading" ? "下载中" : "等待下载"}`} aria-current={index === activeImageIndex ? "true" : undefined} onClick={() => setActiveImageIndex(index)} className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 bg-[var(--color-surface)] ${index === activeImageIndex ? "border-[#ff2442]" : "border-transparent"}`}>
                    {image.status === "ready" && image.thumbnailAvailable
                      ? <CollectionThumbnail item={activeDetail} position={image.position} className="h-full w-full" />
                      : <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-[9px] text-[var(--color-text-secondary)]"><ImageIcon size={15} />{image.status === "failed" ? "失败" : image.status === "downloading" ? "下载中" : "待下载"}</span>}
                    <span className="absolute bottom-0 right-0 rounded-tl bg-black/65 px-1 text-[9px] text-white">{index + 1}</span>
                  </button>)}
                </nav>}

                {currentImage && <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                  {currentImage.error && <p className="mb-2 text-xs text-amber-800">{currentImage.error}</p>}
                  {currentImage.status === "failed" && !currentImage.error && <p className="mb-2 text-xs text-amber-800">图片下载失败</p>}
                  {currentImage.status !== "ready" && currentImage.sourceKind === "legacy_url" && <div className="flex flex-wrap items-center gap-2">
                    <button type="button" disabled={currentImage.status === "downloading" || imageBusy || Boolean(backfillProgress) || accountId !== activeDetail.accountPoolId} onClick={() => void downloadCollectionImage(activeDetail, currentImage.position)} className="inline-flex items-center gap-1.5 rounded-lg bg-[#ff2442] px-3 py-2 text-xs font-medium text-white disabled:opacity-50">
                      {currentImage.status === "downloading" || imageBusy ? <LoaderCircle size={13} className="animate-spin" /> : <RotateCw size={13} />}{currentImage.status === "failed" ? "重试这张图片" : "补全本地图片"}
                    </button>
                    {activeDetail.sourceUrl && <a href={activeDetail.sourceUrl} target="_blank" rel="noreferrer" referrerPolicy="no-referrer" className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:text-[#ff2442]"><ExternalLink size={12} />回到原文重新采集</a>}
                  </div>}
                  {currentImage.status === "ready" && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-secondary)]"><span>原图已保存在本地 · {currentImage.width ?? "?"}×{currentImage.height ?? "?"}</span><button type="button" onClick={() => void addImageToLibrary(activeDetail, currentImage.position)} className="rounded-lg border border-[#ff2442] px-3 py-2 text-xs text-[#ff2442] hover:bg-[#fff3f5]">加入创作素材</button></div>}
                </div>}
              </div>

              <div className="flex min-h-0 flex-col overflow-y-auto">
                <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
                  <div className="min-w-0">
                    <div className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-[var(--color-selected)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-brand)]">{kindIcon(activeDetail)}{clipTypeLabel(activeDetail)}</div>
                    <h3 id="collection-detail-title" className="line-clamp-2 text-base font-semibold leading-6 text-[var(--color-text-primary)]">{activeDetail.title || "未命名剪藏"}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-text-secondary)]">
                      <span>保存到 {activeDetail.accountPoolId === accountId ? accountAlias || "当前本地账号" : "本地账号"}</span>
                      {activeDetail.author && <span>· 页面作者 {activeDetail.author}</span>}
                      {activeDetail.sourceUrl && <span>·</span>}
                      {activeDetail.sourceUrl ? <a href={activeDetail.sourceUrl} target="_blank" rel="noreferrer" referrerPolicy="no-referrer" className="inline-flex max-w-full items-center gap-1 truncate text-[#ff2442] hover:underline"><ExternalLink size={11} />{sourceLabel(activeDetail.sourceUrl)}</a> : <span>手动剪藏</span>}
                      <span>·</span><time dateTime={activeDetail.observedAt}>{Number.isFinite(Date.parse(activeDetail.observedAt)) ? new Date(activeDetail.observedAt).toLocaleString() : "采集时间未知"}</time>
                    </div>
                  </div>
                  <button type="button" onClick={closeDetail} aria-label="关闭剪藏详情" className="shrink-0 rounded-lg p-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"><X size={18} /></button>
                </header>

                <div className="space-y-5 p-5">
                  {detailBody.trim() && <section>
                    <h4 className="mb-2 text-xs font-semibold text-[var(--color-text-secondary)]">{kind === "account" ? "主页简介" : "已采集正文"}</h4>
                    <p className="whitespace-pre-wrap break-words text-sm leading-7 text-[var(--color-text-primary)]">{detailBody}</p>
                  </section>}

                  {kind === "note" && <section className="flex flex-wrap gap-2 border-y border-[var(--color-border)] py-3 text-xs text-[var(--color-text-secondary)]">
                    <span>赞 <strong className="font-semibold text-[var(--color-text-primary)]">{metricText(metrics.like)}</strong></span>
                    <span>收藏 <strong className="font-semibold text-[var(--color-text-primary)]">{metricText(metrics.collect)}</strong></span>
                    <span>评论 <strong className="font-semibold text-[var(--color-text-primary)]">{metricText(metrics.comment)}</strong></span>
                    <span>转发 <strong className="font-semibold text-[var(--color-text-primary)]">{metricText(metrics.share)}</strong></span>
                  </section>}

                  {kind === "account" && <section className="flex flex-wrap gap-2 border-y border-[var(--color-border)] py-3 text-xs text-[var(--color-text-secondary)]">
                    <span>粉丝 <strong className="font-semibold text-[var(--color-text-primary)]">{metricText(metrics.followers)}</strong></span>
                    <span>关注 <strong className="font-semibold text-[var(--color-text-primary)]">{metricText(profile.follows)}</strong></span>
                    <span>笔记 <strong className="font-semibold text-[var(--color-text-primary)]">{metricText(metrics.noteCount)}</strong></span>
                    {profile.ipLocation && <span>地区 <strong className="font-semibold text-[var(--color-text-primary)]">{profile.ipLocation}</strong></span>}
                  </section>}

                  {payload.publishedAt && <p className="text-xs text-[var(--color-text-secondary)]">发布时间 {payload.publishedAt}{payload.publishedLocation ? ` · ${payload.publishedLocation}` : ""}</p>}
                  {clipTags.length > 0 && <section aria-label="话题与标签" className="flex flex-wrap gap-1.5">{clipTags.slice(0, 30).map((tag) => <span key={tag} className="rounded-full bg-[var(--color-surface-2)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)]">#{tag.replace(/^#/u, "")}</span>)}</section>}

                  <section aria-label="剪藏引用" className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold text-[var(--color-text-secondary)]">关联到本地内容</h4>
                      <button type="button" disabled={referenceTargetsLoading || accountId !== activeDetail.accountPoolId} onClick={() => void loadReferenceTargets(activeDetail, referenceTargetsAccount === activeDetail.accountPoolId)} className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] disabled:opacity-50">
                        {referenceTargetsLoading ? "正在读取…" : referenceTargetsAccount === activeDetail.accountPoolId ? "刷新可关联对象" : "读取可关联对象"}
                      </button>
                    </div>
                    {referencesLoading ? <p className="text-xs text-[var(--color-text-secondary)]">正在读取现有关联…</p> : activeReferences.length > 0 ? (
                      <ul className="space-y-1.5">
                        {activeReferences.map((reference) => {
                          const target = referenceTargets.find((candidate) => candidate.kind === reference.targetKind && candidate.id === reference.targetId);
                          const kindLabel = { topic: "话题", reference_account: "榜样", inspiration: "剪藏", note: "笔记", item: "素材" }[reference.targetKind];
                          return <li key={referenceTargetKey(reference.targetKind, reference.targetId)} className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{kindLabel} · {target?.label.replace(/^(话题|榜样|笔记|素材) · /u, "") ?? reference.targetId}{!reference.targetExists && <span className="ml-1 text-amber-700">（目标已删除）</span>}</span>
                            <button type="button" aria-label={`取消${kindLabel}关联 ${reference.targetId}`} disabled={referenceBusy || accountId !== activeDetail.accountPoolId} onClick={() => void removeClipReference(activeDetail, reference)} className="rounded px-2 py-1 text-[var(--color-text-secondary)] hover:text-red-600 disabled:opacity-50">取消关联</button>
                          </li>;
                        })}
                      </ul>
                    ) : <p className="text-xs text-[var(--color-text-secondary)]">{referenceTargetsLoading ? "" : "还没有关联内容。"}</p>}
                    {referenceTargetsAccount === activeDetail.accountPoolId && referenceTargets.length > 0 && <div className="flex flex-wrap gap-2">
                      <select aria-label="选择剪藏关联目标" value={referenceTargetSelection} onChange={(event) => setReferenceTargetSelection(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-xs text-[var(--color-text-primary)]">
                        <option value="">选择笔记、素材、榜样、剪藏或话题</option>
                        {referenceTargets.map((target) => <option key={target.key} value={target.key}>{target.label}</option>)}
                      </select>
                      <button type="button" disabled={!referenceTargetSelection || referenceBusy || accountId !== activeDetail.accountPoolId} onClick={() => void addClipReference(activeDetail)} className="rounded-lg border border-[#ff2442] px-3 py-2 text-xs text-[#ff2442] disabled:opacity-50">添加关联</button>
                    </div>}
                    {kind === "account" && isXhsAuthorProfile(activeDetail) && (roleModelReference
                      ? <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-secondary)]"><span>已加入榜样账号</span><button type="button" disabled={referenceBusy || accountId !== activeDetail.accountPoolId} onClick={() => void removeClipReference(activeDetail, roleModelReference)} className="rounded-lg border border-[var(--color-border)] px-3 py-2 disabled:opacity-50">{referenceBusy ? "正在处理…" : "取消剪藏与榜样的关联"}</button></div>
                      : <button type="button" disabled={promotingAccount || referencesLoading || accountId !== activeDetail.accountPoolId} onClick={() => void promoteClippedAccount(activeDetail)} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-secondary)] disabled:opacity-50">{promotingAccount ? "正在加入榜样…" : "加入榜样账号"}</button>)}
                  </section>

                  {detailNote.trim() && <p className="whitespace-pre-wrap break-words text-xs leading-5 text-[var(--color-text-secondary)]">我的备注：{detailNote}</p>}
                  <details className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                    <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-secondary)]">编辑备注和标签</summary>
                    <div className="mt-3 space-y-3">
                      <label className="block text-xs font-medium text-[var(--color-text-secondary)]">我的备注<textarea value={detailNote} onChange={(event) => setDetailNote(event.target.value)} maxLength={4000} placeholder="写下这条剪藏值得参考的原因" className="mt-1.5 h-20 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]" /></label>
                      <label className="block text-xs font-medium text-[var(--color-text-secondary)]">我的标签<textarea value={detailTags} onChange={(event) => setDetailTags(event.target.value)} placeholder="多个标签用逗号或换行分隔" className="mt-1.5 h-16 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]" /></label>
                      <div className="flex justify-end"><button type="button" disabled={savingDetails || accountId !== activeDetail.accountPoolId} onClick={() => void saveDetailChanges()} className="rounded-lg border border-[#ff2442] px-3 py-2 text-xs font-medium text-[#ff2442] disabled:opacity-50">{savingDetails ? "正在保存…" : "保存备注和标签"}</button></div>
                    </div>
                  </details>

                  {comments.length > 0 && <section className="border-t border-[var(--color-border)] pt-4">
                    <h4 className="mb-2 text-xs font-semibold text-[var(--color-text-secondary)]">已选评论 · {comments.length} 条（摘录）</h4>
                    <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                      {comments.map((comment, index) => <p key={`${index}-${comment.text}`} className="break-words rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-xs leading-5 text-[var(--color-text-secondary)]"><span className="font-medium text-[var(--color-text-primary)]">{comment.author || "匿名用户"}：</span>{comment.text}{comment.truncated ? "…（已截断）" : ""}</p>)}
                    </div>
                  </section>}

                  <section className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-4">
                    {kind === "note" && activeDetail.status === "saved" && <button type="button" onClick={() => void convertToDraft(activeDetail)} className="rounded-lg bg-[#ff2442] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#e61f3b]">转为草稿</button>}
                    {kind === "note" && activeDetail.status === "converted" && <span className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">已转为草稿</span>}
                    {!confirmRemove
                      ? <button type="button" onClick={() => setConfirmRemove(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:border-red-300 hover:text-red-600"><Trash2 size={13} />从剪藏移除</button>
                      : <div className="flex flex-wrap items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800"><span>移除这条剪藏；本地附件与其他引用会保留。</span><button type="button" onClick={() => void cancelCollection()} className="rounded-md bg-red-600 px-2.5 py-1.5 font-medium text-white">确认移除</button><button type="button" onClick={() => setConfirmRemove(false)} className="rounded-md border border-red-200 px-2.5 py-1.5">保留</button></div>}
                  </section>
                </div>
              </div>
            </section>
          </div>
          {zoomedImage && originalImageData && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/95 p-3" onMouseDown={() => setZoomedImage(false)}><button type="button" onClick={() => setZoomedImage(false)} aria-label="关闭图片放大" className="absolute right-5 top-5 rounded-full bg-white/15 p-2 text-white"><X size={20} /></button><img src={originalImageData} alt={`放大的剪藏图片 ${activeImageIndex + 1}`} className="max-h-full max-w-full object-contain" /></div>}
        </>;
      })()}
      {createOpen && IS_TAURI_RUNTIME && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="add-collection-title" className="max-h-[min(90vh,760px)] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h3 id="add-collection-title" className="text-base font-semibold text-[var(--color-text-primary)]">新增网页文章剪藏</h3>
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">保存标题、来源链接和自己的观察，归入当前本地账号。</p>
              </div>
              <button type="button" onClick={() => setCreateOpen(false)} aria-label="关闭弹窗" className="rounded-lg p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"><X size={18} /></button>
            </div>
            <form onSubmit={(event) => { event.preventDefault(); void saveManualCapture(); }} className="space-y-3">
              <label className="block text-xs font-medium text-[var(--color-text-secondary)]">标题<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="给这篇网页文章起个标题" className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm font-normal text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]" /></label>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)]">来源链接（可选）<input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://..." className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm font-normal text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]" /></label>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)]">摘录 / 观察<textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="记录你看到的内容或值得留意的细节" className="mt-1.5 h-36 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm font-normal text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]" /></label>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)]">为什么值得参考<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="可选，补充之后可能用到的原因" className="mt-1.5 h-20 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm font-normal text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]" /></label>
              <div className="flex justify-end gap-2 border-t border-[var(--color-border)] pt-4">
                <button type="button" onClick={() => setCreateOpen(false)} className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]">取消</button>
                <button type="submit" disabled={!title.trim() || savingManual} className="inline-flex items-center gap-1.5 rounded-lg bg-[#ff2442] px-4 py-2 text-sm font-medium text-white hover:bg-[#e61f3b] disabled:opacity-50"><BookmarkPlus size={14} />{savingManual ? "正在保存…" : "保存网页文章"}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
