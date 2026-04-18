import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { ReferenceAccount } from "../lib/types";
import { Spinner, Empty } from "../components/ui";
import { Plus, X, RefreshCw } from "lucide-react";
import { useToast } from "../components/Toast";

// ── 爬虫触发 Modal ──────────────────────────────────────────────────
function CrawlerModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  function start() {
    if (!url.trim()) return;
    setLogs([]);
    setRunning(true);
    setDone(false);

    ctrlRef.current = api.stream(
      "/api/crawler/creator",
      { url: url.trim(), name: name.trim() || undefined, save_db: true },
      (chunk) => {
        if (chunk.message) setLogs((prev) => [...prev, chunk.message as string]);
        if (chunk.done) {
          setRunning(false);
          setDone(true);
          onDone();
        }
      },
      () => { setRunning(false); setDone(true); onDone(); },
      (err) => { setLogs((prev) => [...prev, `错误: ${err.message}`]); setRunning(false); },
    );
  }

  function abort() {
    ctrlRef.current?.abort();
    setRunning(false);
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-zinc-100">
          <span className="font-semibold text-zinc-800 text-sm">导入榜样账号</span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-zinc-500 block mb-1">账号主页 URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.xiaohongshu.com/user/profile/..."
              className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442]"
            />
          </div>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">账号昵称（可选）</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="留空则自动识别"
              className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442]"
            />
          </div>

          {logs.length > 0 && (
            <div className="bg-zinc-950 rounded-xl p-3 max-h-40 overflow-y-auto font-mono">
              {logs.map((l, i) => (
                <p key={i} className="text-xs text-zinc-300 leading-relaxed">{l}</p>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}

          <div className="flex gap-2 justify-end pt-1">
            <button
              onClick={onClose}
              className="text-sm text-zinc-500 border border-zinc-200 px-4 py-1.5 rounded-lg hover:bg-zinc-50"
            >
              取消
            </button>
            {running ? (
              <button
                onClick={abort}
                className="flex items-center gap-1.5 text-sm bg-zinc-200 text-zinc-600 px-4 py-1.5 rounded-lg"
              >
                <RefreshCw size={13} className="animate-spin" />
                停止
              </button>
            ) : (
              <button
                onClick={done ? onClose : start}
                disabled={!url.trim() && !done}
                className="flex items-center gap-1.5 text-sm bg-[#ff2442] text-white px-4 py-1.5 rounded-lg hover:bg-[#e01f3a] disabled:opacity-40"
              >
                {done ? "完成" : "开始导入"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Accounts Page ────────────────────────────────────────────────────────────
export default function Accounts() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showModal, setShowModal] = useState(false);

  const { data: accounts = [], isLoading } = useQuery<ReferenceAccount[]>({
    queryKey: ["accounts"],
    queryFn: () => api.get("/api/accounts/"),
  });

  if (isLoading) return <Spinner />;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-6 py-4 border-b border-zinc-100 bg-white">
        <h1 className="text-lg font-semibold text-zinc-900">榜样账号</h1>
        <button
          onClick={() => setShowModal(true)}
          className="ml-auto flex items-center gap-1.5 text-sm bg-[#ff2442] text-white px-3 py-1.5 rounded-lg hover:bg-[#e01f3a]"
        >
          <Plus size={14} />
          导入账号
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {accounts.length === 0 ? (
          <Empty message="暂无榜样账号，点击「导入账号」或运行 CLI: accounts add" />
        ) : (
          <div className="space-y-4 max-w-2xl">
            {accounts.map((acc) => (
              <div key={acc.account_id}
                className="bg-white rounded-xl p-4 border border-zinc-100">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="font-medium text-zinc-900">{acc.name ?? acc.account_id}</p>
                    <p className="text-xs text-zinc-400 mt-0.5">{acc.account_id}</p>
                  </div>
                  <div className="flex gap-4 text-sm text-zinc-500">
                    <span>粉丝 {acc.followers.toLocaleString()}</span>
                    <span className="text-[#ff2442]">均赞 {acc.avg_likes}</span>
                  </div>
                </div>
                <div className="flex gap-6 text-xs text-zinc-400 mb-3">
                  <span>笔记 {acc.note_count}</span>
                  <span>均评 {acc.avg_comments}</span>
                  <span>均藏 {acc.avg_collects}</span>
                </div>
                {acc.top_notes.length > 0 && (
                  <div>
                    <p className="text-xs text-zinc-400 mb-1">高赞笔记</p>
                    <div className="space-y-1">
                      {acc.top_notes.slice(0, 3).map((n, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <span className="text-zinc-300">{i + 1}.</span>
                          <span className="text-zinc-700 flex-1 truncate">{n.title}</span>
                          <span className="text-[#ff2442] shrink-0">❤ {n.likes}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showModal && (
        <CrawlerModal
          onClose={() => setShowModal(false)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["accounts"] });
            toast("账号数据已导入", "success");
          }}
        />
      )}
    </div>
  );
}
