import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Trash2,
  Plus,
  CheckCircle2,
  AlertTriangle,
  Pencil,
  Shield,
  Bot,
  Globe,
  CircleStop,
  RefreshCw,
} from "lucide-react";
import { api } from "../lib/api";
import { Spinner, Empty } from "../components/ui";
import { useToast } from "../components/Toast";

interface PoolAccount {
  id: number;
  alias: string;
  role: "operation" | "assistant";
  user_data_dir: string;
  xhs_user_id?: string;
  display_name?: string;
  followers?: number;
  status: "active" | "banned" | "suspended" | "retired";
  ban_count: number;
  notes?: string;
  is_active?: boolean;
  created_at: string;
  last_used_at?: string;
}

interface BrowserStatus {
  running: boolean;
  pid?: number;
  user_data_dir?: string;
}

const ROLE_LABEL: Record<PoolAccount["role"], { label: string; cls: string; desc: string }> = {
  operation: {
    label: "运营账号",
    cls: "bg-rose-100 text-rose-600 border border-rose-200",
    desc: "可作为顶栏激活账号，承载该账号的人设、笔记、图库。",
  },
  assistant: {
    label: "辅助账号",
    cls: "bg-sky-100 text-sky-700 border border-sky-200",
    desc: "仅用于浏览器/爬虫场景，不会成为顶栏激活账号。",
  },
};

