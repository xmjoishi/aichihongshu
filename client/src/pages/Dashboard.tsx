import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Analytics } from "../lib/types";
import { StatCard, Spinner } from "../components/ui";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip,
} from "recharts";

export default function Dashboard() {
  const { data, isLoading } = useQuery<Analytics>({
    queryKey: ["analytics"],
    queryFn: () => api.get("/api/analytics/summary"),
  });

  const { data: trend = [] } = useQuery<{ day: string; count: number }[]>({
    queryKey: ["notes-trend"],
    queryFn: () => api.get("/api/analytics/notes-trend"),
  });

  if (isLoading) return <Spinner />;
  if (!data) return null;

  const { library, notes, my_profile } = data;

  return (
    <div className="p-6 max-w-4xl overflow-y-auto h-full">
      <h1 className="text-xl font-semibold text-zinc-900 mb-6">运营看板</h1>

      {/* Profile banner */}
      {my_profile && (
        <div className="bg-gradient-to-r from-[#ff2442] to-[#ff6b81] rounded-2xl p-5 text-white mb-6">
          <p className="text-xs opacity-80 mb-1">当前账号人设</p>
          <p className="text-lg font-semibold">{(my_profile as any).persona_name ?? "未设置"}</p>
          <p className="text-sm opacity-80 mt-1">{(my_profile as any).niche ?? ""}</p>
          <div className="flex gap-6 mt-3 text-sm">
            <span>粉丝 {my_profile.followers ?? 0}</span>
            <span>均赞 {my_profile.avg_likes ?? 0}</span>
            <span>均评 {my_profile.avg_comments ?? 0}</span>
            <span>均藏 {my_profile.avg_collects ?? 0}</span>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="图库物品" value={library.total_items} />
        <StatCard label="笔记总数" value={notes.total} />
        <StatCard label="草稿" value={notes.by_status.draft ?? 0} />
        <StatCard label="已发布" value={notes.by_status.published ?? 0}
          sub={`均赞 ${notes.published_avg.likes}`} />
      </div>

      {/* 趋势折线图 */}
      {trend.length > 0 && (
        <div className="bg-white rounded-2xl border border-zinc-100 p-5 mb-6">
          <h2 className="text-sm font-semibold text-zinc-700 mb-4">近30天笔记创作趋势</h2>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={trend} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 10, fill: "#a1a1aa" }}
                tickFormatter={(v: string) => v.slice(5)} // MM-DD
              />
              <YAxis tick={{ fontSize: 10, fill: "#a1a1aa" }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #f4f4f5" }}
                labelStyle={{ color: "#3f3f46" }}
              />
              <Line
                type="monotone"
                dataKey="count"
                name="笔记数"
                stroke="#ff2442"
                strokeWidth={2}
                dot={{ r: 3, fill: "#ff2442" }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Top notes */}
      {data.top_notes.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-zinc-700 mb-3">发布笔记排行</h2>
          <div className="space-y-2">
            {data.top_notes.map((n, i) => (
              <div key={n.id}
                className="flex items-center gap-3 bg-white rounded-xl px-4 py-3 border border-zinc-100">
                <span className="text-xs font-bold text-zinc-400 w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-800 truncate">{n.title}</p>
                  <p className="text-xs text-zinc-400">{n.item_title}</p>
                </div>
                <span className="text-sm font-semibold text-[#ff2442]">❤ {n.likes}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
