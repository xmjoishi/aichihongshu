import { useWorkspaceEffect } from "../lib/workspaceActivity";
import { useWorkspaceQuery as useQuery } from "../lib/workspaceActivity";
import { useMemo, useState, useEffect } from "react";
import {
  Trash2, Sparkles, RotateCcw, Pencil, Plus,
  ToggleLeft, ToggleRight, BookOpen,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  Dialog, Empty, Spinner, pageTabActiveClass, pageTabClass, pageTabInactiveClass,
  primaryButtonClass, secondaryButtonClass,
} from "../components/ui";
import {
  IS_TAURI_RUNTIME,
  createMemoryEntry,
  deleteExperiencePrompt,
  deleteMemoryEntry,
  listExperiencePrompts,
  listMemoryEntries,
  readMemorySystemRules,
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
} from "../lib/local";
import { generateMemoryPrompt, polishMemoryPrompt, runMemoryAi } from "../lib/memoryAi";
import { publishPageAIContext } from "../lib/pageAIContext";
import { useAccountContext } from "../lib/accountContext";
import { useToast } from "../components/Toast";
import { usePcHarnessMobileConnection } from "../components/PcHarnessQuickControl";

const KIND_LABELS: Record<MemoryKind, string> = {
  positioning: "定位与表达",
  expression: "表达偏好",
  fact: "生活事实",
  event: "事件",
  content_history: "内容历史",
};

type TabKey = "rules" | "prompts" | "entries";

const TABS: { key: TabKey; label: string }[] = [
  { key: "rules", label: "系统规则" },
  { key: "prompts", label: "经验提示词" },
  { key: "entries", label: "事实与事件" },
];

function tabFromQuery(value: string | null): TabKey {
  return value === "prompts" || value === "entries" ? value : "rules";
}

const cardClass = "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4";
const inputClass =
  "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[#ff2442]/50 focus:ring-2 focus:ring-[#ff2442]/10";
const seedButtonClass =
  "rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-100 disabled:opacity-50";

