import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Save, KeyRound, RefreshCw, Monitor, ChevronRight, User, Trash2, RotateCcw, X } from "lucide-react";
import { api, API_BASE } from "../lib/api";
import { useToast } from "../components/Toast";
import { Spinner } from "../components/ui";
import { useHDRSetting } from "../hooks/useHDRSetting";
import { useNavigate } from "react-router-dom";
import { Item } from "../lib/types";

// ── 单独 Section 容器 ──────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-zinc-100 p-5 space-y-4">
      <h2 className="text-sm font-semibold text-zinc-700">{title}</h2>
      {children}
    </div>
  );
}

// ── 表单行 ─────────────────────────────────────────────────────────
function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-4 items-start">
      <div>
        <p className="text-sm text-zinc-700">{label}</p>
        {hint && <p className="text-xs text-zinc-400 mt-0.5">{hint}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

const inputCls = "w-full border border-zinc-200 rounded-lg px-3 py-1.5 text-sm text-zinc-800 \
focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442] bg-white";

// ══════════════════════════════════════════════════════════════════
export default function Settings() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { hdr, toggle: toggleHDR, imgStyle } = useHDRSetting();

  // ── 拉取 env 配置 ──────────────────────────────────────────────
  const { data: envData, isLoading: envLoading } = useQuery<Record<string, string>>({
    queryKey: ["settings-env"],
    queryFn: () => api.get("/api/settings/env"),
  });

  const [envForm, setEnvForm] = useState({
    MINIMAX_API_KEY: "",
    MINIMAX_BASE_URL: "",
    MINIMAX_TEXT_MODEL: "",
    MINIMAX_VISION_MODEL: "",
  });

  useEffect(() => {
    if (envData) {
      setEnvForm({
        MINIMAX_API_KEY: envData.MINIMAX_API_KEY ?? "",
        MINIMAX_BASE_URL: envData.MINIMAX_BASE_URL ?? "",
        MINIMAX_TEXT_MODEL: envData.MINIMAX_TEXT_MODEL ?? "",
        MINIMAX_VISION_MODEL: envData.MINIMAX_VISION_MODEL ?? "",
      });
    }
  }, [envData]);

  const saveEnv = useMutation({
    mutationFn: () => api.patch("/api/settings/env", envForm),
    onSuccess: () => {
      toast("API 配置已保存", "success");
      qc.invalidateQueries({ queryKey: ["settings-env"] });
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  if (envLoading) return <Spinner />;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl space-y-6">
        <h1 className="text-xl font-semibold text-zinc-900">系统设置</h1>

        {/* ── API 配置 ──────────────────────────────────────────── */}
        <Section title="API 配置">
          <Field label="MiniMax API Key" hint="Token Plan 密钥，sk-cp- 开头">
            <div className="relative">
              <KeyRound size={14} className="absolute left-3 top-2.5 text-zinc-400" />
              <input
                type="text"
                value={envForm.MINIMAX_API_KEY}
                onChange={(e) => setEnvForm((f) => ({ ...f, MINIMAX_API_KEY: e.target.value }))}
                placeholder="sk-cp-****（留空则不更新）"
                className={`${inputCls} pl-8`}
              />
            </div>
          </Field>
          <Field label="Base URL" hint="Anthropic 兼容接口">
            <input
              type="text"
              value={envForm.MINIMAX_BASE_URL}
              onChange={(e) => setEnvForm((f) => ({ ...f, MINIMAX_BASE_URL: e.target.value }))}
              className={inputCls}
            />
          </Field>
          <Field label="文本模型">
            <input
              type="text"
              value={envForm.MINIMAX_TEXT_MODEL}
              onChange={(e) => setEnvForm((f) => ({ ...f, MINIMAX_TEXT_MODEL: e.target.value }))}
              className={inputCls}
            />
          </Field>
          <Field label="视觉模型" hint="图片分析">
            <input
              type="text"
              value={envForm.MINIMAX_VISION_MODEL}
              onChange={(e) => setEnvForm((f) => ({ ...f, MINIMAX_VISION_MODEL: e.target.value }))}
              className={inputCls}
            />
          </Field>
          <div className="flex justify-end pt-1">
            <button
              onClick={() => saveEnv.mutate()}
              disabled={saveEnv.isPending}
              className="flex items-center gap-1.5 bg-[#ff2442] hover:bg-[#e01f3a] disabled:opacity-50
                         text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
            >
              {saveEnv.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
              保存 API 配置
            </button>
          </div>
        </Section>

        {/* ── 显示设置 ───────────────────────────────────────────── */}
        <Section title="显示设置">
          <Field
            label="HDR 图片显示"
            hint="开启后图片以 HDR 原色渲染；在不支持 HDR 的显示器上建议关闭，避免颜色过曝"
          >
            <div className="flex items-center gap-3">
              <button
                onClick={() => toggleHDR(!hdr)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                  hdr ? "bg-[#ff2442]" : "bg-zinc-200"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    hdr ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
              <span className="text-sm text-zinc-600">{hdr ? "开启" : "关闭（默认）"}</span>
            </div>
            {/* 实时预览 */}
            <div className="mt-3 flex items-center gap-3">
              <Monitor size={13} className="text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-400">预览效果：</span>
              <div className="relative w-16 h-10 rounded-lg overflow-hidden border border-zinc-200">
                <div className="w-full h-full bg-gradient-to-br from-orange-300 via-pink-400 to-purple-500" style={imgStyle()} />
                <span className="absolute bottom-0.5 left-0 right-0 text-center text-[9px] text-white font-medium drop-shadow">当前</span>
              </div>
            </div>
          </Field>
        </Section>

        {/* ── 账号人设（跳转入口） ───────────────────────────────── */}
        <Section title="账号人设">
          <p className="text-xs text-zinc-400 -mt-1">
            账号定位、人设简介、语气风格、禁忌词、内容策略等设置已移至「我的账号」页面统一管理。
          </p>
          <button
            onClick={() => navigate("/profile")}
            className="w-full flex items-center gap-3 p-3 rounded-xl border border-zinc-100
                       hover:border-zinc-200 hover:bg-zinc-50 transition-colors text-left group"
          >
            <div className="w-9 h-9 rounded-full bg-[#fff0f2] flex items-center justify-center shrink-0">
              <User size={16} className="text-[#ff2442]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-zinc-800">前往「我的账号」</p>
              <p className="text-xs text-zinc-400 mt-0.5">编辑人设名、语气、禁忌词、内容策略…</p>
            </div>
            <ChevronRight size={16} className="text-zinc-300 group-hover:text-zinc-500 shrink-0" />
          </button>
        </Section>

        {/* ── 回收站 ─────────────────────────────────────────────── */}
        <TrashSection />

      </div>
    </div>
  );
}

// ── 回收站 Section ─────────────────────────────────────────────────
function TrashSection() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { imgStyle } = useHDRSetting();
  const [purgeAllConfirm, setPurgeAllConfirm] = useState(false);
  const [purgingAll, setPurgingAll] = useState(false);

  const { data: trashItems = [], isLoading } = useQuery<Item[]>({
    queryKey: ["trash"],
    queryFn: () => api.get("/api/library/trash/list"),
  });

  async function restoreItem(id: number) {
    try {
      await api.post(`/api/library/trash/${id}/restore`, {});
      qc.invalidateQueries({ queryKey: ["trash"] });
      qc.invalidateQueries({ queryKey: ["items"] });
      toast("已恢复", "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    }
  }

  async function purgeItem(id: number) {
    try {
      await api.delete(`/api/library/trash/${id}/purge`);
      qc.invalidateQueries({ queryKey: ["trash"] });
      toast("已永久删除", "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    }
  }

  async function purgeAll() {
    setPurgingAll(true);
    try {
      const res = await api.delete("/api/library/trash/purge-all");
      qc.invalidateQueries({ queryKey: ["trash"] });
      toast(`已清空回收站，删除 ${res.deleted} 张图片`, "success");
      setPurgeAllConfirm(false);
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setPurgingAll(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-zinc-100 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-700">
          回收站
          {trashItems.length > 0 && (
            <span className="ml-2 text-xs font-normal text-zinc-400">{trashItems.length} 张</span>
          )}
        </h2>
        {trashItems.length > 0 && (
          !purgeAllConfirm ? (
            <button
              onClick={() => setPurgeAllConfirm(true)}
              className="text-xs text-zinc-400 hover:text-red-500 transition-colors flex items-center gap-1"
            >
              <Trash2 size={12} />
              清空回收站
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-500">确认永久删除全部？</span>
              <button
                onClick={purgeAll}
                disabled={purgingAll}
                className="text-xs bg-red-500 text-white px-2.5 py-1 rounded-lg hover:bg-red-600 disabled:opacity-50 transition-colors"
              >
                {purgingAll ? "删除中..." : "确认清空"}
              </button>
              <button onClick={() => setPurgeAllConfirm(false)} className="text-zinc-400 hover:text-zinc-600">
                <X size={14} />
              </button>
            </div>
          )
        )}
      </div>

      {isLoading ? (
        <Spinner />
      ) : trashItems.length === 0 ? (
        <p className="text-sm text-zinc-400 text-center py-6">回收站为空</p>
      ) : (
        <div className="space-y-2">
          {trashItems.map((item) => (
            <div key={item.id} className="flex items-center gap-3 p-2.5 rounded-xl border border-zinc-100 hover:bg-zinc-50 transition-colors">
              <img
                src={`${API_BASE}/api/library/${item.id}/image`}
                alt={item.title}
                style={imgStyle()}
                className="w-12 h-12 rounded-lg object-cover bg-zinc-100 shrink-0"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-800 truncate">{item.title}</p>
                <p className="text-xs text-zinc-400 mt-0.5">
                  删除于 {item.deleted_at ? new Date(item.deleted_at).toLocaleDateString("zh-CN") : "-"}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => restoreItem(item.id)}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-green-600 hover:bg-green-50 transition-colors"
                  title="恢复"
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  onClick={() => purgeItem(item.id)}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                  title="永久删除"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
