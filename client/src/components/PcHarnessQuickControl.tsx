import { useWorkspaceQuery as useQuery } from "../lib/workspaceActivity";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, RefreshCw, Smartphone, X } from "lucide-react";
import {
  IS_TAURI_RUNTIME,
  readPcHarnessMobileConnection,
  readPcHarnessStatus,
  rotatePcHarnessToken,
  startPcHarness,
  stopPcHarness,
  type LocalPcHarnessStatus,
} from "../lib/local";

export const PC_HARNESS_STATUS_QUERY_KEY = ["pc-harness-status"] as const;

export function usePcHarnessStatus() {
  return useQuery({
    queryKey: PC_HARNESS_STATUS_QUERY_KEY,
    queryFn: readPcHarnessStatus,
    enabled: IS_TAURI_RUNTIME,
    staleTime: 5_000,
    refetchIntervalInBackground: false,
  });
}

export function usePcHarnessMobileConnection() {
  return useQuery({
    queryKey: ["pc-harness-mobile-connection"],
    queryFn: readPcHarnessMobileConnection,
    enabled: IS_TAURI_RUNTIME,
    staleTime: 500,
    refetchInterval: 1_500,
    refetchIntervalInBackground: false,
  });
}

function statusBaseUrl(status: LocalPcHarnessStatus | undefined): string {
  if (!status) return "";
  const host = status.lanAddresses[0] ?? "127.0.0.1";
  return `http://${host}:${status.port}`;
}

/**
 * 顶栏右上角 PC Harness 快捷控件：状态点 + 一键开/关 + 快捷面板。
 * 完整配置仍在「设置 → 手机 Companion」。
 */
export default function PcHarnessQuickControl() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: status, isFetching } = usePcHarnessStatus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const running = status?.running ?? false;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function run(action: () => Promise<LocalPcHarnessStatus>) {
    setBusy(true);
    try {
      await action();
      await qc.invalidateQueries({ queryKey: PC_HARNESS_STATUS_QUERY_KEY });
    } catch {
      // 错误详情在设置页展示；顶栏只保持状态同步
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }

  if (!IS_TAURI_RUNTIME) return null;

  const baseUrl = statusBaseUrl(status);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label="手机 Companion（PC Harness）快捷面板"
          title="手机 Companion：地址与配对"
          onClick={() => setOpen((v) => !v)}
          className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${running ? "bg-emerald-500" : "bg-zinc-300"}`}
            aria-hidden="true"
          />
          <Smartphone size={13} />
          <span className="hidden sm:inline">手机连接</span>
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={running}
          aria-label={running ? "停止手机 Companion 监听" : "开启手机 Companion 监听"}
          title={running ? "停止监听" : "开启监听"}
          disabled={busy || isFetching}
          onClick={() => void run(running ? stopPcHarness : startPcHarness)}
          className={`relative inline-flex h-4 w-8 items-center rounded-full transition-colors disabled:opacity-50 ${
            running ? "bg-[var(--color-brand)]" : "bg-zinc-300"
          }`}
        >
          <span
            className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
              running ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {open ? (
        <div className="absolute right-0 top-8 z-50 w-72 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-lg">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-[var(--color-text-primary)]">手机 Companion</p>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => setOpen(false)}
              className="rounded-md p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
            >
              <X size={13} />
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
            {running ? "运行中，打开设置页显示二维码，手机扫码即可配对。" : "未开启。开启后仅监听本机局域网，配对令牌鉴权。"}
          </p>

          <div className="mt-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-[var(--color-text-secondary)]">连接地址</span>
              <button
                type="button"
                disabled={!baseUrl}
                onClick={() => void copy(baseUrl, "url")}
                className="flex min-w-0 items-center gap-1 rounded-md border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-primary)] disabled:opacity-50"
                title={baseUrl || "未开启"}
              >
                <code className="max-w-[9rem] truncate">{baseUrl || "—"}</code>
                {copied === "url" ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
              </button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-[var(--color-text-secondary)]">配对令牌</span>
              <button
                type="button"
                disabled={!status?.pairingToken}
                onClick={() => void copy(status?.pairingToken || "", "token")}
                className="flex min-w-0 items-center gap-1 rounded-md border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-primary)] disabled:opacity-50"
                title={status?.pairingToken || "未开启"}
              >
                <code className="max-w-[9rem] truncate">
                  {status?.pairingToken ? `${status.pairingToken.slice(0, 6)}…` : "—"}
                </code>
                {copied === "token" ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
              </button>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={busy || !status?.pairingToken}
              onClick={() => void run(rotatePcHarnessToken)}
              className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
            >
              轮换令牌
            </button>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={busy || isFetching}
                onClick={() => {
                  void qc.invalidateQueries({ queryKey: PC_HARNESS_STATUS_QUERY_KEY });
                }}
                aria-label="刷新状态"
                title="刷新状态"
                className="rounded-lg border border-[var(--color-border)] p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
              >
                <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate("/settings?tab=companion");
                }}
                className="rounded-lg bg-[var(--color-brand)] px-2 py-1 text-[11px] text-white"
              >
                配对二维码
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
