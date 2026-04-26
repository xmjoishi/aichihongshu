import { NavLink } from "react-router-dom";
import {
  LayoutGrid, FileText, Users, User, BarChart2, Settings, TrendingUp, Sparkles,
  ShieldCheck,
} from "lucide-react";

// 顶部：当前运营账号上下文（跟着激活账号切换）
const accountNav = [
  { to: "/", icon: BarChart2, label: "看板" },
  { to: "/library", icon: LayoutGrid, label: "图库" },
  { to: "/notes", icon: FileText, label: "笔记" },
  { to: "/inspire", icon: Sparkles, label: "灵感" },
  { to: "/data", icon: TrendingUp, label: "数据" },
  { to: "/accounts", icon: Users, label: "榜样" },
  { to: "/profile", icon: User, label: "账号" },
];

// 底部：全局（与运营账号无关）
const globalNav = [
  { to: "/accounts/pool", icon: ShieldCheck, label: "账号池" },
  { to: "/settings", icon: Settings, label: "设置" },
];

const itemClass = ({ isActive }: { isActive: boolean }) =>
  `flex flex-col items-center gap-0.5 w-12 py-2 rounded-xl transition-colors
   ${isActive
     ? "bg-[#fff0f2] text-[#ff2442]"
     : "text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50"}`;

export default function Sidebar() {
  return (
    <aside className="w-16 flex flex-col items-center py-6 gap-1 bg-white border-r border-zinc-100 shrink-0">
      {/* Logo */}
      <div className="w-9 h-9 rounded-xl bg-[#ff2442] flex items-center justify-center mb-6">
        <span className="text-white font-bold text-sm">红</span>
      </div>

      {/* 顶部：账号上下文区 */}
      {accountNav.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/" || to === "/accounts"}
          className={itemClass}
        >
          <Icon size={20} />
          <span className="text-[10px] font-medium">{label}</span>
        </NavLink>
      ))}

      {/* 弹簧把全局区压到底部 */}
      <div className="flex-1" />

      {/* 分隔线：上=账号上下文，下=全局 */}
      <div className="w-8 h-px bg-zinc-200 my-1" />

      {/* 底部：全局区 */}
      {globalNav.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/accounts/pool"}
          className={itemClass}
        >
          <Icon size={20} />
          <span className="text-[10px] font-medium">{label}</span>
        </NavLink>
      ))}
    </aside>
  );
}
