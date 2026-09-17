import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, Image, Lightbulb, Search as SearchIcon, Users, X } from "lucide-react";
import { api } from "../lib/api";
import { Empty, Spinner } from "../components/ui";
import {
  IS_TAURI_RUNTIME,
  localItemToItem,
  localNoteToNote,
  localReferenceAccountToReferenceAccount,
  readLocalWorkspaceSnapshot,
  readLocalInspirations,
  saveLocalInspiration,
  type LocalInspirationSummary,
  type LocalWorkspaceSnapshot,
} from "../lib/local";
import { useAccountContext } from "../lib/accountContext";
import { listInspirations, type Inspiration } from "../lib/inspirationCapture";
import { searchWorkspace, type WorkspaceSearchKind, type WorkspaceSearchResult } from "../lib/workspaceSearch";
import type { Item, Note, ReferenceAccount } from "../lib/types";

const QUERY_STORAGE_PREFIX = "aichihongshu.workspace-search.v1";

const kindMeta: Record<WorkspaceSearchKind, { label: string; icon: typeof FileText }> = {
  note: { label: "笔记", icon: FileText },
  item: { label: "素材", icon: Image },
  inspiration: { label: "灵感", icon: Lightbulb },
  reference: { label: "榜样", icon: Users },
};

function storageKey(scopeKey: string): string {
  return `${QUERY_STORAGE_PREFIX}:${encodeURIComponent(scopeKey)}`;
}

function readSavedQuery(scopeKey: string): string {
  try { return window.localStorage.getItem(storageKey(scopeKey)) ?? ""; } catch { return ""; }
}

function localInspirationToInspiration(item: LocalInspirationSummary): Inspiration {
  return {
    id: item.id,
    accountId: item.accountPoolId,
    title: item.title,
    sourceUrl: item.sourceUrl,
    body: item.body,
    observedAt: item.observedAt,
    reason: item.reason,
    status: item.status,
    ...(item.noteId != null ? { noteId: item.noteId } : {}),
    ...(item.dedupeKey ? { dedupeKey: item.dedupeKey } : {}),
  };
}

