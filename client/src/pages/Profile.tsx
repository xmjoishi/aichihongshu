import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, riskAckHeader } from "../lib/api";
import { Profile as ProfileType } from "../lib/types";
import { Spinner } from "../components/ui";
import {
  Pencil, Save, RefreshCw, Sparkles, MapPin,
  Users, Heart, MessageCircle, Bookmark, Edit3,
} from "lucide-react";
import AIPanel from "../components/AIPanel";
import { useToast } from "../components/Toast";
import { useRiskConfirm } from "../components/useRiskConfirm";

// ── 工具函数 ──────────────────────────────────────────────────────
function toArray(s: string): string[] {
  return s.split(/[\n,，]/).map((t) => t.trim()).filter(Boolean);
}
function toText(arr?: string[]): string {
  return (arr ?? []).join("\n");
}
function fmtNum(n?: number): string {
  if (n == null) return "0";
  if (n >= 10000) return (n / 10000).toFixed(1) + "w";
  return String(n);
}

// ── 通用展示组件 ──────────────────────────────────────────────────
function Field({ label, value }: { label: string; value?: string | number }) {
  if (!value && value !== 0) return null;
  return (
    <div className="mb-3">
      <p className="text-xs text-zinc-400 mb-0.5">{label}</p>
      <p className="text-sm text-zinc-800 leading-relaxed whitespace-pre-wrap">{value}</p>
    </div>
  );
}