export default function AccountPool() {
  const [items, setItems] = useState<PoolAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<PoolAccount | null>(null);
  const [browserStatusMap, setBrowserStatusMap] = useState<Record<number, BrowserStatus>>({});
  const [browserBusyMap, setBrowserBusyMap] = useState<Record<number, boolean>>({});

  const { toast } = useToast();
  const qc = useQueryClient();

  const reload = async () => {
    setLoading(true);
    try {
      const pool = await api.get("/api/account-pool");
      const nextItems: PoolAccount[] = pool.items || [];
      setItems(nextItems);

      const statuses = await Promise.all(
        nextItems.map(async (acc) => {
          try {
            const st = await api.get(`/api/crawler/browser?account_id=${acc.id}`);
            return [acc.id, st as BrowserStatus] as const;
          } catch {
            return [acc.id, { running: false } as BrowserStatus] as const;
          }
        }),
      );
      const map: Record<number, BrowserStatus> = {};
      for (const [id, st] of statuses) map[id] = st;
      setBrowserStatusMap(map);

      qc.invalidateQueries({ queryKey: ["account-pool"] });
    } catch (e) {
      toast(`加载失败：${(e as Error).message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const withBrowserBusy = async (accountId: number, fn: () => Promise<void>) => {
    setBrowserBusyMap((m) => ({ ...m, [accountId]: true }));
    try {
      await fn();
    } finally {
      setBrowserBusyMap((m) => ({ ...m, [accountId]: false }));
    }
  };

  const refreshBrowserStatus = async (accountId: number) => {
    try {
      const st = await api.get(`/api/crawler/browser?account_id=${accountId}`);
      setBrowserStatusMap((m) => ({ ...m, [accountId]: st }));
    } catch {
      setBrowserStatusMap((m) => ({ ...m, [accountId]: { running: false } }));
    }
  };

  const handleOpenBrowser = async (acc: PoolAccount) => {
    await withBrowserBusy(acc.id, async () => {
      try {
        await api.post(`/api/crawler/browser?account_id=${acc.id}`, {});
        toast(`已打开「${acc.alias}」浏览器，请扫码登录`, "success");
        await refreshBrowserStatus(acc.id);
      } catch (e) {
        toast(`打开失败：${(e as Error).message}`, "error");
      }
    });
  };

  const handleCloseBrowser = async (acc: PoolAccount) => {
    await withBrowserBusy(acc.id, async () => {
      try {
        await api.delete(`/api/crawler/browser?account_id=${acc.id}`);
        toast(`已关闭「${acc.alias}」浏览器`, "success");
        await refreshBrowserStatus(acc.id);
      } catch (e) {
        toast(`关闭失败：${(e as Error).message}`, "error");
      }
    });
  };

  const handleActivate = async (acc: PoolAccount) => {
    if (acc.role !== "operation") {
      toast("辅助账号不能激活；仅在浏览器/爬虫场景中使用", "error");
      return;
    }
    try {
      await api.post(`/api/account-pool/${acc.id}/activate`, {});
      toast("已切换激活账号", "success");
      await reload();
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["items"] });
    } catch (e) {
      toast(`切换失败：${(e as Error).message}`, "error");
    }
  };

  const handleDelete = async (acc: PoolAccount) => {
    if (acc.is_active) {
      toast("无法删除当前激活账号，请先切换到其他运营账号", "error");
      return;
    }
    if (!confirm(`确认删除账号「${acc.alias}」？\n（仅标记 retired，登录态目录保留）`)) return;
    try {
      await api.delete(`/api/account-pool/${acc.id}`);
      toast("已删除", "success");
      await reload();
    } catch (e) {
      toast(`删除失败：${(e as Error).message}`, "error");
    }
  };

  if (loading) return <div className="flex-1 p-6"><Spinner /></div>;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-800">账号池</h1>
            <p className="text-sm text-zinc-500 mt-1">
              管理运营账号与辅助账号；每个账号拥有独立浏览器登录态。
            </p>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#ff2442] text-white text-sm font-medium hover:bg-[#e51d39]"
          >
            <Plus size={16} /> 新建账号
          </button>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600">
          <div className="font-medium text-zinc-800">使用建议</div>
          <div className="mt-1">1) 顶栏仅可激活运营账号；2) 辅助账号用于搜索/抓取与扫码登录。</div>
        </div>

        {items.length === 0 ? (
          <Empty message="还没有账号，点右上角新建" />
        ) : (
          <div className="grid gap-3">
            {items.map((acc) => {
              const role = ROLE_LABEL[acc.role] ?? ROLE_LABEL.operation;
              const browserStatus = browserStatusMap[acc.id] ?? { running: false };
              const browserBusy = !!browserBusyMap[acc.id];

              return (
                <div
                  key={acc.id}
                  className={`rounded-xl border p-4 bg-white ${
                    acc.is_active ? "border-[#ff2442] ring-2 ring-rose-100" : "border-zinc-200"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-zinc-800 truncate">{acc.alias}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${role.cls}`}>
                          {role.label}
                        </span>
                        {acc.is_active && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-600 border border-emerald-200 flex items-center gap-1">
                            <CheckCircle2 size={12} /> 当前激活
                          </span>
                        )}
                        {acc.status === "banned" && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-rose-100 text-rose-600 border border-rose-200 flex items-center gap-1">
                            <AlertTriangle size={12} /> 已封号
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-500 mt-1">{role.desc}</p>

                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
                        {acc.display_name && <span>名称：{acc.display_name}</span>}
                        {acc.xhs_user_id && <span title={acc.xhs_user_id}>ID：{acc.xhs_user_id.slice(0, 8)}…</span>}
                        {typeof acc.followers === "number" && <span>粉丝：{acc.followers}</span>}
                        {acc.ban_count > 0 && <span className="text-rose-500">封号次数：{acc.ban_count}</span>}
                      </div>

                      <div className="mt-2 flex items-center gap-2 text-xs">
                        {browserStatus.running ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            浏览器运行中{browserStatus.pid ? ` (PID ${browserStatus.pid})` : ""}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-zinc-500 bg-zinc-100 border border-zinc-200 px-2 py-0.5 rounded-full">
                            浏览器未运行
                          </span>
                        )}
                      </div>

                      <p className="text-[11px] text-zinc-400 mt-2 truncate" title={acc.user_data_dir}>
                        {acc.user_data_dir}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {browserStatus.running ? (
                        <button
                          onClick={() => handleCloseBrowser(acc)}
                          disabled={browserBusy}
                          className="px-3 py-1.5 rounded-lg border border-zinc-200 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 flex items-center gap-1.5"
                        >
                          {browserBusy ? <RefreshCw size={13} className="animate-spin" /> : <CircleStop size={13} />}
                          关闭浏览器
                        </button>
                      ) : (
                        <button
                          onClick={() => handleOpenBrowser(acc)}
                          disabled={browserBusy}
                          className="px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-sm text-zinc-700 disabled:opacity-50 flex items-center gap-1.5"
                        >
                          {browserBusy ? <RefreshCw size={13} className="animate-spin" /> : <Globe size={13} />}
                          打开浏览器
                        </button>
                      )}

                      {!acc.is_active && acc.status === "active" && acc.role === "operation" && (
                        <button
                          onClick={() => handleActivate(acc)}
                          className="px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-sm text-zinc-700"
                        >
                          切换为激活
                        </button>
                      )}

                      <button
                        onClick={() => setEditing(acc)}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100"
                        title="编辑账号"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => handleDelete(acc)}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-500 hover:bg-rose-50"
                        title="删除账号"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showAdd && (
        <AddAccountDialog
          onClose={() => setShowAdd(false)}
          onCreated={async () => {
            setShowAdd(false);
            await reload();
          }}
        />
      )}

      {editing && (
        <EditAccountDialog
          account={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function AddAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [alias, setAlias] = useState("");
  const [role, setRole] = useState<PoolAccount["role"]>("operation");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async () => {
    if (!alias.trim()) {
      toast("请输入账号别名", "error");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/account-pool", { alias: alias.trim(), role, notes: notes.trim() || null });
      toast("账号已创建，请在该卡片点击「打开浏览器」扫码登录", "success");
      onCreated();
    } catch (e) {
      toast(`创建失败：${(e as Error).message}`, "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-zinc-800">新建账号</h3>
        <p className="text-sm text-zinc-500 mt-1">运营账号可激活；辅助账号仅用于浏览器/爬虫。</p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-xs text-zinc-500">账号别名</label>
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="如：家居主运营号"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:border-rose-300 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-zinc-500">角色</label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {(["operation", "assistant"] as const).map((r) => {
                const meta = ROLE_LABEL[r];
                return (
                  <button
                    key={r}
                    onClick={() => setRole(r)}
                    className={`px-2 py-2 rounded-lg text-xs border flex items-center justify-center gap-1.5 ${
                      role === r
                        ? `${meta.cls} ring-2 ring-rose-200`
                        : "bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50"
                    }`}
                  >
                    {r === "operation" ? <Shield size={13} /> : <Bot size={13} />}
                    {meta.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-zinc-400 mt-1.5">{ROLE_LABEL[role].desc}</p>
          </div>
          <div>
            <label className="text-xs text-zinc-500">备注（可选）</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="如：用于关键词抓取"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:border-rose-300 focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-zinc-600 hover:bg-zinc-100">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 rounded-lg bg-[#ff2442] text-white text-sm font-medium hover:bg-[#e51d39] disabled:opacity-50"
          >
            {submitting ? "创建中…" : "创建账号"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditAccountDialog({
  account,
  onClose,
  onSaved,
}: {
  account: PoolAccount;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [alias, setAlias] = useState(account.alias);
  const [role, setRole] = useState<PoolAccount["role"]>(account.role);
  const [displayName, setDisplayName] = useState(account.display_name ?? "");
  const [xhsUserId, setXhsUserId] = useState(account.xhs_user_id ?? "");
  const [notes, setNotes] = useState(account.notes ?? "");
  const [statusVal, setStatusVal] = useState<PoolAccount["status"]>(account.status);
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async () => {
    if (!alias.trim()) {
      toast("账号别名不能为空", "error");
      return;
    }
    setSubmitting(true);
    try {
      await api.patch(`/api/account-pool/${account.id}`, {
        alias: alias.trim(),
        role,
        display_name: displayName.trim() || null,
        xhs_user_id: xhsUserId.trim() || null,
        notes: notes.trim() || null,
        status: statusVal,
      });
      toast("已保存", "success");
      onSaved();
    } catch (e) {
      toast(`保存失败：${(e as Error).message}`, "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-zinc-800">编辑账号</h3>
        <p className="text-xs text-zinc-400 mt-1 truncate" title={account.user_data_dir}>
          登录态目录：{account.user_data_dir}
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-xs text-zinc-500">账号别名</label>
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:border-rose-300 focus:outline-none"
            />
            <p className="text-[11px] text-zinc-400 mt-1">修改别名不会改动磁盘目录，仅作显示用。</p>
          </div>

          <div>
            <label className="text-xs text-zinc-500">角色</label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {(["operation", "assistant"] as const).map((r) => {
                const meta = ROLE_LABEL[r];
                return (
                  <button
                    key={r}
                    onClick={() => setRole(r)}
                    className={`px-2 py-2 rounded-lg text-xs border flex items-center justify-center gap-1.5 ${
                      role === r
                        ? `${meta.cls} ring-2 ring-rose-200`
                        : "bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50"
                    }`}
                  >
                    {r === "operation" ? <Shield size={13} /> : <Bot size={13} />}
                    {meta.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-zinc-400 mt-1.5">{ROLE_LABEL[role].desc}</p>
          </div>

          <div>
            <label className="text-xs text-zinc-500">显示名（来自小红书主页）</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="如：好圆夫妇爱宅家"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:border-rose-300 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-xs text-zinc-500">小红书用户 ID</label>
            <input
              value={xhsUserId}
              onChange={(e) => setXhsUserId(e.target.value)}
              placeholder="671ba42b..."
              className="mt-1 w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:border-rose-300 focus:outline-none font-mono"
            />
          </div>

          <div>
            <label className="text-xs text-zinc-500">状态</label>
            <select
              value={statusVal}
              onChange={(e) => setStatusVal(e.target.value as PoolAccount["status"])}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:border-rose-300 focus:outline-none"
            >
              <option value="active">正常</option>
              <option value="suspended">暂停</option>
              <option value="banned">已封禁</option>
              <option value="retired">已弃用</option>
            </select>
          </div>

          <div>
            <label className="text-xs text-zinc-500">备注</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm focus:border-rose-300 focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-zinc-600 hover:bg-zinc-100">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 rounded-lg bg-[#ff2442] text-white text-sm font-medium hover:bg-[#e51d39] disabled:opacity-50"
          >
            {submitting ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
