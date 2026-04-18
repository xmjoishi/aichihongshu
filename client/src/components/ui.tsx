// 状态 Badge
const STATUS_MAP = {
  draft: { label: "草稿", cls: "bg-zinc-100 text-zinc-500" },
  ready: { label: "待发", cls: "bg-amber-100 text-amber-600" },
  published: { label: "已发", cls: "bg-green-100 text-green-600" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_MAP[status as keyof typeof STATUS_MAP] ?? STATUS_MAP.draft;
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

// 标签 Chip
export function Tag({ label }: { label: string }) {
  return (
    <span className="text-xs bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded-full">
      #{label}
    </span>
  );
}

// 空状态
export function Empty({ message = "暂无数据" }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-48 text-zinc-400 gap-2">
      <span className="text-3xl">📭</span>
      <p className="text-sm">{message}</p>
    </div>
  );
}

// 加载中
export function Spinner() {
  return (
    <div className="flex items-center justify-center h-48">
      <div className="w-6 h-6 border-2 border-[#ff2442] border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

// 数字卡片
export function StatCard({
  label, value, sub,
}: {
  label: string; value: string | number; sub?: string;
}) {
  return (
    <div className="bg-white rounded-xl p-4 border border-zinc-100">
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <p className="text-2xl font-semibold text-zinc-900">{value}</p>
      {sub && <p className="text-xs text-zinc-400 mt-0.5">{sub}</p>}
    </div>
  );
}
