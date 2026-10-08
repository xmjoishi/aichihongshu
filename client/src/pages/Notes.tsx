import { useWorkspaceEffect } from "../lib/workspaceActivity";
import { useWorkspaceQuery as useQuery } from "../lib/workspaceActivity";
import { useMemo, useState, useEffect, useLayoutEffect, useRef } from "react";
import { usePanelResize } from "../hooks/usePanelResize";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, API_BASE, openExternalUrl } from "../lib/api";
import { NOTE_TYPE_GROUPS, getNoteTypeBadge, type NoteType } from "../lib/noteTypes";
import { Note } from "../lib/types";
import {
  Dialog,
  Spinner,
  Empty,
  StatusBadge,
  pageTabActiveClass,
  pageTabClass,
  pageTabInactiveClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "../components/ui";
import LocalImage from "../components/LocalImage";
import { DataCaptureButton } from "../components/DataCapture";
import { Save, Copy, ChevronRight, Hash, FileText, Trash2, X, Search, Send, ExternalLink, LayoutList, Columns3 } from "lucide-react";
import AIPanel from "../components/AIPanel";
import { useToast } from "../components/Toast";
import { useHDRSetting } from "../hooks/useHDRSetting";
import { useDebounce } from "../hooks/useDebounce";
import BodyEditor from "../components/BodyEditor";
import {
  IS_TAURI_RUNTIME,
  createLocalDraft,
  deleteLocalNote,
  localItemToItem,
  localNoteToNote,
  readLocalWorkspaceSnapshot,
  restoreLocalNote,
  updateLocalNote,
  updateLocalNoteItems,
  updateLocalNoteStatus,
  type LocalWorkspaceSnapshot,
} from "../lib/local";
import { useAccountChange, useAccountContext } from "../lib/accountContext";
import { getCapability } from "../lib/capabilities";
import {
  createProposal,
  isProposalCurrent,
  listProposals,
  saveProposal,
  type AIProposal,
} from "../lib/aiProposal";
import { preparePublish, type PublishPreparation } from "../lib/publishPreparation";
import { noteToMarkdown } from "../lib/noteMarkdown";
import { makeAISessionKey, publishPageAISidebarVisibility } from "../lib/aiHost";
import { PAGE_AI_ACTION_EVENT, publishPageAIContext } from "../lib/pageAIContext";
import type { AIResponseEnvelope } from "../lib/aiResponse";
import Publish from "./Publish";
import { PublishModal } from "./notes/NotePublishAssistant";
import { NoteImagePanel, NoteImageStrip } from "./notes/NoteImageComponents";


const AUTOSAVE_DELAY = 1500; // ms
const NOTES_VIEW_KEY = "aichihongshu.notes-view.v1";

const EMPTY_NOTES: Note[] = [];

type NotesWorkspaceMode = "list" | "waterfall" | "publish";

function NotesWorkspaceViewSwitcher({ mode, onChange }: { mode: NotesWorkspaceMode; onChange: (mode: NotesWorkspaceMode) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-zinc-50 p-0.5" role="group" aria-label="切换笔记工作区">
      <button
        type="button"
        aria-pressed={mode === "list"}
        aria-label="笔记列表"
        title="笔记列表"
        onClick={() => onChange("list")}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors ${mode === "list" ? "bg-white text-[#ff2442] shadow-sm" : "text-zinc-500 hover:bg-white hover:text-zinc-700"}`}
      >
        <LayoutList size={14} />
        <span>笔记列表</span>
      </button>
      <button
        type="button"
        aria-pressed={mode === "waterfall"}
        aria-label="瀑布流"
        title="瀑布流"
        onClick={() => onChange("waterfall")}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors ${mode === "waterfall" ? "bg-white text-[#ff2442] shadow-sm" : "text-zinc-500 hover:bg-white hover:text-zinc-700"}`}
      >
        <Columns3 size={14} />
        <span>瀑布流</span>
      </button>
      <button
        type="button"
        aria-pressed={mode === "publish"}
        aria-label="发布准备"
        title="发布准备"
        onClick={() => onChange("publish")}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors ${mode === "publish" ? "bg-white text-[#ff2442] shadow-sm" : "text-zinc-500 hover:bg-white hover:text-zinc-700"}`}
      >
        <Send size={14} />
        <span>发布准备</span>
      </button>
    </div>
  );
}

function formatSaveError(cause: unknown, fallback = "保存失败，请重试"): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === "string" && cause.trim()) return cause.trim();
  if (cause && typeof cause === "object") {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
    try {
      const serialized = JSON.stringify(cause);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Keep the user-facing fallback when an invoke error is not serializable.
    }
  }
  return fallback;
}

function notesViewKey(scopeKey: string): string {
  return `${NOTES_VIEW_KEY}:${encodeURIComponent(scopeKey)}`;
}

function notesWorkspaceViewKey(scopeKey: string): string {
  return `${notesViewKey(scopeKey)}:workspace-view`;
}

function readNotesWorkspaceView(scopeKey: string): NotesWorkspaceMode {
  try {
    const saved = sessionStorage.getItem(notesWorkspaceViewKey(scopeKey));
    if (saved === "waterfall" || saved === "publish") return saved;
  } catch { /* optional */ }
  return "list";
}

// ── Note List ────────────────────────────────────────────────────────────────

export function NoteList() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { accountId, scopeKey } = useAccountContext();
  const noteRead = getCapability("note.read");
  const noteWrite = getCapability("note.write");
  const noteStatusWrite = getCapability("note.status.write");
  const noteDelete = getCapability("note.delete");
  const publish = getCapability("publish");
  const requestedWorkspaceView = searchParams.get("view");
  const [savedWorkspaceView, setSavedWorkspaceView] = useState<NotesWorkspaceMode>(() =>
    requestedWorkspaceView === "waterfall" || requestedWorkspaceView === "publish"
      ? requestedWorkspaceView
      : readNotesWorkspaceView(scopeKey)
  );
  const workspaceView: NotesWorkspaceMode = requestedWorkspaceView === "waterfall" || requestedWorkspaceView === "publish"
    ? requestedWorkspaceView
    : requestedWorkspaceView === null ? savedWorkspaceView : "list";
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("created_desc");
  const [showTrash, setShowTrash] = useState(false);
  const [viewPrefsLoadedScope, setViewPrefsLoadedScope] = useState<string | null>(null);

  function handleStatusChange(key: string) {
    // 状态页签（尤其是“全部”）必须离开回收站视图，否则 showTrash
    // 会继续决定数据源，导致点击“全部”后仍停留在回收站。
    setShowTrash(false);
    setStatusFilter(key);
    // 已发 tab 默认按发布时间倒序，其他 tab 保持最新创建
    if (key === "published") setSort("published_desc");
    else setSort("created_desc");
  }
  const { imgStyle } = useHDRSetting();
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [publishingNote, setPublishingNote] = useState<Note | null>(null);
  const [newDraftOpen, setNewDraftOpen] = useState(false);
  const [newDraftTitle, setNewDraftTitle] = useState("");
  const [creatingDraft, setCreatingDraft] = useState(false);
  const notesScrollRef = useRef<HTMLDivElement>(null);
  const viewScopeRef = useRef<string | null>(null);
  const publishView = workspaceView === "publish";
  const waterfallView = workspaceView === "waterfall";
  const scrollViewMode = workspaceView;
  const workspaceViewStorageKey = notesWorkspaceViewKey(scopeKey);
  const scrollStorageKey = `${notesViewKey(scopeKey)}:scroll:${showTrash ? "trash" : statusFilter || "all"}:${scrollViewMode}`;
  const activeScrollStorageKeyRef = useRef(scrollStorageKey);
  const pendingScrollRestoreKeyRef = useRef<string | null>(scrollStorageKey);
  const suppressScrollSaveRef = useRef(true);

  useLayoutEffect(() => {
    if (activeScrollStorageKeyRef.current === scrollStorageKey) return;
    activeScrollStorageKeyRef.current = scrollStorageKey;
    pendingScrollRestoreKeyRef.current = scrollStorageKey;
    suppressScrollSaveRef.current = true;
  }, [scrollStorageKey]);

  function changeWorkspaceMode(mode: NotesWorkspaceMode) {
    try { sessionStorage.setItem(workspaceViewStorageKey, mode); } catch { /* optional */ }
    setSavedWorkspaceView(mode);
    setSearchParams(mode === "list" ? {} : { view: mode });
  }

  useWorkspaceEffect(() => {
    publishPageAIContext({
      route: "/notes",
      page: publishView ? "笔记 · 发布" : waterfallView ? "笔记 · 瀑布流" : "笔记",
      accountId,
      selectedIds: [],
      availableActions: publishView
        ? [
            { id: "review-outbox", label: "检查发布队列" },
            { id: "prepare-publish", label: "准备发布", requiresConfirmation: true },
            ...(noteWrite.available ? [{ id: "save-note-draft", label: "保存笔记草稿", description: "将本轮生成的结构化笔记保存为草稿", requiresConfirmation: true, handler: "save-note-draft" as const }] : []),
          ]
        : [
            { id: "triage-notes", label: "整理笔记" },
            { id: "find-draft", label: "找一篇可发布草稿" },
            ...(noteWrite.available ? [{ id: "save-note-draft", label: "保存笔记草稿", description: "将本轮生成的结构化笔记保存为草稿", requiresConfirmation: true, handler: "save-note-draft" as const }] : []),
          ],
      source: "page",
      permissionScope: ["note.read", "note.write", "note.status.write", "publish"],
    });
  }, [accountId, noteWrite.available, publishView, waterfallView]);

  useWorkspaceEffect(() => {
    const handleAIAction = (event: Event) => {
      const detail = (event as CustomEvent<{ actionId?: string; response?: AIResponseEnvelope; sessionKey?: string; accountId?: number | null; onComplete?: () => void }>).detail;
      if (detail?.actionId !== "save-note-draft" || !detail.response) return;
      if (detail.accountId !== accountId) {
        toast("账号已切换，请在当前账号下重新生成草稿", "warning");
        return;
      }
      const draft = detail.response.blocks.find((block) => block.type === "note-draft");
      if (!draft || draft.type !== "note-draft") {
        toast("这条回复没有可保存的笔记草稿", "info");
        return;
      }
      if (!noteWrite.available) {
        toast(`${noteWrite.reason}。${noteWrite.nextStep}`, "info");
        return;
      }
      void (async () => {
        setCreatingDraft(true);
        try {
          const title = draft.title?.trim() || "新建草稿";
          const tags = draft.tags.map((tag) => tag.replace(/^#+/, "")).filter(Boolean);
          let createdId: number;
          if (IS_TAURI_RUNTIME) {
            if (accountId == null) throw new Error("当前没有可用账号，无法保存笔记草稿");
            const created = await createLocalDraft(title, accountId);
            const saved = await updateLocalNote({
              noteId: created.id,
              accountPoolId: accountId,
              expectedVersion: created.contentVersion,
              title,
              body: draft.body ?? "",
              tags,
              itemIds: [],
              noteType: "text",
            });
            createdId = saved.id;
            await qc.invalidateQueries({ queryKey: ["local-workspace", scopeKey] });
          } else {
            const created = await api.post("/api/content/", { title, body: draft.body ?? "", tags });
            const saved = await api.patch(`/api/content/${created.id}`, { title, body: draft.body ?? "", tags, item_ids: [], note_type: "text" });
            createdId = Number(saved.id ?? created.id);
            await qc.invalidateQueries({ queryKey: ["notes"] });
          }
          if (!Number.isSafeInteger(createdId) || createdId <= 0) throw new Error("草稿已创建，但返回的笔记编号无效");
          const query = new URLSearchParams({ aiHost: "sidebar" });
          if (detail.sessionKey) query.set("aiSession", detail.sessionKey);
          navigate(`/notes/${createdId}?${query.toString()}`);
          toast("笔记草稿已保存", "success");
          detail.onComplete?.();
        } catch (cause) {
          toast(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`, "error");
        } finally {
          setCreatingDraft(false);
        }
      })();
    };
    window.addEventListener(PAGE_AI_ACTION_EVENT, handleAIAction);
    return () => window.removeEventListener(PAGE_AI_ACTION_EVENT, handleAIAction);
  }, [accountId, navigate, noteWrite.available, noteWrite.nextStep, noteWrite.reason, qc, scopeKey, toast]);

  useAccountChange(() => {
    setNewDraftOpen(false);
    setNewDraftTitle("");
    setCreatingDraft(false);
  });

  useEffect(() => {
    viewScopeRef.current = scopeKey;
    try {
      const saved = JSON.parse(localStorage.getItem(notesViewKey(scopeKey)) ?? "null") as Partial<{ statusFilter: string; search: string; sort: string; showTrash: boolean }> | null;
      if (saved) {
        if (typeof saved.statusFilter === "string") setStatusFilter(saved.statusFilter);
        if (typeof saved.search === "string") setSearch(saved.search);
        if (typeof saved.sort === "string") setSort(saved.sort);
        if (typeof saved.showTrash === "boolean") setShowTrash(saved.showTrash);
      }
    } catch { /* preferences are optional */ }
    setViewPrefsLoadedScope(scopeKey);
  }, [scopeKey]);

  useEffect(() => {
    if (requestedWorkspaceView === "waterfall" || requestedWorkspaceView === "publish") {
      setSavedWorkspaceView(requestedWorkspaceView);
      try { sessionStorage.setItem(workspaceViewStorageKey, requestedWorkspaceView); } catch { /* optional */ }
    } else if (requestedWorkspaceView === null) {
      setSavedWorkspaceView(readNotesWorkspaceView(scopeKey));
    }
  }, [requestedWorkspaceView, scopeKey, workspaceViewStorageKey]);

  useEffect(() => {
    if (viewScopeRef.current !== scopeKey) return;
    try { localStorage.setItem(notesViewKey(scopeKey), JSON.stringify({ statusFilter, search, sort, showTrash })); } catch { /* optional */ }
  }, [scopeKey, statusFilter, search, sort, showTrash]);

  const searchDebounced = useDebounce(search, 300);

  const { data: remoteNotes = EMPTY_NOTES, isLoading: remoteNotesLoading } = useQuery<Note[]>({
    queryKey: ["notes", statusFilter, searchDebounced, sort],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (searchDebounced) params.set("search", searchDebounced);
      if (sort) params.set("sort", sort);
      const qs = params.toString();
      return api.get(`/api/content/${qs ? `?${qs}` : ""}`);
    },
    enabled: !IS_TAURI_RUNTIME,
  });
  const { data: localWorkspace, isLoading: localNotesLoading } = useQuery<LocalWorkspaceSnapshot>({
    queryKey: ["local-workspace", scopeKey, "notes"],
    queryFn: () => readLocalWorkspaceSnapshot(accountId ?? undefined, "notes"),
    enabled: IS_TAURI_RUNTIME && noteRead.available && accountId !== null,
  });
  const notes: Note[] = useMemo(() => IS_TAURI_RUNTIME
    ? (showTrash ? (localWorkspace?.trashNotes ?? []) : (localWorkspace?.notes ?? []))
        .map(localNoteToNote)
        .filter((note) => !statusFilter || note.status === statusFilter)
        .filter((note) => !searchDebounced || `${note.title ?? ""} ${note.body ?? ""}`.toLowerCase().includes(searchDebounced.toLowerCase()))
        .sort((a, b) => {
          if (sort === "published_desc") return (b.published_at ?? "").localeCompare(a.published_at ?? "");
          return (b.created_at ?? "").localeCompare(a.created_at ?? "");
        })
    : remoteNotes, [showTrash, localWorkspace?.trashNotes, localWorkspace?.notes, statusFilter, searchDebounced, sort, remoteNotes]);
  const isLoading = IS_TAURI_RUNTIME ? localNotesLoading : remoteNotesLoading;

  useEffect(() => {
    if (viewPrefsLoadedScope !== scopeKey || isLoading || pendingScrollRestoreKeyRef.current !== scrollStorageKey) return;
    const element = notesScrollRef.current;
    if (!element) return;

    const legacyKey = `${notesViewKey(scopeKey)}:scroll`;
    let saved: number;
    try {
      const stored = sessionStorage.getItem(scrollStorageKey) ?? sessionStorage.getItem(legacyKey);
      saved = Number(stored ?? 0);
    } catch {
      saved = 0;
    }
    const targetScrollTop = Number.isFinite(saved) ? Math.max(0, saved) : 0;
    let secondFrame: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (activeScrollStorageKeyRef.current !== scrollStorageKey) return;
        element.scrollTop = targetScrollTop;
        try { sessionStorage.setItem(scrollStorageKey, String(element.scrollTop)); } catch { /* optional */ }
        pendingScrollRestoreKeyRef.current = null;
        suppressScrollSaveRef.current = false;
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, [isLoading, notes.length, scopeKey, scrollStorageKey, viewPrefsLoadedScope]);

  async function deleteNote(id: number) {
    if (!noteDelete.available) {
      toast(`${noteDelete.reason}。${noteDelete.nextStep}`, "info");
      return;
    }
    setDeletingId(id);
    try {
      if (IS_TAURI_RUNTIME) {
        if (accountId === null) throw new Error("当前账号尚未就绪");
        await deleteLocalNote(id, accountId);
        await qc.invalidateQueries({ queryKey: ["local-workspace", scopeKey] });
      } else {
        await api.delete(`/api/content/${id}`);
        qc.invalidateQueries({ queryKey: ["notes"] });
      }
      toast(IS_TAURI_RUNTIME ? "笔记已移入回收站" : "笔记已删除", "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setDeletingId(null);
      setConfirmId(null);
    }
  }

  async function restoreNote(id: number) {
    if (!IS_TAURI_RUNTIME || accountId === null) return;
    setDeletingId(id);
    try {
      await restoreLocalNote(id, accountId);
      await qc.invalidateQueries({ queryKey: ["local-workspace", scopeKey] });
      toast("笔记已恢复", "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setDeletingId(null);
    }
  }

  async function moveTo(noteId: number, newStatus: "draft" | "ready" | "published", noteUrl?: string) {
    if (!noteStatusWrite.available) {
      toast(`${noteStatusWrite.reason}。${noteStatusWrite.nextStep}`, "info");
      return;
    }
    if (IS_TAURI_RUNTIME) {
      const current = notes.find((item) => item.id === noteId);
      if (!current || accountId === null) {
        toast("当前账号下找不到这篇笔记", "error");
        return;
      }
      try {
        await updateLocalNoteStatus({
          noteId,
          accountPoolId: accountId,
          expectedVersion: current.content_version ?? 1,
          status: newStatus,
          noteUrl,
        });
        await qc.invalidateQueries({ queryKey: ["local-workspace", scopeKey] });
      } catch (e: unknown) {
        toast((e as Error).message, "error");
      }
      return;
    }
    qc.setQueryData<Note[]>(["notes", statusFilter, searchDebounced, sort], (old = []) =>
      old.map((n) => (n.id === noteId ? { ...n, status: newStatus } : n))
    );
    try {
      await api.patch(`/api/content/${noteId}/status`, {
        status: newStatus,
        ...(noteUrl ? { note_url: noteUrl } : {}),
      });
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["analytics"] });
    } catch (e: unknown) {
      qc.invalidateQueries({ queryKey: ["notes"] });
      toast((e as Error).message, "error");
    }
  }

  const statusTabs = [
    { key: "", label: "全部" },
    { key: "draft", label: "草稿" },
    { key: "ready", label: "待发" },
    { key: "published", label: "已发" },
  ];

  const sortOptions = [
    { key: "created_desc",   label: "最新创建" },
    { key: "created_asc",    label: "最早创建" },
    { key: "updated_desc",   label: "最近编辑" },
    { key: "published_desc", label: "发布时间" },
    { key: "title_asc",      label: "标题 A→Z" },
  ];

  async function createDraftFromList() {
    if (!noteWrite.available) {
      toast(`${noteWrite.reason}。${noteWrite.nextStep}`, "info");
      return;
    }
    setCreatingDraft(true);
    try {
      await createLocalDraft(newDraftTitle.trim() || "新建草稿", accountId ?? undefined);
      await qc.invalidateQueries({ queryKey: ["local-workspace", scopeKey] });
      setNewDraftOpen(false);
      setNewDraftTitle("");
      toast("草稿已创建", "success");
    } catch (cause) {
      toast(`创建失败：${cause instanceof Error ? cause.message : String(cause)}`, "error");
    } finally {
      setCreatingDraft(false);
    }
  }

  if (searchParams.get("view") === "publish") {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-100 bg-white px-6 py-2">
          <h1 className="text-lg font-semibold text-zinc-900">笔记</h1>
          <NotesWorkspaceViewSwitcher mode="publish" onChange={changeWorkspaceMode} />
          <span className="ml-1 text-xs text-zinc-500">平台交接与结果回填</span>
        </div>
        <div className="min-h-0 flex-1"><Publish embedded /></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {publishingNote && (
        <PublishModal
          note={publishingNote}
          onClose={() => setPublishingNote(null)}
          onPublished={(url) => { moveTo(publishingNote.id, "published", url); setPublishingNote(null); }}
        />
      )}

      {/* Toolbar */}
      <div className="border-b border-zinc-100 bg-white shrink-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2">
          <h1 className="text-lg font-semibold text-zinc-900">笔记</h1>
          <NotesWorkspaceViewSwitcher mode={waterfallView ? "waterfall" : "list"} onChange={changeWorkspaceMode} />
          <button
            type="button"
            onClick={() => {
              if (!noteWrite.available) {
                toast(`${noteWrite.reason}。${noteWrite.nextStep}`, "info");
              } else if (IS_TAURI_RUNTIME) {
                setNewDraftOpen(true);
              } else {
                toast("请先在图库选择素材后生成草稿", "info");
              }
            }}
            disabled={!noteWrite.available}
            title={noteWrite.available ? "新建草稿" : `${noteWrite.reason}；${noteWrite.nextStep}`}
            className="ml-auto text-sm px-4 py-1.5 rounded-lg bg-[#ff2442] text-white hover:bg-[#e01f3a] transition-colors"
          >
            + 新建
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0 border-t border-[var(--color-border)] px-6">
          <div role="tablist" aria-label="笔记筛选" className="flex min-w-0 flex-wrap items-stretch gap-1">
          {statusTabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={statusFilter === t.key && !showTrash}
              onClick={() => handleStatusChange(t.key)}
              className={`${pageTabClass} ${statusFilter === t.key && !showTrash ? pageTabActiveClass : pageTabInactiveClass}`}
            >
              {t.label}
            </button>
          ))}
          {IS_TAURI_RUNTIME && (
            <button
              type="button"
              role="tab"
              aria-selected={showTrash}
              onClick={() => { setShowTrash((value) => !value); setStatusFilter(""); }}
              className={`${pageTabClass} ${showTrash ? "border-amber-500 text-amber-600" : pageTabInactiveClass}`}
              title="本地笔记回收站；关联素材不会随笔记删除"
            >
              回收站{localWorkspace?.trashNotes?.length ? ` (${localWorkspace.trashNotes.length})` : ""}
            </button>
          )}
          </div>
        </div>
        {IS_TAURI_RUNTIME && (
          <div className="border-y border-[var(--color-border)] bg-[var(--color-surface-2)] px-6 py-1.5 text-xs text-[var(--color-text-secondary)]">
            本地笔记 · 编辑、状态变更、素材关联可用；{noteDelete.available ? "删除进入回收站" : "删除仍需迁移"}；发布准备与浏览器填充可用，最终由用户提交
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 px-6 py-2.5">
          <div className="relative w-full max-w-xl flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索标题、正文、标签..."
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#ff2442]/30 focus:border-[#ff2442]"
            />
            {search && (
              <button onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                <X size={13} />
              </button>
            )}
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="text-sm border border-zinc-200 rounded-lg px-3 py-1.5 text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#ff2442]/30 focus:border-[#ff2442] bg-white"
          >
            {sortOptions.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* List */}
      <div ref={notesScrollRef} className="flex-1 overflow-y-auto p-6" onScroll={(event) => {
        if (suppressScrollSaveRef.current) return;
        try { sessionStorage.setItem(activeScrollStorageKeyRef.current, String(event.currentTarget.scrollTop)); } catch { /* optional */ }
      }}>
        {isLoading ? (
          <Spinner />
        ) : notes.length === 0 ? (
          <Empty message="暂无笔记，先到图库导入图片并生成草稿" />
        ) : (
          <div className={waterfallView
            ? "mx-auto w-full max-w-[1600px] columns-1 gap-2.5 sm:columns-2 md:columns-3 lg:columns-4 xl:columns-5"
            : "mx-auto grid w-full max-w-[1240px] grid-cols-1 items-start gap-3 xl:grid-cols-2"}>
            {notes.map((note) => {
              const coverItemId = note.item_ids?.[0] ?? note.item_id;
              const mediaCount = note.item_ids?.length || (note.item_id != null ? 1 : 0);
              const coverMarker = note.note_type === "video"
                ? "视频"
                : mediaCount > 1
                  ? `多图 · ${mediaCount}`
                  : null;
              return (
              <div key={note.id}
                // Multicol balancing needs real card heights; size containment makes
                // WebKit balance against placeholders and leave later columns empty.
                style={waterfallView ? undefined : { contentVisibility: "auto", containIntrinsicSize: "auto 180px" }}
                className={`${waterfallView ? "mb-3 inline-block w-full break-inside-avoid overflow-hidden align-top" : "p-4"} bg-white rounded-xl border border-zinc-100 hover:border-zinc-200 transition-colors group relative`}
              >
                {/* 主体内容行 */}
                <div className={`flex ${waterfallView ? "flex-col gap-0" : "items-start gap-3"} ${showTrash ? "" : "cursor-pointer"}`} onClick={() => { if (!showTrash) navigate(`/notes/${note.id}`); }}>
                  {coverItemId != null ? (
                    <div className={waterfallView ? "relative w-full" : "relative h-16 w-16 shrink-0"}>
                      <LocalImage
                        itemId={coverItemId}
                        src={`${API_BASE}/api/library/${coverItemId}/image`}
                        alt=""
                        style={imgStyle()}
                        variant="thumbnail"
                        className={waterfallView
                          ? "block max-h-[420px] w-full bg-zinc-100 object-cover"
                          : "h-16 w-16 rounded-lg object-cover bg-zinc-100"}
                      />
                      {waterfallView && coverMarker && (
                        <span className="absolute right-2 top-2 rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-white shadow-sm">
                          {coverMarker}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className={waterfallView
                      ? "flex aspect-[4/5] w-full items-center justify-center gap-2 bg-zinc-50 px-3 text-xs text-zinc-400"
                      : "flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-xs text-zinc-400"}>
                      {waterfallView ? <><FileText size={14} />暂无封面</> : "无图"}
                    </div>
                  )}
                  <div className={`min-w-0 flex-1 ${waterfallView ? "w-full p-2.5" : ""}`}>
                    <div className="flex flex-wrap items-center gap-1.5 mb-1">
                      <StatusBadge status={note.status} />
                      {(() => {
                        const badge = getNoteTypeBadge(note.note_type);
                        if (!badge) return null;
                        return (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badge.className}`}>
                            {badge.label}
                          </span>
                        );
                      })()}
                      <span className="ml-auto whitespace-nowrap text-xs text-zinc-500">{note.created_at?.slice(0, 10)}</span>
                    </div>
                    <p className="text-base font-semibold leading-snug text-zinc-900 truncate">
                      {note.title || "（未填写标题）"}
                    </p>
                    {note.body && (
                      <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{note.body}</p>
                    )}
                    {note.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {note.tags.slice(0, waterfallView ? 3 : 4).map((t) => (
                          <span key={t} className="rounded-md bg-[#ff2442]/5 px-1.5 py-0.5 text-[11px] text-[#d91f3b]">#{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* 底部操作栏 */}
                <div className={`flex items-center justify-between border-t border-zinc-100 pt-2.5 ${waterfallView ? "mx-2.5 mb-2.5" : "mt-3"}`}>
                  {/* 左侧：互动数据（已发布）/ 状态推进按钮（草稿/待发） */}
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {!showTrash && note.note_url && <DataCaptureButton url={note.note_url} />}
                    {!showTrash && note.status === "published" && publish.available && (
                      <div className="flex gap-2 items-center">
                        {note.note_url && (
                          <button
                            onClick={(e) => { e.stopPropagation(); openExternalUrl(note.note_url!).catch((error) => toast(`打开链接失败：${error instanceof Error ? error.message : String(error)}`, "error")); }}
                            className="flex items-center gap-1 text-xs text-[#ff2442] border border-[#ff2442]/30 bg-[#ff2442]/5 px-2.5 py-1 rounded-lg hover:bg-[#ff2442]/10 transition-colors"
                            title="在小红书查看"
                          >
                            <ExternalLink size={10} />打开链接
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); moveTo(note.id, "ready"); }}
                          className="text-xs text-amber-600 border border-amber-200 bg-amber-50 px-2.5 py-1 rounded-lg hover:bg-amber-100 transition-colors"
                          title="退回待发，可重新发布"
                        >
                          重新发布
                        </button>
                        <div className="flex gap-3 text-xs text-zinc-400">
                          <span>❤ {note.likes}</span>
                          <span>💬 {note.comments}</span>
                          <span>⭐ {note.collects}</span>
                        </div>
                      </div>
                    )}
                    {!showTrash && note.status === "ready" && (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); moveTo(note.id, "draft"); }}
                          className="text-xs text-zinc-400 border border-zinc-200 px-2.5 py-1 rounded-lg hover:bg-zinc-50 transition-colors"
                        >
                          退回草稿
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (IS_TAURI_RUNTIME) {
                              navigate(`/notes?view=publish&note=${note.id}`);
                              return;
                            }
                            if (!publish.available) {
                              toast(`${publish.reason}。${publish.nextStep}`, "info");
                              return;
                            }
                            setPublishingNote(note);
                          }}
                          disabled={!IS_TAURI_RUNTIME && !publish.available}
                          title={IS_TAURI_RUNTIME ? "打开发布准备" : (publish.available ? "发布" : `${publish.reason}；${publish.nextStep}`)}
                          className="flex items-center gap-1 text-xs text-white bg-[#ff2442] px-2.5 py-1 rounded-lg hover:bg-[#e01f3a] transition-colors font-medium"
                        >
                          <Send size={10} />发布
                        </button>
                      </>
                    )}
                  </div>
                  {/* 右侧：编辑 + 删除 */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                    {!showTrash && (
                      <button
                        onClick={() => navigate(`/notes/${note.id}`)}
                        className="p-1.5 rounded-lg text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
                        title="编辑笔记"
                      >
                        <ChevronRight size={14} />
                      </button>
                    )}
                    {showTrash ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); void restoreNote(note.id); }}
                        disabled={deletingId === note.id}
                        className="text-xs px-2 py-1 rounded-lg text-amber-700 bg-amber-50 hover:bg-amber-100 disabled:opacity-50"
                        title="恢复到笔记列表"
                      >
                        {deletingId === note.id ? "恢复中…" : "恢复"}
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmId(note.id); }}
                        disabled={!noteDelete.available}
                        className="p-1.5 rounded-lg text-zinc-300 hover:text-red-500 hover:bg-red-50 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                        title={noteDelete.available ? "移入笔记回收站" : `${noteDelete.reason}；${noteDelete.nextStep}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 删除确认弹窗 */}
      {confirmId !== null && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setConfirmId(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-6" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold text-zinc-800 mb-1">确认删除？</p>
            <p className="text-xs text-zinc-400 mb-5">笔记会移入当前账号回收站，关联素材会保留，可从回收站恢复。</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmId(null)}
                className="text-xs px-4 py-2 rounded-lg text-zinc-500 hover:bg-zinc-100 transition-colors">
                取消
              </button>
              <button onClick={() => deleteNote(confirmId)} disabled={deletingId === confirmId}
                className="text-xs px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors">
                {deletingId === confirmId ? "删除中..." : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
      {newDraftOpen && (
        <Dialog
          title="新建草稿"
          description="创建后会回到列表，当前本地层先保证创建与回读。"
          onClose={() => !creatingDraft && setNewDraftOpen(false)}
          footer={<><button type="button" className={secondaryButtonClass} disabled={creatingDraft} onClick={() => setNewDraftOpen(false)}>取消</button><button type="button" className={primaryButtonClass} disabled={creatingDraft} onClick={() => void createDraftFromList()}>{creatingDraft ? "创建中…" : "创建草稿"}</button></>}
        >
          <label className="block text-sm font-medium text-[var(--color-text-primary)]">标题（可选）<input autoFocus value={newDraftTitle} onChange={(event) => setNewDraftTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void createDraftFromList()} placeholder="例如：春日客厅改造灵感" className="mt-2 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)]" /></label>
        </Dialog>
      )}
    </div>
  );
}

// ── Note Editor ──────────────────────────────────────────────────────────────

export function NoteEditor() {
  const { id } = useParams<{ id: string }>();
  const noteId = Number(id);
  const [searchParams] = useSearchParams();
  const requestedAISessionKey = searchParams.get("aiSession") || undefined;
  const linkedAISessionKey = requestedAISessionKey && requestedAISessionKey.length <= 180 ? requestedAISessionKey : undefined;
  const linkedAIHostMode = searchParams.get("aiHost") === "sidebar" ? "sidebar" : undefined;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { accountId, accountAlias, databaseIdentity, scopeKey } = useAccountContext();
  const noteAISessionKey = linkedAISessionKey ?? makeAISessionKey({ accountId, noteId });
  const noteRead = getCapability("note.read");
  const noteWrite = getCapability("note.write");
  const noteItemsWrite = getCapability("note.items.write");
  const noteStatusWrite = getCapability("note.status.write");
  const aiGenerate = getCapability("ai.generate");
  const noteExport = getCapability("note.export");

  const { data: remoteNote, isLoading: remoteNoteLoading } = useQuery<Note>({
    queryKey: ["note", noteId],
    queryFn: () => api.get(`/api/content/${noteId}`),
    enabled: !IS_TAURI_RUNTIME,
  });
  const { data: localWorkspace, isLoading: localNoteLoading } = useQuery<LocalWorkspaceSnapshot>({
    queryKey: ["local-workspace", scopeKey, "notes"],
    queryFn: () => readLocalWorkspaceSnapshot(accountId ?? undefined, "notes"),
    enabled: IS_TAURI_RUNTIME && noteRead.available && accountId !== null,
  });
  const note = useMemo(() => IS_TAURI_RUNTIME
    ? (() => { const found = localWorkspace?.notes.find((item) => item.id === noteId); return found ? localNoteToNote(found) : undefined; })()
    : remoteNote, [localWorkspace?.notes, noteId, remoteNote]);
  const editorItems = useMemo(() => localWorkspace?.items.map(localItemToItem), [localWorkspace?.items]);
  const isLoading = IS_TAURI_RUNTIME ? localNoteLoading : remoteNoteLoading;
  const localMode = IS_TAURI_RUNTIME;

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");       // HTML 字符串（Tiptap 输出）
  const [tagsInput, setTagsInput] = useState("");
  const [noteType, setNoteType] = useState<NoteType>("text");
  const [saving, setSaving] = useState(false);
  const [autoSaved, setAutoSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showAI, setShowAI] = useState(() => Boolean(linkedAISessionKey) || (aiGenerate.available && (typeof window === "undefined" || window.innerWidth >= 900)));
  useEffect(() => {
    const source = `notes-editor:${noteId}`;
    publishPageAISidebarVisibility(source, showAI);
    return () => publishPageAISidebarVisibility(source, false);
  }, [noteId, showAI]);
  const [publishPreparation, setPublishPreparation] = useState<PublishPreparation | null>(null);
  const { width: promptWidth, dragging: promptDragging, onDragStart: onPromptDragStart } = usePanelResize({
    defaultWidth: 320,
    min: 240,
    max: 600,
    direction: "left",
    storageKey: "prompt-panel-width",
  });

  // Init local state once note loads
  const [inited, setInited] = useState(false);
  const [noteVersion, setNoteVersion] = useState(1);
  const noteVersionRef = useRef(1);
  // Capture the note version at each AI request. Ordinary editor saves do not
  // advance this baseline; saves caused by applying that same AI draft are
  // tracked separately so sibling fields from one reply remain usable.
  const aiProposalBaseVersionRef = useRef(1);
  const lastAIAppliedProposalBaseVersionRef = useRef<number | null>(null);
  const lastAIAppliedProposalVersionRef = useRef<number | null>(null);
  const pendingAIAppliedProposalBaseVersionRef = useRef<number | null>(null);
  const [lastAIProposal, setLastAIProposal] = useState<AIProposal | null>(null);
  const [proposalHistory, setProposalHistory] = useState<AIProposal[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (linkedAISessionKey) setShowAI(true);
  }, [linkedAISessionKey]);

  useWorkspaceEffect(() => {
    const linkedItemIds = note?.item_ids?.length ? note.item_ids : (note?.item_id != null ? [note.item_id] : []);
    publishPageAIContext({
      route: `/notes/${noteId}`,
      page: "笔记编辑",
      accountId,
      objectType: "note",
      objectId: noteId,
      objectVersion: noteVersion,
      selectedIds: linkedItemIds,
      selectedItems: linkedItemIds.map((id) => ({
        id,
        kind: "素材",
        label: localWorkspace?.items.find((item) => item.id === id)?.title,
      })),
      referenceIds: linkedItemIds,
      draft: {
        title,
        body,
        tags: tagsInput,
        status: note?.status,
        dirty: saving || Boolean(saveError),
      },
      availableActions: [
        { id: "rewrite-note", label: "改写正文" },
        { id: "suggest-title", label: "生成标题" },
        ...(noteWrite.available ? [
          { id: "apply-note-title", label: "替换标题", handler: "apply-note-title" as const },
          { id: "apply-note-body-replace", label: "替换正文", handler: "apply-note-body-replace" as const },
          { id: "apply-note-body-append", label: "追加正文", handler: "apply-note-body-append" as const },
          { id: "apply-note-tags", label: "替换标签", handler: "apply-note-tags" as const },
        ] : []),
        { id: "check-publish", label: "检查发布", requiresConfirmation: true },
      ],
      source: "page",
      permissionScope: ["note.read", "note.write", "note.status.write", "publish"],
    });
  }, [accountId, body, localWorkspace?.items, note, noteId, noteVersion, noteWrite.available, saveError, saving, tagsInput, title]);
  if (note && !inited) {
    setTitle(note.title ?? "");
    // body 直接存纯文本；兼容旧版 HTML 存储：自动剥离标签
    const rawBody = note.body ?? "";
    const isHtml = /<[a-z][\s\S]*>/i.test(rawBody);
    const plainBody = isHtml
      ? rawBody
          .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n")
          .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\n{3,}/g, "\n\n").trim()
      : rawBody;
    setBody(plainBody);
    setTagsInput(note.tags.join(" "));
    setNoteType((note.note_type as "text" | "image" | "video") || "text");
    const version = note.content_version ?? 1;
    setNoteVersion(version);
    noteVersionRef.current = version;
    aiProposalBaseVersionRef.current = version;
    setInited(true);
  }

  // Debounce 自动保存
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveEpochRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useAccountChange(() => {
    saveEpochRef.current += 1;
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    setSaving(false);
    setSaveError(null);
  });

  // 账号或对象切换后丢弃旧编辑态，避免未保存草稿被新账号复用。
  useEffect(() => {
    saveEpochRef.current += 1;
    setInited(false);
    setTitle("");
    setBody("");
    setTagsInput("");
    setNoteVersion(1);
    noteVersionRef.current = 1;
    aiProposalBaseVersionRef.current = 1;
    lastAIAppliedProposalBaseVersionRef.current = null;
    lastAIAppliedProposalVersionRef.current = null;
    pendingAIAppliedProposalBaseVersionRef.current = null;
    setLastAIProposal(null);
    setProposalHistory([]);
    setAutoSaved(false);
    setSaveError(null);
    setShowPrompt(false);
  }, [scopeKey, noteId]);

  // Restore only the latest bounded history for this database/account/note.
  // The scope changes whenever the active account changes, so a prior account's
  // proposal can never become the current editor's diff by accident.
  useEffect(() => {
    const history = listProposals(databaseIdentity, accountId, noteId);
    setProposalHistory(history);
    setLastAIProposal(history[0] ?? null);
  }, [accountId, databaseIdentity, noteId]);

  type SavePayload = {
    title: string;
    body: string;
    tagsInput: string;
    noteType: NoteType;
    itemIds: number[];
    epoch: number;
    accountId: number | null;
    noteId: number;
    aiProposalBaseVersion?: number;
  };

  function enqueueSave(payload: SavePayload): Promise<void> {
    const queued = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (payload.epoch !== saveEpochRef.current || payload.noteId !== noteId) return;
        setSaving(true);
        try {
          const tags = payload.tagsInput.split(/[\s,，#]+/).map((t) => t.trim()).filter(Boolean);
          if (localMode) {
            if (!noteWrite.available) throw new Error(`${noteWrite.reason}。${noteWrite.nextStep}`);
            if (payload.accountId === null) throw new Error("当前账号尚未就绪");
            const updated = await updateLocalNote({
              noteId: payload.noteId,
              accountPoolId: payload.accountId,
              expectedVersion: noteVersionRef.current,
              title: payload.title,
              body: payload.body,
              tags,
              noteType: payload.noteType,
              itemIds: payload.itemIds,
            });
            if (payload.epoch !== saveEpochRef.current) return;
            const nextVersion = updated.contentVersion ?? noteVersionRef.current + 1;
            noteVersionRef.current = nextVersion;
            setNoteVersion(nextVersion);
            if (payload.aiProposalBaseVersion != null && aiProposalBaseVersionRef.current === payload.aiProposalBaseVersion) {
              lastAIAppliedProposalBaseVersionRef.current = payload.aiProposalBaseVersion;
              lastAIAppliedProposalVersionRef.current = nextVersion;
              if (pendingAIAppliedProposalBaseVersionRef.current === payload.aiProposalBaseVersion) {
                pendingAIAppliedProposalBaseVersionRef.current = null;
              }
            }
            await qc.invalidateQueries({ queryKey: ["local-workspace", scopeKey] });
          } else {
            await api.patch(`/api/content/${payload.noteId}`, {
              title: payload.title,
              body: payload.body,
              tags,
              note_type: payload.noteType,
            });
            if (payload.epoch !== saveEpochRef.current || payload.accountId !== accountId) return;
            qc.invalidateQueries({ queryKey: ["notes"] });
            qc.invalidateQueries({ queryKey: ["note", payload.noteId] });
          }
          if (payload.epoch !== saveEpochRef.current) return;
          setSaveError(null);
          setAutoSaved(true);
          setTimeout(() => setAutoSaved(false), 2000);
        } catch (cause) {
          if (payload.epoch === saveEpochRef.current) {
            setSaveError(formatSaveError(cause));
          }
          throw cause;
        } finally {
          if (payload.epoch === saveEpochRef.current) setSaving(false);
        }
      });
    saveQueueRef.current = queued.catch(() => undefined);
    return queued;
  }

  function scheduleAutoSave(newTitle: string, newBody: string, newTags: string, nextNoteType = noteType, aiProposalBaseVersion?: number, delayMs = AUTOSAVE_DELAY) {
    if (aiProposalBaseVersion == null) pendingAIAppliedProposalBaseVersionRef.current = null;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    const saveEpoch = saveEpochRef.current;
    const originAccountId = accountId;
    const originNoteId = noteId;
    const itemIds = note?.item_ids?.length ? note.item_ids : (note?.item_id ? [note.item_id] : []);
    autoSaveTimer.current = setTimeout(() => {
      void enqueueSave({
        title: newTitle,
        body: newBody,
        tagsInput: newTags,
        noteType: nextNoteType,
        itemIds,
        epoch: saveEpoch,
        accountId: originAccountId,
        noteId: originNoteId,
        ...(aiProposalBaseVersion != null ? { aiProposalBaseVersion } : {}),
      }).catch(() => undefined);
    }, delayMs);
  }

  // 清理 timer
  useEffect(() => () => { autoSaveTimer.current && clearTimeout(autoSaveTimer.current); }, []);

  async function save() {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    const saveEpoch = saveEpochRef.current;
    const originAccountId = accountId;
    const originNoteId = noteId;
    try {
      await enqueueSave({
        title,
        body,
        tagsInput,
        noteType,
        itemIds: note?.item_ids?.length ? note.item_ids : (note?.item_id ? [note.item_id] : []),
        epoch: saveEpoch,
        accountId: originAccountId,
        noteId: originNoteId,
        ...(pendingAIAppliedProposalBaseVersionRef.current != null ? { aiProposalBaseVersion: pendingAIAppliedProposalBaseVersionRef.current } : {}),
      });
      if (saveEpoch !== saveEpochRef.current || originAccountId !== accountId) return;
      toast("已保存", "success");
    } catch (e: unknown) {
      if (saveEpoch === saveEpochRef.current) toast(formatSaveError(e), "error");
    }
  }

  useWorkspaceEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  });

  async function markReady() {
    if (!noteStatusWrite.available) {
      toast(`${noteStatusWrite.reason}。${noteStatusWrite.nextStep}`, "info");
      return;
    }
    try {
      if (localMode) {
        if (accountId === null) throw new Error("当前账号尚未就绪");
        const updated = await updateLocalNoteStatus({
          noteId,
          accountPoolId: accountId,
          expectedVersion: noteVersionRef.current,
          status: "ready",
        });
        const nextVersion = updated.contentVersion ?? noteVersionRef.current + 1;
        noteVersionRef.current = nextVersion;
        setNoteVersion(nextVersion);
        setSaveError(null);
        await qc.invalidateQueries({ queryKey: ["local-workspace", scopeKey] });
      } else {
        await api.patch(`/api/content/${noteId}/status`, { status: "ready" });
        qc.invalidateQueries({ queryKey: ["note", noteId] });
        qc.invalidateQueries({ queryKey: ["notes"] });
      }
    } catch (e: unknown) {
      const message = formatSaveError(e);
      setSaveError(message);
      toast(message, "error");
    }
  }

  async function copyMarkdown() {
    if (!noteExport.available) {
      toast(`${noteExport.reason}。${noteExport.nextStep}`, "info");
      return;
    }
    try {
      const markdown = localMode
        ? noteToMarkdown({
            title,
            body,
            tags: tagsInput.split(/[\s,，#]+/).map((tag) => tag.trim()).filter(Boolean),
            status: note?.status ?? "draft",
            createdAt: note?.created_at,
            coverDesc: note?.cover_desc,
          })
        : (await api.get(`/api/content/${noteId}/export`)).markdown;
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    }
  }

  function loadPrompt() {
    if (!note?.prompt_used) return;
    setPrompt(note.prompt_used);
    setShowPrompt(true);
  }

  function adoptAIProposal(field: AIProposal["field"], value: string, apply: (baseVersion: number) => void, proposalBaseVersion?: number): boolean {
    const previousValue = field === "title" ? title : field === "body" ? body : tagsInput;
    const proposal = createProposal({
      accountId,
      noteId,
      baseVersion: proposalBaseVersion ?? aiProposalBaseVersionRef.current,
      field,
      previousValue,
      value,
    });
    const followsSameAIAppliedDraft =
      lastAIAppliedProposalBaseVersionRef.current === proposal.baseVersion &&
      lastAIAppliedProposalVersionRef.current === noteVersionRef.current;
    if (!isProposalCurrent(proposal, { accountId, noteId, version: noteVersionRef.current }) && !followsSameAIAppliedDraft) {
      const next = { ...proposal, status: "conflict" as const };
      saveProposal(databaseIdentity, next);
      setProposalHistory((current) => [next, ...current.filter((item) => item.id !== next.id)].slice(0, 40));
      setLastAIProposal(next);
      toast("AI 提案基于旧版本，原文已保留；请重新生成后再采用", "info");
      return false;
    }
    pendingAIAppliedProposalBaseVersionRef.current = proposal.baseVersion;
    apply(proposal.baseVersion);
    const next = { ...proposal, status: "applied" as const };
    saveProposal(databaseIdentity, next);
    setProposalHistory((current) => [next, ...current.filter((item) => item.id !== next.id)].slice(0, 40));
    setLastAIProposal(next);
    return true;
  }

  /** AIPanel 点击「应用到编辑器」时，将文本追加到正文。 */
  function handleAIApply(text: string) {
    adoptAIProposal("body", text, (baseVersion) => {
      const newBody = body ? body + "\n" + text : text;
      setBody(newBody);
      scheduleAutoSave(title, newBody, tagsInput, noteType, baseVersion, 0);
    });
  }

  if (isLoading) return <Spinner />;
  if (!note) return <div className="p-6 text-zinc-400">笔记不存在</div>;

  const saveStatus = saving
    ? "保存中…"
    : saveError
      ? "保存失败"
      : autoSaved
        ? "已保存"
        : `已同步 · v${noteVersion}`;
  const accountLabel = accountAlias || (accountId === null ? "未选择" : `账号 #${accountId}`);
  const hasAIConflict = lastAIProposal?.status === "conflict";

  return (
    <div className="creator-note-editor flex h-full min-w-0">
      {/* Left: Phone Preview + Editor */}
      <div className="creator-note-main flex-1 flex min-w-0 flex-col overflow-hidden">
        {/* Toolbar */}
          <div className="creator-note-toolbar flex items-center gap-3 px-6 py-3 border-b border-zinc-100 bg-white">
          <button
            onClick={() => navigate("/notes")}
            className="text-zinc-400 hover:text-zinc-700 text-sm"
          >
            ← 返回
          </button>
          <StatusBadge status={note.status} />
          <span className="text-[11px] text-[var(--color-text-secondary)] border border-[var(--color-border)] rounded-full px-2 py-0.5 max-w-[180px] truncate" title={`当前账号：${accountLabel}`}>
            当前账号：{accountLabel}
          </span>
          <span
            className={`creator-note-save-status text-xs ${saveError ? "text-red-500" : saving ? "text-amber-600" : "text-zinc-400"}`}
            aria-live="polite"
            title={saveError ?? undefined}
          >
            {saveStatus}{saveError ? "，点击保存重试" : ""}
          </span>
          {hasAIConflict && (
            <span className="creator-note-conflict text-xs text-amber-600" role="status">
              内容已变化，AI 建议未采用
            </span>
          )}
          <div className="creator-note-toolbar-actions ml-auto flex min-w-0 flex-wrap justify-end gap-2">
            {note.prompt_used && (
              <button
                onClick={() => { loadPrompt(); setShowAI(false); }}
                className={`flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-lg transition-colors ${
                  showPrompt
                    ? "bg-[#fff0f2] border-[#ff2442] text-[#ff2442]"
                    : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
                }`}
              >
                <FileText size={13} />
                查看 Prompt
              </button>
            )}
            <button
              onClick={copyMarkdown}
              disabled={!noteExport.available}
              title={noteExport.available ? "复制 Markdown" : `${noteExport.reason}；${noteExport.nextStep}`}
              className="flex items-center gap-1.5 text-xs border border-zinc-200 px-3 py-1.5 rounded-lg hover:bg-zinc-50"
            >
              <Copy size={13} />
              {copied ? "已复制!" : "复制 MD"}
            </button>
            {note.status === "draft" && (
              <button
                onClick={markReady}
                disabled={!noteStatusWrite.available}
                title={noteStatusWrite.available ? "标记待发" : `${noteStatusWrite.reason}；${noteStatusWrite.nextStep}`}
                className="text-xs bg-amber-500 text-white px-3 py-1.5 rounded-lg hover:bg-amber-600"
              >
                标记待发
              </button>
            )}
            <button
              type="button"
              onClick={() => setPublishPreparation(preparePublish({ ...note, title, body, tags: tagsInput.split(/[\s,，#]+/).map((tag) => tag.trim()).filter(Boolean) }, accountId))}
              className="flex items-center gap-1.5 text-xs border border-zinc-200 px-3 py-1.5 rounded-lg text-zinc-500 hover:bg-zinc-50"
              title="检查当前内容快照，不会提交到平台"
            >
              发布检查
            </button>
            <DataCaptureButton url={note.note_url} size="sm" />
            <button
              onClick={save}
              disabled={saving}
              title={saveError ? `${saveError}；点击重试` : "保存笔记"}
              className="creator-note-toolbar-save flex shrink-0 items-center gap-1.5 text-xs bg-[#ff2442] text-white px-3 py-1.5 rounded-lg hover:bg-[#e01f3a] disabled:opacity-50"
            >
              <Save size={13} />
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>

        {lastAIProposal && (
          <div className="creator-note-ai-diff mx-6 mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600" role="status">
            <div className="flex items-center justify-between gap-2">
              <span>AI 提案：{lastAIProposal.field === "title" ? "标题" : lastAIProposal.field === "body" ? "正文" : "标签"} · {lastAIProposal.status === "conflict" ? "未采用" : "已采用"} · 历史 {proposalHistory.length} 条</span>
              <details>
                <summary className="cursor-pointer text-[#ff2442]">查看差异</summary>
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  <div className="rounded bg-red-50 px-2 py-1"><span className="text-[10px] text-red-500">原值</span><p className="whitespace-pre-wrap break-words line-through decoration-red-300">{lastAIProposal.previousValue || "（空）"}</p></div>
                  <div className="rounded bg-green-50 px-2 py-1"><span className="text-[10px] text-green-600">建议</span><p className="whitespace-pre-wrap break-words">{lastAIProposal.value || "（空）"}</p></div>
                </div>
              </details>
            </div>
          </div>
        )}

        {localMode && (
          <div className="border-b border-[var(--color-border)] bg-[var(--color-selected)] px-6 py-2 text-xs text-[var(--color-text-secondary)]">
            当前笔记来自本地数据库；{noteWrite.available ? "标题、正文、标签、类型和状态支持本地保存" : "本地笔记编辑仍需迁移"}；{noteItemsWrite.available ? "素材关联、排序与移除可用" : "素材关联仍需迁移"}；{noteExport.available ? "导出可用" : "导出仍需迁移"}，{aiGenerate.available ? "AI 可用" : "AI 助手会检测本地 CLI"}。
          </div>
        )}
        {publishPreparation && (
          <div className={`border-b px-6 py-2 text-xs ${publishPreparation.ready ? "border-emerald-100 bg-emerald-50 text-emerald-700" : "border-amber-100 bg-amber-50 text-amber-700"}`} role="status">
            <span className="font-medium">{publishPreparation.ready ? "内容检查通过" : "内容检查未通过"}</span>
            <span className="ml-2">快照 {publishPreparation.snapshotKey}</span>
            {!publishPreparation.ready && <span className="ml-2">{publishPreparation.issues.map((issue) => issue.message).join("；")}</span>}
          </div>
        )}

        {/* Editor body: two-column on wide screens, stacked on narrow */}
        <div className="flex-1 overflow-hidden">
          <div className="flex gap-0 h-full">
            {/* Phone-style preview card */}
            <NoteImagePanel
              itemIds={note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : [])}
              title={title}
              body={body}
              tags={note.tags}
              localItems={editorItems}
              localProfile={localWorkspace?.profile}
            />

            {/* Text editor */}
            <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
              {/* 图片缩略条（仿小红书发布页，标题上方） */}
              <div className="px-6 pt-6 shrink-0">
                <NoteImageStrip
                  itemIds={note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : [])}
                  noteId={noteId}
                  localItems={editorItems}
                  onItemIdsChange={async (itemIds) => {
                    const saveEpoch = saveEpochRef.current;
                    if (localMode) {
                      if (!noteItemsWrite.available) throw new Error(`${noteItemsWrite.reason}。${noteItemsWrite.nextStep}`);
                      if (accountId === null) throw new Error("当前账号尚未就绪");
                      const updated = await updateLocalNoteItems({
                        noteId,
                        accountPoolId: accountId,
                        expectedVersion: noteVersionRef.current,
                        itemIds,
                      });
                      if (saveEpoch !== saveEpochRef.current) return;
                      noteVersionRef.current = updated.contentVersion;
                      setNoteVersion(updated.contentVersion);
                      await qc.invalidateQueries({ queryKey: ["local-workspace", scopeKey] });
                    } else {
                      await api.patch(`/api/content/${noteId}`, { item_ids: itemIds });
                      await qc.invalidateQueries({ queryKey: ["note", noteId] });
                    }
                  }}
                  readOnly={false}
                  allowAdd={!localMode}
                />
                {localMode && (
                  <p className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
                    本地模式支持当前账号素材的关联、排序与移除；新增素材导入仍待迁移。
                  </p>
                )}

                {/* Title */}
                <input
                  type="text"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    scheduleAutoSave(e.target.value, body, tagsInput);
                  }}
                  readOnly={false}
                  placeholder="笔记标题..."
                  className="w-full text-xl font-semibold text-zinc-900 outline-none bg-transparent placeholder:text-zinc-300 mb-3"
                />
              </div>

              {/* Body — 纯文本编辑器 + 表情 */}
              <BodyEditor
                value={body}
                onChange={(text) => {
                  setBody(text);
                  scheduleAutoSave(title, text, tagsInput);
                }}
                tagsLength={tagsInput.length}
                className="flex-1 min-h-0"
                readOnly={false}
              />

              {/* 话题标签 — 固定在底部，紧凑 */}
              <div className="shrink-0 border-t border-zinc-100 px-6 py-2">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Hash size={11} className="text-zinc-400" />
                  <label className="text-[11px] text-zinc-400">话题标签（空格或#分隔）</label>
                </div>
                <input
                  type="text"
                  value={tagsInput}
                  onChange={(e) => {
                    setTagsInput(e.target.value);
                    scheduleAutoSave(title, body, e.target.value);
                  }}
                  readOnly={false}
                  placeholder="#出租屋改造 #租房好物 ..."
                  className="w-full text-xs text-[#ff2442] outline-none bg-transparent placeholder:text-zinc-300 leading-snug"
                />
              </div>

              {/* 发布类型选择 — 两层结构 */}
              <div className="shrink-0 border-t border-zinc-100 px-6 py-2.5 flex items-center gap-3 flex-wrap">
                <span className="text-[11px] text-zinc-400 shrink-0">发布类型</span>
                <div className="flex gap-2 flex-wrap">
                  {NOTE_TYPE_GROUPS.map((group) => {
                    const groupActive = group.types.some((t) => t.key === noteType);
                    // 单类型分组直接渲染按钮，多类型分组渲染分组+子项
                    if (group.types.length === 1) {
                      const t = group.types[0];
                      return (
                        <button
                          key={t.key}
                          disabled={!t.available}
                          onClick={async () => {
                            if (!t.available) return;
                            setNoteType(t.key);
                            try {
                              if (localMode) {
                                await enqueueSave({
                                  title,
                                  body,
                                  tagsInput,
                                  noteType: t.key,
                                  itemIds: note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : []),
                                  epoch: saveEpochRef.current,
                                  accountId,
                                  noteId,
                                });
                              } else {
                                await api.patch(`/api/content/${noteId}`, { note_type: t.key });
                                qc.invalidateQueries({ queryKey: ["note", noteId] });
                              }
                            } catch (cause) {
                              toast(formatSaveError(cause), "error");
                            }
                          }}
                          title={t.description}
                          className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                            noteType === t.key
                              ? "bg-[#ff2442] text-white"
                              : t.available
                                ? "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                                : "bg-zinc-50 text-zinc-300 cursor-not-allowed"
                          }`}
                        >
                          <span>{t.icon}</span>{t.label}
                          {!t.available && <span className="text-[9px] ml-0.5">即将</span>}
                        </button>
                      );
                    }
                    // 多类型分组（图文）：分组标题 + 子按钮
                    return (
                      <div key={group.key} className="flex items-center gap-1">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${
                          groupActive ? "border-[#ff2442]/30 text-[#ff2442] bg-[#ff2442]/5" : "border-zinc-200 text-zinc-400"
                        }`}>
                          {group.icon}{group.label}
                        </span>
                        <span className="text-zinc-200 text-[10px]">›</span>
                        {group.types.map((t) => (
                          <button
                            key={t.key}
                            disabled={!t.available}
                          onClick={async () => {
                            if (!t.available) return;
                            setNoteType(t.key);
                            try {
                              if (localMode) {
                                await enqueueSave({
                                  title,
                                  body,
                                  tagsInput,
                                  noteType: t.key,
                                  itemIds: note.item_ids?.length ? note.item_ids : (note.item_id ? [note.item_id] : []),
                                  epoch: saveEpochRef.current,
                                  accountId,
                                  noteId,
                                });
                              } else {
                                await api.patch(`/api/content/${noteId}`, { note_type: t.key });
                                qc.invalidateQueries({ queryKey: ["note", noteId] });
                              }
                            } catch (cause) {
                              toast(formatSaveError(cause), "error");
                            }
                            }}
                            title={t.description}
                            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                              noteType === t.key
                                ? "bg-[#ff2442] text-white"
                                : t.available
                                  ? "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                                  : "bg-zinc-50 text-zinc-300 cursor-not-allowed"
                            }`}
                          >
                            <span>{t.icon}</span>{t.label}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right: AI Panel / Prompt Panel */}
      {showAI && (
        <AIPanel
          noteId={noteId}
          itemId={note.item_id}
          accountId={accountId}
          available={aiGenerate.available}
          unavailableReason={aiGenerate.reason}
          unavailableNextStep={aiGenerate.nextStep}
          systemExtra={`当前笔记标题：${title || "（空）"}\n当前笔记正文：${body.slice(0, 12000) || "（空）"}\n当前话题：${tagsInput || "（空）"}`}
          sourceNotice={`AI 提案仅基于当前笔记、已选素材和已注入经验；只有带正文的真实来源才可用于摘要。${lastAIProposal?.status === "conflict" ? "上次提案版本已变化，未覆盖原文。" : ""}`}
          onApply={handleAIApply}
          onApplyTitle={(t, proposalBaseVersion) => adoptAIProposal("title", t, (baseVersion) => {
              setTitle(t);
              scheduleAutoSave(t, body, tagsInput, noteType, baseVersion, 0);
            }, proposalBaseVersion)}
          onApplyTags={(tags, proposalBaseVersion) => adoptAIProposal("tags", tags, (baseVersion) => {
              setTagsInput(tags);
              scheduleAutoSave(title, body, tags, noteType, baseVersion, 0);
            }, proposalBaseVersion)}
          onApplyBody={(text, mode, proposalBaseVersion) => adoptAIProposal("body", text, (baseVersion) => {
              const newBody = mode === "replace" ? text : (body ? body + "\n\n" + text : text);
              setBody(newBody);
              scheduleAutoSave(title, newBody, tagsInput, noteType, baseVersion, 0);
            }, proposalBaseVersion)}
          onAIRequestStart={() => {
            aiProposalBaseVersionRef.current = noteVersionRef.current;
          }}
          hostMode={linkedAIHostMode ?? "sidebar"}
          sessionKey={noteAISessionKey}
          historyKey={noteAISessionKey}
          onClose={() => setShowAI(false)}
        />
      )}
      {showPrompt && prompt && (
        <div
          className="note-ai-drawer creator-note-aux-panel creator-note-prompt-panel border-l border-zinc-100 bg-white flex flex-col shrink-0 relative select-none"
          style={{ width: promptWidth, cursor: promptDragging ? "col-resize" : undefined }}
        >
          {/* 拖拽条 */}
          <div
            onMouseDown={onPromptDragStart}
            className="absolute left-0 top-0 bottom-0 z-10 flex items-center justify-center group cursor-col-resize"
            style={{ width: 12, marginLeft: -4 }}
            title="拖动调整宽度"
          >
            <div
              className={`w-[3px] h-full rounded-full transition-colors duration-150
                ${promptDragging ? "bg-[#ff2442]" : "bg-transparent group-hover:bg-[#ff2442]/40"}`}
            />
          </div>
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-700">
              <FileText size={14} className="text-[#ff2442]" />
              创作 Prompt
            </div>
            <button onClick={() => setShowPrompt(false)} aria-label="收起创作 Prompt" className="creator-note-aux-collapse text-zinc-400 hover:text-zinc-700 text-xs">
              收起
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <pre className="text-xs text-zinc-600 whitespace-pre-wrap leading-relaxed">{prompt}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