/** 运营 / AI 同款分段切换，放在标题旁。 */
function PoolPill({
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

function SystemRulesSection() {
  const query = useQuery({
    queryKey: ["memory-system-rules"],
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
        L0 角色骨架不可修改；L1 格式与默认方法论可覆盖，改坏了可一键恢复默认。你的经验写在「经验提示词」，事实写在「事实与事件」。
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

function PromptFormDialog({
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
      description="≤40 字标题、≤300 字内容；注入时排在系统规则之后。"
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

function ExperiencePromptsSection({
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
          注入时排在系统规则之后。每池启用上限 10 条、单条 300 字。当前启用 {enabledCount} / {prompts.length}
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

function MemoryFormDialog({
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

function MemoryEntriesSection({
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

function RelatedSection() {
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

export default function Memory() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = tabFromQuery(searchParams.get("view"));
  const [tab, setTab] = useState<TabKey>(requestedTab);

  useEffect(() => {
    setTab(requestedTab);
  }, [requestedTab]);
  const [origin, setOrigin] = useState<MemoryOrigin>("pc");
  const { accountId } = useAccountContext();
  const { data: mobileConnectedValue } = usePcHarnessMobileConnection();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [seeding, setSeeding] = useState(false);
  const [promptDialog, setPromptDialog] = useState<"add" | null>(null);
  const [promptEditing, setPromptEditing] = useState<LocalExperiencePrompt | null>(null);
  const [memoryDialog, setMemoryDialog] = useState<"add" | null>(null);
  const [memoryEditing, setMemoryEditing] = useState<LocalMemoryEntry | null>(null);

  // 手机上的 SQLite 始终是唯一事实源；手机在线时 PC 通过命令写穿。
  const mobileConnected = mobileConnectedValue === true;
  const canWrite = origin === "pc" || mobileConnected;

  function changeOrigin(next: MemoryOrigin) {
    setOrigin(next);
    setPromptDialog(null);
    setPromptEditing(null);
    setMemoryDialog(null);
    setMemoryEditing(null);
  }

  function selectTab(next: TabKey) {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    params.set("view", next);
    setSearchParams(params, { replace: true });
  }

  // 让 AI 助手感知记忆页：可存记忆/经验、切换分区，并按当前 tab 调整建议
  useWorkspaceEffect(() => {
    publishPageAIContext({
      route: "/memory",
      page: tab === "prompts" ? "记忆 · 经验提示词" : tab === "entries" ? "记忆 · 事实与事件" : "记忆 · 系统规则",
      accountId,
      selectedIds: [],
      availableActions: [
        ...(origin === "pc" ? [
          { id: "save-memory-entry", label: "存为记忆", description: "把事实/事件/偏好存入 PC 记忆池", requiresConfirmation: true, handler: "save-memory-entry" as const },
          { id: "save-experience-prompt", label: "存为经验提示词", description: "把写法/口吻偏好存入 PC 记忆池", requiresConfirmation: true, handler: "save-experience-prompt" as const },
        ] : []),
        { id: "open-memory-prompts", label: "打开经验提示词", handler: "navigate" as const, href: "/memory?view=prompts" },
        { id: "open-memory-entries", label: "打开事实与事件", handler: "navigate" as const, href: "/memory?view=entries" },
        { id: "open-memory-rules", label: "打开系统规则", handler: "navigate" as const, href: "/memory?view=rules" },
      ],
      source: "page",
      permissionScope: origin === "pc" ? ["memory.read", "memory.write", "experience.write"] : ["memory.read"],
    });
  }, [accountId, origin, tab]);

  function openAdd() {
    if (tab === "prompts") setPromptDialog("add");
    if (tab === "entries") setMemoryDialog("add");
  }

  async function seedSamples() {
    if (!canWrite || seeding || (tab !== "prompts" && tab !== "entries")) return;
    setSeeding(true);
    const pool = accountId ?? 1;
    try {
      const promptSamples: Array<LocalExperiencePromptUpsert> = [
        {
          accountPoolId: pool,
          origin,
          title: "口吻偏好",
          content: "先吐槽再给结论，短句换行，像跟朋友唠；不提「精致 / 高品质 / 高级感」这类营销腔。",
          enabled: true,
          applyScope: "account",
          applyTarget: "all",
          source: "user",
          sortOrder: 0,
        },
        {
          accountPoolId: pool,
          origin,
          title: "结构套路",
          content: "痛点开头 → 真实体感 → 避坑点 → 一句值不值；总分总，每段不超过 3 行。",
          enabled: true,
          applyScope: "account",
          applyTarget: "compose",
          source: "user",
          sortOrder: 1,
        },
        {
          accountPoolId: pool,
          origin,
          title: "常用句式",
          content: "「说真的」「踩过坑才懂」「后来换了之后」；多用第一人称，少用「大家」。",
          enabled: true,
          applyScope: "global",
          applyTarget: "compose",
          source: "user",
          sortOrder: 2,
        },
        {
          accountPoolId: pool,
          origin,
          title: "避坑底线",
          content: "没用过的东西不下结论；不编造价格、尺寸和购买链接；AI 推断必须先存候选再确认。",
          enabled: true,
          applyScope: "global",
          applyTarget: "all",
          source: "user",
          sortOrder: 3,
        },
      ];
      const entrySamples: Array<LocalMemoryEntryCreate> = [
        {
          accountPoolId: pool,
          origin,
          kind: "positioning",
          content: "目标读者：一线城市租房改造党，预算有限、怕踩坑；内容围绕小户型收纳与低成本改造。",
          subject: "账号定位",
          source: "账号规划",
          sourceType: "user",
          enabled: true,
        },
        {
          accountPoolId: pool,
          origin,
          kind: "expression",
          content: "禁用「精致」「高品质」「高级感」「轻奢」；口语短句，先痛点后解法。",
          subject: "表达偏好",
          source: "人设设定",
          sourceType: "user",
          enabled: true,
        },
        {
          accountPoolId: pool,
          origin,
          kind: "fact",
          content: "门后置物架旧塑料款会卡住踢脚线，深度不够，放不了收纳箱。",
          subject: "门后置物架（旧塑料款）",
          source: "用户口述",
          sourceType: "user",
          occurredAt: "2026-03",
          enabled: true,
        },
        {
          accountPoolId: pool,
          origin,
          kind: "event",
          content: "旧架卡踢脚线后换成金属款，同样门后位置，用来放包和收纳箱，高度刚好。",
          subject: "门后置物架（新金属款）",
          source: "用户口述",
          sourceType: "user",
          occurredAt: "2026-03",
          enabled: true,
        },
        {
          accountPoolId: pool,
          origin,
          kind: "fact",
          content: "油烟机漏烟/倒灌（旧 AI 稿新增描述，尚未核实）。",
          subject: "厨房油烟机",
          source: "AI 稿",
          sourceType: "ai_draft",
          enabled: false,
        },
        {
          accountPoolId: pool,
          origin,
          kind: "content_history",
          content: "《出租屋厨房改造》已发布，属「小户型改造」系列第 2 篇；封面用改造前后对比。",
          subject: "小户型改造系列",
          source: "发布记录",
          sourceType: "user",
          occurredAt: "2026-04",
          enabled: true,
        },
      ];
      if (origin === "mobile") {
        const result = tab === "prompts"
          ? await writeMobileMemoryCommand("seedExamples", {
              section: "prompts",
              prompts: promptSamples.map(({ title, content, enabled, applyScope, applyTarget, sortOrder }) => ({
                title,
                content,
                enabled,
                applyScope,
                applyTarget,
                sortOrder,
              })),
            })
          : await writeMobileMemoryCommand("seedExamples", {
              section: "entries",
              entries: entrySamples.map(({ kind, content, subject, source, sourceType, occurredAt, enabled }) => ({
                kind,
                content,
                subject,
                source,
                sourceType,
                occurredAt,
                enabled,
              })),
            });
        toast(
          result.message ?? (result.cacheSynced ? "示例已保存到手机并同步" : "示例已保存到手机，PC 缓存待同步"),
          result.cacheSynced ? "success" : "warning",
        );
      } else if (tab === "prompts") {
        const current = await listExperiencePrompts(pool, origin);
        const missing = promptSamples.filter((sample) => !current.some(
          (item) => item.title === sample.title && item.content === sample.content
            && item.applyScope === sample.applyScope && item.applyTarget === sample.applyTarget,
        ));
        let enabledSlots = Math.max(0, 10 - current.filter((item) => item.enabled).length);
        let disabledByLimit = 0;
        for (const prompt of missing) {
          const enabled = prompt.enabled && enabledSlots > 0;
          if (enabled) enabledSlots -= 1;
          else if (prompt.enabled) disabledByLimit += 1;
          await upsertExperiencePrompt({ ...prompt, enabled });
        }
        toast(
          missing.length === 0
            ? "当前已包含全部经验提示词示例"
            : `已添加 ${missing.length} 条经验提示词示例${disabledByLimit ? `，${disabledByLimit} 条因启用上限已停用` : ""}`,
          "success",
        );
      } else {
        const current = await listMemoryEntries({ accountPoolId: pool, origin });
        const missing = entrySamples.filter((sample) => !current.some(
          (item) => item.kind === sample.kind && item.content === sample.content && item.subject === sample.subject,
        ));
        for (const payload of missing) await createMemoryEntry(payload);
        toast(missing.length > 0 ? `已添加 ${missing.length} 条记忆示例` : "当前已包含全部记忆示例", "success");
      }
      qc.invalidateQueries({ queryKey: ["experience-prompts", accountId, origin] });
      qc.invalidateQueries({ queryKey: ["memory-entries", accountId, origin] });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
      qc.invalidateQueries({ queryKey: ["experience-prompts", accountId, origin] });
      qc.invalidateQueries({ queryKey: ["memory-entries", accountId, origin] });
    } finally {
      setSeeding(false);
    }
  }

  if (!IS_TAURI_RUNTIME) {
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-sm text-zinc-500">记忆中心依赖本地运行时（Tauri），浏览器预览暂不支持。</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 pb-0 pt-5">
        {/* 标题行：标题 + 池切换居左，状态居左，操作按钮居右 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">记忆</h1>
            <PoolPill origin={origin} onChange={changeOrigin} />
            {origin === "pc" && <span className="text-xs text-emerald-600">本机数据 · 可维护</span>}
          </div>
          {tab !== "rules" && canWrite && (
            <button type="button" className={primaryButtonClass} onClick={openAdd}>
              <Plus size={14} /> {tab === "prompts" ? "新增经验提示词" : "新增记忆"}
            </button>
          )}
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]">
          维护 AI 会记住的经验与事实；系统规则只读，其余可增删改与候选确认
        </p>
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => selectTab(t.key)}
              className={`${pageTabClass} ${tab === t.key ? pageTabActiveClass : pageTabInactiveClass}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div data-page-scroll="memory-main" className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto w-full max-w-6xl space-y-4">
          {origin === "mobile" && (
            <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-3 py-2 text-xs ${mobileConnected ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${mobileConnected ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden="true" />
              <strong>{mobileConnected ? "手机已连接" : "手机未连接"}</strong>
              <span>
                {mobileConnected
                  ? "修改先保存到手机，再更新此处缓存。"
                  : "当前展示本地缓存；手机 App 前台连接后才能编辑。"}
              </span>
            </div>
          )}
          <div key={origin}>
            {tab === "rules" && (
              <>
                <SystemRulesSection />
                <div className="mt-4"><RelatedSection /></div>
              </>
            )}
            {tab === "prompts" && (
              <ExperiencePromptsSection
                origin={origin}
                canWrite={canWrite}
                onSeed={seedSamples}
                seeding={seeding}
                onEdit={(prompt) => setPromptEditing(prompt)}
              />
            )}
            {tab === "entries" && (
              <MemoryEntriesSection
                origin={origin}
                canWrite={canWrite}
                onSeed={seedSamples}
                seeding={seeding}
                onEdit={(entry) => setMemoryEditing(entry)}
              />
            )}
          </div>
        </div>
      </div>

      {(promptDialog || promptEditing) && (
        <PromptFormDialog
          origin={origin}
          canWrite={canWrite}
          accountId={accountId}
          editing={promptEditing}
          onClose={() => {
            setPromptDialog(null);
            setPromptEditing(null);
          }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["experience-prompts", accountId, origin] });
          }}
        />
      )}
      {(memoryDialog || memoryEditing) && (
        <MemoryFormDialog
          origin={origin}
          canWrite={canWrite}
          accountId={accountId}
          editing={memoryEditing}
          onClose={() => {
            setMemoryDialog(null);
            setMemoryEditing(null);
          }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["memory-entries", accountId, origin] });
          }}
        />
      )}
    </div>
  );
}
