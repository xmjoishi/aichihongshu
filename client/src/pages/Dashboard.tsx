import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, openInBrowser } from "../lib/api";
import { Analytics } from "../lib/types";
import { Spinner } from "../components/ui";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip,
} from "recharts";
import {
  AlertCircle, BookImage, FileText, ArrowRight,
  ExternalLink, Pencil, TrendingUp,
} from "lucide-react";

// ── 趋势图数据结构 ────────────────────────────────────────────────────────────
interface TrendResponse {
  granularity: "day" | "week";
  items: { day: string; count: number; total_likes: number }[];
}

// ── 今日建议行动卡片 ──────────────────────────────────────────────────────────
function SuggestionCard({
  icon,
  text,
  action,
  onClick,
  color = "zinc",
}: {
  icon: React.ReactNode;
  text: string;
  action: string;
  onClick: () => void;
  color?: "red" | "amber" | "zinc";
}) {
  const colorMap = {
    red:   "bg-[#fff1f3] text-[#ff2442]",
    amber: "bg-amber-50 text-amber-600",
    zinc:  "bg-zinc-50 text-zinc-500",
  };
  return (
    <div className={`flex items-center gap-3 rounded-xl px-4 py-3 ${colorMap[color]}`}>
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 text-sm">{text}</span>
      <button
        onClick={onClick}
        className="shrink-0 flex items-center gap-1 text-xs font-medium opacity-80 hover:opacity-100"
      >
        {action} <ArrowRight size={11} />
      </button>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery<Analytics>({
    queryKey: ["analytics"],
    queryFn: () => api.get("/api/analytics/summary"),
  });

  const { data: trendResp } = useQuery<TrendResponse>({
    queryKey: ["notes-trend"],
    queryFn: () => api.get("/api/analytics/notes-trend"),
  });

  if (isLoading) return <Spinner />;
  if (!data) return null;

  const { library, notes, my_profile, top_notes, suggestions } = data;
  const profile = my_profile as any;

  const isProfileSetup = !!(profile?.persona_name);
  const hasFollowers = (profile?.followers ?? 0) > 0;
  // profileIncomplete: 有粉丝但人设未完善（已在 banner 引导文案中使用）
  void (hasFollowers && !isProfileSetup);

  const trend = trendResp?.items ?? [];
  const granularity = trendResp?.granularity ?? "day";
  const hasTrend = trend.length > 1;

  // 建议行动列表
  const suggestionItems: React.ReactNode[] = [];
  if (!isProfileSetup) {
    suggestionItems.push(
      <SuggestionCard
        key="profile"
        icon={<AlertCircle size={16} />}
        text="账号人设未设置，影响所有笔记的语气和风格"
        action="去设置"
        onClick={() => navigate("/profile")}
        color="red"
      />
    );
  }
  if ((suggestions?.items_without_notes ?? 0) > 0) {
    suggestionItems.push(
      <SuggestionCard
        key="library"
        icon={<BookImage size={16} />}
        text={`图库有 ${suggestions!.items_without_notes} 件物品还没生成笔记`}
        action="去创作"
        onClick={() => navigate("/library")}
        color="amber"
      />
    );
  }
  if ((suggestions?.days_since_publish ?? -1) !== null && (suggestions?.days_since_publish ?? -1) >= 3) {
    suggestionItems.push(
      <SuggestionCard
        key="publish"
        icon={<TrendingUp size={16} />}
        text={`已 ${suggestions!.days_since_publish} 天没发布，建议今天发一篇`}
        action="看草稿"
        onClick={() => navigate("/notes")}
        color="amber"
      />
    );
  }
  if ((suggestions?.draft_count ?? 0) > 0 && (suggestions?.days_since_publish ?? -1) !== null && (suggestions?.days_since_publish ?? -1) < 3) {
    suggestionItems.push(
      <SuggestionCard
        key="draft"
        icon={<FileText size={16} />}
        text={`有 ${suggestions!.draft_count} 篇草稿待完善`}
        action="查看"
        onClick={() => navigate("/notes")}
        color="zinc"
      />
    );
  }

  return (
    <div className="overflow-y-auto h-full w-full">
    <div className="p-6 max-w-4xl mx-auto w-full">
      <h1 className="text-xl font-semibold text-zinc-900 mb-6">运营看板</h1>

      {/* ── Profile banner ── */}
      {isProfileSetup ? (
        <div className="bg-gradient-to-r from-[#ff2442] to-[#ff6b81] rounded-2xl p-5 text-white mb-6">
          <p className="text-xs opacity-70 mb-1">当前账号人设</p>
          <p className="text-lg font-semibold">{profile.persona_name}</p>
          {profile.niche && <p className="text-sm opacity-80 mt-0.5">{profile.niche}</p>}
          <div className="flex gap-6 mt-3 text-sm">
            <span>粉丝 {(profile.followers ?? 0).toLocaleString()}</span>
            <span>均赞 {profile.avg_likes ?? 0}</span>
            <span>均评 {profile.avg_comments ?? 0}</span>
            <span>均藏 {profile.avg_collects ?? 0}</span>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border-2 border-dashed border-zinc-200 p-5 mb-6 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-700">账号人设未设置</p>
            <p className="text-xs text-zinc-400 mt-0.5">
              {hasFollowers
                ? `已检测到 ${(profile.followers ?? 0).toLocaleString()} 粉丝，完善人设后笔记语气会更准确`
                : "设置人设后 AI 生成的笔记语气更符合你的账号风格"}
            </p>
          </div>
          <button
            onClick={() => navigate("/profile")}
            className="shrink-0 ml-4 flex items-center gap-1.5 text-sm font-medium text-white bg-[#ff2442] px-4 py-2 rounded-xl hover:bg-[#e01f3a] transition-colors"
          >
            <Pencil size={13} /> 去设置
          </button>
        </div>
      )}

      {/* ── Stats row ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {/* 图库物品 */}
        <button
          onClick={() => navigate("/library")}
          className="bg-white rounded-2xl border border-zinc-100 p-4 text-left hover:border-zinc-200 hover:shadow-sm transition-all group"
        >
          <p className="text-xs text-zinc-400 mb-1">图库物品</p>
          <p className="text-2xl font-bold text-zinc-800">{library.total_items}</p>
          {(suggestions?.items_without_notes ?? 0) > 0 && (
            <p className="text-xs text-amber-500 mt-1">{suggestions!.items_without_notes} 件未出稿</p>
          )}
        </button>

        {/* 笔记总数 */}
        <button
          onClick={() => navigate("/notes")}
          className="bg-white rounded-2xl border border-zinc-100 p-4 text-left hover:border-zinc-200 hover:shadow-sm transition-all"
        >
          <p className="text-xs text-zinc-400 mb-1">笔记总数</p>
          <p className="text-2xl font-bold text-zinc-800">{notes.total}</p>
          {(notes.by_status.draft ?? 0) > 0 && (
            <p className="text-xs text-zinc-400 mt-1">{notes.by_status.draft} 篇草稿</p>
          )}
        </button>

        {/* 已发布 */}
        <button
          onClick={() => navigate("/data")}
          className="bg-white rounded-2xl border border-zinc-100 p-4 text-left hover:border-zinc-200 hover:shadow-sm transition-all"
        >
          <p className="text-xs text-zinc-400 mb-1">已发布</p>
          <p className="text-2xl font-bold text-[#ff2442]">{notes.by_status.published ?? 0}</p>
          <p className="text-xs text-zinc-400 mt-1">均赞 {notes.published_avg.likes}</p>
        </button>

        {/* 均赞 */}
        <div className="bg-white rounded-2xl border border-zinc-100 p-4">
          <p className="text-xs text-zinc-400 mb-1">均赞 / 均藏</p>
          <p className="text-2xl font-bold text-zinc-800">{notes.published_avg.likes}</p>
          <p className="text-xs text-zinc-400 mt-1">藏 {notes.published_avg.collects} · 评 {notes.published_avg.comments}</p>
        </div>
      </div>

      {/* ── 今日建议行动 ── */}
      {suggestionItems.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-zinc-700 mb-2">建议行动</h2>
          <div className="space-y-2">{suggestionItems}</div>
        </div>
      )}

      {/* ── 趋势柱状图 ── */}
      <div className="bg-white rounded-2xl border border-zinc-100 p-5 mb-6">
        <h2 className="text-sm font-semibold text-zinc-700 mb-4">
          笔记发布趋势
          <span className="ml-2 text-xs font-normal text-zinc-400">
            {granularity === "week" ? "近90天（按周）" : "近90天（按日）"}
          </span>
        </h2>
        {hasTrend ? (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={trend} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" vertical={false} />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 10, fill: "#a1a1aa" }}
                tickFormatter={(v: string) => v.slice(5)}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#a1a1aa" }}
                allowDecimals={false}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #f4f4f5" }}
                labelStyle={{ color: "#3f3f46" }}
                formatter={(value: unknown, name: unknown) => [
                  value as number,
                  name === "count" ? "笔记数" : "总点赞",
                ]}
              />
              <Bar dataKey="count" name="count" fill="#ff2442" radius={[4, 4, 0, 0]} maxBarSize={32} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex flex-col items-center justify-center h-[180px] text-zinc-400">
            <TrendingUp size={32} className="mb-2 opacity-30" />
            <p className="text-sm">发布更多笔记后这里会出现趋势图</p>
          </div>
        )}
      </div>

      {/* ── 发布笔记排行 ── */}
      {top_notes.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-zinc-700 mb-3">发布笔记排行</h2>
          <div className="space-y-2">
            {top_notes.map((n, i) => (
              <div
                key={n.id}
                className="flex items-center gap-3 bg-white rounded-xl px-4 py-3 border border-zinc-100 group"
              >
                <span className="text-xs font-bold text-zinc-300 w-4 shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-800 truncate">{n.title}</p>
                  {n.item_title && (
                    <p className="text-xs text-zinc-400 truncate">{n.item_title}</p>
                  )}
                </div>
                <span className="text-sm font-semibold text-[#ff2442] shrink-0">❤ {n.likes}</span>
                {n.note_url && (
                  <button
                    onClick={() => openInBrowser(n.note_url!)}
                    title="在小红书查看"
                    className="shrink-0 p-1 text-zinc-300 hover:text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <ExternalLink size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
