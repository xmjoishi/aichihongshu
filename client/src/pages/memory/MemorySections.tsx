import { useWorkspaceQuery as useQuery } from "../../lib/workspaceActivity";
import { useMemo, useState } from "react";
import {
  Trash2, Sparkles, RotateCcw, Pencil,
  ToggleLeft, ToggleRight, BookOpen,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Dialog, Empty, Spinner,
  primaryButtonClass, secondaryButtonClass,
} from "../../components/ui";
import {
  IS_TAURI_RUNTIME,
  createMemoryEntry,
  deleteExperiencePrompt,
  deleteMemoryEntry,
  listExperiencePrompts,
  listMemoryEntries,
  readMemorySystemRules,
  readMobileSystemRules,
  resetMemoryL1Override,
  saveMemoryL1Override,
  setMemoryEntryEnabled,
  upsertExperiencePrompt,
  updateMemoryEntry,
  writeMobileMemoryCommand,
  type LocalExperiencePrompt,
  type LocalExperiencePromptUpsert,
  type LocalMemoryEntry,
  type LocalMemoryEntryCreate,
  type LocalMemorySystemRules,
  type MemoryKind,
  type MemoryOrigin,
} from "../../lib/local";
import { generateMemoryPrompt, polishMemoryPrompt, runMemoryAi } from "../../lib/memoryAi";
import { useAccountContext } from "../../lib/accountContext";
import { useToast } from "../../components/Toast";
import { reviewExperiencePrompts } from "./experiencePromptReview";

const KIND_LABELS: Record<MemoryKind, string> = {
  positioning: "定位与表达",
  expression: "表达偏好",
  fact: "生活事实",
  event: "事件",
  content_history: "内容历史",
};

const cardClass = "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4";
const inputClass =
  "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]/50 focus:ring-2 focus:ring-[#ff2442]/10";
const seedButtonClass =
  "rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-100 disabled:opacity-50";

/** 运营 / AI 同款分段切换，放在标题旁。 */
export function PoolPill({
  origin, onChange,
}: {
  origin: MemoryOrigin;
  onChange: (next: MemoryOrigin) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-xl bg-[var(--color-surface-2)] p-1" role="tablist" aria-label="记忆池">
      {([
        { key: "pc" as const, label: "本机" },
        { key: "mobile" as const, label: "手机" },
      ]).map((item) => {
        const active = origin === item.key;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              active
                ? "bg-white text-[#ff2442] shadow-sm"
                : "bg-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function MemoryEmptyState({ message }: { message: string }) {
  return (
    <div className={`${cardClass} flex h-full min-h-[160px] flex-col items-center justify-center gap-3`}>
      <Empty message={message} />
    </div>
  );
}

export function SystemRulesSection({ origin, mobileConnected }: { origin: MemoryOrigin; mobileConnected: boolean }) {
  return origin === "mobile"
    ? <MobileSystemRulesSection mobileConnected={mobileConnected} />
    : <PcSystemRulesSection />;
}

function MobileSystemRulesSection({ mobileConnected }: { mobileConnected: boolean }) {
  const { accountId } = useAccountContext();
  const query = useQuery({
    queryKey: ["memory-system-rules", "mobile", accountId, mobileConnected],
    queryFn: () => readMobileSystemRules(accountId!),
    enabled: IS_TAURI_RUNTIME && mobileConnected && accountId != null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (!IS_TAURI_RUNTIME) return <Empty message="请在桌面客户端连接手机后读取系统规则" />;
  if (!mobileConnected) return <Empty message="无法读取手机系统规则：手机未连接。请在手机前台打开记忆页并保持 Harness 连接。" />;
  if (accountId == null) return <Empty message="请先选择已配对的账号" />;
  if (query.isPending) return <Spinner />;
  const rules = query.data;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--color-text-secondary)]">手机实际运行的默认写作经验与输出规则，只读。账号人设、启用经验和当篇主题会另外加入请求。手机尚不支持系统规则覆盖。</p>
        <button type="button" className={secondaryButtonClass} disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? "读取中…" : "重新读取手机"}</button>
      </div>
      {query.isError ? <Empty message={`手机规则读取失败：${query.error instanceof Error ? query.error.message : String(query.error)}`} /> : rules ? <>
        <p className="text-xs text-[var(--color-text-secondary)]">来源：手机 · {rules.source} · 版本 {rules.version} · 读取于 {new Date(rules.readAt).toLocaleString()}</p>
        {([{ title: "手机默认写作经验", content: rules.defaultExperience }, { title: "手机输出规则", content: rules.outputRules }]).map(section => (
          <div key={section.title} className={cardClass}>
            <h3 className="mb-2 text-sm font-semibold">{section.title} · 只读</h3>
            <pre className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-text-secondary)]">{section.content}</pre>
          </div>
        ))}
      </> : <Empty message="手机未返回系统规则，请更新手机应用后重试" />}
    </div>
  );
}

