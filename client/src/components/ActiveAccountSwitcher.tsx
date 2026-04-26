import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Users, Shield } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
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

  const { data: poolData } = useQuery<{ items: PoolAccount[] }>({
    queryKey: ["account-pool"],
    queryFn: () => api.get("/api/account-pool"),
    refetchOnWindowFocus: true,
    refetchInterval: 10000,
  });

  const items = poolData?.items ?? [];
  const operationItems = items.filter((a) => a.status === "active" && a.role === "operation");
  const active = operationItems.find((a) => a.is_active);
  const others = operationItems.filter((a) => !a.is_active);

  const handleSwitch = async (id: number) => {
    setOpen(false);
    try {
      await api.post(`/api/account-pool/${id}/activate`, {});
      toast("已切换激活账号", "success");
      qc.invalidateQueries({ queryKey: ["account-pool"] });
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["items"] });
    } catch (e) {
      toast(`切换失败：${(e as Error).message}`, "error");
    }
  };

  if (!active) {
    return (
      <Link
        to="/accounts/pool"
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 text-xs"
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
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white border border-zinc-200 hover:border-zinc-300 text-sm"
      >
        <Shield size={14} className="text-emerald-500" />
        <span className="text-zinc-800 font-medium max-w-[140px] truncate">{displayName}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
        <ChevronDown size={14} className="text-zinc-400" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-64 rounded-xl bg-white shadow-lg border border-zinc-200 z-40 overflow-hidden">
            <div className="px-3 py-2 bg-zinc-50 border-b border-zinc-100">
              <div className="text-[11px] text-zinc-500">当前激活（运营账号）</div>
              <div className="text-sm font-medium text-zinc-800 mt-0.5 flex items-center gap-2">
                <span className="truncate">{displayName}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${badge.cls}`}>{badge.label}</span>
              </div>
            </div>

            {others.length > 0 && (
              <div className="py-1">
                <div className="px-3 py-1 text-[10px] text-zinc-400 uppercase">切换运营账号</div>
                {others.map((a) => {
                  const b = ROLE_BADGE[a.role] ?? ROLE_BADGE.operation;
                  return (
                    <button
                      key={a.id}
                      onClick={() => handleSwitch(a.id)}
                      className="w-full px-3 py-1.5 text-left hover:bg-zinc-50 flex items-center justify-between gap-2"
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
              className="block px-3 py-2 text-xs text-zinc-600 hover:bg-zinc-50 border-t border-zinc-100"
            >
              管理账号池 →
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
