import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Users, Shield } from "lucide-react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import {
  IS_TAURI_RUNTIME,
  activateLocalAccount,
  readLocalAccountPool,
  type LocalPoolAccount,
} from "../lib/local";
import { emitAccountChanged } from "../lib/accountContext";
import { useToast } from "./Toast";

interface PoolAccount {
  id: number;
  alias: string;
  role: "operation" | "assistant";
  display_name?: string;
  is_active?: boolean;
  status: string;
}

const ROLE_BADGE: Record<PoolAccount["role"], { label: string; cls: string }> = {
  operation: { label: "运营", cls: "bg-rose-100 text-rose-600" },
  assistant: { label: "辅助", cls: "bg-sky-100 text-sky-700" },
};

export default function ActiveAccountSwitcher({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [compactMenuPosition, setCompactMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: remotePoolData } = useQuery<{ items: PoolAccount[] }>({
    queryKey: ["account-pool"],
    queryFn: () => api.get("/api/account-pool"),
    enabled: !IS_TAURI_RUNTIME,
    refetchOnWindowFocus: true,
    refetchInterval: 10000,
  });
  const { data: localPoolData } = useQuery<{ items: LocalPoolAccount[] }>({
    queryKey: ["local-account-pool"],
    queryFn: readLocalAccountPool,
    enabled: IS_TAURI_RUNTIME,
    refetchOnWindowFocus: true,
    refetchInterval: 10000,
  });

  const items: PoolAccount[] = IS_TAURI_RUNTIME
    ? (localPoolData?.items ?? []).map((account) => ({
        id: account.id,
        alias: account.alias,
        role: account.role as PoolAccount["role"],
        display_name: account.displayName,
        is_active: account.isActive,
        status: account.status,
      }))
    : (remotePoolData?.items ?? []);
  const operationItems = items.filter((a) => a.status === "active" && a.role === "operation");
  const active = operationItems.find((a) => a.is_active);
  const others = operationItems.filter((a) => !a.is_active);

  const handleSwitch = async (id: number) => {
    setOpen(false);
    try {
      if (IS_TAURI_RUNTIME) {
        await activateLocalAccount(id);
      } else {
        await api.post(`/api/account-pool/${id}/activate`, {});
      }
      // 先通知各页面清理旧选中项/未完成的本地回调，再让对应 query key 重新读取。
      emitAccountChanged(id);
      toast("已切换激活账号", "success");
      qc.invalidateQueries({ queryKey: IS_TAURI_RUNTIME ? ["local-account-pool"] : ["account-pool"] });
      if (IS_TAURI_RUNTIME) {
        qc.invalidateQueries({ queryKey: ["local-workspace"] });
      }
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["analytics"] });
      qc.invalidateQueries({ queryKey: ["knowledge"] });
    } catch (e) {
      toast(`切换失败：${(e as Error).message}`, "error");
    }
  };

  if (!active) {
    return (
      <Link
        to="/accounts/pool"
        title={compact ? "设置运营账号" : undefined}
        aria-label="设置运营账号"
        className={`flex items-center rounded-lg text-xs text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-2)] ${compact ? "h-10 w-10 justify-center" : "h-9 gap-2 px-1.5"}`}
      >
        <span className={`inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] ${compact ? "h-8 w-8" : "h-7 w-7"}`}>
          <Users size={14} />
        </span>
        {!compact && <>
          <span className="font-medium">设置运营账号</span>
          <ChevronDown size={13} className="text-zinc-400" />
        </>}
      </Link>
    );
  }

  const badge = ROLE_BADGE[active.role] ?? ROLE_BADGE.operation;
  const displayName = active.display_name || active.alias;
  const menuContents = (
    <>
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-3">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">当前账号</div>
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><Shield size={17} /></span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{displayName}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />运营中 · {badge.label}</div>
          </div>
        </div>
      </div>
      {others.length > 0 ? (
        <div className="border-b border-[var(--color-border)] py-1.5">
          <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">切换运营账号</div>
          {others.map((a) => {
            const itemBadge = ROLE_BADGE[a.role] ?? ROLE_BADGE.operation;
            return (
              <button key={a.id} onClick={() => handleSwitch(a.id)} role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-[var(--color-surface-2)]">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-500"><Shield size={13} /></span>
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-primary)]">{a.display_name || a.alias}</span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${itemBadge.cls}`}>{itemBadge.label}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="border-b border-[var(--color-border)] px-3 py-3 text-xs text-[var(--color-text-secondary)]">暂无其他可切换的运营账号</div>
      )}
      <Link to="/accounts/pool" onClick={() => setOpen(false)} role="menuitem" className="flex items-center justify-between gap-2 px-3 py-2.5 text-xs text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]">
        <span className="flex items-center gap-2"><Users size={14} /> 管理账号池</span><span aria-hidden="true">→</span>
      </Link>
    </>
  );

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (!open && compact && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setCompactMenuPosition({
              left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 296)),
              top: Math.max(8, Math.min(rect.top, window.innerHeight - 360)),
            });
          }
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? `切换运营账号，当前为${displayName}` : undefined}
        title={compact ? `当前账号：${displayName}，点击切换` : undefined}
        className={`flex items-center rounded-lg text-left transition hover:bg-[var(--color-surface-2)] ${compact ? "h-10 w-10 justify-center" : "h-9 min-w-0 max-w-[240px] gap-2 px-1.5 py-0.5"}`}
      >
        <span className={`inline-flex shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 ${compact ? "h-8 w-8" : "h-7 w-7"}`}>
          <Shield size={compact ? 17 : 14} />
        </span>
        {!compact && <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-tight text-[var(--color-text-primary)]">{displayName}</span>
          </span>
          <ChevronDown size={14} className={`shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </>}
      </button>

      {open && compact && compactMenuPosition && createPortal(
        <>
          <div className="fixed inset-0 z-[59]" onClick={() => setOpen(false)} />
          <div role="menu" style={{ left: compactMenuPosition.left, top: compactMenuPosition.top }} className="fixed z-[60] max-h-[80vh] w-72 overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
            {menuContents}
          </div>
        </>,
        document.body,
      )}
      {open && !compact && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute left-0 top-full z-40 mt-2 w-72 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
            {menuContents}
          </div>
        </>
      )}
    </div>
  );
}
