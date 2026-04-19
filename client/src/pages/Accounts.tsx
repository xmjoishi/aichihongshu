import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, openInBrowser } from "../lib/api";
import { ReferenceAccount } from "../lib/types";
import { Spinner, Empty } from "../components/ui";
import {
  Plus, X, RefreshCw, Trash2, Sparkles, RotateCcw,
  ChevronRight, Copy, Check, Pencil, Save, ExternalLink,
} from "lucide-react";
import { useToast } from "../components/Toast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { usePanelResize } from "../hooks/usePanelResize";

// ── 解析 content_style JSON → keywords 数组 ─────────────────────────────────
function stripFence(raw: string): string {
  // 去掉 AI 返回时可能带的 ```json ... ``` markdown fence
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

function parseStyleKeywords(raw?: string): string[] {
  if (!raw) return [];
  try {
    const cs = JSON.parse(stripFence(raw));
    if (Array.isArray(cs.keywords)) return cs.keywords.slice(0, 6);
  } catch {}
  return [];
}

function fixJsonQuotes(s: string): string {
  // AI 有时在 JSON 字符串值里嵌套直引号（如 自称"姐"），导致 JSON 无效。
  // 策略：逐字符扫描，在字符串值内部遇到的裸 " 替换成中文引号 " / "
  let result = "";
  let inString = false;
  let escaped = false;
  let quoteCount = 0; // 当前字符串值内遇到的裸引号计数（奇=开，偶=闭）
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === "\\") { result += ch; escaped = true; continue; }
    if (ch === '"') {
      if (!inString) {
        inString = true; quoteCount = 0; result += ch;
      } else {
        // 判断是否是合法的字符串结束引号：后面是 ,}]: 或空白
        const next = s[i + 1] ?? "";
        if (/[\s,\}\]:]/.test(next) || i === s.length - 1) {
          inString = false; result += ch;
        } else {
          // 嵌套裸引号，替换成中文引号
          quoteCount++;
          result += quoteCount % 2 === 1 ? "\u201c" : "\u201d";
        }
      }
      continue;
    }
    result += ch;
  }
  return result;
}

function parseStyleFull(raw?: string): { keywords: string[]; tone?: string; format?: string; hook?: string; audience?: string; summary?: string } | null {
  if (!raw) return null;
  const cleaned = stripFence(raw);
  // 第一次尝试直接解析
  try { return JSON.parse(cleaned); } catch {}
  // 第二次：修复嵌套引号后再解析
  try { return JSON.parse(fixJsonQuotes(cleaned)); } catch {}
  return null;
}

