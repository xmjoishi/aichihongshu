import { useWorkspaceEffect } from "../lib/workspaceActivity";
import { useWorkspaceQuery as useQuery } from "../lib/workspaceActivity";
import { useState, useRef, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, X, RotateCcw, StopCircle, Send, Copy, Check, Plus, Maximize2, AtSign, Paperclip, Search, ChevronDown, PanelRight, PictureInPicture2, History, MessageSquare } from "lucide-react";
import { useAIStream } from "../hooks/useAIStream";
import { MdContent } from "./MdContent";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Item } from "../lib/types";
import {
  IS_TAURI_RUNTIME,
  localItemToItem,
  localNoteToNote,
  localProfileToProfile,
  localReferenceAccountToReferenceAccount,
  listPromptConfigs,
  listMemoryEntries,
  listExperiencePrompts,
  readLocalInspirations,
  readLocalKnowledgePreferences,
  readLocalWorkspaceSnapshot,
} from "../lib/local";
import {
  probeLocalAIProviders,
  refreshLocalAIProviders,
  readPreferredLocalAIProvider,
  readVerifiedLocalAIProviders,
  savePreferredLocalAIProvider,
  type LocalAIProviderStatus,
} from "../lib/localAi";
import { usePanelResize } from "../hooks/usePanelResize";
import { useAccountContext } from "../lib/accountContext";
import { buildLocalKnowledgeContext } from "../lib/localKnowledge";
import { buildMemoryContext } from "../lib/memoryContext";
import { MemorySaveDialog, type MemorySaveDraft } from "./MemorySaveDialog";
import { AI_HOST_MODES, GLOBAL_AI_EVENT, makeAISessionKey, type AIHostMode } from "../lib/aiHost";
import { PAGE_AI_ACTION_EVENT, pageAIContextPrompt, usePageAIContext, type AIAction, type AISelectionDetail, type PageAIContext } from "../lib/pageAIContext";
import { readAgentSessions, subscribeAgentSessions, touchAgentSession, type AgentSessionMetadata } from "../lib/aiWorkspace";
import { parseAIResponse, type AIResponseBlock, type AIResponseEnvelope } from "../lib/aiResponse";
import { readModelApiSettings, type ModelApiSettingsView } from "../lib/modelApi";
import { readAiRuntimeSettings, type AiRuntimeSettings } from "../lib/aiRuntime";
import DefaultModelPicker, { type DefaultPickerGroup } from "./aiSettings/DefaultModelPicker";
import { cliDefaultModelValues, cliModelLabel } from "./aiSettings/cliModels";

interface AIPanelProps {
  noteId?: number;
  itemId?: number;
  accountId?: number | null;
  systemExtra?: string;
  /** 面板可以在能力未接入时打开，用于展示准确的不可用原因。 */
  available?: boolean;
  unavailableReason?: string;
  unavailableNextStep?: string;
  onApply?: (text: string) => void;
  onApplyTitle?: (title: string, proposalBaseVersion?: number) => boolean | void;
  onApplyTags?: (tags: string, proposalBaseVersion?: number) => boolean | void;
  onApplyBody?: (text: string, mode: "replace" | "append", proposalBaseVersion?: number) => boolean | void;
  onClose?: () => void;
  sourceNotice?: string;
  /** Presentation mode; all modes use the same conversation/run session. */
  hostMode?: AIHostMode;
  onHostModeChange?: (mode: AIHostMode) => void;
  fillHost?: boolean;
  sessionKey?: string;
  historyKey?: string | null;
  assistantMode?: "ask" | "agent";
  pageContext?: PageAIContext;
  onAIRequestStart?: () => void;
  onSelectSession?: (sessionId: string) => void;
}

interface QuickAction {
  key: string;
  label: string;
  prompt: string;
  enabled: number | boolean;
}

interface AIReferenceOption {
  id: string;
  token: string;
  /** 发送给模型的可读引用文本；token 仍保留在菜单中作为稳定标识。 */
  displayToken?: string;
  label: string;
  detail?: string;
  group: string;
}

interface AICommandOption {
  id: string;
  label: string;
  detail?: string;
}

interface ComposerToken {
  key: string;
  kind: "reference" | "command";
  raw: string;
  display: string;
}

type NoteDraftFieldActions = {
  title?: AIAction;
  bodyReplace?: AIAction;
  bodyAppend?: AIAction;
  tags?: AIAction;
};

const EMPTY_SELECTED_ASSETS: Item[] = [];

