import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Save, KeyRound, RefreshCw, Monitor, ChevronRight, User,
  Trash2, RotateCcw, X, Plus, Pencil, Check, GripVertical,
  Globe, CircleStop,
} from "lucide-react";
import { api, API_BASE } from "../lib/api";
import { useToast } from "../components/Toast";
import { Spinner } from "../components/ui";
import { useHDRSetting } from "../hooks/useHDRSetting";
import { useNavigate } from "react-router-dom";
import { Item } from "../lib/types";

// ── 通用 Section 容器 ──────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-zinc-100 p-5 space-y-4">
      <h2 className="text-sm font-semibold text-zinc-700">{title}</h2>
      {children}
    </div>
  );
}

// ── 表单行 ─────────────────────────────────────────────────────────
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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

// ── 页签定义 ──────────────────────────────────────────────────────
const TABS = [
  { key: "general", label: "通用" },
  { key: "prompts", label: "提示词" },
  { key: "trash",   label: "回收站" },
] as const;
type TabKey = typeof TABS[number]["key"];

// ══════════════════════════════════════════════════════════════════
export default function Settings() {
  const [activeTab, setActiveTab] = useState<TabKey>("general");

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 页签栏 */}
      <div className="flex items-center gap-1 px-6 py-3 border-b border-zinc-100 bg-white shrink-0">
        <h1 className="text-lg font-semibold text-zinc-900 mr-4">设置</h1>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`text-sm px-3 py-1 rounded-lg transition-colors ${
              activeTab === t.key
                ? "bg-[#ff2442] text-white"
                : "text-zinc-500 hover:bg-zinc-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl space-y-6">
          {activeTab === "general" && <GeneralTab />}
          {activeTab === "prompts" && <PromptsTab />}
          {activeTab === "trash"   && <TrashSection />}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 通用页
// ══════════════════════════════════════════════════════════════════
function GeneralTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { hdr, toggle: toggleHDR, imgStyle } = useHDRSetting();

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
    <>
      {/* ── API 配置 */}
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
          <input type="text" value={envForm.MINIMAX_BASE_URL}
            onChange={(e) => setEnvForm((f) => ({ ...f, MINIMAX_BASE_URL: e.target.value }))}
            className={inputCls} />
        </Field>
        <Field label="文本模型">
          <input type="text" value={envForm.MINIMAX_TEXT_MODEL}
            onChange={(e) => setEnvForm((f) => ({ ...f, MINIMAX_TEXT_MODEL: e.target.value }))}
            className={inputCls} />
        </Field>
        <Field label="视觉模型" hint="图片分析">
          <input type="text" value={envForm.MINIMAX_VISION_MODEL}
            onChange={(e) => setEnvForm((f) => ({ ...f, MINIMAX_VISION_MODEL: e.target.value }))}
            className={inputCls} />
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

      {/* ── 显示设置 */}
      <Section title="显示设置">
        <Field label="HDR 图片显示" hint="开启后图片以 HDR 原色渲染；在不支持 HDR 的显示器上建议关闭，避免颜色过曝">
          <div className="flex items-center gap-3">
            <button
              onClick={() => toggleHDR(!hdr)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${hdr ? "bg-[#ff2442]" : "bg-zinc-200"}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${hdr ? "translate-x-6" : "translate-x-1"}`} />
            </button>
            <span className="text-sm text-zinc-600">{hdr ? "开启" : "关闭（默认）"}</span>
          </div>
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

      {/* ── 爬虫浏览器 */}
      <BrowserSection />

      {/* ── 账号人设跳转 */}
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
    </>
  );
}

