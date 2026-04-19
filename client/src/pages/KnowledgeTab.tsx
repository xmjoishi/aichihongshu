import { useState, useEffect } from "react";
import {
  BarChart2, BookOpen, Users, Lightbulb,
  ToggleLeft, ToggleRight, Trash2, Plus,
  ChevronDown, ChevronUp, ExternalLink,
  Sparkles, Check,
} from "lucide-react";
import { api, openInChromium } from "../lib/api";
import type {
  KnowledgeRule, KnowledgeMySample,
  KnowledgeRefGroup, KnowledgeInspiration,
} from "../lib/types";

// ─── 分区容器 ─────────────────────────────────────────────────────────────────

function Section({
  icon: Icon, title, badge, children, defaultOpen = true,
}: {
  icon: React.ElementType;
  title: string;
  badge?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white rounded-2xl border border-zinc-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-zinc-50 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Icon size={15} className="text-[#ff2442]" />
          <span className="text-sm font-semibold text-zinc-800">{title}</span>
          {badge && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#ff2442]/10 text-[#ff2442] font-medium">
              {badge}
            </span>
          )}
        </div>
        {open ? <ChevronUp size={14} className="text-zinc-400" /> : <ChevronDown size={14} className="text-zinc-400" />}
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  );
}

// ─── 分区1：互动规律 ──────────────────────────────────────────────────────────