function AIResponseBlocks({
  blocks,
  noteDraftActions,
  onNoteDraftAction,
}: {
  blocks: AIResponseBlock[];
  noteDraftActions?: NoteDraftFieldActions;
  onNoteDraftAction?: (action: AIAction, block: Extract<AIResponseBlock, { type: "note-draft" }>) => boolean;
}) {
  const [appliedActions, setAppliedActions] = useState<Record<string, string>>({});

  function fieldAction(action: AIAction | undefined, fieldLabel: string, buttonLabel: string, block: Extract<AIResponseBlock, { type: "note-draft" }>) {
    if (!action || !onNoteDraftAction) return null;
    const appliedLabel = appliedActions[action.id];
    return (
      <button
        type="button"
        onClick={() => {
          if (onNoteDraftAction(action, block)) {
            setAppliedActions((current) => ({ ...current, [action.id]: buttonLabel === "追加" ? "已追加" : "已替换" }));
          }
        }}
        title={appliedLabel ? "内容已立即写入笔记，自动保存已开始" : action.description ?? `${fieldLabel}${buttonLabel}到当前笔记`}
        aria-label={appliedLabel ? `${fieldLabel}：${appliedLabel}` : `${fieldLabel}：${buttonLabel}`}
        className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${appliedLabel ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-zinc-200 bg-white text-zinc-500 hover:border-[#ff2442]/40 hover:bg-[#fff5f6] hover:text-[#c81d36]"}`}
      >
        {appliedLabel && <Check size={11} />}
        {appliedLabel ?? buttonLabel}
      </button>
    );
  }

  return (
    <div className="space-y-2.5">
      {blocks.map((block, index) => {
        if (block.type === "markdown") return <MdContent key={index} content={block.content} />;
        if (block.type === "note-draft") return (
          <section key={index} className="space-y-2 rounded-xl border border-zinc-200 bg-white p-3">
            {block.title && <div><div className="mb-1 flex items-center justify-between gap-2"><div className="text-[10px] font-medium text-zinc-400">标题</div>{fieldAction(noteDraftActions?.title, "标题", "替换", block)}</div><div className="font-medium text-zinc-800">{block.title}</div></div>}
            {block.body && <div><div className="mb-1 flex items-center justify-between gap-2"><div className="text-[10px] font-medium text-zinc-400">正文</div><div className="flex shrink-0 items-center gap-1.5">{fieldAction(noteDraftActions?.bodyReplace, "正文", "替换", block)}{fieldAction(noteDraftActions?.bodyAppend, "正文", "追加", block)}</div></div><div className="whitespace-pre-wrap leading-relaxed text-zinc-700">{block.body}</div></div>}
            {block.tags.length > 0 && <div><div className="mb-1 flex items-center justify-between gap-2"><div className="text-[10px] font-medium text-zinc-400">标签</div>{fieldAction(noteDraftActions?.tags, "标签", "替换", block)}</div><div className="flex flex-wrap gap-1">{block.tags.map((tag, tagIndex) => <span key={`${tag}-${tagIndex}`} className="rounded-full bg-[#fff0f2] px-2 py-0.5 text-[10px] text-[#d21f3a]">#{tag}</span>)}</div></div>}
          </section>
        );
        if (block.type === "metrics") return (
          <div key={index} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {block.items.map((item, itemIndex) => <div key={`${item.label}-${itemIndex}`} className="rounded-lg border border-zinc-200 bg-white px-2.5 py-2"><div className="text-[10px] text-zinc-400">{item.label}</div><div className="mt-0.5 font-semibold text-zinc-800">{item.value}</div>{item.detail && <div className="mt-0.5 text-[10px] text-zinc-500">{item.detail}</div>}</div>)}
          </div>
        );
        if (block.type === "table") return (
          <div key={index} className="overflow-x-auto rounded-lg border border-zinc-200 bg-white"><table className="min-w-full text-left text-[11px]"><thead className="bg-zinc-50 text-zinc-500"><tr>{block.columns.map((column, columnIndex) => <th key={`${column}-${columnIndex}`} className="px-2.5 py-2 font-medium">{column}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-t border-zinc-100">{block.columns.map((_, columnIndex) => <td key={columnIndex} className="px-2.5 py-2 text-zinc-700">{row[columnIndex] ?? "—"}</td>)}</tr>)}</tbody></table></div>
        );
        if (block.type === "persona-fields") return <dl key={index} className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white px-3">{block.fields.map((field, fieldIndex) => <div key={`${field.label}-${fieldIndex}`} className="grid grid-cols-[minmax(5rem,0.35fr)_1fr] gap-3 py-2"><dt className="text-zinc-400">{field.label}</dt><dd className="whitespace-pre-wrap text-zinc-700">{field.value}</dd></div>)}</dl>;
        if (block.type === "diff") return <div key={index} className="space-y-2">{block.items.map((item, itemIndex) => <div key={`${item.label}-${itemIndex}`} className="rounded-lg border border-zinc-200 bg-white p-2.5"><div className="mb-1 font-medium text-zinc-700">{item.label}</div>{item.before != null && <div className="whitespace-pre-wrap text-zinc-500"><span className="mr-1 text-[10px] text-zinc-400">原内容</span>{item.before}</div>}{item.after != null && <div className="mt-1 whitespace-pre-wrap text-zinc-800"><span className="mr-1 text-[10px] text-[#ff2442]">建议</span>{item.after}</div>}</div>)}</div>;
        if (block.type === "checklist") return <ul key={index} className="space-y-1.5">{block.items.map((item, itemIndex) => <li key={`${item.label}-${itemIndex}`} className="flex gap-2"><span className={item.done ? "text-emerald-600" : "text-zinc-300"}>{item.done ? "✓" : "○"}</span><span className="whitespace-pre-wrap">{item.label}</span></li>)}</ul>;
        return null;
      })}
    </div>
  );
}

function findNoteDraft(response: AIResponseEnvelope): Extract<AIResponseBlock, { type: "note-draft" }> | undefined {
  return response.blocks.find((block): block is Extract<AIResponseBlock, { type: "note-draft" }> => block.type === "note-draft");
}

function isFieldScopedAction(action: AIAction): boolean {
  return action.handler?.startsWith("apply-note-") ?? false;
}

function hostModeIcon(mode: AIHostMode) {
  if (mode === "floating") return <PictureInPicture2 size={14} />;
  if (mode === "sidebar") return <PanelRight size={14} />;
  return <Maximize2 size={14} />;
}

interface EmptySessionSuggestion {
  title: string;
  detail: string;
  prompt: string;
}

function getEmptySessionSuggestions(context: PageAIContext): EmptySessionSuggestion[] {
  const noteTitle = context.draft?.title?.trim();
  if (context.objectType === "note") {
    const currentNote = noteTitle ? `「${noteTitle}」` : "这篇笔记";
    return [
      { title: "检查笔记", detail: "看看标题、正文和标签是否一致", prompt: `请检查当前笔记${currentNote}的标题、正文和标签，指出最值得先改的一处。` },
      { title: "提炼亮点", detail: "整理核心信息和读者能获得的价值", prompt: `请从当前笔记${currentNote}中提炼 3 个核心亮点，并说明读者最关心哪一个。` },
      { title: "给出优化稿", detail: "保留原意，改善表达和可读性", prompt: `请基于当前笔记${currentNote}，给出标题、正文和标签的优化建议，先不要直接修改。` },
    ];
  }
  if (context.page.includes("数据") || context.route === "/data") {
    return [
      { title: "总结近期表现", detail: "找出值得关注的变化", prompt: "请总结当前账号近期笔记表现，并指出最值得关注的变化。" },
      { title: "找内容规律", detail: "比较高表现笔记的共同点", prompt: "请结合当前可用数据，分析高表现笔记有哪些共同点。" },
      { title: "规划下一步", detail: "把复盘结论转成可执行建议", prompt: "根据当前数据复盘，给我 3 条下一步内容运营建议。" },
    ];
  }
  if (context.page.includes("素材") || context.route === "/library") {
    return [
      { title: "整理素材", detail: "按主题和场景梳理当前素材", prompt: "请帮我梳理当前素材的主题和使用场景，并建议如何分类。" },
      { title: "寻找选题", detail: "从素材中找适合当前账号的方向", prompt: "请从当前素材中找出适合当前账号的 3 个笔记选题。" },
      { title: "生成笔记思路", detail: "把素材转成内容结构", prompt: "请基于当前选中的素材，给我一份笔记标题和内容结构建议。" },
    ];
  }
  if (context.page.includes("人设") || context.page.includes("账号")) {
    return [
      { title: "检查账号人设", detail: "找出定位表达中的空缺", prompt: "请检查当前账号人设信息是否清晰、完整，指出需要补充的部分。" },
      { title: "梳理表达风格", detail: "总结适合账号的语气和表达", prompt: "请根据当前账号资料，整理一份简洁的表达风格建议。" },
      { title: "规划内容方向", detail: "让选题更贴近目标受众", prompt: "请结合当前账号定位和目标受众，建议 3 个稳定的内容方向。" },
    ];
  }
  if (context.page.includes("灵感")) {
    return [
      { title: "找 3 个选题", detail: "结合当前灵感和账号方向", prompt: "请结合当前灵感和账号方向，给我 3 个具体可做的选题。" },
      { title: "分析参考账号", detail: "提炼可借鉴的内容方法", prompt: "请分析当前选中的参考账号，提炼值得借鉴的内容方法。" },
      { title: "生成笔记草稿", detail: "先给结构，便于继续编辑", prompt: "请基于当前选题生成一份笔记草稿，分标题、正文和标签建议。" },
    ];
  }
  if (context.page.includes("记忆") || context.route === "/memory") {
    return [
      { title: "帮我记一条", detail: "说一件想让 AI 长期记住的事实", prompt: "帮我记一条事实记忆：我搬到了新的出租屋，厨房是开放式的。存好后告诉我记了什么。" },
      { title: "提炼经验提示词", detail: "从偏好里抽可注入的写法规则", prompt: "帮我把「先吐槽再给结论、短句换行、不提高品质」整理成一条经验提示词。" },
      { title: "检查记忆", detail: "看哪些已启用、哪些可能过时", prompt: "请帮我梳理当前记忆里哪些条目可能已过时或和别的冲突，给出处理建议。" },
    ];
  }
  return [
    { title: "整理当前工作", detail: "总结重点和待办", prompt: "请根据当前页面和账号上下文，帮我整理目前最重要的事项。" },
    { title: "优化一篇笔记", detail: "检查标题、正文和标签", prompt: "我想优化一篇笔记，请先告诉我需要提供或检查哪些内容。" },
    { title: "规划下一步", detail: "给出几条可执行建议", prompt: "结合当前账号情况，给我 3 条下一步内容运营建议。" },
  ];
}

function getReadableObjectLabel(context: PageAIContext, noteId?: number, itemId?: number): string | null {
  if (context.objectType === "note" || noteId != null) {
    return `笔记「${context.draft?.title?.trim() || "未命名笔记"}」`;
  }
  if (context.objectType === "item" || itemId != null) {
    return `素材「${context.objectLabel?.trim() || `素材 ${itemId ?? context.objectId}`}」`;
  }
  if (context.objectId == null) return null;
  const objectTypeLabels: Record<string, string> = {
    topic: "选题",
    account: "账号",
    "reference-workspace": "榜样与参考",
  };
  const typeLabel = objectTypeLabels[context.objectType ?? ""] ?? context.objectType ?? "当前项目";
  const objectLabel = context.objectLabel?.trim();
  return objectLabel ? `${typeLabel}「${objectLabel}」` : `${typeLabel}「${context.objectId}」`;
}

// ── 主组件 ────────────────────────────────────────────────────────
export default function AIPanel({
  noteId, itemId, accountId, systemExtra,
  available = true, unavailableReason, unavailableNextStep,
  onApply, onApplyTitle, onApplyTags, onApplyBody, onClose, sourceNotice,
  hostMode = "sidebar", onHostModeChange, fillHost = false, sessionKey: providedSessionKey,
  historyKey, assistantMode, pageContext: providedPageContext,
  onAIRequestStart,
  onSelectSession,
}: AIPanelProps) {
  const navigate = useNavigate();
  const { accountId: contextAccountId, scopeKey } = useAccountContext();
  const registeredPageContext = usePageAIContext();
  const pageContext = providedPageContext ?? registeredPageContext;
  const effectiveAccountId = accountId ?? pageContext.accountId ?? contextAccountId;
  const sessionKey = providedSessionKey ?? makeAISessionKey(
    { accountId: effectiveAccountId, noteId, itemId },
    `${pageContext.route}:${pageContext.objectId ?? "workspace"}`,
  );
  const [localHostMode, setLocalHostMode] = useState<AIHostMode>(hostMode);
  const activeHostMode = onHostModeChange ? hostMode : localHostMode;
  const [hostModeMenuOpen, setHostModeMenuOpen] = useState(false);
  const hostModeMenuRef = useRef<HTMLDivElement>(null);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [agentSessions, setAgentSessions] = useState<AgentSessionMetadata[]>([]);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const [contextDetailsOpen, setContextDetailsOpen] = useState(false);
  const [selectedContextOpen, setSelectedContextOpen] = useState(false);
  const [promptMode, setPromptMode] = useState<"ask" | "agent">(assistantMode ?? "ask");
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false);
  const [referenceSearch, setReferenceSearch] = useState("");
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [commandSearch, setCommandSearch] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>(IS_TAURI_RUNTIME ? "" : "model-api");
  const [input, setInput] = useState("");
  const [composerTokens, setComposerTokens] = useState<ComposerToken[]>([]);
  const previousSessionKeyRef = useRef(sessionKey);
  useEffect(() => setPromptMode(assistantMode ?? "ask"), [assistantMode]);
  useEffect(() => {
    if (previousSessionKeyRef.current === sessionKey) return;
    previousSessionKeyRef.current = sessionKey;
    setInput("");
    setComposerTokens([]);
    setReferenceMenuOpen(false);
    setCommandMenuOpen(false);
  }, [sessionKey]);
  useEffect(() => {
    const refresh = () => setAgentSessions(readAgentSessions(effectiveAccountId));
    refresh();
    return subscribeAgentSessions(refresh);
  }, [effectiveAccountId]);
  useWorkspaceEffect(() => {
    if (!historyMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!historyMenuRef.current?.contains(event.target as Node)) setHistoryMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [historyMenuOpen]);
  useWorkspaceEffect(() => {
    if (!hostModeMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!hostModeMenuRef.current?.contains(event.target as Node)) setHostModeMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHostModeMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [hostModeMenuOpen]);
  const changeHostMode = (mode: AIHostMode) => {
    setHostModeMenuOpen(false);
    if (mode === "page") {
      onHostModeChange?.(mode);
      openAgentWorkspace();
      return;
    }
    if (onHostModeChange) {
      onHostModeChange(mode);
      return;
    }
    if (mode === "floating") {
      window.dispatchEvent(new CustomEvent(GLOBAL_AI_EVENT, { detail: { sessionKey, historyKey: historyKey ?? null } }));
      onClose?.();
      return;
    }
    setLocalHostMode(mode);
  };
  const { data: localWorkspace } = useQuery({
    queryKey: ["local-workspace", scopeKey, "workspace"],
    queryFn: () => readLocalWorkspaceSnapshot(effectiveAccountId ?? undefined, "workspace"),
    enabled: IS_TAURI_RUNTIME && effectiveAccountId !== null,
    staleTime: 30_000,
  });
  const unresolvedSelectedAssetIds = useMemo(() => (pageContext.selectedItems ?? [])
    .filter((item) => item.kind === "素材" && !item.label)
    .map((item) => Number(item.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0), [pageContext.selectedItems]);
  const { data: remoteSelectedAssets = EMPTY_SELECTED_ASSETS } = useQuery<Item[]>({
    queryKey: ["ai-selected-context-assets", scopeKey, unresolvedSelectedAssetIds],
    queryFn: () => Promise.all(unresolvedSelectedAssetIds.map((id) => api.get(`/api/library/${id}`) as Promise<Item>)),
    enabled: available && !IS_TAURI_RUNTIME && unresolvedSelectedAssetIds.length > 0,
    staleTime: 30_000,
  });
  const selectedContextItems = useMemo(() => {
    const selection: AISelectionDetail[] = pageContext.selectedItems?.length
      ? pageContext.selectedItems
      : pageContext.selectedIds.map((id) => ({ id, kind: "项目" }));
    if (selection.length === 0) return [];
    const selectedAssetIds = new Set(selection
      .filter((item) => item.kind === "素材")
      .map((item) => Number(item.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0));
    const assetById = new Map<number, Item>();
    if (selectedAssetIds.size > 0) {
      for (const item of localWorkspace?.items ?? []) {
        if (selectedAssetIds.has(item.id)) assetById.set(item.id, localItemToItem(item));
      }
      for (const item of remoteSelectedAssets) assetById.set(item.id, item);
    }
    return selection.map((item) => {
      const asset = item.kind === "素材" ? assetById.get(Number(item.id)) : undefined;
      return {
        id: item.id,
        kind: item.kind || "项目",
        label: item.label?.trim() || asset?.title?.trim() || `${item.kind || "项目"} ${item.id}`,
      };
    });
  }, [localWorkspace?.items, pageContext.selectedIds, pageContext.selectedItems, remoteSelectedAssets]);
  const contextObjectLabel = getReadableObjectLabel(pageContext, noteId, itemId);
  const contextTitle = contextObjectLabel ? `${pageContext.page} · ${contextObjectLabel}` : pageContext.page;
  const welcomeSuggestions = useMemo(() => getEmptySessionSuggestions(pageContext), [pageContext]);
  const { data: localInspirations = [] } = useQuery({
    queryKey: ["local-ai-inspirations", scopeKey],
    queryFn: () => readLocalInspirations(effectiveAccountId ?? undefined),
    enabled: IS_TAURI_RUNTIME && effectiveAccountId !== null,
    staleTime: 3_000,
  });
  const { data: localKnowledgePreferences } = useQuery({
    queryKey: ["local-knowledge-preferences", scopeKey],
    queryFn: () => readLocalKnowledgePreferences(effectiveAccountId ?? undefined),
    enabled: IS_TAURI_RUNTIME && effectiveAccountId !== null,
    staleTime: 3_000,
  });
  const { data: localQuickActions = [] } = useQuery<QuickAction[]>({
    queryKey: ["local-settings-prompts", scopeKey],
    queryFn: () => listPromptConfigs(effectiveAccountId ?? undefined),
    enabled: IS_TAURI_RUNTIME && effectiveAccountId !== null,
    staleTime: 30_000,
  });
  const localKnowledge = useMemo(() => buildLocalKnowledgeContext({
    notes: (localWorkspace?.notes ?? []).map(localNoteToNote),
    profile: localWorkspace?.profile ? localProfileToProfile(localWorkspace.profile) : undefined,
    references: (localWorkspace?.referenceAccounts ?? []).map(localReferenceAccountToReferenceAccount),
    inspirations: localInspirations,
    preferences: localKnowledgePreferences,
  }), [localInspirations, localKnowledgePreferences, localWorkspace]);
  // 记忆注入：默认只用 PC 池（不串手机池）；候选与失效条目在 buildMemoryContext 内过滤。
  const { data: memoryEntries = [] } = useQuery({
    queryKey: ["ai-memory-entries", scopeKey],
    queryFn: () => listMemoryEntries({ accountPoolId: effectiveAccountId ?? undefined, origin: "pc", enabled: true }),
    enabled: IS_TAURI_RUNTIME && effectiveAccountId !== null,
    staleTime: 3_000,
  });
  const { data: memoryPrompts = [] } = useQuery({
    queryKey: ["ai-memory-prompts", scopeKey],
    queryFn: () => listExperiencePrompts(effectiveAccountId ?? undefined, "pc"),
    enabled: IS_TAURI_RUNTIME && effectiveAccountId !== null,
    staleTime: 3_000,
  });
  const memoryContext = useMemo(
    () =>
      buildMemoryContext({
        entries: memoryEntries,
        prompts: memoryPrompts,
        origin: "pc",
        target: noteId != null || pageContext.objectType === "note" ? "compose" : "chat",
        includeMobilePool: false,
      }),
    [memoryEntries, memoryPrompts, noteId, pageContext.objectType],
  );
  const noteReferenceIndex = (localWorkspace?.notes ?? []).slice(0, 40).map((note) => `${note.id}=${note.title || `笔记 ${note.id}`}`).join("；");
  const selectedReferenceContext = composerTokens
    .filter((token) => token.kind === "reference")
    .map((token) => token.raw)
    .join("；");
  const effectiveSystemExtra = [
    systemExtra,
    pageAIContextPrompt({ ...pageContext, accountId: effectiveAccountId }),
    noteReferenceIndex ? `可引用笔记目录（仅可引用其中 ID）：${noteReferenceIndex}` : "",
    selectedReferenceContext ? `用户本轮显式引用：${selectedReferenceContext}` : "",
    localKnowledge.prompt,
    memoryContext.prompt,
  ].filter(Boolean).join("\n\n");
  const [selectedLocalProviderId, setSelectedLocalProviderId] = useState<LocalAIProviderStatus["id"] | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [localProviders, setLocalProviders] = useState<LocalAIProviderStatus[]>([]);
  const { data: modelApiSettings } = useQuery<ModelApiSettingsView>({
    queryKey: ["model-api-settings"],
    queryFn: readModelApiSettings,
    enabled: IS_TAURI_RUNTIME,
    staleTime: 30_000,
  });
  const { data: aiRuntime } = useQuery<AiRuntimeSettings>({
    queryKey: ["ai-runtime-settings"],
    queryFn: readAiRuntimeSettings,
    enabled: IS_TAURI_RUNTIME,
    staleTime: 30_000,
  });
  const connectedModelProviders = (modelApiSettings?.providers ?? []).filter((provider) => provider.configured);
  const modelApiProviderId = selectedConnectionId.startsWith("model-api:")
    ? selectedConnectionId.slice("model-api:".length)
    : selectedConnectionId === "model-api"
      ? (modelApiSettings?.defaultProviderId || connectedModelProviders[0]?.id || "")
      : "";
  const pickerGroups = useMemo<DefaultPickerGroup[]>(() => {
    const groups: DefaultPickerGroup[] = [];
    for (const provider of connectedModelProviders) {
      const models = provider.enabledModels.length > 0 ? provider.enabledModels : (provider.model ? [provider.model] : []);
      if (models.length === 0) continue;
      groups.push({
        kind: "model-api",
        provider: provider.id,
        label: provider.label,
        entries: models.map((model) => ({
          key: `${provider.id}:${model}`,
          kind: "model-api" as const,
          provider: provider.id,
          providerLabel: provider.label,
          model,
          modelLabel: model,
        })),
      });
    }
    for (const provider of localProviders.filter((item) => item.state === "present")) {
      const enabled = aiRuntime?.agentCli.enabledModels[provider.id] ?? [];
      const values = enabled.length > 0 ? enabled : cliDefaultModelValues(provider.id);
      groups.push({
        kind: "agent-cli",
        provider: provider.id,
        label: provider.label,
        entries: values.map((model) => ({
          key: `cli:${provider.id}:${model}`,
          kind: "agent-cli" as const,
          provider: provider.id,
          providerLabel: provider.label,
          model,
          modelLabel: cliModelLabel(provider.id, model),
        })),
      });
    }
    return groups;
  }, [connectedModelProviders, localProviders, aiRuntime?.agentCli.enabledModels]);
  const pickerCurrent = useMemo(() => {
    if (modelApiProviderId) return { kind: "model-api" as const, provider: modelApiProviderId, model: selectedModel };
    if (selectedLocalProviderId) return { kind: "agent-cli" as const, provider: selectedLocalProviderId, model: selectedModel };
    return null;
  }, [modelApiProviderId, selectedLocalProviderId, selectedModel]);
  const { messages, streaming, loading, error, run, send, retry, clear, abort } = useAIStream({
    noteId,
    itemId,
    accountId,
    systemExtra: effectiveSystemExtra,
    localProviderId: selectedLocalProviderId ?? undefined,
    localProviderScope: scopeKey,
    connection: modelApiProviderId ? "model-api" : "agent-cli",
    modelApiProviderId: modelApiProviderId || undefined,
    modelApiModel: selectedModel || undefined,
    sessionKey,
    historyKey: historyKey ?? undefined,
    assistantMode: promptMode,
  });
  function sendPrompt(text: string) {
    if (!text.trim() || loading) return;
    onAIRequestStart?.();
    const noteEditing = noteId != null && Boolean(onApplyTitle || onApplyBody || onApplyTags);
    send(text, false, noteEditing ? {
      ...(typeof pageContext.objectVersion === "number" ? { proposalBaseVersion: pageContext.objectVersion } : {}),
      proposalNoteId: noteId,
      proposalAccountId: effectiveAccountId ?? null,
    } : undefined);
  }
  const responseEnvelopes = useMemo(
    () => messages.map((message) => message.role === "assistant" ? parseAIResponse(message.content) : null),
    [messages],
  );
  const [copied, setCopied] = useState<number | null>(null);
  const [memorySaveDraft, setMemorySaveDraft] = useState<MemorySaveDraft | null>(null);
  const qc = useQueryClient();
  const [localProbeError, setLocalProbeError] = useState<string | null>(null);
  const [localProbeVersion, setLocalProbeVersion] = useState(0);
  const [checkingLocalProvider, setCheckingLocalProvider] = useState(IS_TAURI_RUNTIME);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function openNoteReference(reference: AIResponseEnvelope["references"][number]) {
    if (reference.type !== "note") return;
    const targetNoteId = Number(reference.id);
    if (!Number.isSafeInteger(targetNoteId) || targetNoteId <= 0) return;
    changeHostMode("sidebar");
    const params = new URLSearchParams({ aiSession: sessionKey, aiHost: "sidebar" });
    navigate(`/notes/${targetNoteId}?${params.toString()}`);
    onClose?.();
  }

  function executeResponseAction(
    actionId: string,
    response: AIResponseEnvelope,
    selectedDraft?: Extract<AIResponseBlock, { type: "note-draft" }>,
    proposalBaseVersion?: number,
  ): boolean {
    const action = pageContext.availableActions.find((candidate) => candidate.id === actionId);
    if (!action || (!action.handler && !action.href)) return false;
    if (action.requiresConfirmation && !window.confirm(`确认执行“${action.label}”吗？`)) return false;
    if (action.handler?.startsWith("apply-note-") && proposalBaseVersion == null && !window.confirm("这条历史提案没有记录生成时的笔记版本，仍要应用到当前笔记吗？")) return false;
    const draft = selectedDraft ?? findNoteDraft(response);
    if (action.handler === "apply-note-title") {
      if (!draft?.title || !onApplyTitle) return false;
      return onApplyTitle(draft.title, proposalBaseVersion) !== false;
    }
    if (action.handler === "apply-note-body-replace" || action.handler === "apply-note-body-append") {
      if (!draft?.body || !onApplyBody) return false;
      return onApplyBody(draft.body, action.handler === "apply-note-body-replace" ? "replace" : "append", proposalBaseVersion) !== false;
    }
    if (action.handler === "apply-note-tags") {
      if (!draft?.tags.length || !onApplyTags) return false;
      return onApplyTags(draft.tags.map((tag) => `#${tag}`).join(" "), proposalBaseVersion) !== false;
    }
    if (action.handler === "navigate" && action.href) {
      navigate(action.href);
      return true;
    }
    if (action.handler === "save-note-draft") {
      window.dispatchEvent(new CustomEvent(PAGE_AI_ACTION_EVENT, {
        detail: { actionId: action.id, response, sessionKey, accountId: effectiveAccountId, onComplete: () => onClose?.() },
      }));
      return true;
    }
    if (action.handler === "save-memory-entry" || action.handler === "save-experience-prompt") {
      const requested = response.actions.find((item) => item.id === action.id);
      const params = requested?.params ?? {};
      const fromParams = typeof params.content === "string" ? params.content : "";
      const fromBlocks = response.blocks.find((block) => block.type === "markdown")?.content ?? "";
      const content = (fromParams || fromBlocks || response.blocks.map((b) => ("content" in b ? b.content : "")).join("\n")).trim();
      setMemorySaveDraft({
        mode: action.handler === "save-experience-prompt" ? "prompt" : "entry",
        title: typeof params.title === "string" ? params.title : "",
        content: content.slice(0, 1000),
        kind: typeof params.kind === "string" ? params.kind as MemorySaveDraft["kind"] : undefined,
        subject: typeof params.subject === "string" ? params.subject : "",
        source: "AI 会话",
      });
      return true;
    }
    return false;
  }

  function canExecuteResponseAction(action: AIAction): boolean {
    if (action.handler === "apply-note-title") return Boolean(onApplyTitle);
    if (action.handler === "apply-note-body-replace" || action.handler === "apply-note-body-append") return Boolean(onApplyBody);
    if (action.handler === "apply-note-tags") return Boolean(onApplyTags);
    if (action.handler === "navigate") return Boolean(action.href);
    if (action.handler === "save-note-draft") return true;
    if (action.handler === "save-memory-entry" || action.handler === "save-experience-prompt") return IS_TAURI_RUNTIME;
    return false;
  }

  /** 会话尾部一键沉淀：把本轮助手回复存为记忆/经验，默认停用。 */
  function openSaveDraft(mode: "entry" | "prompt", messageContent: string) {
    const seed = messageContent.replace(/\s+/g, " ").trim().slice(0, 500);
    setMemorySaveDraft({
      mode,
      title: seed.slice(0, 20) || "会话经验",
      content: seed || "（请补充内容）",
      kind: mode === "entry" ? "expression" : undefined,
      source: "AI 会话",
    });
  }

  useWorkspaceEffect(() => {
    if (!IS_TAURI_RUNTIME) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active) return;
      setCheckingLocalProvider(true);
      setLocalProbeError(null);
      (localProbeVersion > 0 ? refreshLocalAIProviders() : probeLocalAIProviders())
        .then((providers) => {
          if (!active) return;
          setLocalProviders(providers);
          const availableProvider = providers.find((provider) => provider.state === "present");
          setSelectedLocalProviderId((current) => (
            current && providers.some((provider) => provider.id === current && provider.state === "present")
              ? current
              : availableProvider?.id ?? null
          ));
          setSelectedConnectionId((current) => (
            current && (current === "model-api" || providers.some((provider) => provider.id === current && provider.state === "present"))
              ? current
              : availableProvider?.id ?? (IS_TAURI_RUNTIME ? "" : "model-api")
          ));
          if (!providers.some((provider) => provider.state === "present")) {
            const failed = providers
              .filter((provider) => provider.state === "failed")
              .map((provider) => `${provider.label}：${provider.reason}`);
            setLocalProbeError(failed.length > 0 ? failed.join("；") : "未发现 claude、codex 或 opencode CLI");
          }
        })
        .catch(() => {
          if (active) {
            setLocalProviders([]);
            setSelectedLocalProviderId(null);
            setLocalProbeError("桌面进程无法完成本地 CLI 检测");
          }
        })
        .finally(() => {
          if (active) setCheckingLocalProvider(false);
        });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [localProbeVersion]);

  const localProvider = localProviders.find((provider) => provider.id === selectedLocalProviderId && provider.state === "present")
    ?? localProviders.find((provider) => provider.state === "present")
    ?? null;
  const verifiedLocalProviders = new Set(readVerifiedLocalAIProviders(scopeKey));
  const localProviderTextVerified = localProvider ? localProvider.text || verifiedLocalProviders.has(localProvider.id) : false;
  const localReady = localProvider?.state === "present";
  const aiReady = available || localReady;

  useEffect(() => {
    if (!IS_TAURI_RUNTIME) return;
    const preferred = readPreferredLocalAIProvider(scopeKey);
    setSelectedLocalProviderId(preferred);
    if (preferred) setSelectedConnectionId(preferred);
  }, [scopeKey]);

  // 从后端加载快捷操作
  const { data: remoteQuickActions = [] } = useQuery<QuickAction[]>({
    queryKey: ["quick-actions"],
    queryFn: () => api.get("/api/settings/prompts"),
    enabled: available && !IS_TAURI_RUNTIME,
    staleTime: 30_000,
  });
  const quickActions = IS_TAURI_RUNTIME ? localQuickActions : remoteQuickActions;
  const enabledActions = quickActions.filter((a) => Boolean(a.enabled));

  // 经验库注入状态（轻量轮询，staleTime 长）
  const { data: knowledgeRules = [] } = useQuery<{ enabled: boolean }[]>({
    queryKey: ["knowledge-rules"],
    queryFn: () => api.get("/api/knowledge/rules"),
    enabled: available && !IS_TAURI_RUNTIME,
    staleTime: 60_000,
  });
  const { data: knowledgeSamples = [] } = useQuery<{ use_as_reference: boolean }[]>({
    queryKey: ["knowledge-my-samples"],
    queryFn: () => api.get("/api/knowledge/my-samples"),
    enabled: available && !IS_TAURI_RUNTIME,
    staleTime: 60_000,
  });
  const { data: knowledgeRefGroups = [] } = useQuery<{ notes: unknown[] }[]>({
    queryKey: ["knowledge-ref-samples"],
    queryFn: () => api.get("/api/knowledge/ref-samples"),
    enabled: available && !IS_TAURI_RUNTIME,
    staleTime: 60_000,
  });
  const remoteKnowledgeSummary = (() => {
    const nRules = knowledgeRules.filter((r) => r.enabled).length;
    const nMy = knowledgeSamples.filter((s) => s.use_as_reference).length;
    const nRef = knowledgeRefGroups.reduce((s: number, g) => s + g.notes.length, 0);
    const parts: string[] = [];
    if (nRules) parts.push(`${nRules} 条规律`);
    if (nMy) parts.push(`${nMy} 篇高赞样本`);
    if (nRef) parts.push(`${nRef} 篇榜样参考`);
    return parts.length ? `经验库已注入：${parts.join(" · ")}` : "";
  })();
  const knowledgeSummary = IS_TAURI_RUNTIME ? localKnowledge.summary : remoteKnowledgeSummary;
  const memorySummary = IS_TAURI_RUNTIME ? memoryContext.summary : "";
  const contextSummary = [knowledgeSummary, memorySummary].filter(Boolean).join(" · ");

  // ── 拖拽调整宽度
  const { width, dragging, onDragStart } = usePanelResize({
    defaultWidth: 420,
    min: 320,
    max: 720,
    direction: "left",
    storageKey: "ai-panel-width",
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    if (!historyKey || effectiveAccountId == null || messages.length === 0) return;
    const latest = [...messages].reverse().find((message) => message.role === "user" && message.content.trim())
      ?? [...messages].reverse().find((message) => message.content.trim());
    if (latest) touchAgentSession(effectiveAccountId, historyKey, latest.content);
  }, [effectiveAccountId, historyKey, messages]);

  function handleSend() {
    const tokenText = composerTokens.map((token) => token.display).join(" ");
    const prompt = [tokenText, input.trim()].filter(Boolean).join("\n");
    if (!aiReady || !prompt.trim()) return;
    sendPrompt(prompt);
    setInput("");
    setComposerTokens([]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      setReferenceMenuOpen(false);
      setCommandMenuOpen(false);
      return;
    }
    if (e.key === "Backspace" && !input.trim() && composerTokens.length > 0) {
      e.preventDefault();
      setInput("");
      setComposerTokens((current) => current.slice(0, -1));
      return;
    }
    if (e.key === "@") {
      setReferenceSearch("");
      setReferenceMenuOpen(true);
      setCommandMenuOpen(false);
    } else if (e.key === "/" && !input.trim()) {
      setCommandSearch("");
      setCommandMenuOpen(true);
      setReferenceMenuOpen(false);
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  function openAgentWorkspace() {
    const query = new URLSearchParams({ session: sessionKey, mode: promptMode });
    navigate(`/assistant?${query.toString()}`);
    onClose?.();
  }

  function startNewSession() {
    setInput("");
    setComposerTokens([]);
    clear();
    if (activeHostMode === "floating") {
      navigate("/assistant?new=1");
      onClose?.();
    }
  }

  async function copyText(text: string, idx: number) {
    await navigator.clipboard.writeText(text);
    setCopied(idx);
    setTimeout(() => setCopied(null), 1500);
  }

  const referenceOptions = useMemo<AIReferenceOption[]>(() => {
    const options: AIReferenceOption[] = [
      { id: "page", token: "@page", displayToken: `@当前页 · ${pageContext.page}`, label: `当前页 · ${pageContext.page}`, group: "当前上下文" },
      { id: "account", token: "@account", displayToken: "@当前账号", label: "当前账号", detail: effectiveAccountId == null ? "待确认" : `账号 ${effectiveAccountId}`, group: "当前上下文" },
    ];
    if (pageContext.objectId != null || noteId != null || itemId != null) {
      const objectId = pageContext.objectId ?? noteId ?? itemId;
      const objectLabel = contextObjectLabel ?? `项目 ${objectId}`;
      options.push({ id: "object", token: `@object:${objectId}`, displayToken: `@${objectLabel}`, label: objectLabel, detail: objectLabel, group: "当前上下文" });
    }
    if (pageContext.selectedIds.length > 0) {
      options.push({ id: "selection", token: "@selection", displayToken: `@当前选中 · ${pageContext.selectedIds.length} 项`, label: "当前选中", detail: `${pageContext.selectedIds.length} 项`, group: "当前上下文" });
    }
    for (const note of (localWorkspace?.notes ?? []).slice(0, 8)) {
      const label = note.title || `笔记 ${note.id}`;
      options.push({ id: `note-${note.id}`, token: `@note:${note.id}`, displayToken: `@笔记 · ${label}`, label, group: "最近笔记" });
    }
    for (const item of (localWorkspace?.items ?? []).slice(0, 8)) {
      const label = item.title || `素材 ${item.id}`;
      options.push({ id: `asset-${item.id}`, token: `@asset:${item.id}`, displayToken: `@素材 · ${label}`, label, group: "最近素材" });
    }
    for (const inspiration of localInspirations.slice(0, 8)) {
      const label = inspiration.title || `灵感 ${inspiration.id}`;
      options.push({ id: `inspiration-${inspiration.id}`, token: `@inspiration:${inspiration.id}`, displayToken: `@灵感 · ${label}`, label, group: "最近灵感" });
    }
    for (const reference of (localWorkspace?.referenceAccounts ?? []).slice(0, 8)) {
      const refId = reference.id ?? reference.accountId;
      const label = reference.name || reference.accountId || `榜样 ${refId}`;
      options.push({ id: `reference-${refId}`, token: `@reference:${refId}`, displayToken: `@榜样 · ${label}`, label, group: "榜样" });
    }
    return options;
  }, [contextObjectLabel, effectiveAccountId, itemId, localInspirations, localWorkspace, noteId, pageContext]);

  const commandOptions = useMemo<AICommandOption[]>(() => [
    ...pageContext.availableActions.map((action) => ({ id: action.id, label: action.label, detail: action.requiresConfirmation ? "执行前确认" : "当前页可用" })),
    { id: "new-session", label: "新建会话", detail: "清空当前输入和对话" },
    { id: "clear-session", label: "清空当前会话", detail: "移除当前历史消息" },
  ], [pageContext.availableActions]);

  const filteredReferences = referenceOptions.filter((option) => {
    const query = referenceSearch.trim().toLowerCase();
    return !query || `${option.label} ${option.detail ?? ""} ${option.token}`.toLowerCase().includes(query);
  });
  const filteredCommands = commandOptions.filter((option) => {
    const query = commandSearch.trim().toLowerCase();
    return !query || `${option.label} ${option.detail ?? ""} ${option.id}`.toLowerCase().includes(query);
  });

  function removeTrailingTrigger(current: string): string {
    return current.replace(/(?:^|\s)([@/])[^\s]*$/, (match) => match.startsWith(" ") ? " " : "").trimEnd();
  }

  function addComposerToken(token: Omit<ComposerToken, "key">) {
    setInput((current) => `${removeTrailingTrigger(current)} `);
    setComposerTokens((current) => [
      ...current,
      { ...token, key: `${token.kind}-${Date.now()}-${current.length}` },
    ]);
    setReferenceMenuOpen(false);
    setCommandMenuOpen(false);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleReferenceSelect(option: AIReferenceOption) {
    addComposerToken({
      kind: "reference",
      raw: option.token,
      display: option.displayToken ?? option.token,
    });
  }

  function handleCommandSelect(option: AICommandOption) {
    if (option.id === "new-session") {
      startNewSession();
      setCommandMenuOpen(false);
      return;
    }
    if (option.id === "clear-session") {
      setInput("");
      setComposerTokens([]);
      clear();
      setCommandMenuOpen(false);
      return;
    }
    addComposerToken({
      kind: "command",
      raw: `/${option.id}`,
      display: `/${option.label}`,
    });
  }

  function handleInputChange(value: string) {
    // 兼容用户手动输入或旧会话里的结构化 token：输入区显示可读名称，
    // 不把内部的 note:31 / asset:12 暴露给用户。
    const displayValue = referenceOptions.reduce((current, option) => (
      option.displayToken ? current.split(option.token).join(option.displayToken) : current
    ), value);
    const atMatch = displayValue.match(/(?:^|\s)@([^\s]*)$/);
    const slashMatch = displayValue.match(/(?:^|\s)\/([^\s]*)$/);
    // 触发 @ / 菜单后，符号和搜索词由弹层承载，正文区保持干净；
    // 选择候选项时再以一个完整块回填。
    const inputWithoutTrigger = (atMatch || slashMatch)
      ? displayValue.replace(/(?:^|\s)([@/])[^\s]*$/, (match) => match.startsWith(" ") ? " " : "")
      : displayValue;
    setInput(inputWithoutTrigger);
    setReferenceSearch(atMatch?.[1] ?? "");
    setCommandSearch(slashMatch?.[1] ?? "");
    if (atMatch) setReferenceMenuOpen(true);
    else if (!slashMatch) setReferenceMenuOpen(false);
    if (slashMatch) setCommandMenuOpen(true);
    else if (!atMatch) setCommandMenuOpen(false);
  }

  function applyPickerTarget(kind: "model-api" | "agent-cli", provider: string, model: string) {
    setSelectedModel(model);
    if (kind === "model-api") {
      setSelectedConnectionId(`model-api:${provider}`);
      setSelectedLocalProviderId(null);
    } else {
      setSelectedConnectionId(provider);
      setSelectedLocalProviderId(provider as LocalAIProviderStatus["id"]);
      savePreferredLocalAIProvider(scopeKey, provider as LocalAIProviderStatus["id"]);
    }
  }

  const pageActions = pageContext.availableActions.filter((action) => !isFieldScopedAction(action));
  const hasContextDetails = Boolean(sourceNotice || pageActions.length || localReady || contextSummary || localProbeError);
  const normalizedHistoryQuery = historyQuery.trim().toLocaleLowerCase();
  const filteredAgentSessions = agentSessions.filter((session) => (
    !normalizedHistoryQuery || `${session.title} ${session.lastMessagePreview}`.toLocaleLowerCase().includes(normalizedHistoryQuery)
  ));

  return (
    <div
      className={`ai-panel-drawer creator-note-aux-panel creator-note-ai-panel flex flex-col bg-white relative ${
        activeHostMode === "floating" ? "rounded-2xl border border-zinc-200 shadow-2xl h-[min(720px,calc(100vh-32px))]" :
        activeHostMode === "page" ? "ai-panel-page h-full w-full" : "h-full border-l border-zinc-100 shrink-0"
      }`}
      style={{ width: activeHostMode === "page" || fillHost ? "100%" : width, cursor: dragging ? "col-resize" : undefined }}
    >
      {/* 左侧拖拽条：视觉 4px，热区 12px（负 margin 扩展左侧） */}
      {!fillHost && activeHostMode === "sidebar" && <div
        onMouseDown={onDragStart}
        className={`absolute left-0 top-0 bottom-0 z-10 flex items-center justify-center
                    group cursor-col-resize`}
        style={{ width: 12, marginLeft: -4 }}
        title="拖动调整宽度"
      >
        {/* 视觉指示线 */}
        <div
          className={`w-[3px] h-full rounded-full transition-colors duration-150
            ${dragging ? "bg-[#ff2442]" : "bg-transparent group-hover:bg-[#ff2442]/40"}`}
        />
      </div>}

      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-100 px-4">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-[#ff2442]" />
          <span className="text-sm font-semibold text-zinc-800">AI 助手</span>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={startNewSession} title="新建会话" className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700">
            <Plus size={15} />
          </button>
          {activeHostMode !== "page" && (
            <div className="relative" ref={hostModeMenuRef}>
              <button
                type="button"
                onClick={() => setHostModeMenuOpen((current) => !current)}
                aria-label="切换 AI 显示方式"
                aria-haspopup="menu"
                aria-expanded={hostModeMenuOpen}
                title="切换显示方式"
                className={`flex h-8 items-center gap-1 rounded-lg px-2 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 ${hostModeMenuOpen ? "bg-zinc-100 text-zinc-800" : ""}`}
              >
                {hostModeIcon(activeHostMode)}
                <ChevronDown size={12} />
              </button>
              {hostModeMenuOpen && (
                <div role="menu" aria-label="AI 显示方式" className="absolute right-0 top-full z-40 mt-2 w-52 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-xl">
                  {(["sidebar", "floating", "page"] as AIHostMode[]).map((modeId) => {
                    const modeInfo = AI_HOST_MODES.find((mode) => mode.id === modeId)!;
                    return (
                      <button
                        key={modeId}
                        type="button"
                        role="menuitemradio"
                        aria-checked={activeHostMode === modeId}
                        onClick={() => changeHostMode(modeId)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${activeHostMode === modeId ? "bg-zinc-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-50"}`}
                      >
                        <span className="text-zinc-500">{hostModeIcon(modeId)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-medium">{modeInfo.label === "独立页" ? "在 AI 页面打开" : modeInfo.label}</span>
                          <span className="mt-0.5 block truncate text-[10px] text-zinc-400">{modeInfo.description}</span>
                        </span>
                        {activeHostMode === modeId && <Check size={13} className="shrink-0 text-[#ff2442]" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {activeHostMode === "floating" && onSelectSession && (
            <div className="relative" ref={historyMenuRef}>
              <button
                type="button"
                onClick={() => setHistoryMenuOpen((current) => !current)}
                aria-label="选择会话历史"
                aria-haspopup="dialog"
                aria-expanded={historyMenuOpen}
                title="会话历史"
                className={`rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 ${historyMenuOpen ? "bg-zinc-100 text-zinc-800" : ""}`}
              >
                <History size={15} />
              </button>
              {historyMenuOpen && (
                <div role="dialog" aria-label="会话历史" className="absolute right-0 top-full z-[70] mt-2 flex max-h-[min(420px,calc(100vh-96px))] w-[min(320px,calc(100vw-40px))] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white p-2 shadow-2xl">
                  <div className="flex shrink-0 items-center justify-between px-1 pb-2">
                    <span className="text-xs font-semibold text-zinc-700">会话历史</span>
                    <span className="text-[10px] text-zinc-400">{filteredAgentSessions.length} 条</span>
                  </div>
                  <label className="relative mb-2 block shrink-0">
                    <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                    <input
                      value={historyQuery}
                      onChange={(event) => setHistoryQuery(event.target.value)}
                      placeholder="搜索会话标题或内容"
                      aria-label="搜索会话标题或内容"
                      className="h-8 w-full rounded-lg border border-zinc-200 bg-zinc-50 pl-8 pr-2 text-[11px] text-zinc-700 outline-none transition placeholder:text-zinc-400 focus:border-[#ff2442]/50 focus:bg-white"
                    />
                  </label>
                  <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
                    {filteredAgentSessions.length === 0 ? (
                      <p className="px-2 py-4 text-center text-[11px] text-zinc-400">{normalizedHistoryQuery ? "没有匹配的会话" : "还没有可选的历史会话"}</p>
                    ) : filteredAgentSessions.map((session) => {
                      const active = session.id === sessionKey;
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => {
                            onSelectSession(session.id);
                            setHistoryMenuOpen(false);
                            setHistoryQuery("");
                          }}
                          className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition ${active ? "bg-[#fff1f3] text-[#c81d36]" : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"}`}
                          title={session.lastMessagePreview || session.title}
                        >
                          <MessageSquare size={13} className="mt-0.5 shrink-0 opacity-70" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11px] font-medium">{session.title}</span>
                            {session.lastMessagePreview && <span className="mt-0.5 block truncate text-[10px] opacity-65">{session.lastMessagePreview}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          {messages.length > 0 && (
            <button onClick={clear} title="清空对话" className="p-1 text-zinc-400 hover:text-zinc-600 rounded transition-colors">
              <RotateCcw size={13} />
            </button>
          )}
          {onClose && (
            <>
              {activeHostMode !== "floating" && (
                <button
                  onClick={onClose}
                  aria-label="收起 AI 助手"
                  className="creator-note-aux-collapse px-1.5 py-1 text-[11px] text-zinc-400 hover:text-zinc-700 rounded transition-colors"
                >
                  收起
                </button>
              )}
              <button onClick={onClose} aria-label="关闭 AI 助手" className="p-1 text-zinc-400 hover:text-zinc-600 rounded transition-colors">
                <X size={14} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-zinc-100 bg-[var(--color-surface-2)] px-4 py-1 text-[10px] text-zinc-400">
        <span className="truncate" title={`${contextTitle} · ${effectiveAccountId == null ? "账号待确认" : `账号 ${effectiveAccountId}`}`}>
          {contextTitle} · {effectiveAccountId == null ? "账号待确认" : `账号 ${effectiveAccountId}`}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`${run?.status === "running" ? "text-amber-600" : run?.status === "failed" ? "text-red-500" : run?.status === "interrupted" ? "text-amber-600" : "text-zinc-400"}`}>
            {run?.status === "running" ? "进行中" : run?.status === "interrupted" ? "已中断" : run?.status === "failed" ? "失败" : "就绪"}
          </span>
          {hasContextDetails && (
            <button type="button" onClick={() => setContextDetailsOpen((current) => !current)} aria-expanded={contextDetailsOpen} className="flex items-center gap-0.5 rounded px-1 py-0.5 text-zinc-400 transition hover:bg-[var(--color-surface)] hover:text-zinc-700" title="查看上下文与能力详情">
              详情 <ChevronDown size={11} className={`transition-transform ${contextDetailsOpen ? "rotate-180" : ""}`} />
            </button>
          )}
        </div>
      </div>
      {contextDetailsOpen && hasContextDetails && (
        <div className="max-h-32 shrink-0 space-y-1.5 overflow-y-auto border-b border-zinc-100 bg-[var(--color-surface-2)] px-4 py-2 text-[10px] leading-relaxed text-zinc-500">
          {sourceNotice && <p>{sourceNotice}</p>}
          {pageActions.length > 0 && <p>本页可用操作：{pageActions.slice(0, 5).map((action) => action.label).join(" · ")}</p>}
          {localReady && <p>本地 AI CLI：{localProvider.label} · {localProviderTextVerified ? "文本输出已验证" : "等待真实文本输出验证"} · 图片和工具能力尚未声明</p>}
          {contextSummary && <p>{contextSummary}</p>}
          {localProbeError && <p className="text-red-600">{localProbeError}</p>}
        </div>
      )}

      {!aiReady && (
        <div className="mx-3 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 shrink-0" role="status">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-amber-800">AI 生成暂未可用</p>
            {IS_TAURI_RUNTIME && !checkingLocalProvider && (
              <button
                type="button"
                onClick={() => setLocalProbeVersion((version) => version + 1)}
                className="text-[10px] text-amber-800 underline underline-offset-2 hover:text-amber-950"
              >
                重新检测
              </button>
            )}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-amber-700">
            {checkingLocalProvider ? "正在检测本地 AI CLI" : unavailableReason ?? "当前运行环境没有可用的 AI Provider"}。
            {unavailableNextStep ? ` ${unavailableNextStep}。` : ""}
            {localProbeError ? ` ${localProbeError}。` : ""}
          </p>
        </div>
      )}

      {/* 对话区 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className={`flex min-h-full w-full flex-col space-y-3 ${activeHostMode === "page" ? "mx-auto max-w-3xl" : ""}`}>
        {messages.length === 0 && !loading && !streaming && !error && aiReady && (
          <div className={`flex min-h-full w-full flex-col justify-center py-4 ${activeHostMode === "page" ? "" : "mx-auto max-w-lg"}`}>
            <div className="mb-3 flex items-center gap-2 text-zinc-500">
              <Sparkles size={15} className="text-[#ff2442]" />
              <span className="text-xs font-medium">从当前页面开始</span>
            </div>
            <div className="grid gap-2">
              {welcomeSuggestions.map((suggestion) => (
                <button
                  key={suggestion.title}
                  type="button"
                  onClick={() => sendPrompt(suggestion.prompt)}
                  disabled={loading}
                  className="group rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-left transition hover:border-[#ff2442]/35 hover:bg-[#fff8f9] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="block text-xs font-medium text-zinc-700 group-hover:text-[#c81d36]">{suggestion.title}</span>
                  <span className="mt-0.5 block text-[10px] leading-relaxed text-zinc-400">{suggestion.detail}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => {
          const isLast = i === messages.length - 1;
          const response = responseEnvelopes[i];
          const responseActions = response?.actions.flatMap((requested) => {
            const declared = pageContext.availableActions.find((action) => action.id === requested.id);
            return declared && canExecuteResponseAction(declared) ? [{ requested, declared }] : [];
          }) ?? [];
          const hasNoteDraft = response?.blocks.some((block) => block.type === "note-draft") ?? false;
          const proposalScopeMatches = msg.proposalNoteId === noteId && msg.proposalAccountId === effectiveAccountId;
          const hasRestorableProposalVersion = proposalScopeMatches && typeof msg.proposalBaseVersion === "number";
          const legacySessionMatchesNote = noteId != null && historyKey === makeAISessionKey({ accountId: effectiveAccountId, noteId });
          const hasProposalScopeMetadata = msg.proposalNoteId != null || Object.prototype.hasOwnProperty.call(msg, "proposalAccountId") || typeof msg.proposalBaseVersion === "number";
          const canRestoreNoteDraftActions = hasNoteDraft && (
            hasRestorableProposalVersion || (!hasProposalScopeMetadata && legacySessionMatchesNote)
          );
          const noteDraftActions = canRestoreNoteDraftActions ? {
            title: pageContext.availableActions.find((action) => action.handler === "apply-note-title" && canExecuteResponseAction(action)),
            bodyReplace: pageContext.availableActions.find((action) => action.handler === "apply-note-body-replace" && canExecuteResponseAction(action)),
            bodyAppend: pageContext.availableActions.find((action) => action.handler === "apply-note-body-append" && canExecuteResponseAction(action)),
            tags: pageContext.availableActions.find((action) => action.handler === "apply-note-tags" && canExecuteResponseAction(action)),
          } : undefined;
          const footerActions = responseActions.filter(({ declared }) => !isFieldScopedAction(declared));
          return (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              {msg.role === "user" ? (
                <div className="max-w-[85%] bg-[#ff2442] text-white rounded-2xl rounded-tr-sm px-3 py-2 text-xs leading-relaxed">
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
              ) : (
                <div className="w-full max-w-full group select-text">
                  <div className="w-full rounded-2xl rounded-tl-sm border border-zinc-100 bg-zinc-50 px-4 py-3 text-xs text-zinc-700 select-text">
                    {response ? (
                      <AIResponseBlocks
                        blocks={response.blocks}
                        noteDraftActions={noteDraftActions}
                        onNoteDraftAction={(action, block) => executeResponseAction(action.id, response, block, hasRestorableProposalVersion ? msg.proposalBaseVersion : undefined)}
                      />
                    ) : <MdContent content={msg.content} />}
                  </div>
                  {response && (response.references.length > 0 || (isLast && (response.suggestions.length > 0 || footerActions.length > 0))) && (
                    <div className="mt-2 space-y-2 px-1">
                      {response.references.length > 0 && <div className="flex flex-wrap items-center gap-1.5"><span className="text-[10px] text-zinc-400">引用</span>{response.references.map((reference, referenceIndex) => <button key={`${reference.type}-${reference.id}-${referenceIndex}`} type="button" onClick={() => openNoteReference(reference)} disabled={reference.type !== "note"} className={`max-w-full truncate rounded-md border px-2 py-1 text-[10px] ${reference.type === "note" ? "border-zinc-200 bg-white text-zinc-600 hover:border-[#ff2442]/40 hover:text-[#d21f3a]" : "border-zinc-100 bg-zinc-50 text-zinc-400"}`} title={reference.title}>{reference.type === "note" ? `笔记 · ${reference.title}` : `${reference.type} · ${reference.title}`}</button>)}</div>}
                      {isLast && response.suggestions.length > 0 && <div className="space-y-1"><div className="text-[10px] text-zinc-400">Suggest · 继续对话</div><div className="flex flex-wrap gap-1.5">{response.suggestions.map((suggestion, suggestionIndex) => <button key={`${suggestion.text}-${suggestionIndex}`} type="button" disabled={loading} onClick={() => sendPrompt(suggestion.text)} className="max-w-full rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-left text-[10px] text-zinc-600 transition hover:border-[#ff2442]/40 hover:bg-[#fff5f6] hover:text-[#c81d36] disabled:opacity-50" title={suggestion.text}>{suggestion.label}</button>)}</div></div>}
                      {isLast && footerActions.length > 0 && <div className="space-y-1"><div className="text-[10px] text-zinc-400">Action · 页面操作</div><div className="flex flex-wrap gap-1.5">{footerActions.map(({ requested, declared }) => <button key={requested.id} type="button" onClick={() => executeResponseAction(requested.id, response)} className="rounded-md border border-[#ff2442]/20 bg-[#fff5f6] px-2.5 py-1 text-[10px] font-medium text-[#c81d36] transition hover:border-[#ff2442]/50 hover:bg-[#ffedf0]" title={declared.description}>{declared.label}{declared.requiresConfirmation ? " · 确认" : ""}</button>)}</div></div>}
                    </div>
                  )}
                  {isLast && IS_TAURI_RUNTIME && !loading && (
                    <div className="mt-2 space-y-1 px-1">
                      <div className="text-[10px] text-zinc-400">沉淀 · 本轮经验</div>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => openSaveDraft("entry", msg.content)}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-medium text-amber-700 transition hover:bg-amber-100"
                          title="把本轮谈到的事实/偏好存为记忆，默认停用"
                        >
                          存为记忆
                        </button>
                        <button
                          type="button"
                          onClick={() => openSaveDraft("prompt", msg.content)}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-medium text-amber-700 transition hover:bg-amber-100"
                          title="把希望 AI 遵守的写法存为经验提示词"
                        >
                          存为经验
                        </button>
                      </div>
                    </div>
                  )}
                  {/* hover 操作栏 */}
                  <div className="flex gap-2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity px-1">
                    <button
                      onClick={() => copyText(msg.content, i)}
                      className="flex items-center gap-0.5 text-zinc-400 hover:text-zinc-600 text-[10px]"
                    >
                      {copied === i ? <Check size={10} /> : <Copy size={10} />}
                      {copied === i ? "已复制" : "复制"}
                    </button>
                    {onApply && (
                      <button onClick={() => onApply(msg.content)} className="text-[10px] text-[#ff2442] hover:underline">
                        应用到编辑器
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* 流式输出中 */}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[92%] bg-zinc-50 border border-zinc-100 rounded-2xl rounded-tl-sm px-3 py-2.5 text-xs text-zinc-700 select-text">
              {/^(?:\s*```json\s*)?\s*\{\s*"intent"/.test(streaming)
                ? <span className="text-zinc-400">正在整理结构化回复…</span>
                : <MdContent content={streaming} streaming />}
            </div>
          </div>
        )}

        {/* 等待第一个 chunk */}
        {loading && !streaming && (
          <div className="flex justify-start">
            <div className="bg-zinc-50 border border-zinc-100 rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex gap-1 items-center">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 150}ms` }} />
                ))}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start justify-between gap-3 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2" role="alert">
            <span className="min-w-0 whitespace-pre-wrap break-words">{error}</span>
            {messages.some((message) => message.role === "user" && message.content.trim()) && (
              <button
                type="button"
                onClick={() => { onAIRequestStart?.(); retry(); }}
                disabled={loading}
                className="shrink-0 rounded-md border border-red-200 bg-white px-2 py-1 text-[10px] text-red-600 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                重试
              </button>
            )}
          </div>
        )}

        <div ref={bottomRef} />
        </div>
      </div>

      {/* 快捷操作 — 常驻横向滚动，位于输入框上方 */}
      {aiReady && messages.length > 0 && enabledActions.length > 0 && (
        <QuickActionBar actions={enabledActions} onSend={sendPrompt} loading={loading} />
      )}

      {/* 输入框 */}
      <div className="border-t border-zinc-100 p-3 shrink-0">
        <div className={activeHostMode === "page" ? "mx-auto w-full max-w-3xl" : undefined}>
        {selectedContextItems.length > 0 && (
          <div className="mb-2 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap">
            <button
              type="button"
              onClick={() => setSelectedContextOpen((current) => !current)}
              aria-expanded={selectedContextOpen}
              aria-controls="ai-selected-context-items"
              title="查看本次已选内容"
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#ff2442]/10 px-2 py-1 text-[10px] text-[#c81d36] transition hover:bg-[#ff2442]/15"
            >
              已选 {selectedContextItems.length} 项
              <ChevronDown size={11} className={`transition-transform ${selectedContextOpen ? "rotate-180" : ""}`} />
            </button>
          </div>
        )}
        {selectedContextOpen && selectedContextItems.length > 0 && (
          <div id="ai-selected-context-items" className="mb-2 max-h-28 overflow-y-auto rounded-lg border border-zinc-200 bg-[var(--color-surface-2)] p-2">
            <div className="mb-1.5 text-[10px] font-medium text-zinc-500">本次已选内容</div>
            <div className="space-y-1">
              {selectedContextItems.map((item) => (
                <div key={`${item.kind}-${item.id}`} className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-white px-2 py-1.5 text-[10px]">
                  <span className="min-w-0 truncate text-zinc-700" title={item.label}>{item.label}</span>
                  <span className="shrink-0 text-zinc-400">{item.kind} · #{item.id}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="ai-composer-shell relative rounded-xl bg-white transition-colors">
          {referenceMenuOpen && (
            <AIReferencePicker
              options={filteredReferences}
              search={referenceSearch}
              onSearch={setReferenceSearch}
              onSelect={handleReferenceSelect}
              onClose={() => setReferenceMenuOpen(false)}
            />
          )}
          {commandMenuOpen && (
            <AICommandPalette
              options={filteredCommands}
              search={commandSearch}
              onSearch={setCommandSearch}
              onSelect={handleCommandSelect}
              onClose={() => setCommandMenuOpen(false)}
            />
          )}
          {composerTokens.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-zinc-100 px-3 py-2">
              {composerTokens.map((token) => (
                <span
                  key={token.key}
                  title={token.display}
                  className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] leading-4 ${token.kind === "reference" ? "border-[#ff2442]/20 bg-[#fff3f5] text-[#c81d36]" : "border-violet-200 bg-violet-50 text-violet-700"}`}
                >
                  <span className="max-w-[18rem] truncate">{token.display}</span>
                  <button
                    type="button"
                    aria-label={`删除${token.kind === "reference" ? "引用" : "操作"} ${token.display}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setComposerTokens((current) => current.filter((item) => item.key !== token.key))}
                    className="shrink-0 rounded p-0.5 opacity-60 transition hover:bg-white hover:opacity-100"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!aiReady}
            placeholder={promptMode === "agent" ? "描述目标，Agent 会先给出执行计划…" : "提问、搜索知识，或发送想整理的想法…"}
            rows={activeHostMode === "floating" ? 3 : 2}
            className="ai-composer-field w-full resize-none rounded-t-xl px-3 py-2.5 text-xs leading-relaxed placeholder:text-zinc-300 disabled:bg-zinc-50 disabled:text-zinc-400 disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-1 border-t border-zinc-100 px-2 py-1.5">
            <button type="button" onClick={() => { setReferenceSearch("素材"); setReferenceMenuOpen(true); setCommandMenuOpen(false); }} title="引用素材" className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700">
              <Paperclip size={14} />
            </button>
            <button type="button" onClick={() => { setReferenceSearch(""); setReferenceMenuOpen((open) => !open); setCommandMenuOpen(false); }} title="引用笔记、素材或页面" className={`rounded-md p-1.5 transition hover:bg-zinc-100 hover:text-zinc-700 ${referenceMenuOpen ? "bg-zinc-100 text-[#ff2442]" : "text-zinc-400"}`}>
              <AtSign size={14} />
            </button>
            <div className="ml-1 flex items-center rounded-lg border border-zinc-200 bg-zinc-50 p-0.5" role="group" aria-label="助手模式">
              {(["ask", "agent"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPromptMode(mode)}
                  aria-pressed={promptMode === mode}
                  className={`rounded-md px-2.5 py-1 text-[11px] transition ${promptMode === mode ? "bg-white text-[#ff2442] shadow-sm" : "text-zinc-400 hover:text-zinc-600"}`}
                >
                  {mode === "ask" ? "Ask" : "Agent"}
                </button>
              ))}
            </div>
            <div className="ml-auto w-[200px] shrink-0">
              <DefaultModelPicker
                groups={pickerGroups}
                current={pickerCurrent}
                onApply={applyPickerTarget}
              />
            </div>
            {loading ? (
              <button type="button" onClick={abort} className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-red-50 hover:text-red-500" title="停止生成">
                <StopCircle size={17} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!aiReady || (!input.trim() && composerTokens.length === 0)}
                className="rounded-lg bg-[#ff2442] p-1.5 text-white transition hover:bg-[#e01f3a] disabled:opacity-30"
                title="发送"
              >
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-right text-[10px] text-zinc-300">Enter 发送 · Shift+Enter 换行 · {promptMode === "agent" ? "Agent 会先请求确认" : "Ask 只回答和分析"}</p>
        </div>
      </div>
      {memorySaveDraft && (
        <MemorySaveDialog
          draft={memorySaveDraft}
          onClose={() => setMemorySaveDraft(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["memory-entries"] });
            void qc.invalidateQueries({ queryKey: ["experience-prompts"] });
            void qc.invalidateQueries({ queryKey: ["ai-memory-entries"] });
            void qc.invalidateQueries({ queryKey: ["ai-memory-prompts"] });
          }}
        />
      )}
    </div>
  );
}

function AIReferencePicker({
  options,
  search,
  onSearch,
  onSelect,
  onClose,
}: {
  options: AIReferenceOption[];
  search: string;
  onSearch: (value: string) => void;
  onSelect: (option: AIReferenceOption) => void;
  onClose: () => void;
}) {
  let previousGroup = "";
  return (
    <div className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-80 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2">
        <AtSign size={13} className="text-[#ff2442]" />
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="引用当前页、笔记、素材、灵感或榜样…"
          autoFocus
          className="ai-composer-search h-8 min-w-0 flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 text-xs text-zinc-700 outline-none transition-colors focus:border-zinc-300 focus:outline-none focus-visible:outline-none focus:ring-0 placeholder:text-zinc-300"
          onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        />
        <span className="text-[10px] text-zinc-300">结构化引用</span>
      </div>
      <div className="max-h-64 overflow-y-auto p-1">
        {options.length === 0 ? <p className="px-3 py-5 text-center text-xs text-zinc-400">没有匹配的引用</p> : options.map((option) => {
          const showGroup = option.group !== previousGroup;
          previousGroup = option.group;
          return (
            <div key={option.id}>
              {showGroup && <p className="px-2.5 pb-1 pt-2 text-[10px] font-medium text-zinc-400">{option.group}</p>}
              <button type="button" onClick={() => onSelect(option)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-[#fff0f2]">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-[10px] text-zinc-500">@</span>
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-700">{option.label}</span>
                {option.detail && <span className="max-w-[35%] truncate text-[10px] text-zinc-400">{option.detail}</span>}
                <code className="shrink-0 text-[10px] text-zinc-300">{option.token}</code>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AICommandPalette({
  options,
  search,
  onSearch,
  onSelect,
  onClose,
}: {
  options: AICommandOption[];
  search: string;
  onSearch: (value: string) => void;
  onSelect: (option: AICommandOption) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-80 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2">
        <span className="font-mono text-sm text-[#ff2442]">/</span>
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="选择当前页命令…"
          autoFocus
          className="ai-composer-search h-8 min-w-0 flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 text-xs text-zinc-700 outline-none transition-colors focus:border-zinc-300 focus:outline-none focus-visible:outline-none focus:ring-0 placeholder:text-zinc-300"
          onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
        />
        <span className="text-[10px] text-zinc-300">页面能力</span>
      </div>
      <div className="max-h-64 overflow-y-auto p-1">
        {options.length === 0 ? <p className="px-3 py-5 text-center text-xs text-zinc-400">当前页没有匹配命令</p> : options.map((option) => (
          <button key={option.id} type="button" onClick={() => onSelect(option)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-[#fff0f2]">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#fff0f2] font-mono text-xs text-[#ff2442]">/</span>
            <span className="min-w-0 flex-1 truncate text-xs text-zinc-700">{option.label}</span>
            <span className="text-[10px] text-zinc-400">{option.detail}</span>
            <code className="shrink-0 text-[10px] text-zinc-300">/{option.id}</code>
          </button>
        ))}
      </div>
    </div>
  );
}



// ── 常驻快捷操作栏 ─────────────────────────────────────────────────
function QuickActionBar({
  actions,
  onSend,
  loading,
}: {
  actions: QuickAction[];
  onSend: (prompt: string) => void;
  loading: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 鼠标拖拽横向滚动
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragScrollLeft = useRef(0);

  function onMouseDown(e: React.MouseEvent) {
    if (!scrollRef.current) return;
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragScrollLeft.current = scrollRef.current.scrollLeft;
    scrollRef.current.style.cursor = "grabbing";
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!dragging.current || !scrollRef.current) return;
    const dx = e.clientX - dragStartX.current;
    scrollRef.current.scrollLeft = dragScrollLeft.current - dx;
  }

  function onMouseUp() {
    dragging.current = false;
    if (scrollRef.current) scrollRef.current.style.cursor = "grab";
  }

  if (actions.length === 0) return null;

  return (
    <div className="border-t border-zinc-100 shrink-0 py-2 px-2">
      <div
        ref={scrollRef}
        className="flex gap-1.5 overflow-x-auto scrollbar-hide"
        style={{ cursor: "grab", WebkitOverflowScrolling: "touch" }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        {actions.map((a) => (
          <button
            key={a.key}
            onClick={() => onSend(a.prompt)}
            disabled={loading}
            className="text-xs bg-zinc-50 hover:bg-[#ff2442]/10 hover:text-[#ff2442] text-zinc-600
                       px-2.5 py-1.5 rounded-full border border-zinc-200 hover:border-[#ff2442]/30
                       transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 select-none"
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