// ── 爬虫浏览器 Section ────────────────────────────────────────────
function BrowserSection() {
  const { toast } = useToast();

  const { data: status, refetch } = useQuery<{ running: boolean; pid?: number }>({
    queryKey: ["browser-status"],
    queryFn: () => api.get("/api/crawler/browser"),
    refetchInterval: 3000,   // 每 3 秒轮询一次，感知浏览器被手动关闭
  });

  const open = useMutation({
    mutationFn: () => api.post("/api/crawler/browser", {}),
    onSuccess: () => { refetch(); toast("浏览器已启动", "success"); },
    onError: (e: Error) => toast(e.message, "error"),
  });

  const close = useMutation({
    mutationFn: () => api.delete("/api/crawler/browser"),
    onSuccess: () => { refetch(); toast("浏览器已关闭", "success"); },
    onError: (e: Error) => toast(e.message, "error"),
  });

  const running = status?.running ?? false;

  return (
    <Section title="爬虫浏览器">
      <p className="text-xs text-zinc-400 -mt-1">
        使用与爬虫相同的 Playwright Chromium 打开小红书，登录态共享，不影响系统其他浏览器。
      </p>
      <div className="flex items-center gap-3">
        {running ? (
          <>
            <span className="flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              运行中 {status?.pid ? `(PID ${status.pid})` : ""}
            </span>
            <button
              onClick={() => close.mutate()}
              disabled={close.isPending}
              className="flex items-center gap-1.5 text-sm border border-zinc-200 text-zinc-600 px-3 py-1.5 rounded-lg hover:bg-zinc-50 disabled:opacity-50"
            >
              <CircleStop size={13} />
              关闭浏览器
            </button>
          </>
        ) : (
          <button
            onClick={() => open.mutate()}
            disabled={open.isPending}
            className="flex items-center gap-1.5 text-sm bg-[#ff2442] text-white px-4 py-1.5 rounded-lg hover:bg-[#e01f3a] disabled:opacity-50"
          >
            {open.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Globe size={13} />}
            打开爬虫浏览器
          </button>
        )}
      </div>
      <div className="text-xs text-zinc-400 space-y-1">
        <p>登录态缓存在 <code className="bg-zinc-100 px-1 rounded text-zinc-600">browser_data/xhs_user_data_dir</code>，扫码一次后长期有效。</p>
        <p className="text-amber-600">⚠️ 导入账号时需要 xsec_token：在此浏览器里<strong>搜索</strong>目标账号名 → 从搜索结果点进主页 → 地址栏会自动带上 token → 再复制 URL。</p>
      </div>
    </Section>
  );
}

// ══════════════════════════════════════════════════════════════════
// 提示词页
// ══════════════════════════════════════════════════════════════════
interface PromptConfig {
  key: string;
  label: string;
  prompt: string;
  sort_order: number;
  enabled: number;
}

function PromptsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: prompts = [], isLoading } = useQuery<PromptConfig[]>({
    queryKey: ["settings-prompts"],
    queryFn: () => api.get("/api/settings/prompts"),
  });

  // 弹窗状态：null = 关闭，"new" = 新增，string = 编辑中的 key
  const [modalMode, setModalMode] = useState<null | "new" | string>(null);
  const [form, setForm] = useState({ label: "", prompt: "" });
  const [saving, setSaving] = useState(false);

  function openNew() {
    setForm({ label: "", prompt: "" });
    setModalMode("new");
  }

  function openEdit(p: PromptConfig) {
    setForm({ label: p.label, prompt: p.prompt });
    setModalMode(p.key);
  }

  function closeModal() {
    setModalMode(null);
  }

  async function saveModal() {
    if (!form.label.trim() || !form.prompt.trim()) return;
    setSaving(true);
    try {
      if (modalMode === "new") {
        const key = `custom_${Date.now()}`;
        await api.post("/api/settings/prompts", {
          key,
          label: form.label,
          prompt: form.prompt,
          sort_order: prompts.length,
          enabled: true,
        });
        toast("已添加", "success");
      } else {
        await api.put(`/api/settings/prompts/${modalMode}`, form);
        toast("已保存", "success");
      }
      qc.invalidateQueries({ queryKey: ["settings-prompts"] });
      qc.invalidateQueries({ queryKey: ["quick-actions"] });
      closeModal();
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(p: PromptConfig) {
    try {
      await api.put(`/api/settings/prompts/${p.key}`, { enabled: p.enabled ? 0 : 1 });
      qc.invalidateQueries({ queryKey: ["settings-prompts"] });
      qc.invalidateQueries({ queryKey: ["quick-actions"] });
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    }
  }

  async function deletePrompt(key: string) {
    try {
      await api.delete(`/api/settings/prompts/${key}`);
      qc.invalidateQueries({ queryKey: ["settings-prompts"] });
      qc.invalidateQueries({ queryKey: ["quick-actions"] });
      toast("已删除", "success");
    } catch (e: unknown) {
      toast((e as Error).message, "error");
    }
  }

  if (isLoading) return <Spinner />;

  return (
    <>
      <div className="space-y-4">
        <div className="bg-white rounded-2xl border border-zinc-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-700">AI 快捷操作</h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                在笔记编辑页 AI 助手面板中显示，点击即可发送对应 prompt
              </p>
            </div>
            <button
              onClick={openNew}
              className="flex items-center gap-1 text-xs text-[#ff2442] hover:text-[#e01f3a] transition-colors"
            >
              <Plus size={13} />
              新增
            </button>
          </div>

          <div className="space-y-2">
            {prompts.map((p) => (
              <div key={p.key} className="rounded-xl border border-zinc-100 hover:border-zinc-200 transition-colors">
                <div className="flex items-start gap-2 p-3">
                  <GripVertical size={14} className="text-zinc-200 mt-0.5 shrink-0 cursor-grab" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        p.enabled ? "bg-[#ff2442]/10 text-[#ff2442]" : "bg-zinc-100 text-zinc-400"
                      }`}>{p.label}</span>
                      {!p.enabled && <span className="text-[10px] text-zinc-300">已禁用</span>}
                    </div>
                    <p className="text-xs text-zinc-500 leading-relaxed line-clamp-2 font-mono">{p.prompt}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => toggleEnabled(p)}
                      className={`w-8 h-4 rounded-full transition-colors relative ${p.enabled ? "bg-[#ff2442]" : "bg-zinc-200"}`}
                      title={p.enabled ? "点击禁用" : "点击启用"}
                    >
                      <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${p.enabled ? "right-0.5" : "left-0.5"}`} />
                    </button>
                    <button onClick={() => openEdit(p)} className="p-1.5 text-zinc-300 hover:text-zinc-600 rounded-lg hover:bg-zinc-100 transition-colors" title="编辑">
                      <Pencil size={12} />
                    </button>
                    <button onClick={() => deletePrompt(p.key)} className="p-1.5 text-zinc-300 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors" title="删除">
                      <X size={12} />
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {prompts.length === 0 && (
              <p className="text-sm text-zinc-400 text-center py-6">暂无快捷操作，点击「新增」添加</p>
            )}
          </div>
        </div>

        {/* 说明 */}
        <div className="bg-zinc-50 rounded-xl border border-zinc-100 p-4 text-xs text-zinc-500 space-y-1 leading-relaxed">
          <p className="font-medium text-zinc-600">提示词配置说明</p>
          <p>• 快捷操作按钮会显示在笔记编辑页 AI 助手面板的首屏，点击即发送。</p>
          <p>• Prompt 中可使用当前笔记标题/正文作为上下文，AI 会自动获取。</p>
          <p>• 建议「生成标题」类 prompt 末尾注明格式（如：每行一个，编号列出），方便 AI 输出结构化结果供快速使用。</p>
        </div>
      </div>

      {/* 编辑 / 新增弹窗 */}
      {modalMode !== null && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={closeModal}>
          <div
            className="bg-white rounded-2xl w-full max-w-lg shadow-xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100">
              <span className="font-semibold text-zinc-800 text-sm">
                {modalMode === "new" ? "新增快捷操作" : "编辑快捷操作"}
              </span>
              <button onClick={closeModal} className="text-zinc-400 hover:text-zinc-700 transition-colors">
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-zinc-500 block mb-1.5">按钮名称</label>
                <input
                  type="text"
                  value={form.label}
                  onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="如：生成标题、改写开头"
                  autoFocus
                  className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442]"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-500 block mb-1.5">Prompt 内容</label>
                <textarea
                  value={form.prompt}
                  onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
                  placeholder="输入发送给 AI 的指令..."
                  rows={12}
                  className="w-full border border-zinc-200 rounded-lg px-3 py-2.5 text-sm text-zinc-700
                             focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442]
                             resize-none leading-relaxed font-mono"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-zinc-100">
              <button
                onClick={closeModal}
                className="text-xs text-zinc-400 hover:text-zinc-600 px-4 py-2 rounded-lg hover:bg-zinc-100 transition-colors"
              >
                取消
              </button>
              <button
                onClick={saveModal}
                disabled={saving || !form.label.trim() || !form.prompt.trim()}
                className="flex items-center gap-1.5 text-xs bg-[#ff2442] text-white px-4 py-2 rounded-lg hover:bg-[#e01f3a] disabled:opacity-50 transition-colors"
              >
                <Check size={11} />
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ══════════════════════════════════════════════════════════════════
// 回收站
// ══════════════════════════════════════════════════════════════════
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
            <button onClick={() => setPurgeAllConfirm(true)} className="text-xs text-zinc-400 hover:text-red-500 transition-colors flex items-center gap-1">
              <Trash2 size={12} />清空回收站
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-500">确认永久删除全部？</span>
              <button onClick={purgeAll} disabled={purgingAll}
                className="text-xs bg-red-500 text-white px-2.5 py-1 rounded-lg hover:bg-red-600 disabled:opacity-50 transition-colors">
                {purgingAll ? "删除中..." : "确认清空"}
              </button>
              <button onClick={() => setPurgeAllConfirm(false)} className="text-zinc-400 hover:text-zinc-600"><X size={14} /></button>
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
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-800 truncate">{item.title}</p>
                <p className="text-xs text-zinc-400 mt-0.5">
                  删除于 {item.deleted_at ? new Date(item.deleted_at).toLocaleDateString("zh-CN") : "-"}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button onClick={() => restoreItem(item.id)} className="p-1.5 rounded-lg text-zinc-400 hover:text-green-600 hover:bg-green-50 transition-colors" title="恢复">
                  <RotateCcw size={14} />
                </button>
                <button onClick={() => purgeItem(item.id)} className="p-1.5 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-50 transition-colors" title="永久删除">
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
