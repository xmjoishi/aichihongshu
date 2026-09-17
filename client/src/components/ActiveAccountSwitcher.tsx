import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Users, Shield } from "lucide-react";
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

export default function ActiveAccountSwitcher() {
  const [open, setOpen] = useState(false);
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
      if (IS_TAURI_RUNTIME) qc.invalidateQueries({ queryKey: ["local-dashboard"] });
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
        className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-text-primary)] hover:border-[var(--color-brand)]"
      >
        <Users size={14} /> 设置运营账号
      </Link>
    );
  }

  const badge = ROLE_BADGE[active.role] ?? ROLE_BADGE.operation;
  const displayName = active.display_name || active.alias;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm hover:border-[var(--color-brand)]"
      >
        <Shield size={14} className="text-emerald-500" />
        <span className="text-zinc-800 font-medium max-w-[140px] truncate">{displayName}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
        <ChevronDown size={14} className="text-zinc-400" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 top-full z-40 mt-2 w-64 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
            <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
              <div className="text-[11px] text-[var(--color-text-secondary)]">当前激活（运营账号）</div>
              <div className="mt-0.5 flex items-center gap-2 text-sm font-medium text-[var(--color-text-primary)]">
                <span className="truncate">{displayName}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${badge.cls}`}>{badge.label}</span>
              </div>
            </div>

            {others.length > 0 && (
              <div className="py-1">
                <div className="px-3 py-1 text-[10px] uppercase text-[var(--color-text-secondary)]">切换运营账号</div>
                {others.map((a) => {
                  const b = ROLE_BADGE[a.role] ?? ROLE_BADGE.operation;
                  return (
                    <button
                      key={a.id}
                      onClick={() => handleSwitch(a.id)}
                      role="menuitem"
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[var(--color-surface-2)]"
                    >
                      <span className="text-sm text-zinc-700 truncate">{a.display_name || a.alias}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${b.cls}`}>{b.label}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <Link
              to="/accounts/pool"
              onClick={() => setOpen(false)}
              className="block border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
            >
              管理账号池 →
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