function Chips({ label, items }: { label: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="mb-3">
      <p className="text-xs text-zinc-400 mb-1">{label}</p>
      <div className="flex flex-wrap gap-1">
        {items.map((t) => (
          <span key={t} className="text-xs bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded-full">{t}</span>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl p-5 border border-zinc-100">
      <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">{title}</h2>
      {children}
    </div>
  );
}

// ── 小红书名片 ────────────────────────────────────────────────────
function StatItem({ icon, label, value, small }: {
  icon: React.ReactNode; label: string; value: string; small?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center gap-0.5 ${small ? "min-w-[36px]" : "min-w-[44px]"}`}>
      <span className={`font-semibold text-zinc-800 ${small ? "text-xs" : "text-sm"}`}>{value}</span>
      <span className="flex items-center gap-0.5 text-[10px] text-zinc-400">{icon}{label}</span>
    </div>
  );
}

function XhsProfileCard({ profile, onRefresh, refreshing }: {
  profile: ProfileType; onRefresh: () => void; refreshing: boolean;
}) {
  const name = profile.display_name || profile.persona_name || "未命名账号";
  const avatarLetter = name.charAt(0).toUpperCase();

  return (
    <div className="bg-white rounded-2xl border border-zinc-100 overflow-hidden shadow-sm">
      {/* 封面 */}
      <div className="h-20 bg-gradient-to-r from-[#ff2442] to-[#ff8fa3]" />

      <div className="px-5 pb-5">
        {/* 头像行 */}
        <div className="flex items-end justify-between -mt-8 mb-3">
          <div className="w-16 h-16 rounded-full border-2 border-white shadow-md overflow-hidden flex-shrink-0 bg-[#ff2442]">
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt={name}
                className="w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-white text-xl font-bold">
                {avatarLetter}
              </div>
            )}
          </div>
          <div className="relative group">
            <button onClick={onRefresh} disabled={refreshing}
              className="flex items-center gap-1.5 text-xs border border-zinc-200 px-3 py-1.5
                         rounded-full text-zinc-500 hover:bg-zinc-50 hover:border-zinc-300
                         disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "抓取中..." : "同步小红书"}
            </button>
            {/* Tooltip */}
            <div className="absolute right-0 top-full mt-2 w-56 bg-zinc-800 text-white text-xs rounded-xl px-3 py-2 leading-relaxed
                            opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 z-50 shadow-lg">
              <p className="font-medium mb-0.5">🕷️ 重新爬取小红书主页</p>
              <p className="text-zinc-300">调用爬虫抓取最新粉丝数、简介、笔记互动数据，并同步到本地数据库。需要浏览器已登录。</p>
            </div>
          </div>
        </div>

        {/* 姓名 + IP */}
        <div className="flex items-start justify-between gap-2 mb-1">
          <div>
            <h3 className="text-base font-bold text-zinc-900">{name}</h3>
            {profile.account_id && (
              <p className="text-xs text-zinc-400 font-mono select-all">账号 ID：{profile.account_id}</p>
            )}
          </div>
          {profile.ip_location && (
            <span className="flex items-center gap-0.5 text-xs text-zinc-400 flex-shrink-0 mt-0.5">
              <MapPin size={11} />{profile.ip_location}
            </span>
          )}
        </div>

        {/* 账号标签 */}
        {(profile.xhs_tags ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {profile.xhs_tags.map((tag) => (
              <span key={tag} className="text-xs bg-[#fff0f2] text-[#ff2442] px-2 py-0.5 rounded-full">
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* 简介 */}
        {(profile.xhs_bio || profile.persona_bio) && (
          <p className="text-sm text-zinc-600 leading-relaxed mb-3 whitespace-pre-wrap">
            {profile.xhs_bio || profile.persona_bio}
          </p>
        )}

        {/* 数据栏 */}
        <div className="pt-3 border-t border-zinc-50 space-y-2">
          <div className="flex items-center gap-4">
            <StatItem icon={<Users size={13} />} label="粉丝" value={fmtNum(profile.followers)} />
            <StatItem icon={<Users size={13} />} label="关注" value={fmtNum(profile.xhs_follows)} />
            <StatItem icon={null} label="笔记" value={fmtNum(profile.total_notes)} />
            <div className="flex-1" />
            <StatItem icon={<Heart size={13} className="text-[#ff2442]" />} label="总获赞" value={fmtNum(profile.total_likes)} small />
            <StatItem icon={<Bookmark size={13} className="text-amber-400" />} label="总收藏" value={fmtNum(profile.total_collects)} small />
          </div>
          <div className="flex items-center justify-end gap-4">
            <StatItem icon={<Heart size={13} className="text-[#ff2442]" />} label="均赞" value={fmtNum(profile.avg_likes)} small />
            <StatItem icon={<MessageCircle size={13} className="text-zinc-400" />} label="均评" value={fmtNum(profile.avg_comments)} small />
            <StatItem icon={<Bookmark size={13} className="text-amber-400" />} label="均藏" value={fmtNum(profile.avg_collects)} small />
          </div>
        </div>

        {profile.crawled_at && (
          <p className="text-xs text-zinc-300 mt-2 text-right">
            数据更新于 {profile.crawled_at.slice(0, 16)}
          </p>
        )}
      </div>
    </div>
  );
}

// ── 编辑表单样式 ──────────────────────────────────────────────────
const inputCls =
  "w-full border border-zinc-200 rounded-lg px-3 py-1.5 text-sm text-zinc-800 " +
  "focus:outline-none focus:ring-2 focus:ring-[#ff2442]/30 focus:border-[#ff2442] bg-white";
const textareaCls = `${inputCls} resize-y`;

interface EditForm {
  account_id: string;
  display_name: string;
  niche: string;
  target_audience: string;
  persona_name: string;
  persona_bio: string;
  persona_tone: string;
  followers: string;
  posting_rhythm: string;
  content_pillars: string;
  persona_taboos: string;
  preferred_styles: string;
  preferred_scenes: string;
  hashtag_pool: string;
}

function profileToForm(p: ProfileType): EditForm {
  return {
    account_id: p.account_id ?? "",
    display_name: p.display_name ?? "",
    niche: p.niche ?? "",
    target_audience: p.target_audience ?? "",
    persona_name: p.persona_name ?? "",
    persona_bio: p.persona_bio ?? "",
    persona_tone: p.persona_tone ?? "",
    followers: String(p.followers ?? ""),
    posting_rhythm: p.posting_rhythm ?? "",
    content_pillars: toText(p.content_pillars),
    persona_taboos: toText(p.persona_taboos),
    preferred_styles: toText(p.preferred_styles),
    preferred_scenes: toText(p.preferred_scenes),
    hashtag_pool: toText(p.hashtag_pool),
  };
}

function EditField({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <label className="text-xs font-medium text-zinc-600 block mb-1">
        {label}
        {hint && <span className="text-zinc-400 font-normal ml-1">({hint})</span>}
      </label>
      {children}
    </div>
  );
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl p-5 border border-zinc-100">
      <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">{title}</h2>
      {children}
    </div>
  );
}

// ── Tab 组件 ──────────────────────────────────────────────────────
type TabId = "account" | "persona";

function Tabs({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }) {
  return (
    <div className="flex border-b border-zinc-100 bg-white px-6">
      {([ 
        { id: "account" as TabId, label: "账号信息" },
        { id: "persona" as TabId, label: "人设信息" },
      ]).map(({ id, label }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors -mb-px ${
            active === id
              ? "border-[#ff2442] text-[#ff2442]"
              : "border-transparent text-zinc-500 hover:text-zinc-700"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
export default function ProfilePage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { confirmAndRetry, dialog: riskDialog } = useRiskConfirm();
  const [activeTab, setActiveTab] = useState<TabId>("account");
  const [editing, setEditing] = useState(false);
  const [showAI, setShowAI] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const focusedFieldRef = useRef<keyof EditForm | null>(null);

  const { data: profile, isLoading } = useQuery<ProfileType>({
    queryKey: ["profile"],
    queryFn: () => api.get("/api/profile"),
  });

  const { data: activeStatus } = useQuery<{ active?: { alias?: string; display_name?: string } | null }>({
    queryKey: ["account-pool", "protection"],
    queryFn: () => api.get("/api/account-pool/protection/status"),
  });

  // 刷新爬虫轮询
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!refreshing) return;
    const timer = setInterval(async () => {
      try {
        const status = await api.get("/api/profile/refresh-status");
        if (!status.running) {
          setRefreshing(false);
          clearInterval(timer);
          if (status.last_error) {
            toast(`刷新失败：${status.last_error}`, "error");
          } else {
            toast("账号数据已更新", "success");
            qc.invalidateQueries({ queryKey: ["profile"] });
          }
        }
      } catch {
        setRefreshing(false);
        clearInterval(timer);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [refreshing, qc, toast]);

  async function handleRefresh() {
    try {
      await confirmAndRetry((ack) => api.post("/api/profile/refresh", {}, riskAckHeader(ack)));
      setRefreshing(true);
      toast("正在抓取小红书主页数据，请稍候...", "info");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast(msg || "启动刷新失败", "error");
    }
  }

  useEffect(() => {
    if (editing && profile) setForm(profileToForm(profile));
  }, [editing, profile]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!form) throw new Error("no form");
      return api.patch("/api/profile", {
        account_id: form.account_id || undefined,
        display_name: form.display_name || undefined,
        niche: form.niche || undefined,
        target_audience: form.target_audience || undefined,
        persona_name: form.persona_name || undefined,
        persona_bio: form.persona_bio || undefined,
        persona_tone: form.persona_tone || undefined,
        followers: form.followers ? Number(form.followers) : undefined,
        posting_rhythm: form.posting_rhythm || undefined,
        content_pillars: toArray(form.content_pillars),
        persona_taboos: toArray(form.persona_taboos),
        preferred_styles: toArray(form.preferred_styles),
        preferred_scenes: toArray(form.preferred_scenes),
        hashtag_pool: toArray(form.hashtag_pool),
      });
    },
    onSuccess: () => {
      toast("已保存", "success");
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["analytics"] });
      setEditing(false);
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  function handleAIApply(text: string) {
    if (!form) return;
    const field = focusedFieldRef.current ?? "persona_bio";
    setForm((f) => f ? { ...f, [field]: f[field] ? f[field] + "\n" + text : text } : f);
    toast(`已插入到「${field}」`, "info");
  }

  function setField(key: keyof EditForm, val: string) {
    setForm((f) => f ? { ...f, [key]: val } : f);
  }

  if (isLoading) return <Spinner />;

  if (!profile) return (
    <div className="p-6 text-zinc-400 text-sm">
      尚未初始化账号，请运行：<br />
      <code className="bg-zinc-100 px-2 py-0.5 rounded mt-1 inline-block text-zinc-600">
        uv run python app/cli.py profile init --url "..."
      </code>
    </div>
  );

  // ══ 只读视图 ══════════════════════════════════════════════════
  if (!editing) {
    const activeName = activeStatus?.active?.display_name || activeStatus?.active?.alias || "未激活";
    return (
      <div className="flex flex-col h-full">
        {/* 顶部标题栏 */}
        <div className="flex items-center px-6 py-4 border-b border-zinc-100 bg-white shrink-0">
          <h1 className="text-lg font-semibold text-zinc-900">我的账号</h1>
          <span className="ml-3 text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">
            当前账号：{activeName}
          </span>
          <span className="text-xs text-zinc-400 ml-3">更新 {profile.updated_at?.slice(0, 10)}</span>
          <button
            onClick={() => setEditing(true)}
            className="ml-auto flex items-center gap-1.5 text-sm border border-zinc-200
                       px-3 py-1.5 rounded-lg hover:bg-zinc-50 text-zinc-600 transition-colors"
          >
            <Pencil size={13} />
            编辑
          </button>
        </div>

        {/* Tab 切换 */}
        <Tabs active={activeTab} onChange={setActiveTab} />

        {/* Tab 内容 */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-lg space-y-4">

            {activeTab === "account" && (
              <>
                {/* 小红书名片 */}
                <XhsProfileCard profile={profile} onRefresh={handleRefresh} refreshing={refreshing} />
              </>
            )}

            {activeTab === "persona" && (
              <>
                {/* 人设核心 */}
                <Section title="人设设定">
                  <Field label="人设名" value={profile.persona_name} />
                  <Field label="人设简介" value={profile.persona_bio} />
                  <Field label="语气风格" value={profile.persona_tone} />
                  <Field label="发帖节奏" value={profile.posting_rhythm} />
                  <Chips label="禁忌词" items={profile.persona_taboos} />
                </Section>

                {/* 内容策略 */}
                <Section title="内容策略">
                  <Field label="垂类定位" value={profile.niche} />
                  <Field label="目标受众" value={profile.target_audience} />
                  <Chips label="内容支柱" items={profile.content_pillars} />
                  <Chips label="偏好风格" items={profile.preferred_styles} />
                  <Chips label="偏好场景" items={profile.preferred_scenes} />
                  <Chips label="常用标签池" items={profile.hashtag_pool} />
                </Section>
              </>
            )}

          </div>
        </div>
      </div>
    );
  }

  // ══ 编辑视图 ══════════════════════════════════════════════════
  if (!form) return <Spinner />;

  return (
    <div className="flex h-full">
      {riskDialog}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 工具栏 */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-zinc-100 bg-white shrink-0">
          <button
            onClick={() => { setEditing(false); setShowAI(false); }}
            className="text-zinc-400 hover:text-zinc-700 text-sm"
          >
            ← 取消
          </button>
          <span className="text-sm font-semibold text-zinc-700 ml-1">编辑账号</span>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => setShowAI((v) => !v)}
              className={`flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-lg transition-colors ${
                showAI
                  ? "bg-[#fff0f2] border-[#ff2442] text-[#ff2442]"
                  : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
              }`}
            >
              <Sparkles size={13} />
              AI 助手
            </button>
            <button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="flex items-center gap-1.5 text-xs bg-[#ff2442] text-white
                         px-3 py-1.5 rounded-lg hover:bg-[#e01f3a] disabled:opacity-50 transition-colors"
            >
              {saveMutation.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
              保存
            </button>
          </div>
        </div>

        {/* Tab 切换（编辑态） */}
        <Tabs active={activeTab} onChange={setActiveTab} />

        {/* 表单内容 */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-lg space-y-6">

            {/* ── 账号信息 Tab ── */}
            {activeTab === "account" && (
              <>
                <FormSection title="账号信息">
                  <p className="text-xs text-zinc-400 mb-4">
                    账号 ID 是小红书系统分配的十六进制用户 ID（非小红书号），用于爬虫同步。
                    头像、简介、粉丝数等字段由爬虫自动同步，切换到「账号信息」只读视图后点击「同步小红书」更新。
                  </p>
                  <EditField label="账号 ID" hint="小红书系统 ID，非小红书号">
                    <input type="text" value={form.account_id ?? ""}
                      onChange={(e) => setField("account_id", e.target.value)}
                      placeholder="671ba42b000000001d033de2"
                      className={inputCls} />
                  </EditField>
                </FormSection>

                <div className="flex items-center gap-2 p-4 bg-zinc-50 rounded-xl border border-zinc-100">
                  <Edit3 size={14} className="text-zinc-400 shrink-0" />
                  <p className="text-xs text-zinc-500">
                    发帖节奏、垂类定位等运营策略字段在「人设信息」标签页中编辑。
                  </p>
                </div>
              </>
            )}

            {/* ── 人设信息 Tab ── */}
            {activeTab === "persona" && (
              <>
                <FormSection title="人设设定">
                  <p className="text-xs text-zinc-400 mb-4">
                    用于生成笔记标题、正文和内容方向，不直接展示在小红书页面。
                  </p>
                  <EditField label="人设名" hint="昵称/角色名，可与账号显示名不同">
                    <input type="text" value={form.persona_name}
                      onFocus={() => { focusedFieldRef.current = "persona_name"; }}
                      onChange={(e) => setField("persona_name", e.target.value)}
                      className={inputCls} />
                  </EditField>
                  <EditField label="人设简介" hint="50字以内，一句话描述角色定位">
                    <textarea rows={3} value={form.persona_bio}
                      onFocus={() => { focusedFieldRef.current = "persona_bio"; }}
                      onChange={(e) => setField("persona_bio", e.target.value)}
                      className={textareaCls} />
                  </EditField>
                  <EditField label="语气风格" hint="例：嘴硬傲娇，短句换行，先吐槽再给结论">
                    <textarea rows={3} value={form.persona_tone}
                      onFocus={() => { focusedFieldRef.current = "persona_tone"; }}
                      onChange={(e) => setField("persona_tone", e.target.value)}
                      className={textareaCls} />
                  </EditField>
                  <EditField label="禁忌词" hint="每行一个，绝对不出现在笔记中">
                    <textarea rows={4} value={form.persona_taboos}
                      onFocus={() => { focusedFieldRef.current = "persona_taboos"; }}
                      onChange={(e) => setField("persona_taboos", e.target.value)}
                      className={textareaCls} placeholder={"精致\n高品质\n高级感\n氛围感"} />
                  </EditField>
                </FormSection>

                <FormSection title="内容策略">
                  <EditField label="垂类定位" hint="例：家居软装/出租屋改造">
                    <input type="text" value={form.niche}
                      onFocus={() => { focusedFieldRef.current = "niche"; }}
                      onChange={(e) => setField("niche", e.target.value)}
                      className={inputCls} />
                  </EditField>
                  <EditField label="目标受众">
                    <input type="text" value={form.target_audience}
                      onFocus={() => { focusedFieldRef.current = "target_audience"; }}
                      onChange={(e) => setField("target_audience", e.target.value)}
                      className={inputCls} />
                  </EditField>
                  <EditField label="内容支柱" hint="每行一个">
                    <textarea rows={3} value={form.content_pillars}
                      onFocus={() => { focusedFieldRef.current = "content_pillars"; }}
                      onChange={(e) => setField("content_pillars", e.target.value)}
                      className={textareaCls} placeholder={"出租屋改造\n家居好物分享\n软装搭配教程"} />
                  </EditField>
                  <EditField label="偏好风格" hint="每行一个">
                    <textarea rows={3} value={form.preferred_styles}
                      onFocus={() => { focusedFieldRef.current = "preferred_styles"; }}
                      onChange={(e) => setField("preferred_styles", e.target.value)}
                      className={textareaCls} />
                  </EditField>
                  <EditField label="偏好场景" hint="每行一个">
                    <textarea rows={3} value={form.preferred_scenes}
                      onFocus={() => { focusedFieldRef.current = "preferred_scenes"; }}
                      onChange={(e) => setField("preferred_scenes", e.target.value)}
                      className={textareaCls} />
                  </EditField>
                  <EditField label="常用标签池" hint="每行一个，以 # 开头或不加均可">
                    <textarea rows={5} value={form.hashtag_pool}
                      onFocus={() => { focusedFieldRef.current = "hashtag_pool"; }}
                      onChange={(e) => setField("hashtag_pool", e.target.value)}
                      className={textareaCls} placeholder={"家居好物\n出租屋改造\n软装搭配"} />
                  </EditField>
                </FormSection>
              </>
            )}

          </div>
        </div>
      </div>

      {/* AI 面板 */}
      {showAI && (
        <AIPanel
          systemExtra="当前任务：帮助优化或生成账号人设内容，包括人设简介、语气风格、禁忌词、标签池等。"
          onApply={handleAIApply}
          onClose={() => setShowAI(false)}
        />
      )}
    </div>
  );
}