// ── 爬虫触发 Modal ──────────────────────────────────────────────────────────
function CrawlerModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [detectedName, setDetectedName] = useState<string | null>(null);
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
    setDetectedName(null);
    ctrlRef.current = api.stream(
      "/api/crawler/creator",
      { url: url.trim(), name: name.trim() || undefined, save_db: true },
      (chunk) => {
        if (chunk.message) setLogs((prev) => [...prev, chunk.message as string]);
        if (chunk.done) {
          setRunning(false);
          setDone(true);
          if (chunk.nickname) setDetectedName(chunk.nickname as string);
          onDone();
        }
      },
      () => { setRunning(false); setDone(true); onDone(); },
      (err) => { setLogs((prev) => [...prev, `错误: ${err.message}`]); setRunning(false); },
    );
  }

  function abort() { ctrlRef.current?.abort(); setRunning(false); }

  const urlWarning = url.trim() && !url.trim().includes("xsec_token=");

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
            <input type="text" value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.xiaohongshu.com/user/profile/...?xsec_token=..."
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442] ${urlWarning ? "border-amber-400 bg-amber-50" : "border-zinc-200"}`} />
            {urlWarning ? (
              <p className="text-xs text-amber-600 mt-1 font-medium">
                ⚠️ URL 缺少 xsec_token！直接输入账号 URL 小红书会返回自己的数据。<br />
                正确做法：在爬虫浏览器里<strong>搜索</strong>目标账号名 → 从搜索结果点击进入主页 → 再从地址栏复制完整 URL。
              </p>
            ) : (
              <p className="text-xs text-zinc-400 mt-1">
                在爬虫浏览器搜索账号名 → 点击进入主页（会自动带 xsec_token） → 从地址栏复制完整 URL
              </p>
            )}
          </div>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">账号昵称（可选）</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="留空则自动识别"
              className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442]" />
          </div>
          {!running && !done && (
            <p className="text-xs text-zinc-400 bg-zinc-50 rounded-lg px-3 py-2">
              首次运行会打开浏览器，需要扫码登录小红书。登录态会缓存，后续无需重复扫码。
            </p>
          )}
          {done && detectedName && (
            <p className="text-xs text-green-700 bg-green-50 rounded-lg px-3 py-2">
              已识别账号昵称：<span className="font-medium">{detectedName}</span>
            </p>
          )}
          {logs.length > 0 && (
            <div className="relative">
              <div className="bg-zinc-950 rounded-xl p-3 max-h-40 overflow-y-auto font-mono">
                {logs.map((l, i) => <p key={i} className="text-xs text-zinc-300 leading-relaxed">{l}</p>)}
                <div ref={logsEndRef} />
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(logs.join("\n"))}
                title="复制日志"
                className="absolute top-2 right-2 p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
              >
                <Copy size={12} />
              </button>
            </div>
          )}
          <div className="flex gap-2 justify-end pt-1">
            <button onClick={onClose} className="text-sm text-zinc-500 border border-zinc-200 px-4 py-1.5 rounded-lg hover:bg-zinc-50">取消</button>
            {running ? (
              <button onClick={abort} className="flex items-center gap-1.5 text-sm bg-zinc-200 text-zinc-600 px-4 py-1.5 rounded-lg">
                <RefreshCw size={13} className="animate-spin" />停止
              </button>
            ) : (
              <button onClick={done ? onClose : start} disabled={(!url.trim() && !done) || running}
                className="flex items-center gap-1.5 text-sm bg-[#ff2442] text-white px-4 py-1.5 rounded-lg hover:bg-[#e01f3a] disabled:opacity-40">
                {done ? "完成" : urlWarning ? "忽略警告，强行导入" : "开始导入"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 账号卡片 ─────────────────────────────────────────────────────────────────
function AccountCard({
  acc,
  selected,
  onClick,
  onDelete,
}: {
  acc: ReferenceAccount;
  selected: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keywords = parseStyleKeywords(acc.content_style);
  const hasStyle = keywords.length > 0;

  function handleDeleteClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (confirmDelete) {
      onDelete();
    } else {
      setConfirmDelete(true);
      timerRef.current = setTimeout(() => setConfirmDelete(false), 2500);
    }
  }

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-xl p-4 border cursor-pointer transition-all hover:shadow-sm
        ${selected ? "border-[#ff2442] shadow-sm ring-1 ring-[#ff2442]/20" : "border-zinc-100 hover:border-zinc-200"}`}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); openInBrowser(`https://www.xiaohongshu.com/user/profile/${acc.account_id}`); }}
              className="font-medium text-zinc-900 truncate hover:text-[#ff2442] transition-colors flex items-center gap-1"
            >
              {acc.name ?? acc.account_id}
              <ExternalLink size={11} className="shrink-0 opacity-40" />
            </button>
            {selected && <ChevronRight size={14} className="text-[#ff2442] shrink-0" />}
          </div>
          <p className="text-xs text-zinc-400 mt-0.5 truncate">{acc.account_id}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-3">
          <div className="text-right">
            <p className="text-sm font-semibold text-[#ff2442]">❤ {acc.avg_likes.toLocaleString()}</p>
            <p className="text-xs text-zinc-400">均赞</p>
          </div>
          <button
            onClick={handleDeleteClick}
            title={confirmDelete ? "再次点击确认删除" : "删除账号"}
            className={`p-1.5 rounded-lg transition-colors text-xs ${confirmDelete
              ? "bg-red-50 text-red-500 hover:bg-red-100 px-2"
              : "text-zinc-300 hover:text-red-400 hover:bg-red-50"
            }`}
          >
            {confirmDelete ? "确认删除？" : <Trash2 size={14} />}
          </button>
        </div>
      </div>

      {/* 数据行 */}
      <div className="flex gap-4 text-xs text-zinc-400 mb-3">
        <span>粉丝 {acc.followers.toLocaleString()}</span>
        <span>笔记 {acc.note_count}</span>
        <span>均评 {acc.avg_comments}</span>
        <span>均藏 {acc.avg_collects}</span>
      </div>

      {/* chip 标签 */}
      {hasStyle ? (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {keywords.slice(0, 4).map((kw, i) => (
            <span key={i} className="text-[11px] bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded-full">
              {kw}
            </span>
          ))}
          {keywords.length > 4 && (
            <span className="text-[11px] text-zinc-400 px-1 py-0.5">+{keywords.length - 4}</span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1 mb-3">
          <span className="text-[11px] bg-amber-50 text-amber-500 border border-amber-200 px-2 py-0.5 rounded-full">
            ✦ 待分析风格
          </span>
        </div>
      )}

      {/* 高赞笔记 */}
      {acc.top_notes.length > 0 && (
        <div className="space-y-1">
          {acc.top_notes.slice(0, 3).map((n, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="text-zinc-300 shrink-0">{i + 1}.</span>
              {n.url ? (
                <button
                  onClick={(e) => { e.stopPropagation(); openInBrowser(n.url!); }}
                  className="text-zinc-600 flex-1 truncate hover:text-[#ff2442] transition-colors text-left"
                >
                  {n.title}
                </button>
              ) : (
                <span className="text-zinc-600 flex-1 truncate">{n.title}</span>
              )}
              <span className="text-[#ff2442] shrink-0">❤ {n.likes.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 右侧详情抽屉 ─────────────────────────────────────────────────────────────
function AccountDrawer({
  acc,
  onClose,
  onUpdated,
}: {
  acc: ReferenceAccount;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { toast } = useToast();
  const { width, dragging, onDragStart } = usePanelResize({
    defaultWidth: 400,
    min: 300,
    max: 680,
    direction: "left",
    storageKey: "account-drawer-width",
  });

  // ── 基础信息编辑 ──
  const [editingInfo, setEditingInfo] = useState(false);
  const [editName, setEditName] = useState(acc.name ?? "");
  const [editFollowers, setEditFollowers] = useState(String(acc.followers ?? 0));
  const [savingInfo, setSavingInfo] = useState(false);

  async function saveInfo() {
    setSavingInfo(true);
    try {
      await api.patch(`/api/accounts/${acc.account_id}`, {
        name: editName.trim() || undefined,
        followers: parseInt(editFollowers, 10) || 0,
      });
      toast("已保存", "success");
      setEditingInfo(false);
      onUpdated();
    } catch {
      toast("保存失败", "error");
    } finally {
      setSavingInfo(false);
    }
  }

  // ── content_style 编辑 ──
  const [editingStyle, setEditingStyle] = useState(false);
  const [styleText, setStyleText] = useState(acc.content_style || "");
  const [savingStyle, setSavingStyle] = useState(false);

  // ── AI 分析风格 ──
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeStream, setAnalyzeStream] = useState("");
  const analyzeCtrlRef = useRef<AbortController | null>(null);

  // ── 学习要点 ──
  const [insights, setInsights] = useState(acc.insights || "");
  const [insightsLoading, setInsightsLoading] = useState(false);
  const insightsCtrlRef = useRef<AbortController | null>(null);
  const [insightsLoaded, setInsightsLoaded] = useState(!!acc.insights);

  // ── 仿写 Prompt ──
  const [imitateNote, setImitateNote] = useState<{ title: string; likes: number } | null>(null);
  const [imitateItemTitle, setImitateItemTitle] = useState("");
  const [imitateResult, setImitateResult] = useState("");
  const [imitateLoading, setImitateLoading] = useState(false);
  const [copiedImitate, setCopiedImitate] = useState(false);

  // ── 加入参考库 ──
  const [addedToLib, setAddedToLib] = useState<Set<number>>(new Set());

  const styleObj = parseStyleFull(acc.content_style);

  async function saveStyle() {
    setSavingStyle(true);
    try {
      await api.patch(`/api/accounts/${acc.account_id}`, { content_style: styleText });
      toast("风格描述已保存", "success");
      setEditingStyle(false);
      onUpdated();
    } catch {
      toast("保存失败", "error");
    } finally {
      setSavingStyle(false);
    }
  }

  function startAnalyze() {
    setAnalyzing(true);
    setAnalyzeStream("");
    setEditingStyle(false);
    analyzeCtrlRef.current = api.stream(
      `/api/accounts/${acc.account_id}/analyze`,
      {},
      (chunk) => {
        if (chunk.text) setAnalyzeStream((p) => p + chunk.text);
        if (chunk.done) {
          setAnalyzing(false);
          setAnalyzeStream("");
          onUpdated();
          toast("风格分析完成", "success");
        }
        if (chunk.error) { setAnalyzing(false); toast("分析失败: " + chunk.error, "error"); }
      },
      () => { setAnalyzing(false); onUpdated(); },
      (err) => { setAnalyzing(false); toast("分析出错: " + err.message, "error"); },
      "POST",
    );
  }

  function loadInsights(refresh = false) {
    setInsightsLoading(true);
    if (refresh) setInsights("");
    insightsCtrlRef.current = api.stream(
      `/api/accounts/${acc.account_id}/insights${refresh ? "?refresh=true" : ""}`,
      {},
      (chunk) => {
        if (chunk.cached) { setInsights(String(chunk.text ?? "")); setInsightsLoading(false); setInsightsLoaded(true); return; }
        if (chunk.text) setInsights((p) => p + String(chunk.text));
        if (chunk.done) { setInsightsLoading(false); setInsightsLoaded(true); }
        if (chunk.error) { setInsightsLoading(false); toast("生成失败: " + chunk.error, "error"); }
      },
      () => { setInsightsLoading(false); setInsightsLoaded(true); },
      (err) => { setInsightsLoading(false); toast("出错: " + err.message, "error"); },
      "GET",
    );
  }

  async function generateImitate(note: { title: string; likes: number }) {
    setImitateNote(note);
    setImitateResult("");
    setImitateLoading(true);
    try {
      const res = await api.post(`/api/accounts/${acc.account_id}/imitate`, {
        note_title: note.title,
        note_likes: note.likes,
        item_title: imitateItemTitle || undefined,
      });
      setImitateResult(String(res.prompt || ""));
    } catch {
      toast("生成仿写失败", "error");
    } finally {
      setImitateLoading(false);
    }
  }

  async function addToRefLib(note: { title: string; likes: number }, idx: number) {
    try {
      await api.post("/api/knowledge/ref-samples", {
        account_id: acc.account_id,
        title: note.title,
        likes: note.likes,
      });
      setAddedToLib((prev) => new Set(prev).add(idx));
      toast("已加入经验库参考样本", "success");
    } catch {
      toast("加入失败", "error");
    }
  }

  async function copyImitate() {
    await navigator.clipboard.writeText(imitateResult);
    setCopiedImitate(true);
    setTimeout(() => setCopiedImitate(false), 1500);
  }

  return (
    <div
      className="flex flex-col h-full bg-white border-l border-zinc-100 relative shrink-0 select-none"
      style={{ width, cursor: dragging ? "col-resize" : undefined }}
    >
      {/* 拖拽条 */}
      <div
        onMouseDown={onDragStart}
        className="absolute left-0 top-0 bottom-0 z-10 flex items-center justify-center group cursor-col-resize"
        style={{ width: 12, marginLeft: -4 }}
        title="拖动调整宽度"
      >
        <div className={`w-[3px] h-full rounded-full transition-colors duration-150
          ${dragging ? "bg-[#ff2442]" : "bg-transparent group-hover:bg-[#ff2442]/40"}`} />
      </div>

      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-100 shrink-0">
        {editingInfo ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="账号名称"
                className="flex-1 text-sm border border-zinc-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-[#ff2442]/50"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-500 shrink-0 w-14">粉丝数</label>
              <input
                type="number"
                value={editFollowers}
                onChange={(e) => setEditFollowers(e.target.value)}
                className="w-32 text-sm border border-zinc-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-[#ff2442]/50"
              />
            </div>
            <div className="flex items-center gap-2 pt-0.5">
              <button
                onClick={saveInfo}
                disabled={savingInfo}
                className="flex items-center gap-1 text-xs bg-[#ff2442] text-white px-3 py-1.5 rounded-lg hover:bg-[#e01f3a] disabled:opacity-50"
              >
                <Save size={12} />
                {savingInfo ? "保存中…" : "保存"}
              </button>
              <button
                onClick={() => setEditingInfo(false)}
                className="text-xs text-zinc-500 px-3 py-1.5 rounded-lg border border-zinc-200 hover:bg-zinc-50"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <button
                onClick={() => openInBrowser(`https://www.xiaohongshu.com/user/profile/${acc.account_id}`)}
                className="font-semibold text-zinc-900 text-sm hover:text-[#ff2442] transition-colors flex items-center gap-1"
              >
                {acc.name ?? acc.account_id}
                <ExternalLink size={11} className="opacity-40" />
              </button>
              <p className="text-xs text-zinc-400">{acc.account_id}</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => { setEditName(acc.name ?? ""); setEditFollowers(String(acc.followers ?? 0)); setEditingInfo(true); }}
                title="编辑账号信息"
                className="p-1.5 text-zinc-400 hover:text-zinc-600 rounded-lg hover:bg-zinc-100"
              >
                <Pencil size={13} />
              </button>
              <button onClick={onClose} className="p-1.5 text-zinc-400 hover:text-zinc-700 rounded-lg hover:bg-zinc-100">
                <X size={15} />
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* 数据看板 */}
        <div className="grid grid-cols-3 gap-px bg-zinc-100 border-b border-zinc-100">
          {[
            { label: "均赞", value: acc.avg_likes.toLocaleString(), red: true },
            { label: "均评", value: acc.avg_comments.toLocaleString() },
            { label: "均藏", value: acc.avg_collects.toLocaleString() },
          ].map((stat) => (
            <div key={stat.label} className="bg-white px-4 py-3 text-center">
              <p className={`text-lg font-bold ${stat.red ? "text-[#ff2442]" : "text-zinc-700"}`}>
                {stat.value}
              </p>
              <p className="text-xs text-zinc-400">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* ── 值得学习的地方 ── */}
        <div className="px-4 py-4 border-b border-zinc-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-1.5">
              <Sparkles size={14} className="text-[#ff2442]" />
              <span className="text-sm font-semibold text-zinc-800">值得学习的地方</span>
            </div>
            <div className="flex gap-1">
              {insightsLoaded && (
                <button
                  onClick={() => loadInsights(true)}
                  disabled={insightsLoading}
                  title="重新生成"
                  className="p-1 text-zinc-400 hover:text-zinc-600 rounded disabled:opacity-30"
                >
                  <RotateCcw size={12} />
                </button>
              )}
              {!insightsLoaded && !insightsLoading && (
                <button
                  onClick={() => loadInsights(false)}
                  className="text-xs text-[#ff2442] border border-[#ff2442]/30 px-2 py-0.5 rounded-lg hover:bg-[#ff2442]/5"
                >
                  AI 生成
                </button>
              )}
            </div>
          </div>
          {insightsLoading && !insights && (
            <div className="flex items-center gap-2 text-xs text-zinc-400 py-2">
              <RefreshCw size={12} className="animate-spin" />
              正在分析…
            </div>
          )}
          {insights ? (
            <div className="text-sm leading-relaxed">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  p: ({ children }) => <p className="text-sm text-zinc-700 leading-relaxed mb-2">{children}</p>,
                  strong: ({ children }) => <strong className="font-semibold text-zinc-900">{children}</strong>,
                  ul: ({ children }) => <ul className="space-y-1 mb-2">{children}</ul>,
                  ol: ({ children }) => <ol className="space-y-1 mb-2 list-decimal list-inside">{children}</ol>,
                  li: ({ children }) => (
                    <li className="text-sm text-zinc-700 flex gap-1.5">
                      <span className="text-[#ff2442] shrink-0 mt-0.5">✦</span>
                      <span>{children}</span>
                    </li>
                  ),
                  h3: ({ children }) => <h3 className="text-sm font-semibold text-zinc-800 mt-3 mb-1">{children}</h3>,
                  h4: ({ children }) => <h4 className="text-sm font-medium text-zinc-700 mt-2 mb-1">{children}</h4>,
                }}
              >
                {insights}
              </ReactMarkdown>
            </div>
          ) : !insightsLoading ? (
            <p className="text-xs text-zinc-400 italic">点击「AI 生成」获取学习要点</p>
          ) : null}
          {insightsLoading && insights && (
            <div className="text-sm leading-relaxed">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  p: ({ children }) => <p className="text-sm text-zinc-700 leading-relaxed mb-2">{children}</p>,
                  strong: ({ children }) => <strong className="font-semibold text-zinc-900">{children}</strong>,
                  ul: ({ children }) => <ul className="space-y-1 mb-2">{children}</ul>,
                  ol: ({ children }) => <ol className="space-y-1 mb-2 list-decimal list-inside">{children}</ol>,
                  li: ({ children }) => (
                    <li className="text-sm text-zinc-700 flex gap-1.5">
                      <span className="text-[#ff2442] shrink-0 mt-0.5">✦</span>
                      <span>{children}</span>
                    </li>
                  ),
                  h3: ({ children }) => <h3 className="text-sm font-semibold text-zinc-800 mt-3 mb-1">{children}</h3>,
                  h4: ({ children }) => <h4 className="text-sm font-medium text-zinc-700 mt-2 mb-1">{children}</h4>,
                }}
              >
                {insights}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {/* ── 内容风格分析 ── */}
        <div className="px-4 py-4 border-b border-zinc-100">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-zinc-800">内容风格分析</span>
            <div className="flex gap-1">
              {!editingStyle && !analyzing && (
                <button
                  onClick={() => { setEditingStyle(true); setStyleText(acc.content_style || ""); }}
                  className="p-1 text-zinc-400 hover:text-zinc-600 rounded"
                  title="手动编辑"
                >
                  <Pencil size={12} />
                </button>
              )}
              <button
                onClick={startAnalyze}
                disabled={analyzing}
                className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-lg border transition-colors
                  ${analyzing
                    ? "border-zinc-200 text-zinc-400 cursor-not-allowed"
                    : "border-[#ff2442]/30 text-[#ff2442] hover:bg-[#ff2442]/5"
                  }`}
              >
                {analyzing ? <RefreshCw size={10} className="animate-spin" /> : <Sparkles size={10} />}
                {analyzing ? "分析中…" : "AI 重新分析"}
              </button>
            </div>
          </div>

          {analyzing && (
            <pre className="text-xs text-zinc-500 whitespace-pre-wrap leading-relaxed bg-zinc-50 rounded-lg p-3">
              {analyzeStream || "正在分析…"}
            </pre>
          )}

          {!analyzing && editingStyle ? (
            <div className="space-y-2">
              <textarea
                value={styleText}
                onChange={(e) => setStyleText(e.target.value)}
                rows={8}
                className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442] resize-none"
                placeholder='{"keywords":["标签1"],"tone":"语气","summary":"概述"}'
              />
              <div className="flex gap-2 justify-end">
                <button onClick={() => setEditingStyle(false)} className="text-xs text-zinc-500 px-3 py-1.5 rounded-lg border border-zinc-200 hover:bg-zinc-50">
                  取消
                </button>
                <button onClick={saveStyle} disabled={savingStyle}
                  className="flex items-center gap-1 text-xs bg-[#ff2442] text-white px-3 py-1.5 rounded-lg hover:bg-[#e01f3a] disabled:opacity-40">
                  <Save size={11} />
                  {savingStyle ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          ) : !analyzing && styleObj ? (
            <div className="space-y-2.5">
              {styleObj.keywords && styleObj.keywords.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {styleObj.keywords.map((kw, i) => (
                    <span key={i} className="text-xs bg-[#ff2442]/8 text-[#ff2442] px-2 py-0.5 rounded-full border border-[#ff2442]/20">
                      {kw}
                    </span>
                  ))}
                </div>
              )}
              {[
                { label: "语气", value: styleObj.tone },
                { label: "格式", value: styleObj.format },
                { label: "标题套路", value: styleObj.hook },
                { label: "目标受众", value: styleObj.audience },
              ].filter((r) => r.value).map((row) => (
                <div key={row.label}>
                  <span className="text-[11px] text-zinc-400 font-medium">{row.label}：</span>
                  <span className="text-xs text-zinc-700">{row.value}</span>
                </div>
              ))}
              {styleObj.summary && (
                <p className="text-xs text-zinc-600 bg-zinc-50 rounded-lg p-2.5 leading-relaxed border border-zinc-100">
                  {styleObj.summary}
                </p>
              )}
            </div>
          ) : !analyzing && acc.content_style ? (
            <pre className="text-xs text-zinc-600 whitespace-pre-wrap leading-relaxed">{acc.content_style}</pre>
          ) : !analyzing ? (
            <p className="text-xs text-zinc-400 italic">暂无风格分析，点击「AI 重新分析」自动生成</p>
          ) : null}
        </div>

        {/* ── 高赞笔记列表 ── */}
        {acc.top_notes.length > 0 && (
          <div className="px-4 py-4 border-b border-zinc-100">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-zinc-800">高赞笔记</span>
              <span className="text-xs text-zinc-400">{acc.top_notes.length} 条</span>
            </div>
            {/* 仿写物品输入框 */}
            <div className="mb-3">
              <input
                type="text"
                value={imitateItemTitle}
                onChange={(e) => setImitateItemTitle(e.target.value)}
                placeholder="可选：填入要写的物品名，生成更精准的仿写 Prompt"
                className="w-full border border-zinc-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442]"
              />
            </div>
            <div className="space-y-2">
              {acc.top_notes.map((n, i) => (
                <div key={i}>
                  <div className="flex items-start gap-2 text-xs group">
                    <span className="text-zinc-300 shrink-0 mt-0.5">{i + 1}.</span>
                    {n.url ? (
                      <button
                        onClick={() => openInBrowser(n.url!)}
                        className="text-zinc-700 flex-1 leading-relaxed hover:text-[#ff2442] transition-colors flex items-start gap-1 text-left"
                      >
                        {n.title}
                        <ExternalLink size={10} className="shrink-0 mt-0.5 opacity-40" />
                      </button>
                    ) : (
                      <span className="text-zinc-700 flex-1 leading-relaxed">{n.title}</span>
                    )}
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[#ff2442]">❤ {n.likes.toLocaleString()}</span>
                      <button
                        onClick={() => addToRefLib(n, i)}
                        disabled={addedToLib.has(i)}
                        className="opacity-0 group-hover:opacity-100 text-[10px] border border-zinc-300 text-zinc-500 px-1.5 py-0.5 rounded hover:border-sky-400 hover:text-sky-500 transition-all disabled:opacity-50 disabled:cursor-default"
                        title="加入经验库参考样本"
                      >
                        {addedToLib.has(i) ? "已入库" : "入库"}
                      </button>
                      <button
                        onClick={() => generateImitate(n)}
                        disabled={imitateLoading && imitateNote?.title === n.title}
                        className="opacity-0 group-hover:opacity-100 text-[10px] border border-zinc-300 text-zinc-500 px-1.5 py-0.5 rounded hover:border-[#ff2442] hover:text-[#ff2442] transition-all disabled:opacity-30"
                      >
                        仿写
                      </button>
                    </div>
                  </div>
                  {/* 仿写结果展示 */}
                  {imitateNote?.title === n.title && (
                    <div className="mt-2 ml-4 bg-zinc-50 rounded-xl p-3 border border-zinc-100">
                      {imitateLoading ? (
                        <div className="flex items-center gap-2 text-xs text-zinc-400">
                          <RefreshCw size={11} className="animate-spin" />生成中…
                        </div>
                      ) : imitateResult ? (
                        <>
                          <pre className="text-xs text-zinc-600 whitespace-pre-wrap leading-relaxed mb-2">{imitateResult}</pre>
                          <div className="flex justify-end">
                            <button onClick={copyImitate}
                              className="flex items-center gap-1 text-xs text-zinc-500 border border-zinc-200 px-2 py-1 rounded-lg hover:border-[#ff2442] hover:text-[#ff2442]">
                              {copiedImitate ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
                              {copiedImitate ? "已复制" : "复制 Prompt"}
                            </button>
                          </div>
                        </>
                      ) : null}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 底部：快捷操作 ── */}
        <div className="px-4 py-4">
          <p className="text-xs text-zinc-400">
            爬取于 {acc.crawled_at ? new Date(acc.crawled_at).toLocaleDateString("zh-CN") : "未知"}
            {acc.analyzed_at && ` · 分析于 ${new Date(acc.analyzed_at).toLocaleDateString("zh-CN")}`}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Accounts Page ─────────────────────────────────────────────────────────────
export default function Accounts() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showModal, setShowModal] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: accounts = [], isLoading } = useQuery<ReferenceAccount[]>({
    queryKey: ["accounts"],
    queryFn: () => api.get("/api/accounts/"),
  });

  const deleteMutation = useMutation({
    mutationFn: (account_id: string) => api.delete(`/api/accounts/${account_id}`),
    onSuccess: (_, account_id) => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      if (selectedId === account_id) setSelectedId(null);
      toast("账号已删除", "success");
    },
    onError: () => toast("删除失败", "error"),
  });

  const selectedAcc = accounts.find((a) => a.account_id === selectedId) ?? null;

  if (isLoading) return <Spinner />;

  return (
    <div className="flex h-full overflow-hidden">
      {/* 左侧列表区 */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <div className="flex items-center px-6 py-4 border-b border-zinc-100 bg-white shrink-0">
          <h1 className="text-lg font-semibold text-zinc-900">榜样账号</h1>
          <span className="ml-2 text-sm text-zinc-400">{accounts.length} 个</span>
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
            <div className="space-y-3 max-w-2xl">
              {accounts.map((acc) => (
                <AccountCard
                  key={acc.account_id}
                  acc={acc}
                  selected={selectedId === acc.account_id}
                  onClick={() => setSelectedId(selectedId === acc.account_id ? null : acc.account_id)}
                  onDelete={() => deleteMutation.mutate(acc.account_id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 右侧详情抽屉 */}
      {selectedAcc && (
        <AccountDrawer
          key={selectedAcc.account_id}
          acc={selectedAcc}
          onClose={() => setSelectedId(null)}
          onUpdated={() => qc.invalidateQueries({ queryKey: ["accounts"] })}
        />
      )}

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
