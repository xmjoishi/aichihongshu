import { useQuery } from "@tanstack/react-query";
import { IS_TAURI_RUNTIME, readLocalRuntimeStatus, readLocalWorkspaceSnapshot } from "../lib/local";
import { useAccountContext } from "../lib/accountContext";

export default function LocalRuntimeStatus() {
  const { accountId, scopeKey } = useAccountContext();
  const runtimeQuery = useQuery({
    queryKey: ["local-runtime-status"],
    queryFn: readLocalRuntimeStatus,
    enabled: IS_TAURI_RUNTIME,
    staleTime: Infinity,
  });
  const summaryQuery = useQuery({
    queryKey: ["local-workspace", scopeKey, "summary"],
    queryFn: () => readLocalWorkspaceSnapshot(accountId ?? undefined, "summary"),
    enabled: IS_TAURI_RUNTIME && accountId !== null,
  });
  const runtime = runtimeQuery.data;
  const snapshot = summaryQuery.data;
  const error = runtimeQuery.error?.message ?? summaryQuery.error?.message;
  const loading = runtimeQuery.isFetching || summaryQuery.isFetching;
  const refresh = () => Promise.all([runtimeQuery.refetch(), summaryQuery.refetch()]);

  if (!IS_TAURI_RUNTIME) {
    return (
      <span className="text-[11px] text-zinc-400" title="当前为浏览器预览模式">
        浏览器预览
      </span>
    );
  }

  if (error) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-[11px] text-red-500" title={error}>
        <span>本地存储错误</span>
        <button className="text-zinc-500 underline" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  }

  if (!runtime || !snapshot) {
    return <span className="text-[11px] text-zinc-400">正在连接本地存储…</span>;
  }

  return (
    <div className="flex min-w-0 items-center gap-2 text-[11px] text-zinc-500">
      <span className="inline-flex items-center gap-1 text-emerald-600" title="本地数据可用">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        本地数据可用
      </span>
      <span>图库 {snapshot.itemCount}</span>
      <span>笔记 {snapshot.noteCount}</span>
      <button
        className="text-zinc-400 hover:text-zinc-700 disabled:opacity-50"
        disabled={loading}
        onClick={() => void refresh()}
        title="刷新本地工作区快照"
      >
        刷新
      </button>
    </div>
  );
}
