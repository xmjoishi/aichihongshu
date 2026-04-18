import { NavLink } from "react-router-dom";
import {
  LayoutGrid, FileText, Users, User, BarChart2, Send, Settings,
} from "lucide-react";

const nav = [
  { to: "/", icon: BarChart2, label: "看板" },
  { to: "/library", icon: LayoutGrid, label: "图库" },
  { to: "/notes", icon: FileText, label: "笔记" },
  { to: "/publish", icon: Send, label: "发布" },
  { to: "/accounts", icon: Users, label: "榜样" },
  { to: "/profile", icon: User, label: "账号" },
];

export default function Sidebar() {
  return (
    <aside className="w-16 flex flex-col items-center py-6 gap-1 bg-white border-r border-zinc-100 shrink-0">
      {/* Logo */}
      <div className="w-9 h-9 rounded-xl bg-[#ff2442] flex items-center justify-center mb-6">
        <span className="text-white font-bold text-sm">红</span>
      </div>

      {nav.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          className={({ isActive }) =>
            `flex flex-col items-center gap-0.5 w-12 py-2 rounded-xl transition-colors
             ${isActive
               ? "bg-[#fff0f2] text-[#ff2442]"
               : "text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50"}`
          }
        >
          <Icon size={20} />
          <span className="text-[10px] font-medium">{label}</span>
        </NavLink>
      ))}

      {/* Settings 固定在底部 */}
      <div className="flex-1" />
      <NavLink
        to="/settings"
        className={({ isActive }) =>
          `flex flex-col items-center gap-0.5 w-12 py-2 rounded-xl transition-colors
           ${isActive
             ? "bg-[#fff0f2] text-[#ff2442]"
             : "text-zinc-400 hover:text-zinc-700 hover:bg-zinc-50"}`
        }
      >
        <Settings size={20} />
        <span className="text-[10px] font-medium">设置</span>
      </NavLink>
    </aside>
  );
}
