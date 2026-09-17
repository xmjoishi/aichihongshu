import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import {
  IS_TAURI_RUNTIME,
  readLocalAccountPool,
  readLocalRuntimeStatus,
  type LocalPoolAccount,
} from "./local";

interface RemotePoolAccount {
  id: number;
  alias: string;
  is_active?: boolean;
  status: string;
  role: string;
}

/**
 * 当前 UI 操作范围。query key 使用 scopeKey，避免一个账号的过期结果进入另一个账号的视图。
 * databaseIdentity 在本地模式来自 Rust 返回的真实数据库路径；浏览器模式使用 API 地址。
 */
export interface AccountContext {
  accountId: number | null;
  accountAlias: string | null;
  databaseIdentity: string;
  scopeKey: string;
  ready: boolean;
}

export const ACCOUNT_CHANGED_EVENT = "aichihongshu:account-changed";

export function emitAccountChanged(accountId: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ACCOUNT_CHANGED_EVENT, { detail: { accountId } }));
}

/**
 * 订阅账号切换完成事件。使用 ref 保持监听器稳定，避免页面状态变化时
 * 重绑监听器；页面可在回调里取消旧请求并清空选中项/草稿。
 */
export function useAccountChange(onChange: (accountId: number) => void): void {
  const callbackRef = useRef(onChange);
  callbackRef.current = onChange;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event) => {
      const accountId = (event as CustomEvent<{ accountId?: number }>).detail?.accountId;
      if (typeof accountId === "number") callbackRef.current(accountId);
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, handler);
  }, []);
}

export function useAccountContext(): AccountContext {
  const { data: runtimeStatus } = useQuery({
    queryKey: ["local-runtime-status"],
    queryFn: readLocalRuntimeStatus,
    enabled: IS_TAURI_RUNTIME,
    staleTime: Infinity,
  });
  const { data: localPool } = useQuery<{ items: LocalPoolAccount[] }>({
    queryKey: ["local-account-pool"],
    queryFn: readLocalAccountPool,
    enabled: IS_TAURI_RUNTIME,
    refetchOnWindowFocus: true,
    refetchInterval: 10_000,
  });
  const { data: remotePool } = useQuery<{ items: RemotePoolAccount[] }>({
    queryKey: ["account-pool"],
    queryFn: () => api.get("/api/account-pool"),
    enabled: !IS_TAURI_RUNTIME,
    refetchOnWindowFocus: true,
    refetchInterval: 10_000,
  });

  const active = IS_TAURI_RUNTIME
    ? localPool?.items.find((item) => item.isActive && item.status === "active" && item.role === "operation")
    : remotePool?.items.find((item) => item.is_active && item.status === "active" && item.role === "operation");
  const accountId = active?.id ?? null;
  const databaseIdentity = IS_TAURI_RUNTIME
    ? runtimeStatus?.databasePath ?? "tauri:database-pending"
    : `http:${typeof window !== "undefined" ? window.location.origin : "browser"}`;
  const scopeKey = `${databaseIdentity}:account:${accountId ?? "unresolved"}`;

  return {
    accountId,
    accountAlias: active?.alias ?? null,
    databaseIdentity,
    scopeKey,
    ready: accountId !== null,
  };
}