function PcSystemRulesSection() {
  const query = useQuery({
    queryKey: ["memory-system-rules", "pc"],
    queryFn: readMemorySystemRules,
    enabled: IS_TAURI_RUNTIME,
    staleTime: 60_000,
  });
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const rules: LocalMemorySystemRules | undefined = query.data;

  async function save() {
    try {
      await saveMemoryL1Override(draft);
      setEditing(false);
      setError("");
      qc.invalidateQueries({ queryKey: ["memory-system-rules"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function reset() {
    try {
      await resetMemoryL1Override();
      setEditing(false);
      setError("");
      qc.invalidateQueries({ queryKey: ["memory-system-rules"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (query.isPending) return <Spinner />;
  if (!rules) return <Empty message="系统规则加载失败" />;

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--color-text-secondary)]">
        本机系统规则，仅影响 PC。L0 角色骨架不可修改；L1 格式与默认方法论可覆盖，改坏了可一键恢复默认。你的经验写在「经验提示词」，事实写在「事实与事件」。
      </p>
      <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
        <div className={cardClass}>
          <div className="mb-2 flex items-center gap-2">
            <BookOpen size={14} className="text-[#ff2442]" />
            <span className="text-sm font-semibold text-[var(--color-text-primary)]">L0 角色骨架</span>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500">只读</span>
          </div>
          <pre className="whitespace-pre-wrap rounded-xl bg-[var(--color-canvas)] border border-[var(--color-border)] px-3 py-2.5 text-xs leading-relaxed text-[var(--color-text-secondary)]">
            {rules.l0}
          </pre>
        </div>
        <div className={cardClass}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-[#ff2442]" />
              <span className="text-sm font-semibold text-[var(--color-text-primary)]">L1 格式与方法论</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${rules.l1IsOverride ? "bg-[#ff2442]/10 text-[#ff2442]" : "bg-zinc-100 text-zinc-500"}`}>
                {rules.l1IsOverride ? "已覆盖" : "默认"}
              </span>
            </div>
            {!editing && (
              <div className="flex gap-2">
                <button type="button" className={secondaryButtonClass} onClick={() => { setDraft(rules.l1Active); setEditing(true); }}>
                  <Pencil size={13} /> 编辑副本
                </button>
                {rules.l1IsOverride && (
                  <button type="button" className={secondaryButtonClass} onClick={reset}>
                    <RotateCcw size={13} /> 恢复默认
                  </button>
                )}
              </div>
            )}
          </div>
          {editing ? (
            <div className="space-y-2">
              <textarea
                className={`${inputClass} min-h-[160px] font-mono text-xs leading-relaxed`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              {error && <p className="text-xs text-red-500">{error}</p>}
              <div className="flex gap-2">
                <button type="button" className={primaryButtonClass} onClick={save}>保存覆盖</button>
                <button type="button" className={secondaryButtonClass} onClick={() => setEditing(false)}>取消</button>
              </div>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap rounded-xl bg-[var(--color-canvas)] border border-[var(--color-border)] px-3 py-2.5 text-xs leading-relaxed text-[var(--color-text-secondary)]">
              {rules.l1Active}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

type PromptForm = {
  title: string;
  content: string;
  enabled: boolean;
  applyScope: "global" | "account";
  applyTarget: "all" | "compose" | "chat";
};

const emptyPromptForm: PromptForm = {
  title: "",
  content: "",
  enabled: true,
  applyScope: "account",
  applyTarget: "all",
};

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">
      {children}
    </span>
  );
}

function TargetMultiSelect({
  value, onChange,
}: {
  value: PromptForm["applyTarget"];
  onChange: (next: PromptForm["applyTarget"]) => void;
}) {
  const compose = value === "all" || value === "compose";
  const chat = value === "all" || value === "chat";
  function toggle(nextCompose: boolean, nextChat: boolean) {
    if (nextCompose && nextChat) onChange("all");
    else if (nextCompose) onChange("compose");
    else if (nextChat) onChange("chat");
    else onChange("all");
  }
  return (
    <div className="flex flex-wrap gap-2">
      {([
        { key: "compose", label: "出稿", on: compose, set: (on: boolean) => toggle(on, chat) },
        { key: "chat", label: "对话", on: chat, set: (on: boolean) => toggle(compose, on) },
      ]).map((item) => (
        <button
          key={item.key}
          type="button"
          aria-pressed={item.on}
          onClick={() => item.set(!item.on)}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
            item.on
              ? "border-[#ff2442] bg-[#ff2442]/10 text-[#ff2442]"
              : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:border-[#ff2442]/40"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function PromptFormDialog({
  origin, canWrite, accountId, editing, onClose, onSaved,
}: {
  origin: MemoryOrigin;
  canWrite: boolean;
  accountId: number | null;
  editing: LocalExperiencePrompt | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<PromptForm>(
    editing
      ? {
          title: editing.title,
          content: editing.content,
          enabled: editing.enabled,
          applyScope: editing.applyScope,
          applyTarget: editing.applyTarget,
        }
      : emptyPromptForm,
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const payload: LocalExperiencePromptUpsert = {
        accountPoolId: accountId ?? 1,
        origin,
        id: editing?.id ?? null,
        title: form.title,
        content: form.content,
        enabled: form.enabled,
        applyScope: form.applyScope,
        applyTarget: form.applyTarget,
        source: "user",
      };
      if (origin === "mobile") {
        const prompt = {
          title: form.title,
          content: form.content,
          enabled: form.enabled,
          applyScope: form.applyScope,
          applyTarget: form.applyTarget,
          sortOrder: editing?.sortOrder ?? 0,
        };
        const result = await writeMobileMemoryCommand(
          editing ? "updatePrompt" : "createPrompt",
          editing
            ? { remoteId: editing.id, expected: editing, prompt }
            : { prompt },
        );
        toast(result.cacheSynced ? "手机已保存并同步" : result.message ?? "手机已保存，PC 缓存待同步", result.cacheSynced ? "success" : "warning");
      } else {
        await upsertExperiencePrompt(payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      if (origin === "mobile") onSaved();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={editing ? "编辑经验提示词" : "新增经验提示词"}
      description="≤40 字标题、≤5000 字内容；注入时排在系统规则之后。"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>取消</button>
          <button type="button" className={primaryButtonClass} onClick={submit} disabled={saving || !canWrite}>
            {saving ? "保存中…" : editing ? "保存修改" : "添加"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <FieldLabel>标题</FieldLabel>
          <input
            className={inputClass}
            placeholder="如：口吻偏好"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </label>
        <label className="block">
          <FieldLabel>内容</FieldLabel>
          <textarea
            className={`${inputClass} min-h-[110px]`}
            placeholder="如：先吐槽再给结论，短句换行，不提「高品质」"
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
          />
        </label>
        <div>
          <FieldLabel>适用账号</FieldLabel>
          <select
            className={inputClass}
            value={form.applyScope}
            onChange={(e) => setForm({ ...form, applyScope: e.target.value as PromptForm["applyScope"] })}
          >
            <option value="account">当前账号</option>
            <option value="global">全部账号（全局）</option>
          </select>
        </div>
        <div>
          <FieldLabel>用于场景（可多选）</FieldLabel>
          <TargetMultiSelect
            value={form.applyTarget}
            onChange={(next) => setForm({ ...form, applyTarget: next })}
          />
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    </Dialog>
  );
}

export function ExperiencePromptsSection({
  origin, canWrite, onSeed, seeding, onEdit,
}: {
  origin: MemoryOrigin;
  canWrite: boolean;
  onSeed: () => void;
  seeding: boolean;
  onEdit: (prompt: LocalExperiencePrompt) => void;
}) {
  const { accountId } = useAccountContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  const query = useQuery({
    queryKey: ["experience-prompts", accountId, origin],
    queryFn: () => listExperiencePrompts(accountId ?? undefined, origin),
    enabled: IS_TAURI_RUNTIME,
    staleTime: 1_000,
    refetchInterval: origin === "mobile" ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
  const prompts = useMemo(() => query.data ?? [], [query.data]);
  const enabledCount = prompts.filter((p) => p.enabled).length;
  const reviewFindings = useMemo(
    () => origin === "pc" ? reviewExperiencePrompts(prompts) : [],
    [origin, prompts],
  );

  function refresh() {
    qc.invalidateQueries({ queryKey: ["experience-prompts", accountId, origin] });
  }

  async function toggle(prompt: LocalExperiencePrompt) {
    if (!canWrite) return;
    try {
      if (origin === "mobile") {
        const result = await writeMobileMemoryCommand("setPromptEnabled", {
          remoteId: prompt.id,
          expected: prompt,
          enabled: !prompt.enabled,
        });
        toast(result.cacheSynced ? "手机已保存并同步" : result.message ?? "手机已保存，PC 缓存待同步", result.cacheSynced ? "success" : "warning");
      } else {
        await upsertExperiencePrompt({
          accountPoolId: accountId ?? 1,
          origin,
          id: prompt.id,
          title: prompt.title,
          content: prompt.content,
          enabled: !prompt.enabled,
          applyScope: prompt.applyScope,
          applyTarget: prompt.applyTarget,
          source: prompt.source,
          sortOrder: prompt.sortOrder,
        });
        toast("经验提示词已更新", "success");
      }
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      refresh();
    }
  }

  async function remove(prompt: LocalExperiencePrompt) {
    if (!canWrite) return;
    try {
      if (origin === "mobile") {
        const result = await writeMobileMemoryCommand("deletePrompt", {
          remoteId: prompt.id,
          expected: prompt,
        });
        toast(result.cacheSynced ? "已从手机删除" : result.message ?? "手机已删除，PC 缓存待同步", result.cacheSynced ? "success" : "warning");
      } else {
        await deleteExperiencePrompt(prompt.id, accountId ?? 1, origin);
        toast("经验提示词已删除", "success");
      }
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      refresh();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--color-text-secondary)]">
          注入时排在系统规则之后。每池启用上限 10 条、单条 5000 字。当前启用 {enabledCount} / {prompts.length}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={seedButtonClass}
            onClick={onSeed}
            disabled={!canWrite || seeding}
            title={!canWrite ? "手机 App 前台连接后可补充示例" : "只补当前分区缺少的示例，不覆盖已有内容"}
            aria-label="补充经验提示词示例，只添加缺失项，不覆盖现有内容"
          >
            {seeding ? "补充中…" : "补充示例"}
          </button>
        </div>
      </div>

      {origin === "pc" && (
        <section className={`${cardClass} space-y-2`} aria-label="经验提示词重复与冲突检查" aria-live="polite">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-[#ff2442]" />
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">重复与冲突检查</h3>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500">只读建议</span>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)]">
            仅检查正文重复，以及同时启用、适用范围有重叠的明确 Emoji、小标题、分段和列表要求；普通自然语言风格差异不作推断。
          </p>
          {reviewFindings.length === 0 ? (
            <p className="text-xs text-[var(--color-text-secondary)]">按上述规则暂未发现重复或明确冲突。</p>
          ) : (
            <ul className="space-y-2">
              {reviewFindings.map((finding) => (
                <li key={finding.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${finding.kind === "conflict" ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800"}`}>
                      {finding.kind === "conflict" ? "明确偏好冲突" : "正文重复"}
                    </span>
                    <span className="text-xs font-medium text-[var(--color-text-primary)]">{finding.label}</span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-text-primary)]">{finding.reason}</p>
                  {finding.kind === "conflict" && (
                    <ul className="mt-1 space-y-0.5 text-[11px] text-[var(--color-text-secondary)]">
                      {finding.evidence.map((item, index) => (
                        <li key={`${finding.id}:${item.promptId}:${index}`}>「{item.title}」：{item.excerpt}</li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-1.5 text-[11px] text-[var(--color-text-secondary)]">{finding.suggestion}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {query.isPending ? (
        <Spinner />
      ) : (
        <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
          {prompts.length === 0 && (
            <MemoryEmptyState
              message={origin === "pc" ? "本机还没有经验提示词" : "手机记忆池还没有经验提示词"}
            />
          )}
          {prompts.map((prompt) => (
            <div
              key={`${origin}-${prompt.id}`}
              className={`${cardClass} flex flex-col gap-2 ${prompt.enabled ? "" : "opacity-70"}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold text-[var(--color-text-primary)]">{prompt.title}</span>
                    <span className="rounded-full bg-[#ff2442]/10 px-2 py-0.5 text-[10px] text-[#ff2442]">
                      {prompt.applyScope === "global" ? "全局" : "当前账号"}
                    </span>
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500">
                      {prompt.applyTarget === "all" ? "出稿与对话" : prompt.applyTarget === "compose" ? "仅出稿" : "仅对话"}
                    </span>
                    {!prompt.enabled && (
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500">已停用</span>
                    )}
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-text-secondary)]">{prompt.content}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={!canWrite}
                    onClick={() => toggle(prompt)}
                    title={`${prompt.enabled ? "停用" : "启用"}经验提示词`}
                    aria-label={`${prompt.enabled ? "停用" : "启用"}经验提示词：${prompt.title}`}
                  >
                    {prompt.enabled
                      ? <ToggleRight size={20} className="text-[#ff2442]" />
                      : <ToggleLeft size={20} className="text-zinc-300" />}
                  </button>
                  <button type="button" disabled={!canWrite} onClick={() => onEdit(prompt)} title="编辑经验提示词" aria-label={`编辑经验提示词：${prompt.title}`} className="rounded-md p-1 hover:bg-[var(--color-surface-2)]">
                    <Pencil size={13} className="text-[var(--color-text-secondary)]" />
                  </button>
                  <button type="button" disabled={!canWrite} onClick={() => remove(prompt)} title="删除经验提示词" aria-label={`删除经验提示词：${prompt.title}`} className="group rounded-md p-1 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">
                    <Trash2 size={13} className="text-[var(--color-text-secondary)] transition group-hover:text-red-600" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type MemoryForm = {
  kind: MemoryKind;
  content: string;
  subject: string;
  occurredAt: string;
  source: string;
  confirmStatus: "candidate" | "confirmed";
};

const emptyMemoryForm: MemoryForm = {
  kind: "fact",
  content: "",
  subject: "",
  occurredAt: "",
  source: "",
  confirmStatus: "candidate",
};

export function MemoryFormDialog({
  origin, canWrite, accountId, editing, onClose, onSaved,
}: {
  origin: MemoryOrigin;
  canWrite: boolean;
  accountId: number | null;
  editing: LocalMemoryEntry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<MemoryForm>(
    editing
      ? {
          kind: editing.kind,
          content: editing.content,
          subject: editing.subject,
          occurredAt: editing.occurredAt ?? "",
          source: editing.source,
          confirmStatus: editing.confirmStatus === "confirmed" ? "confirmed" : "candidate",
        }
      : emptyMemoryForm,
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [aiBusy, setAiBusy] = useState<"" | "polish" | "generate">("");
  const [aiAbort, setAiAbort] = useState<(() => void) | null>(null);

  async function submit() {
    setSaving(true);
    try {
      if (origin === "mobile") {
        const entry = {
          kind: form.kind,
          content: form.content,
          subject: form.subject,
          source: form.source,
          sourceType: form.source.startsWith("AI") ? "ai_draft" : "user",
          occurredAt: form.occurredAt || null,
          confirmStatus: "candidate",
          enabled: !form.source.trim().startsWith("AI"),
        };
        const result = await writeMobileMemoryCommand(
          editing ? "updateEntry" : "createEntry",
          editing
            ? { remoteId: editing.id, expected: editing, entry }
            : { entry },
        );
        toast(result.cacheSynced ? "手机已保存并同步" : result.message ?? "手机已保存，PC 缓存待同步", result.cacheSynced ? "success" : "warning");
      } else if (editing) {
        await updateMemoryEntry({
          id: editing.id,
          accountPoolId: accountId ?? 1,
          kind: form.kind,
          content: form.content,
          subject: form.subject,
          source: form.source,
          sourceType: form.source.startsWith("AI") ? "ai_draft" : "user",
          occurredAt: form.occurredAt || null,
        });
      } else {
        const payload: LocalMemoryEntryCreate = {
          accountPoolId: accountId ?? 1,
          origin,
          kind: form.kind,
          content: form.content,
          subject: form.subject,
          source: form.source,
          sourceType: form.source.startsWith("AI") ? "ai_draft" : "user",
          occurredAt: form.occurredAt || null,
          // AI 来源默认停用，手动内容默认启用
          enabled: !form.source.trim().startsWith("AI"),
        };
        await createMemoryEntry(payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      if (origin === "mobile") onSaved();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function runAi(mode: "polish" | "generate") {
    const kindLabel = KIND_LABELS[form.kind];
    const prompt =
      mode === "polish"
        ? polishMemoryPrompt(form.content, kindLabel)
        : generateMemoryPrompt(form.content || form.subject, kindLabel);
    if (mode === "polish" && !form.content.trim()) {
      setError("先写点内容再润色");
      return;
    }
    if (mode === "generate" && !(form.content.trim() || form.subject.trim())) {
      setError("先写要点（可放在内容或主体里）再生成");
      return;
    }
    setAiBusy(mode);
    setError("");
    const run = runMemoryAi(prompt);
    setAiAbort(() => run.abort);
    try {
      const result = await run.promise;
      if (result) {
        setForm((prev) => ({ ...prev, content: result }));
      } else {
        setError("AI 返回为空");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy("");
      setAiAbort(null);
    }
  }

  return (
    <Dialog
      title={editing ? "编辑记忆" : "新增记忆"}
      description="启用后才会注入 AI；AI 生成的条目默认停用，确认无误再打开开关。"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>取消</button>
          <button type="button" className={primaryButtonClass} onClick={submit} disabled={saving || !canWrite}>
            {saving ? "保存中…" : editing ? "保存修改" : "添加"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <FieldLabel>类型</FieldLabel>
          <select
            className={inputClass}
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as MemoryKind })}
          >
            {(Object.keys(KIND_LABELS) as MemoryKind[]).map((kind) => (
              <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
            ))}
          </select>
        </div>
        <label className="block">
          <FieldLabel>主体（可选）</FieldLabel>
          <input
            className={inputClass}
            placeholder="如：门后置物架 / 厨房油烟机"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
          />
        </label>
        <label className="block">
          <FieldLabel>发生时间（可选）</FieldLabel>
          <input
            className={inputClass}
            placeholder="可只写年月，如：2026-03"
            value={form.occurredAt}
            onChange={(e) => setForm({ ...form, occurredAt: e.target.value })}
          />
        </label>
        <label className="block">
          <FieldLabel>记忆内容</FieldLabel>
          <textarea
            className={`${inputClass} min-h-[110px]`}
            placeholder="客观、具体；也可先写要点，再点「AI 生成」"
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
          />
        </label>
        <div>
          <FieldLabel>AI 辅助</FieldLabel>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={seedButtonClass}
              disabled={aiBusy !== ""}
              onClick={() => runAi("generate")}
            >
              {aiBusy === "generate" ? "生成中…" : "AI 生成"}
            </button>
            <button
              type="button"
              className={seedButtonClass}
              disabled={aiBusy !== ""}
              onClick={() => runAi("polish")}
            >
              {aiBusy === "polish" ? "润色中…" : "AI 润色"}
            </button>
            {aiBusy && (
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => {
                  aiAbort?.();
                  setAiBusy("");
                }}
              >
                停止
              </button>
            )}
          </div>
        </div>
        <label className="block">
          <FieldLabel>来源（可选）</FieldLabel>
          <input
            className={inputClass}
            placeholder="如：用户口述 / AI 稿 / 发布记录"
            value={form.source}
            onChange={(e) => setForm({ ...form, source: e.target.value })}
          />
        </label>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    </Dialog>
  );
}

export function MemoryEntriesSection({
  origin, canWrite, onSeed, seeding, onEdit,
}: {
  origin: MemoryOrigin;
  canWrite: boolean;
  onSeed: () => void;
  seeding: boolean;
  onEdit: (entry: LocalMemoryEntry) => void;
}) {
  const { accountId } = useAccountContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [enabledFilter, setEnabledFilter] = useState<"all" | "on" | "off">("all");
  const query = useQuery({
    queryKey: ["memory-entries", accountId, origin, enabledFilter],
    queryFn: () =>
      listMemoryEntries({
        accountPoolId: accountId ?? undefined,
        origin,
        enabled: enabledFilter === "all" ? undefined : enabledFilter === "on",
      }),
    enabled: IS_TAURI_RUNTIME,
    staleTime: 1_000,
    refetchInterval: origin === "mobile" ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
  const entries = useMemo(() => query.data ?? [], [query.data]);
  const enabledCount = entries.filter((e) => e.enabled).length;

  function refresh() {
    qc.invalidateQueries({ queryKey: ["memory-entries", accountId, origin] });
  }

  async function toggle(entry: LocalMemoryEntry) {
    if (!canWrite) return;
    try {
      if (origin === "mobile") {
        const result = await writeMobileMemoryCommand("setEntryEnabled", {
          remoteId: entry.id,
          expected: entry,
          enabled: !entry.enabled,
        });
        toast(result.cacheSynced ? "手机已保存并同步" : result.message ?? "手机已保存，PC 缓存待同步", result.cacheSynced ? "success" : "warning");
      } else {
        await setMemoryEntryEnabled(entry.id, accountId ?? 1, !entry.enabled);
        toast("记忆状态已更新", "success");
      }
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      refresh();
    }
  }

  async function remove(entry: LocalMemoryEntry) {
    if (!canWrite) return;
    try {
      if (origin === "mobile") {
        const result = await writeMobileMemoryCommand("deleteEntry", {
          remoteId: entry.id,
          expected: entry,
        });
        toast(result.cacheSynced ? "已从手机删除" : result.message ?? "手机已删除，PC 缓存待同步", result.cacheSynced ? "success" : "warning");
      } else {
        await deleteMemoryEntry(entry.id, accountId ?? 1);
        toast("记忆已删除", "success");
      }
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      refresh();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {([
            { key: "all" as const, label: `全部 ${entries.length}` },
            { key: "on" as const, label: `启用中 ${enabledCount}` },
            { key: "off" as const, label: `已停用 ${entries.length - enabledCount}` },
          ]).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setEnabledFilter(item.key)}
              className={`rounded-full px-3 py-1 text-xs transition ${
                enabledFilter === item.key
                  ? "bg-[#ff2442] text-white font-medium"
                  : "bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {enabledFilter === "all" && (
            <button
              type="button"
              className={seedButtonClass}
              onClick={onSeed}
              disabled={!canWrite || seeding}
              title={!canWrite ? "手机 App 前台连接后可补充示例" : "只补当前分区缺少的示例，不覆盖已有内容"}
              aria-label="补充记忆示例，只添加缺失项，不覆盖现有内容"
            >
              {seeding ? "补充中…" : "补充示例"}
            </button>
          )}
        </div>
      </div>

      {query.isPending ? (
        <Spinner />
      ) : (
        <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
          {entries.length === 0 && (
            <MemoryEmptyState
              message={enabledFilter === "all" ? (origin === "pc" ? "本机还没有记忆" : "手机记忆池暂无条目") : "该状态下暂无条目"}
            />
          )}
          {entries.map((entry) => (
            <div key={`${origin}-${entry.id}`} className={`${cardClass} ${entry.enabled ? "" : "opacity-70"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-full bg-[#ff2442]/10 px-2 py-0.5 text-[10px] text-[#ff2442]">
                      {KIND_LABELS[entry.kind]}
                    </span>
                    {!entry.enabled && (
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500">已停用</span>
                    )}
                    {entry.subject && (
                      <span className="text-[11px] text-[var(--color-text-secondary)]">{entry.subject}</span>
                    )}
                    {entry.occurredAt && (
                      <span className="text-[11px] text-[var(--color-text-secondary)]">@{entry.occurredAt}</span>
                    )}
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-primary)]">{entry.content}</p>
                  {entry.source && (
                    <p className="mt-1.5 text-[11px] text-[var(--color-text-secondary)]">来源：{entry.source}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={!canWrite}
                    onClick={() => toggle(entry)}
                    title={`${entry.enabled ? "停用" : "启用"}记忆`}
                    aria-label={`${entry.enabled ? "停用" : "启用"}记忆：${entry.subject || KIND_LABELS[entry.kind]}`}
                  >
                    {entry.enabled
                      ? <ToggleRight size={20} className="text-[#ff2442]" />
                      : <ToggleLeft size={20} className="text-zinc-300" />}
                  </button>
                  <button type="button" disabled={!canWrite} title="编辑记忆" aria-label={`编辑记忆：${entry.subject || KIND_LABELS[entry.kind]}`} onClick={() => onEdit(entry)} className="rounded-md p-1.5 hover:bg-[var(--color-surface-2)]">
                    <Pencil size={13} className="text-[var(--color-text-secondary)]" />
                  </button>
                  <button type="button" disabled={!canWrite} title="删除记忆" aria-label={`删除记忆：${entry.subject || KIND_LABELS[entry.kind]}`} onClick={() => remove(entry)} className="group rounded-md p-1.5 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">
                    <Trash2 size={13} className="text-[var(--color-text-secondary)] transition group-hover:text-red-600" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RelatedSection() {
  return (
    <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
      <div className={cardClass}>
        <div className="flex items-center gap-2">
          <BookOpen size={14} className="text-[#ff2442]" />
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">经验库数据</span>
        </div>
        <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
          互动规律 / 高赞样本 / 榜样参考 / 灵感仍在
          <Link to="/data?view=knowledge" className="mx-1 text-[#ff2442] hover:underline">数据与复盘 · 经验库</Link>
          维护，后续收编进本页。
        </p>
      </div>
      <div className={cardClass}>
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-[#ff2442]" />
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">快捷指令</span>
        </div>
        <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
          在
          <Link to="/settings" className="mx-1 text-[#ff2442] hover:underline">设置 · 提示词</Link>
          维护，后续收编进本页。
        </p>
      </div>
    </div>
  );
}