export default function WorkspaceSearch() {
  const { accountId, accountAlias, databaseIdentity, scopeKey } = useAccountContext();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [inspirations, setInspirations] = useState<Inspiration[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const localQuery = useQuery<LocalWorkspaceSnapshot>({
    queryKey: ["local-search", scopeKey],
    queryFn: () => readLocalWorkspaceSnapshot(accountId ?? undefined),
    enabled: IS_TAURI_RUNTIME && accountId !== null,
  });
  const remoteNotes = useQuery<Note[]>({
    queryKey: ["search-notes", scopeKey],
    queryFn: () => api.get("/api/content/?limit=200"),
    enabled: !IS_TAURI_RUNTIME,
  });
  const remoteItems = useQuery<Item[]>({
    queryKey: ["search-items", scopeKey],
    queryFn: () => api.get("/api/library/?offset=0&limit=200"),
    enabled: !IS_TAURI_RUNTIME,
  });
  const remoteReferences = useQuery<ReferenceAccount[]>({
    queryKey: ["search-references", scopeKey],
    queryFn: () => api.get("/api/accounts/"),
    enabled: !IS_TAURI_RUNTIME,
  });

  useEffect(() => {
    let active = true;
    if (IS_TAURI_RUNTIME && accountId !== null) {
      void readLocalInspirations(accountId).then(async (items) => {
        if (items.length === 0) {
          const legacy = listInspirations(databaseIdentity, accountId);
          for (const item of legacy) {
            try {
              await saveLocalInspiration({
                id: item.id,
                accountPoolId: item.accountId,
                title: item.title,
                sourceUrl: item.sourceUrl,
                body: item.body,
                observedAt: item.observedAt,
                reason: item.reason,
                dedupeKey: item.dedupeKey,
              });
            } catch {
              // 搜索页不因单条旧灵感损坏而阻断其他数据。
            }
          }
          if (legacy.length > 0) items = await readLocalInspirations(accountId);
        }
        if (active) setInspirations(items.map(localInspirationToInspiration));
      }).catch(() => {
        if (active) setInspirations([]);
      });
    } else {
      setInspirations([]);
    }
    const fromUrl = params.get("q");
    if (fromUrl === null) setQuery(readSavedQuery(scopeKey));
    return () => { active = false; };
  }, [accountId, databaseIdentity, params, scopeKey]);

  useEffect(() => {
    try { window.localStorage.setItem(storageKey(scopeKey), query); } catch { /* storage optional */ }
    const next = new URLSearchParams(params);
    if (query.trim()) next.set("q", query.trim()); else next.delete("q");
    setParams(next, { replace: true });
  }, [query, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const key = `${storageKey(scopeKey)}:scroll`;
    try {
      const value = Number(window.sessionStorage.getItem(key));
      if (Number.isFinite(value) && listRef.current) listRef.current.scrollTop = value;
    } catch { /* storage optional */ }
    const element = listRef.current;
    if (!element) return;
    const save = () => { try { window.sessionStorage.setItem(key, String(element.scrollTop)); } catch { /* optional */ } };
    element.addEventListener("scroll", save, { passive: true });
    return () => element.removeEventListener("scroll", save);
  }, [scopeKey, localQuery.data]);

  const localItems = useMemo(() => (localQuery.data?.items ?? []).map(localItemToItem), [localQuery.data?.items]);
  const localNotes = useMemo(() => (localQuery.data?.notes ?? []).map(localNoteToNote), [localQuery.data?.notes]);
  const localReferences = useMemo(() => (localQuery.data?.referenceAccounts ?? []).map(localReferenceAccountToReferenceAccount), [localQuery.data?.referenceAccounts]);
  const notes = IS_TAURI_RUNTIME ? localNotes : (remoteNotes.data ?? []);
  const items = IS_TAURI_RUNTIME ? localItems : (remoteItems.data ?? []);
  const references = IS_TAURI_RUNTIME ? localReferences : (remoteReferences.data ?? []);
  const results = useMemo<WorkspaceSearchResult[]>(() => searchWorkspace({ query, notes, items, inspirations, references }), [query, notes, items, inspirations, references]);
  const loading = IS_TAURI_RUNTIME ? localQuery.isLoading : remoteNotes.isLoading || remoteItems.isLoading || remoteReferences.isLoading;
  const accountLabel = accountAlias || (accountId === null ? "未选择" : `账号 ${accountId}`);

  return (
    <div className="flex h-full flex-col bg-[var(--color-canvas)]">
      <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">统一搜索</h1>
            <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">只搜索当前账号的笔记、素材、灵感和榜样资料</p>
          </div>
          <span className="ml-auto rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)]">当前账号：{accountLabel}</span>
        </div>
        <div className="relative mt-4 max-w-2xl">
          <SearchIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setQuery("")}
            placeholder="搜索标题、正文、标签、观察或账号…"
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-2.5 pl-10 pr-10 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/20"
          />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="清除搜索" className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700"><X size={15} /></button>}
        </div>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto p-6">
        {!query.trim() ? (
          <div className="mx-auto max-w-2xl rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center text-sm text-[var(--color-text-secondary)]">输入关键词开始搜索</div>
        ) : loading ? <Spinner /> : results.length === 0 ? <Empty message="当前账号没有匹配结果" /> : (
          <div className="mx-auto max-w-2xl space-y-2">
            <p className="mb-3 text-xs text-[var(--color-text-secondary)]">找到 {results.length} 条结果</p>
            {results.map((result) => {
              const meta = kindMeta[result.kind];
              const Icon = meta.icon;
              return (
                <Link key={result.id} to={result.href} className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition hover:border-[var(--color-brand)] hover:shadow-sm">
                  <span className="mt-0.5 rounded-lg bg-[var(--color-selected)] p-2 text-[var(--color-brand)]"><Icon size={16} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2"><span className="truncate text-sm font-medium text-[var(--color-text-primary)]">{result.title}</span><span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500">{meta.label}</span>{result.badge && <span className="shrink-0 text-[10px] text-zinc-400">{result.badge}</span>}</span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--color-text-secondary)]">{result.summary}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
