import { ReactNode, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, TerminalSquare } from "lucide-react";
import { API_BASE, checkBackendHealth, IS_TAURI } from "../lib/api";

type BackendStatus = "checking" | "ready" | "offline";

export default function BackendGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BackendStatus>("checking");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    let cancelled = false;

    const run = async (initial = false) => {
      if (initial) setStatus("checking");
      const ok = await checkBackendHealth();
      if (cancelled) return;
      if (ok) {
        setStatus("ready");
        setDetail("");
        window.clearInterval(timer);
      } else {
        setStatus("offline");
        setDetail(`无法连接本地后端 ${API_BASE}`);
      }
    };

    run(true);
    // 后端就绪后在 run() 内部自动停止轮询
    const timer = window.setInterval(() => run(false), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (status === "ready") return <>{children}</>;

  return (
    <div className="min-h-screen bg-[#fafafa] flex items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-3xl border border-zinc-200 bg-white shadow-sm p-8">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-2xl bg-rose-50 flex items-center justify-center shrink-0">
            {status === "checking" ? (
              <RefreshCw size={22} className="text-[#ff2442] animate-spin" />
            ) : (
              <AlertTriangle size={22} className="text-[#ff2442]" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold text-zinc-900">
              {status === "checking" ? "正在连接本地服务" : "本地服务未启动"}
            </h1>
            <p className="text-sm text-zinc-500 mt-2 leading-6">
              {status === "checking"
                ? "应用正在等待 FastAPI 后端就绪。首次启动或系统刚解压完成时，可能需要几秒。"
                : "桌面端需要先连接本地 FastAPI 服务，前端页面才能正常读写数据、打开浏览器和发布内容。"}
            </p>
            {detail && <p className="text-xs text-rose-600 mt-3">{detail}</p>}
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-zinc-100 bg-zinc-50 p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
            <TerminalSquare size={16} className="text-zinc-500" />
            处理建议
          </div>
          {IS_TAURI ? (
            <p className="text-sm text-zinc-600 leading-6">
              如果这是打包版桌面应用，通常说明内置后端启动失败。请等待几秒后点击重试；若仍失败，重新打开应用并检查同目录日志文件。
            </p>
          ) : (
            <div className="text-sm text-zinc-600 leading-6 space-y-2">
              <p>开发环境请先启动后端：</p>
              <code className="block rounded-lg bg-zinc-900 text-zinc-100 px-3 py-2 text-xs">
                uv run python -m app.server --port 8765
              </code>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={async () => {
              setStatus("checking");
              const ok = await checkBackendHealth();
              setStatus(ok ? "ready" : "offline");
              setDetail(ok ? "" : `无法连接本地后端 ${API_BASE}`);
            }}
            className="inline-flex items-center gap-2 rounded-xl bg-[#ff2442] px-4 py-2 text-sm font-medium text-white hover:bg-[#e11d3b] transition-colors"
          >
            <RefreshCw size={14} />
            重试连接
          </button>
          <span className="text-xs text-zinc-400">健康检查地址：{API_BASE}/health</span>
        </div>
      </div>
    </div>
  );
}
