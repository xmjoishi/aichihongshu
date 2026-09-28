import { useWorkspaceEffect } from "../../lib/workspaceActivity";
import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import type { AiDefaultTargetKind } from "../../lib/aiRuntime";

export interface DefaultPickerEntry {
  key: string;
  kind: AiDefaultTargetKind;
  provider: string;
  providerLabel: string;
  model: string;
  /** 展示用名称；为空时回落到 model。 */
  modelLabel?: string;
  detail?: string;
}

export interface DefaultPickerGroup {
  kind: AiDefaultTargetKind;
  /** Provider 实例 id，用于分组与刷新。 */
  provider: string;
  label: string;
  entries: DefaultPickerEntry[];
}

interface Props {
  groups: DefaultPickerGroup[];
  current: { kind: AiDefaultTargetKind; provider: string; model: string } | null;
  onApply: (kind: AiDefaultTargetKind, provider: string, model: string) => void;
}

/** Provider 品牌色点（参考 Noomd）。 */
function providerDotClass(provider: string, kind: AiDefaultTargetKind): string {
  if (kind === "agent-cli") {
    if (provider === "claude") return "bg-[#d97706]";
    if (provider === "codex") return "bg-[#10a37f]";
    return "bg-[#6366f1]";
  }
  if (provider === "deepseek") return "bg-[#4d6bfe]";
  if (provider === "minimax") return "bg-[#e11d48]";
  if (provider === "openai") return "bg-[#10a37f]";
  if (provider === "anthropic") return "bg-[#d97706]";
  return "bg-[var(--color-brand)]";
}

/** 「新会话默认使用」弹出选择器：API / CLI 双 tab，搜索 + 按 Provider 分组。 */
export default function DefaultModelPicker({ groups, current, onApply }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<AiDefaultTargetKind>(current?.kind === "agent-cli" ? "agent-cli" : "model-api");
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useWorkspaceEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const display = useMemo(() => {
    if (!current || !current.provider) return { provider: "未设置", model: "" };
    for (const group of groups) {
      const hit = group.entries.find((entry) => entry.provider === current.provider && entry.model === current.model);
      if (hit) return { provider: hit.providerLabel, model: hit.modelLabel || hit.model || (hit.kind === "agent-cli" ? "默认模型" : "默认模型") };
    }
    return {
      provider: current.provider,
      model: current.model || "默认模型",
    };
  }, [current, groups]);

  const query = search.trim().toLowerCase();
  const visibleGroups = groups
    .filter((group) => group.kind === tab)
    .map((group) => ({
      ...group,
      entries: group.entries.filter((entry) =>
        `${entry.providerLabel} ${entry.provider} ${entry.model}`.toLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.entries.length > 0);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${display.provider} · ${display.model}`}
        className="flex h-[34px] w-full min-w-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs font-medium hover:border-[var(--color-brand)]/50"
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${providerDotClass(current?.provider ?? "", current?.kind ?? "model-api")}`}
          aria-hidden="true"
        />
        <span className="min-w-0 shrink-0 truncate text-[var(--color-text-primary)]">{display.provider}</span>
        <span className="shrink-0 text-[var(--color-text-secondary)]">·</span>
        <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">{display.model}</span>
        <ChevronDown size={12} className="shrink-0 text-[var(--color-text-secondary)]" />
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-40 mt-2 w-[min(280px,calc(100vw-48px))] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
          <div className="flex items-center gap-1 border-b border-[var(--color-border)] p-2">
            {([["model-api", "API"], ["agent-cli", "本地 CLI"]] as [AiDefaultTargetKind, string][]).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={`rounded-lg px-2.5 py-1 text-xs ${tab === value ? "bg-[var(--color-selected)] text-[var(--color-brand)]" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"}`}
              >
                {label}
              </button>
            ))}
            <div className="ml-auto flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-[var(--color-surface-2)] px-2">
              <Search size={12} className="shrink-0 text-[var(--color-text-secondary)]" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索 Provider 或模型…"
                className="h-7 min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-secondary)]"
              />
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {visibleGroups.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-[var(--color-text-secondary)]">
                {tab === "model-api" ? "暂无已连接的 API Provider，请先在下方连接" : "未发现可用的本地 CLI"}
              </p>
            ) : null}
            {visibleGroups.map((group) => (
              <div key={`${group.kind}-${group.provider}`} className="mb-1">
                <div className="flex items-center gap-1.5 px-2 py-1">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${providerDotClass(group.provider, group.kind)}`} aria-hidden="true" />
                  <p className="min-w-0 flex-1 truncate text-[10px] font-medium text-[var(--color-text-secondary)]">{group.label}</p>
                </div>
                {group.entries.map((entry) => {
                  const active = current?.kind === entry.kind && current.provider === entry.provider && current.model === entry.model;
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      onClick={() => {
                        onApply(entry.kind, entry.provider, entry.model);
                        setOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg py-1.5 pl-5 pr-2.5 text-left text-xs transition ${active ? "bg-[var(--color-selected)]" : "hover:bg-[var(--color-surface-2)]"}`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${providerDotClass(entry.provider, entry.kind)}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-[var(--color-text-primary)]">{entry.modelLabel || entry.model || "默认模型"}</span>
                      </span>
                      {entry.detail ? <span className="shrink-0 text-[10px] text-[var(--color-text-secondary)]">{entry.detail}</span> : null}
                      {active ? <Check size={13} className="shrink-0 text-[var(--color-brand)]" /> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
