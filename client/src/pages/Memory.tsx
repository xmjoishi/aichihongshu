import { useWorkspaceEffect } from "../lib/workspaceActivity";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { primaryButtonClass, pageTabClass, pageTabActiveClass, pageTabInactiveClass } from "../components/ui";
import {
  IS_TAURI_RUNTIME,
  createMemoryEntry,
  listExperiencePrompts,
  listMemoryEntries,
  upsertExperiencePrompt,
  writeMobileMemoryCommand,
  type LocalExperiencePrompt,
  type LocalExperiencePromptUpsert,
  type LocalMemoryEntry,
  type LocalMemoryEntryCreate,
  type MemoryOrigin,
} from "../lib/local";
import { publishPageAIContext } from "../lib/pageAIContext";
import { useAccountContext } from "../lib/accountContext";
import { useToast } from "../components/Toast";
import { usePcHarnessMobileConnection } from "../components/PcHarnessQuickControl";

import {
  PoolPill,
  SystemRulesSection,
  ExperiencePromptsSection,
  MemoryEntriesSection,
  RelatedSection,
  PromptFormDialog,
  MemoryFormDialog,
} from "./memory/MemorySections";

type TabKey = "rules" | "prompts" | "entries";

const TABS: { key: TabKey; label: string }[] = [
  { key: "rules", label: "系统规则" },
  { key: "prompts", label: "经验提示词" },
  { key: "entries", label: "事实与事件" },
];

function tabFromQuery(value: string | null): TabKey {
  return value === "prompts" || value === "entries" ? value : "rules";
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
                  : "手机 App 前台连接后才能读取系统规则或编辑；经验与事实可查看本地缓存。"}
              </span>
            </div>
          )}
          <div key={origin}>
            {tab === "rules" && (
              <>
                <SystemRulesSection origin={origin} mobileConnected={mobileConnected} />
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
