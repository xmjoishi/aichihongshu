import { useCallback, useEffect, useState } from "react";
import {
  IS_TAURI_RUNTIME,
  readLocalRuntimeStatus,
  readLocalWorkspaceSnapshot,
  type LocalRuntimeStatus as LocalRuntimeStatusData,
  type LocalWorkspaceSnapshot,
} from "../lib/local";

export default function LocalRuntimeStatus() {
  const [runtime, setRuntime] = useState<LocalRuntimeStatusData | null>(null);
  const [snapshot, setSnapshot] = useState<LocalWorkspaceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!IS_TAURI_RUNTIME) return;
    setLoading(true);
    setError(null);
    try {
      const [status, workspace] = await Promise.all([
        readLocalRuntimeStatus(),
        readLocalWorkspaceSnapshot(),
      ]);
      setRuntime(status);
      setSnapshot(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      <span className="max-w-28 truncate" title={`当前账号：${snapshot.activeAccount.alias}`}>
        {snapshot.activeAccount.alias}
      </span>
      <span>图库 {snapshot.items.length}</span>
      <span>笔记 {snapshot.notes.length}</span>
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