function RulesSection() {
  const [rules, setRules] = useState<KnowledgeRule[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/api/knowledge/rules").then((data) => {
      setRules(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  async function toggle(key: string, enabled: boolean) {
    await api.patch(`/api/knowledge/rules/${key}`, { enabled });
    setRules((prev) => prev.map((r) => r.key === key ? { ...r, enabled } : r));
  }

  const enabledCount = rules.filter((r) => r.enabled).length;

  if (loading) return <p className="text-xs text-zinc-400 py-4 text-center">加载中…</p>;
  if (!rules.length) return (
    <p className="text-xs text-zinc-400 py-4 text-center">
      暂无规律数据，发布更多笔记并录入互动数据后自动生成
    </p>
  );

  return (
    <Section icon={BarChart2} title="互动规律" badge={`${enabledCount} 条启用`}>
      <p className="text-xs text-zinc-400 mb-3">启用的规律会在生成笔记时自动注入 prompt</p>
      <div className="space-y-2">
        {rules.map((rule) => (
          <div key={rule.key}
            className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl border transition-colors
              ${rule.enabled ? "border-[#ff2442]/20 bg-[#ff2442]/5" : "border-zinc-100 bg-zinc-50"}`}
          >
            <div>
              <span className="text-[10px] text-zinc-400 font-medium uppercase tracking-wide">{rule.label}</span>
              <p className="text-xs text-zinc-700 mt-0.5">{rule.desc}</p>
            </div>
            <button
              onClick={() => toggle(rule.key, !rule.enabled)}
              className="shrink-0 ml-3 transition-colors"
              title={rule.enabled ? "点击停用" : "点击启用"}
            >
              {rule.enabled
                ? <ToggleRight size={22} className="text-[#ff2442]" />
                : <ToggleLeft size={22} className="text-zinc-300" />}
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ─── 分区2：我的高赞样本 ──────────────────────────────────────────────────────

function MySamplesSection() {
  const [samples, setSamples] = useState<KnowledgeMySample[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/api/knowledge/my-samples").then((data) => {
      setSamples(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  async function toggle(id: number, use: boolean) {
    await api.patch(`/api/knowledge/my-samples/${id}`, { use_as_reference: use });
    setSamples((prev) => prev.map((s) => s.id === id ? { ...s, use_as_reference: use } : s));
  }

  const selectedCount = samples.filter((s) => s.use_as_reference).length;

  if (loading) return <p className="text-xs text-zinc-400 py-4 text-center">加载中…</p>;
  if (!samples.length) return (
    <p className="text-xs text-zinc-400 py-4 text-center">
      暂无已发布笔记，发布并录入互动数据后在此管理参考样本
    </p>
  );

  return (
    <Section icon={BookOpen} title="我的高赞样本" badge={selectedCount ? `已选 ${selectedCount} 篇` : undefined}>
      <p className="text-xs text-zinc-400 mb-3">勾选后生成笔记时 AI 会模仿这些笔记的语气和结构</p>
      <div className="space-y-2">
        {samples.map((s) => (
          <div key={s.id}
            className={`flex items-start gap-3 px-3.5 py-3 rounded-xl border transition-colors cursor-pointer
              ${s.use_as_reference ? "border-[#ff2442]/20 bg-[#ff2442]/5" : "border-zinc-100 hover:border-zinc-200"}`}
            onClick={() => toggle(s.id, !s.use_as_reference)}
          >
            {/* 勾选状态 */}
            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 transition-colors
              ${s.use_as_reference ? "border-[#ff2442] bg-[#ff2442]" : "border-zinc-300"}`}>
              {s.use_as_reference && <Check size={9} className="text-white" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-zinc-800 truncate">{s.title || "无标题"}</span>
                <span className="text-[10px] text-rose-500 shrink-0">赞 {s.likes}</span>
              </div>
              {s.body_preview && (
                <p className="text-[11px] text-zinc-400 mt-0.5 line-clamp-2">{s.body_preview}…</p>
              )}
            </div>
            {s.note_url && (
              <button onClick={(e) => { e.stopPropagation(); openInChromium(s.note_url!); }}
                className="shrink-0 text-zinc-300 hover:text-[#ff2442] transition-colors mt-0.5">
                <ExternalLink size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

// ─── 分区3：榜样笔记样本 ──────────────────────────────────────────────────────

function RefSamplesSection() {
  const [groups, setGroups] = useState<KnowledgeRefGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanding, setExpanding] = useState<string | null>(null);

  useEffect(() => {
    api.get("/api/knowledge/ref-samples").then((data) => {
      setGroups(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  async function remove(accountId: string, idx: number) {
    await api.delete(`/api/knowledge/ref-samples/${accountId}/${idx}`);
    setGroups((prev) => prev.map((g) => {
      if (g.account_id !== accountId) return g;
      const notes = [...g.notes];
      notes.splice(idx, 1);
      return { ...g, notes };
    }).filter((g) => g.notes.length > 0));
  }

  const totalCount = groups.reduce((s, g) => s + g.notes.length, 0);

  if (loading) return <p className="text-xs text-zinc-400 py-4 text-center">加载中…</p>;
  if (!groups.length) return (
    <p className="text-xs text-zinc-400 py-4 text-center">
      暂无榜样笔记样本，在「榜样」页账号详情中点击「加入参考库」添加
    </p>
  );

  return (
    <Section icon={Users} title="榜样笔记样本" badge={totalCount ? `${totalCount} 条` : undefined}>
      <p className="text-xs text-zinc-400 mb-3">生成笔记时 AI 会参考这些榜样的表达方式</p>
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.account_id}>
            <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide mb-1.5">
              @{group.name}
            </p>
            <div className="space-y-1.5">
              {group.notes.map((note, idx) => {
                const expKey = `${group.account_id}-${idx}`;
                const isExpanded = expanding === expKey;
                return (
                  <div key={idx} className="border border-zinc-100 rounded-xl overflow-hidden">
                    <div className="flex items-start gap-2 px-3.5 py-2.5">
                      <div className="flex-1 min-w-0">
                        <span className="text-xs text-zinc-700 font-medium">{note.title}</span>
                        <span className="ml-2 text-[10px] text-rose-400">赞 {note.likes}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {note.body && (
                          <button
                            onClick={() => setExpanding(isExpanded ? null : expKey)}
                            className="text-[10px] text-zinc-400 hover:text-zinc-600 transition-colors"
                          >
                            {isExpanded ? "收起" : "正文"}
                          </button>
                        )}
                        {note.note_url && (
                          <button onClick={() => openInChromium(note.note_url!)}
                            className="text-zinc-300 hover:text-[#ff2442] transition-colors">
                            <ExternalLink size={12} />
                          </button>
                        )}
                        <button onClick={() => remove(group.account_id, idx)}
                          className="text-zinc-300 hover:text-red-400 transition-colors">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                    {isExpanded && note.body && (
                      <div className="px-3.5 pb-3 text-[11px] text-zinc-500 leading-relaxed border-t border-zinc-50 pt-2 bg-zinc-50 whitespace-pre-wrap">
                        {note.body}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ─── 分区4：选题灵感 ──────────────────────────────────────────────────────────

function InspirationsSection() {
  const [items, setItems] = useState<KnowledgeInspiration[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newKeyword, setNewKeyword] = useState("");

  useEffect(() => {
    api.get("/api/knowledge/inspirations").then((data) => {
      setItems(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  async function addInspiration() {
    if (!newTitle.trim()) return;
    const item = await api.post("/api/knowledge/inspirations", {
      title: newTitle.trim(),
      keyword: newKeyword.trim() || null,
      source: "manual",
    });
    setItems((prev) => [item, ...prev]);
    setNewTitle("");
    setNewKeyword("");
    setAdding(false);
  }

  async function remove(id: number) {
    await api.delete(`/api/knowledge/inspirations/${id}`);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  const sourceLabel: Record<string, string> = {
    ai: "AI生成", crawl: "爬虫导入", manual: "手动添加",
  };
  const sourceColor: Record<string, string> = {
    ai: "bg-purple-50 text-purple-500",
    crawl: "bg-sky-50 text-sky-500",
    manual: "bg-zinc-100 text-zinc-500",
  };

  if (loading) return <p className="text-xs text-zinc-400 py-4 text-center">加载中…</p>;

  return (
    <Section icon={Lightbulb} title="选题灵感" badge={items.length ? `${items.length} 条` : undefined}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-zinc-400">收藏的选题方向，生成笔记时作为创意方向参考</p>
        <button
          onClick={() => setAdding(!adding)}
          className="flex items-center gap-1 text-xs text-[#ff2442] hover:underline"
        >
          <Plus size={12} /> 手动添加
        </button>
      </div>

      {adding && (
        <div className="mb-3 p-3 border border-[#ff2442]/20 rounded-xl bg-[#ff2442]/5 space-y-2">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="选题方向（如：出租屋窗帘改造大变样）"
            className="w-full text-xs border border-zinc-200 rounded-lg px-3 py-2 outline-none focus:border-[#ff2442] transition-colors"
          />
          <div className="flex gap-2">
            <input
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              placeholder="关键词（可选，如：窗帘）"
              className="flex-1 text-xs border border-zinc-200 rounded-lg px-3 py-1.5 outline-none focus:border-[#ff2442] transition-colors"
            />
            <button
              onClick={addInspiration}
              disabled={!newTitle.trim()}
              className="text-xs px-3 py-1.5 rounded-lg bg-[#ff2442] text-white hover:bg-[#e01f3a] disabled:opacity-30 transition-colors"
            >
              添加
            </button>
            <button
              onClick={() => setAdding(false)}
              className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {!items.length ? (
        <p className="text-xs text-zinc-400 py-2 text-center">
          暂无灵感，点击「手动添加」或通过 AI 对话生成后收藏
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <div key={item.id}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-zinc-200 bg-white group hover:border-zinc-300 transition-colors"
            >
              <Sparkles size={10} className="text-zinc-300 shrink-0" />
              <span className="text-xs text-zinc-700">{item.title}</span>
              {item.keyword && (
                <span className="text-[10px] text-zinc-400">·{item.keyword}</span>
              )}
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${sourceColor[item.source] || sourceColor.manual}`}>
                {sourceLabel[item.source] || item.source}
              </span>
              <button
                onClick={() => remove(item.id)}
                className="opacity-0 group-hover:opacity-100 text-zinc-300 hover:text-red-400 transition-all ml-0.5"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

export default function KnowledgeTab() {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-sm font-semibold text-zinc-800">经验库</h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            沉淀下来的创作经验，生成笔记时自动注入 prompt
          </p>
        </div>
      </div>
      <RulesSection />
      <MySamplesSection />
      <RefSamplesSection />
      <InspirationsSection />
    </div>
  );
}
