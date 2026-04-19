import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  Heart, MessageCircle, Bookmark, TrendingUp,
  ExternalLink, RefreshCw, ChevronUp, ChevronDown,
  Sparkles, X, CornerDownLeft, StopCircle,
} from "lucide-react";
import { api, API_BASE, openInChromium } from "../lib/api";
import type { Analytics, AnalyticsNote, Insights } from "../lib/types";
import { MdContent } from "../components/MdContent";
import { useAIStream } from "../hooks/useAIStream";
import { usePanelResize } from "../hooks/usePanelResize";
import KnowledgeTab from "./KnowledgeTab";

// ─── 工具函数 ───────────────────────────────────────────────

function fmtDate(s?: string) {
  if (!s) return "—";
  return s.slice(0, 10);
}

function StatCard({
  label, value, sub, icon: Icon, color,
}: {
  label: string; value: string | number; sub?: string;
  icon: React.ElementType; color: string;
}) {
  return (
    <div className="bg-white rounded-2xl p-5 flex items-start gap-4 shadow-sm border border-zinc-100">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${color}`}>
        <Icon size={18} className="text-white" />
      </div>
      <div>
        <p className="text-xs text-zinc-400">{label}</p>
        <p className="text-2xl font-bold text-zinc-800 leading-tight">{value}</p>
        {sub && <p className="text-xs text-zinc-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Tab: 总览 ───────────────────────────────────────────────

function OverviewTab({ summary }: { summary: Analytics | null }) {
  if (!summary) {
    return <div className="flex items-center justify-center h-60 text-zinc-400">加载中…</div>;
  }

  const avg = summary.notes.published_avg;
  const published = summary.notes.by_status["published"] ?? 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard label="已发布笔记" value={published} icon={TrendingUp} color="bg-[#ff2442]" />
        <StatCard
          label="平均点赞" value={avg.likes}
          sub="每篇已发布笔记"
          icon={Heart} color="bg-rose-400"
        />
        <StatCard
          label="平均收藏" value={avg.collects}
          sub="每篇已发布笔记"
          icon={Bookmark} color="bg-amber-400"
        />
        <StatCard
          label="平均评论" value={avg.comments}
          sub="每篇已发布笔记"
          icon={MessageCircle} color="bg-sky-400"
        />
      </div>

      {/* 高赞笔记 Top5 */}
      {summary.top_notes.length > 0 && (
        <div className="bg-white rounded-2xl p-5 border border-zinc-100 shadow-sm">
          <h3 className="text-sm font-semibold text-zinc-700 mb-3">点赞 Top 5</h3>
          <div className="space-y-2">
            {summary.top_notes.slice(0, 5).map((n, i) => (
              <div key={n.id} className="flex items-center gap-3">
                <span className={`w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold
                  ${i === 0 ? "bg-[#ff2442] text-white" : i < 3 ? "bg-zinc-200 text-zinc-600" : "bg-zinc-100 text-zinc-400"}`}>
                  {i + 1}
                </span>
                <span className="flex-1 text-sm text-zinc-700 truncate">{n.title || "无标题"}</span>
                <span className="flex items-center gap-1 text-xs text-rose-500 font-medium">
                  <Heart size={12} /> {n.likes}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tab: 笔记排行 ────────────────────────────────────────────

type SortKey = "likes" | "collects" | "comments";

function RankingTab() {
  const navigate = useNavigate();
  const [sort, setSort] = useState<SortKey>("likes");
  const [notes, setNotes] = useState<AnalyticsNote[]>([]);
  const [loading, setLoading] = useState(false);
  // inline 编辑状态
  const [editing, setEditing] = useState<{ id: number; field: SortKey } | null>(null);
  const [editVal, setEditVal] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get(`/api/analytics/notes?sort=${sort}`);
      setNotes(data);
    } finally {
      setLoading(false);
    }
  }, [sort]);

  useEffect(() => { load(); }, [load]);

  const startEdit = (id: number, field: SortKey, current: number) => {
    setEditing({ id, field });
    setEditVal(String(current));
  };

  const commitEdit = async () => {
    if (!editing) return;
    const val = parseInt(editVal, 10);
    if (isNaN(val) || val < 0) { setEditing(null); return; }
    setSaving(true);
    try {
      await api.patch(`/api/content/${editing.id}/stats`, { [editing.field]: val });
      setNotes(prev => prev.map(n =>
        n.id === editing.id ? { ...n, [editing.field]: val } : n
      ));
    } finally {
      setSaving(false);
      setEditing(null);
    }
  };

  const sortBtns: { key: SortKey; label: string; icon: React.ElementType; color: string }[] = [
    { key: "likes", label: "点赞", icon: Heart, color: "text-rose-500" },
    { key: "collects", label: "收藏", icon: Bookmark, color: "text-amber-500" },
    { key: "comments", label: "评论", icon: MessageCircle, color: "text-sky-500" },
  ];

  return (
    <div className="space-y-4">
      {/* 排序切换 */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-400 mr-1">排序：</span>
        {sortBtns.map(({ key, label, icon: Icon, color }) => (
          <button
            key={key}
            onClick={() => setSort(key)}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
              ${sort === key ? "bg-[#ff2442] text-white" : "bg-white border border-zinc-200 text-zinc-600 hover:border-zinc-300"}`}
          >
            <Icon size={12} className={sort === key ? "text-white" : color} />
            {label}
          </button>
        ))}
        <div className="relative group ml-auto">
          <button
            onClick={load}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-zinc-500 bg-white border border-zinc-200 hover:border-zinc-300 transition-colors"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            刷新列表
          </button>
          {/* Tooltip */}
          <div className="absolute right-0 top-full mt-2 w-52 bg-zinc-800 text-white text-xs rounded-xl px-3 py-2 leading-relaxed
                          opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 z-50 shadow-lg">
            <p className="font-medium mb-0.5">📊 重新加载本地数据</p>
            <p className="text-zinc-300">从本地数据库重新读取已有笔记数据，不触发爬虫。如需同步最新数据，请前往「账号」页点击「同步小红书」。</p>
          </div>
        </div>
      </div>

      {/* 表格 */}
      <div className="bg-white rounded-2xl border border-zinc-100 shadow-sm overflow-hidden">
        {loading && notes.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-zinc-400 text-sm">加载中…</div>
        ) : notes.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-zinc-400 text-sm">暂无已发布笔记</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-xs text-zinc-400">
                <th className="text-left px-4 py-3 font-medium w-8">#</th>
                <th className="text-left px-4 py-3 font-medium">标题</th>
                {sortBtns.map(({ key, label, icon: Icon, color }) => (
                  <th key={key} className="text-center px-3 py-3 font-medium">
                    <span className={`flex items-center justify-center gap-1 ${color}`}>
                      <Icon size={11} /> {label}
                      {sort === key ? (
                        <ChevronDown size={10} />
                      ) : (
                        <ChevronUp size={10} className="opacity-30" />
                      )}
                    </span>
                  </th>
                ))}
                <th className="text-center px-3 py-3 font-medium">发布日期</th>
                <th className="text-center px-3 py-3 font-medium">互动率</th>
                <th className="px-3 py-3 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {notes.map((note, idx) => (
                <tr
                  key={note.id}
                  className="border-b border-zinc-50 hover:bg-zinc-50/50 transition-colors"
                >
                  <td className="px-4 py-3 text-zinc-400 text-xs">{idx + 1}</td>
                  <td className="px-4 py-3 max-w-[240px]">
                    <div className="flex items-center gap-2">
                      {note.cover_image && (
                        <img
                          src={`${API_BASE}/api/library/image-raw?path=${encodeURIComponent(note.cover_image)}`}
                          className="w-8 h-8 rounded-lg object-cover shrink-0 bg-zinc-100"
                          alt=""
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                      )}
                      <button
                        onClick={() => navigate(`/notes/${note.id}`)}
                        className="text-left text-zinc-700 hover:text-[#ff2442] transition-colors line-clamp-2 text-xs leading-snug"
                      >
                        {note.title || "无标题"}
                      </button>
                    </div>
                  </td>
                  {sortBtns.map(({ key }) => (
                    <td key={key} className="px-3 py-3 text-center">
                      {editing?.id === note.id && editing.field === key ? (
                        <input
                          autoFocus
                          type="number"
                          min={0}
                          value={editVal}
                          onChange={e => setEditVal(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={e => {
                            if (e.key === "Enter") commitEdit();
                            if (e.key === "Escape") setEditing(null);
                          }}
                          disabled={saving}
                          className="w-16 text-center border border-[#ff2442] rounded-md px-1 py-0.5 text-xs outline-none"
                        />
                      ) : (
                        <button
                          onClick={() => startEdit(note.id, key, note[key])}
                          className="font-medium text-zinc-700 hover:text-[#ff2442] transition-colors cursor-pointer"
                        >
                          {note[key]}
                        </button>
                      )}
                    </td>
                  ))}
                  <td className="px-3 py-3 text-center text-xs text-zinc-400">{fmtDate(note.published_at)}</td>
                  <td className="px-3 py-3 text-center">
                    <span className="text-xs text-zinc-500 bg-zinc-100 rounded-full px-2 py-0.5">
                      {note.engagement_rate}x
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    {note.note_url && (
                      <button
                        onClick={() => openInChromium(note.note_url!)}
                        className="text-zinc-300 hover:text-[#ff2442] transition-colors"
                      >
                        <ExternalLink size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-zinc-400 text-center">点击数字可直接编辑更新互动数据</p>
    </div>
  );
}

// ─── Tab: 内容规律 ────────────────────────────────────────────

function Bar({ value, max, color = "bg-[#ff2442]" }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex-1 h-2 bg-zinc-100 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function InsightsTab() {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/api/analytics/insights")
      .then(setInsights)
      .catch(() => setInsights(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex items-center justify-center h-60 text-zinc-400">加载中…</div>;
  if (!insights) return <div className="flex items-center justify-center h-60 text-zinc-400">暂无数据</div>;

  const maxTitleLikes = Math.max(...insights.title_length_dist.map(d => d.avg_likes), 1);
  const maxHourLikes = Math.max(...insights.hour_dist.map(d => d.avg_likes), 1);
  const maxTagCount = Math.max(...insights.tag_freq.map(d => d.count), 1);

  const { mine, reference } = insights.comparison;
  const compItems = [
    { label: "平均点赞", mine: mine.avg_likes, ref: reference.avg_likes, icon: Heart, color: "text-rose-500" },
    { label: "平均收藏", mine: mine.avg_collects, ref: reference.avg_collects, icon: Bookmark, color: "text-amber-500" },
    { label: "平均评论", mine: mine.avg_comments, ref: reference.avg_comments, icon: MessageCircle, color: "text-sky-500" },
  ];

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      {/* 标题字数 vs 点赞 */}
      <div className="bg-white rounded-2xl p-5 border border-zinc-100 shadow-sm">
        <h3 className="text-sm font-semibold text-zinc-700 mb-4">标题字数 vs 平均点赞</h3>
        {insights.title_length_dist.every(d => d.count === 0) ? (
          <p className="text-xs text-zinc-400 text-center py-6">暂无数据</p>
        ) : (
          <div className="space-y-3">
            {insights.title_length_dist.map(d => (
              <div key={d.range} className="flex items-center gap-3">
                <span className="w-14 text-xs text-zinc-500 shrink-0">{d.range} 字</span>
                <Bar value={d.avg_likes} max={maxTitleLikes} />
                <span className="w-16 text-right text-xs text-zinc-600 font-medium">
                  {d.avg_likes} <span className="text-zinc-300 font-normal">({d.count}篇)</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 发布时段 */}
      <div className="bg-white rounded-2xl p-5 border border-zinc-100 shadow-sm">
        <h3 className="text-sm font-semibold text-zinc-700 mb-4">发布时段 vs 平均点赞</h3>
        {insights.hour_dist.length === 0 ? (
          <p className="text-xs text-zinc-400 text-center py-6">暂无数据</p>
        ) : (
          <div className="space-y-2">
            {insights.hour_dist.map(d => (
              <div key={d.hour} className="flex items-center gap-3">
                <span className="w-10 text-xs text-zinc-500 shrink-0">{String(d.hour).padStart(2, "0")}:00</span>
                <Bar value={d.avg_likes} max={maxHourLikes} color="bg-amber-400" />
                <span className="w-16 text-right text-xs text-zinc-600 font-medium">
                  {d.avg_likes} <span className="text-zinc-300 font-normal">({d.count}篇)</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 标签词频 */}
      <div className="bg-white rounded-2xl p-5 border border-zinc-100 shadow-sm">
        <h3 className="text-sm font-semibold text-zinc-700 mb-4">高频标签 Top 20</h3>
        {insights.tag_freq.length === 0 ? (
          <p className="text-xs text-zinc-400 text-center py-6">暂无数据</p>
        ) : (
          <div className="space-y-2">
            {insights.tag_freq.map(d => (
              <div key={d.tag} className="flex items-center gap-3">
                <span className="w-24 text-xs text-zinc-600 truncate shrink-0">#{d.tag}</span>
                <Bar value={d.count} max={maxTagCount} color="bg-sky-400" />
                <span className="w-16 text-right text-xs text-zinc-500">
                  {d.count}次 · {d.avg_likes}赞
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 与榜样账号对比 */}
      <div className="bg-white rounded-2xl p-5 border border-zinc-100 shadow-sm">
        <h3 className="text-sm font-semibold text-zinc-700 mb-4">与榜样账号均值对比</h3>
        {reference.avg_likes === 0 && reference.avg_comments === 0 && reference.avg_collects === 0 ? (
          <p className="text-xs text-zinc-400 text-center py-6">暂无榜样账号数据，请先添加榜样账号</p>
        ) : (
          <div className="space-y-4">
            {compItems.map(({ label, mine: m, ref: r, icon: Icon, color }) => {
              const maxVal = Math.max(m, r, 1);
              const ratio = r > 0 ? Math.round((m / r) * 100) : null;
              return (
                <div key={label}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`flex items-center gap-1 text-xs font-medium ${color}`}>
                      <Icon size={11} /> {label}
                    </span>
                    {ratio !== null && (
                      <span className={`text-xs font-semibold ${ratio >= 100 ? "text-emerald-500" : "text-zinc-400"}`}>
                        {ratio >= 100 ? "+" : ""}{ratio - 100}%
                      </span>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-8 text-right text-[10px] text-zinc-400 shrink-0">我的</span>
                      <div className="flex-1 h-2 bg-zinc-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-[#ff2442] transition-all duration-500"
                          style={{ width: `${Math.round((m / maxVal) * 100)}%` }} />
                      </div>
                      <span className="w-10 text-right text-xs text-zinc-700 font-medium">{m}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-8 text-right text-[10px] text-zinc-400 shrink-0">榜样</span>
                      <div className="flex-1 h-2 bg-zinc-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-zinc-300 transition-all duration-500"
                          style={{ width: `${Math.round((r / maxVal) * 100)}%` }} />
                      </div>
                      <span className="w-10 text-right text-xs text-zinc-500">{r}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── AI 数据对话抽屉 ──────────────────────────────────────────


const QUICK_QUESTIONS = [
  "哪类标题字数效果最好？",
  "哪个时间段发布互动最高？",
  "最常用哪些标签，哪个赞最多？",
  "我跟榜样账号差距在哪？",
  "怎么提升收藏率？",
];

function buildSystemExtra(summary: Analytics | null, insights: Insights | null): string {
  const lines: string[] = ["【以下是用户的小红书账号真实数据，请基于这些数据回答问题】"];

  if (summary) {
    const avg = summary.notes.published_avg;
    const published = summary.notes.by_status["published"] ?? 0;
    lines.push(`\n已发布笔记：${published} 篇`);
    lines.push(`平均点赞：${avg.likes}，平均收藏：${avg.collects}，平均评论：${avg.comments}`);
    if (summary.top_notes.length > 0) {
      lines.push("\n点赞 Top5 笔记：");
      summary.top_notes.slice(0, 5).forEach((n, i) => {
        lines.push(`  ${i + 1}. 《${n.title}》 赞${n.likes}`);
      });
    }
  }

  if (insights) {
    lines.push("\n标题字数 vs 平均点赞：");
    insights.title_length_dist.forEach((d) => {
      if (d.count > 0) lines.push(`  ${d.range}字：均赞${d.avg_likes}（${d.count}篇）`);
    });

    if (insights.hour_dist.length > 0) {
      const best = [...insights.hour_dist].sort((a, b) => b.avg_likes - a.avg_likes)[0];
      lines.push(`\n最佳发布时段：${best.hour}:00（均赞${best.avg_likes}）`);
    }

    if (insights.tag_freq.length > 0) {
      lines.push("\n高频标签 Top5：");
      insights.tag_freq.slice(0, 5).forEach((t) => {
        lines.push(`  #${t.tag}（${t.count}次，均赞${t.avg_likes}）`);
      });
    }

    const { mine, reference } = insights.comparison;
    if (reference.avg_likes > 0) {
      lines.push(`\n与榜样对比 — 我的：赞${mine.avg_likes}/藏${mine.avg_collects}/评${mine.avg_comments}`);
      lines.push(`            榜样均值：赞${reference.avg_likes}/藏${reference.avg_collects}/评${reference.avg_comments}`);
    }
  }

  lines.push("\n请用简洁口语回答，给出具体可操作的建议。");
  return lines.join("\n");
}

function DataAIDrawer({
  open, onClose,
  summary, insights,
}: {
  open: boolean; onClose: () => void;
  summary: Analytics | null; insights: Insights | null;
}) {
  const systemExtra = buildSystemExtra(summary, insights);
  const { messages, streaming, loading, send, abort } = useAIStream({ systemExtra });
  const { width, dragging, onDragStart } = usePanelResize({
    defaultWidth: 384,
    min: 300,
    max: 640,
    direction: "left",
    storageKey: "data-ai-drawer-width",
  });
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100);
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  function handleSend(text: string) {
    if (!text.trim() || loading) return;
    send(text.trim());
    setInput("");
  }

  return createPortal(
    <>
      {/* 遮罩 */}
      {open && (
        <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      )}
      {/* 抽屉 */}
      <div
        className={`fixed top-0 right-0 h-full z-50 bg-white shadow-2xl flex flex-col
          transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`}
        style={{ width, cursor: dragging ? "col-resize" : undefined }}
      >
        {/* 左侧拖拽条：视觉 4px，热区 12px */}
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
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-zinc-100 shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles size={15} className="text-[#ff2442]" />
            <span className="text-sm font-semibold text-zinc-800">问数据</span>
            <span className="text-xs text-zinc-400">基于你的真实账号数据</span>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* 对话区 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && !loading && (
            <div className="space-y-2 pt-2">
              <p className="text-xs text-zinc-400 mb-3">快捷问题：</p>
              {QUICK_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => handleSend(q)}
                  className="w-full text-left text-xs px-3 py-2 rounded-xl border border-zinc-100
                             text-zinc-600 hover:border-[#ff2442] hover:text-[#ff2442] transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              {m.role === "user" ? (
                <div className="max-w-[85%] bg-[#ff2442] text-white rounded-2xl rounded-br-sm px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap">
                  {m.content}
                </div>
              ) : (
                <div className="max-w-[90%] bg-zinc-50 border border-zinc-100 rounded-2xl rounded-bl-sm px-3.5 py-2.5 text-xs text-zinc-700">
                  <MdContent content={m.content} />
                </div>
              )}
            </div>
          ))}
          {/* 流式输出 */}
          {streaming && (
            <div className="flex justify-start">
              <div className="max-w-[90%] bg-zinc-50 border border-zinc-100 rounded-2xl rounded-bl-sm px-3.5 py-2.5 text-xs text-zinc-700">
                <MdContent content={streaming} streaming />
              </div>
            </div>
          )}
          {/* 等待首个 chunk */}
          {loading && !streaming && (
            <div className="flex justify-start">
              <div className="bg-zinc-50 border border-zinc-100 rounded-2xl rounded-bl-sm px-4 py-3">
                <span className="inline-flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce"
                      style={{ animationDelay: `${i * 150}ms` }} />
                  ))}
                </span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* 快捷问题 chip（有消息后显示） */}
        {messages.length > 0 && !loading && (
          <div className="px-4 pt-2 flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide shrink-0">
            {QUICK_QUESTIONS.slice(0, 3).map((q) => (
              <button key={q} onClick={() => handleSend(q)}
                className="shrink-0 text-xs px-2.5 py-1 rounded-full border border-zinc-200 text-zinc-500
                           hover:border-[#ff2442] hover:text-[#ff2442] transition-colors whitespace-nowrap">
                {q}
              </button>
            ))}
          </div>
        )}

        {/* 输入区 */}
        <div className="px-4 pb-4 pt-2 border-t border-zinc-100 shrink-0">
          <div className="flex gap-2 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(input); }
              }}
              placeholder="问问你的数据…"
              rows={2}
              disabled={loading}
              className="flex-1 resize-none text-xs border border-zinc-200 rounded-xl px-3 py-2
                         outline-none focus:border-[#ff2442] transition-colors placeholder:text-zinc-300
                         disabled:opacity-50"
            />
            {loading ? (
              <button onClick={abort}
                className="p-2.5 rounded-xl bg-zinc-100 text-zinc-500 hover:bg-zinc-200 transition-colors shrink-0">
                <StopCircle size={14} />
              </button>
            ) : (
              <button onClick={() => handleSend(input)} disabled={!input.trim()}
                className="p-2.5 rounded-xl bg-[#ff2442] text-white hover:bg-[#e01f3a] disabled:opacity-30 transition-colors shrink-0">
                <CornerDownLeft size={14} />
              </button>
            )}
          </div>
          <p className="text-[10px] text-zinc-300 mt-1.5 text-center">Enter 发送 · Shift+Enter 换行</p>
        </div>
      </div>
    </>,
    document.body
  );
}

// ─── 主页面 ───────────────────────────────────────────────────

type Tab = "overview" | "ranking" | "insights" | "knowledge";

const tabs: { key: Tab; label: string }[] = [
  { key: "overview", label: "总览" },
  { key: "ranking", label: "笔记排行" },
  { key: "insights", label: "内容规律" },
  { key: "knowledge", label: "经验库" },
];

export default function Data() {
  const [tab, setTab] = useState<Tab>("overview");
  const [summary, setSummary] = useState<Analytics | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    api.get("/api/analytics/summary").then(setSummary).catch(() => {});
    api.get("/api/analytics/insights").then(setInsights).catch(() => {});
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      {/* 顶部 Header */}
      <div className="px-6 pt-6 pb-0 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-bold text-zinc-800">数据</h1>
            <p className="text-xs text-zinc-400 mt-0.5">追踪笔记表现，发现内容规律</p>
          </div>
        </div>
        {/* Tab 栏 */}
        <div className="flex gap-1 border-b border-zinc-100">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px
                ${tab === key
                  ? "border-[#ff2442] text-[#ff2442]"
                  : "border-transparent text-zinc-400 hover:text-zinc-600"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {tab === "overview" && <OverviewTab summary={summary} />}
        {tab === "ranking" && <RankingTab />}
        {tab === "insights" && <InsightsTab />}
        {tab === "knowledge" && <KnowledgeTab />}
      </div>

      {/* 悬浮「问数据」按钮 */}
      {!drawerOpen && (
        <button
          onClick={() => setDrawerOpen(true)}
          title="基于你的真实账号数据进行 AI 对话"
          className="absolute bottom-6 right-6 flex items-center gap-2 px-4 py-2.5 rounded-full
                     bg-[#ff2442] text-white shadow-lg hover:bg-[#e01f3a] active:scale-95
                     transition-all text-sm font-medium"
        >
          <Sparkles size={15} />
          问数据
        </button>
      )}

      {/* AI 对话抽屉 */}
      <DataAIDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        summary={summary}
        insights={insights}
      />
    </div>
  );
}
