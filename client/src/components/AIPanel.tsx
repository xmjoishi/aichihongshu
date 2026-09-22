import { useState, useRef, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, X, RotateCcw, StopCircle, Send, Copy, Check, Plus, Maximize2, AtSign, Paperclip, Search, ChevronDown } from "lucide-react";
import { useAIStream } from "../hooks/useAIStream";
import { MdContent } from "./MdContent";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  IS_TAURI_RUNTIME,
  localNoteToNote,
  localProfileToProfile,
  localReferenceAccountToReferenceAccount,
  listPromptConfigs,
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
import { AI_HOST_MODES, makeAISessionKey, type AIHostMode } from "../lib/aiHost";
import { pageAIContextPrompt, usePageAIContext, type PageAIContext } from "../lib/pageAIContext";
import { touchAgentSession } from "../lib/aiWorkspace";

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
  onApplyTitle?: (title: string) => void;
  onApplyTags?: (tags: string) => void;
  onApplyBody?: (text: string, mode: "replace" | "append") => void;
  onClose?: () => void;
  sourceNotice?: string;
  /** Presentation mode; all modes use the same conversation/run session. */
  hostMode?: AIHostMode;
  onHostModeChange?: (mode: AIHostMode) => void;
  sessionKey?: string;
  historyKey?: string;
  assistantMode?: "ask" | "agent";
  pageContext?: PageAIContext;
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

// ── 检测 AI 输出类型 ─────────────────────────────────────────────
type OutputType = "titles" | "tags" | "body" | "generic";

function detectOutputType(content: string): OutputType {
  // 标题列表：编号 / 情绪型 / 场景型 / 问题型 开头的多行
  const titlePatterns = [
    /^\d+[.、]\s+.{4,}/m,
    /^(情绪型|问题型|场景型)[：:]/m,
  ];
  if (titlePatterns.some((p) => p.test(content))) return "titles";

  // 标签：3 个以上 #标签
  if ((content.match(/#[\u4e00-\u9fa5\w]+/g) || []).length >= 3) return "tags";

  // 正文：字数足够多（> 50 字）且没有被识别为标题/标签
  const plain = content.replace(/<[^>]+>/g, "").replace(/\s/g, "");
  if (plain.length > 50) return "body";

  return "generic";
}

/** 从 AI 回复中提取候选标题列表 */
function extractTitles(content: string): string[] {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const titles: string[] = [];
  for (const line of lines) {
    // 1. 标题  /  情绪型：标题  /  - 标题
    const m =
      line.match(/^\d+[.、]\s*(.+)/) ||
      line.match(/^(?:情绪型|问题型|场景型)[：:]\s*(.+)/) ||
      line.match(/^[-•]\s+(.+)/);
    if (m) {
      const t = m[1].replace(/[（(].*?[)）]/g, "").trim();
      if (t.length >= 4 && t.length <= 30) titles.push(t);
    }
  }
  return titles;
}

/** 从 AI 回复中提取标签列表 */
function extractTags(content: string): string[] {
  return (content.match(/#[\u4e00-\u9fa5\w]+/g) || []);
}

// ── 结构化输出卡片 ─────────────────────────────────────────────────
function StructuredOutput({
  content,
  outputType,
  onApplyTitle,
  onApplyTags,
  onApplyBody,
  onRegenerate,
}: {
  content: string;
  outputType: OutputType;
  onApplyTitle?: (t: string) => void;
  onApplyTags?: (t: string) => void;
  onApplyBody?: (text: string, mode: "replace" | "append") => void;
  onRegenerate?: () => void;
}) {
  const [usedIdx, setUsedIdx] = useState<number | null>(null);
  const [bodyApplied, setBodyApplied] = useState<"replace" | "append" | null>(null);

  if (outputType === "titles") {
    const titles = extractTitles(content);
    if (titles.length === 0) return null;
    return (
      <div className="mt-2 space-y-1">
        <p className="text-[10px] text-zinc-400 font-medium">点击直接使用：</p>
        {titles.map((t, i) => (
          <button
            key={i}
            onClick={() => { onApplyTitle?.(t); setUsedIdx(i); }}
            className={`w-full text-left text-xs px-2.5 py-1.5 rounded-lg border transition-all flex items-center justify-between gap-2 ${
              usedIdx === i
                ? "border-[#ff2442] ring-1 ring-[#ff2442] text-zinc-800 bg-[#fff0f2]"
                : "border-zinc-200 hover:border-[#ff2442] hover:bg-[#fff0f2] text-zinc-700"
            }`}
          >
            <span>{t}</span>
            {usedIdx === i && (
              <span className="shrink-0 text-[10px] text-[#ff2442] font-medium">已使用</span>
            )}
          </button>
        ))}
      </div>
    );
  }

  if (outputType === "tags") {
    const tags = extractTags(content);
    if (tags.length === 0) return null;
    const tagsStr = tags.join(" ");
    return (
      <div className="mt-2">
        <p className="text-[10px] text-zinc-400 font-medium mb-1.5">点击一键填入话题栏：</p>
        <div className="flex flex-wrap gap-1 mb-2">
          {tags.map((tag, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 bg-[#ff2442]/10 text-[#ff2442] rounded-full">{tag}</span>
          ))}
        </div>
        <button
          onClick={() => onApplyTags?.(tagsStr)}
          className="text-xs text-[#ff2442] hover:underline flex items-center gap-1"
        >
          <Check size={10} /> 全部填入话题栏
        </button>
      </div>
    );
  }

  if (outputType === "body") {
    // 从 AI 输出中提取正文部分（兼容多种格式）
    const extractBodyText = (raw: string): string => {
      // 去掉 markdown bold 标记，方便统一匹配
      const text = raw.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");

      // 尝试提取"优化后的正文："/"优化后正文："段落，到下一个分节标题为止
      // 分节标题特征：行首出现"优化说明"/"说明"/"备注"/"---"，或行首是表格 "|"
      const sectionMatch = text.match(
        /优化后(?:的)?正文[：:]\s*\n([\s\S]+?)(?:\n{1,2}(?:优化说明|说明|备注)[：:\s]|\n{1,2}---|\n{1,2}\|.+\||\n{0,2}$)/
      );
      if (sectionMatch) return sectionMatch[1].trim();

      // 没有结构标记，返回去掉首行（如果首行像标题）后的内容
      const lines = text.trim().split("\n");
      if (lines[0].endsWith("：") || lines[0].endsWith(":")) {
        return lines.slice(1).join("\n").trim();
      }
      return text.trim();
    };

    const plainText = extractBodyText(content);

    return (
      <div className="mt-2.5 pt-2.5 border-t border-zinc-200 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-zinc-400">采纳到正文：</span>
        <button
          onClick={() => {
            onApplyBody?.(plainText, "replace");
            setBodyApplied("replace");
          }}
          className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border transition-all ${
            bodyApplied === "replace"
              ? "bg-[#ff2442] text-white border-[#ff2442]"
              : "border-zinc-200 hover:border-[#ff2442] hover:bg-[#fff0f2] text-zinc-700"
          }`}
        >
          {bodyApplied === "replace"
            ? <><Check size={10} /> 已替换</>
            : "替换正文"}
        </button>
        <button
          onClick={() => {
            onApplyBody?.(plainText, "append");
            setBodyApplied("append");
          }}
          className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border transition-all ${
            bodyApplied === "append"
              ? "bg-zinc-700 text-white border-zinc-700"
              : "border-zinc-200 hover:border-zinc-400 hover:bg-zinc-50 text-zinc-600"
          }`}
        >
          {bodyApplied === "append"
            ? <><Check size={10} /> 已追加</>
            : "追加到末尾"}
        </button>
        {onRegenerate && (
          <button
            onClick={() => { setBodyApplied(null); onRegenerate(); }}
            className="text-[10px] text-zinc-400 hover:text-zinc-600 ml-auto flex items-center gap-0.5 transition-colors"
          >
            <RotateCcw size={10} /> 重新生成
          </button>
        )}
      </div>
    );
  }

  return null;
}

// ── 主组件 ────────────────────────────────────────────────────────
export default function AIPanel({
  noteId, itemId, accountId, systemExtra,
  available = true, unavailableReason, unavailableNextStep,
  onApply, onApplyTitle, onApplyTags, onApplyBody, onClose, sourceNotice,
  hostMode = "sidebar", onHostModeChange, sessionKey: providedSessionKey,
  historyKey, assistantMode, pageContext: providedPageContext,
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
  const [promptMode, setPromptMode] = useState<"ask" | "agent">(assistantMode ?? "ask");
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false);
  const [referenceSearch, setReferenceSearch] = useState("");
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [commandSearch, setCommandSearch] = useState("");
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>(IS_TAURI_RUNTIME ? "" : "model-api");
  useEffect(() => setPromptMode(assistantMode ?? "ask"), [assistantMode]);
  const changeHostMode = (mode: AIHostMode) => {
    if (onHostModeChange) onHostModeChange(mode);
    else setLocalHostMode(mode);
  };
  const { data: localWorkspace } = useQuery({
    queryKey: ["local-ai-knowledge", scopeKey],
    queryFn: () => readLocalWorkspaceSnapshot(effectiveAccountId ?? undefined),
    enabled: IS_TAURI_RUNTIME && effectiveAccountId !== null,
    staleTime: 3_000,
  });
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
  const effectiveSystemExtra = [
    systemExtra,
    pageAIContextPrompt({ ...pageContext, accountId: effectiveAccountId }),
    localKnowledge.prompt,
  ].filter(Boolean).join("\n\n");
  const [selectedLocalProviderId, setSelectedLocalProviderId] = useState<LocalAIProviderStatus["id"] | null>(null);
  const { messages, streaming, loading, error, run, send, retry, clear, abort } = useAIStream({
    noteId,
    itemId,
    accountId,
    systemExtra: effectiveSystemExtra,
    localProviderId: selectedLocalProviderId ?? undefined,
    localProviderScope: scopeKey,
    sessionKey,
    historyKey,
    assistantMode: promptMode,
  });
  const [input, setInput] = useState("");
  const [composerTokens, setComposerTokens] = useState<ComposerToken[]>([]);
  const [copied, setCopied] = useState<number | null>(null);
  const [localProviders, setLocalProviders] = useState<LocalAIProviderStatus[]>([]);
  const [localProbeError, setLocalProbeError] = useState<string | null>(null);
  const [localProbeVersion, setLocalProbeVersion] = useState(0);
  const [checkingLocalProvider, setCheckingLocalProvider] = useState(IS_TAURI_RUNTIME);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
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
    send(prompt);
    setInput("");
    setComposerTokens([]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      setReferenceMenuOpen(false);
      setCommandMenuOpen(false);
      setProviderMenuOpen(false);
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
      options.push({ id: "object", token: `@object:${objectId}`, displayToken: `@当前对象 · ${objectId}`, label: "当前对象", detail: String(objectId), group: "当前上下文" });
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
  }, [effectiveAccountId, itemId, localInspirations, localWorkspace, noteId, pageContext]);

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

  function selectConnection(id: string) {
    setSelectedConnectionId(id);
    setProviderMenuOpen(false);
    setProviderSearch("");
    if (id !== "model-api") {
      const providerId = id as LocalAIProviderStatus["id"];
      setSelectedLocalProviderId(providerId);
      savePreferredLocalAIProvider(scopeKey, providerId);
    }
  }

  return (
    <div
      className={`ai-panel-drawer creator-note-aux-panel creator-note-ai-panel flex flex-col bg-white relative ${
        activeHostMode === "floating" ? "rounded-2xl border border-zinc-200 shadow-2xl h-[min(720px,calc(100vh-32px))]" :
        activeHostMode === "page" ? "h-full w-full" : "h-full border-l border-zinc-100 shrink-0"
      }`}
      style={{ width: activeHostMode === "page" ? "100%" : width, cursor: dragging ? "col-resize" : undefined }}
    >
      {/* 左侧拖拽条：视觉 4px，热区 12px（负 margin 扩展左侧） */}
      <div
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
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-[#ff2442]" />
          <span className="text-sm font-semibold text-zinc-800">AI 助手</span>
          {activeHostMode !== "floating" && activeHostMode !== "page" && (
            <select
              value={activeHostMode}
              onChange={(event) => changeHostMode(event.target.value as AIHostMode)}
              aria-label="切换 AI 助手尺寸"
              className="ml-1 rounded-lg border border-zinc-200 bg-white px-1.5 py-1 text-[10px] text-zinc-500 outline-none focus:border-[#ff2442]"
            >
              {AI_HOST_MODES.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
            </select>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={startNewSession} title="新建会话" className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700">
            <Plus size={15} />
          </button>
          {activeHostMode !== "page" && (
            <button type="button" onClick={openAgentWorkspace} title="在 AI 工作区打开" className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-[#ff2442]">
              <Maximize2 size={14} />
            </button>
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

      {sourceNotice && (
        <div className="px-4 py-1.5 bg-[var(--color-selected)] border-b border-[var(--color-border)] shrink-0">
          <p className="text-[10px] text-[var(--color-text-secondary)] leading-relaxed">{sourceNotice}</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-b border-zinc-100 bg-zinc-50/70 px-4 py-1.5 text-[10px] text-zinc-400">
        <span className="truncate">页面：{pageContext.page || pageContext.route} · {effectiveAccountId == null ? "账号待确认" : `账号 ${effectiveAccountId}`}{pageContext.objectId != null ? ` · 对象 ${pageContext.objectId}` : noteId != null ? ` · 笔记 ${noteId}` : itemId != null ? ` · 素材 ${itemId}` : " · 工作区"}</span>
        <span className={`shrink-0 ${run?.status === "running" ? "text-amber-600" : run?.status === "failed" ? "text-red-500" : run?.status === "interrupted" ? "text-amber-600" : "text-zinc-400"}`}>
          {run?.status === "running" ? "任务进行中" : run?.status === "interrupted" ? "任务已中断" : run?.status === "failed" ? "任务失败" : "任务就绪"}
        </span>
      </div>
      {pageContext.availableActions.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-100 px-4 py-1 text-[10px] text-zinc-400">
          <span className="shrink-0">页面操作：</span>
          {pageContext.availableActions.slice(0, 5).map((action) => <span key={action.id} className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5">{action.label}</span>)}
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

      {localReady && activeHostMode !== "floating" && activeHostMode !== "page" && (
        <div className="mx-3 mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 shrink-0" role="status">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-emerald-800">本地 AI CLI：{localProvider.label}</p>
            <span className="text-[10px] text-emerald-700">可在输入区切换 Provider / Model</span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-emerald-700">
            {localProviderTextVerified ? "文本能力已由真实非空输出验证" : "已发现命令，发送一次真实文本后才会确认文本能力"}；图片和工具能力仍未声明。
          </p>
        </div>
      )}

      {/* 经验库注入状态 */}
      {knowledgeSummary && activeHostMode !== "floating" && activeHostMode !== "page" && (
        <div className="px-4 py-1.5 bg-[#ff2442]/5 border-b border-[#ff2442]/10 shrink-0">
          <p className="text-[10px] text-[#ff2442]/70 leading-relaxed">{knowledgeSummary}</p>
        </div>
      )}

      {/* 对话区 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((msg, i) => {
          const isLast = i === messages.length - 1;
          const outputType = msg.role === "assistant" ? detectOutputType(msg.content) : "generic";
          return (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              {msg.role === "user" ? (
                <div className="max-w-[85%] bg-[#ff2442] text-white rounded-2xl rounded-tr-sm px-3 py-2 text-xs leading-relaxed">
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
              ) : (
                <div className="max-w-[92%] group select-text">
                  <div className="bg-zinc-50 border border-zinc-100 rounded-2xl rounded-tl-sm px-3 py-2.5 text-xs text-zinc-700 select-text">
                    <MdContent content={msg.content} />
                    {/* 结构化操作区 —— 仅最后一条 AI 消息显示 */}
                    {isLast && !streaming && (
                      <StructuredOutput
                        content={msg.content}
                        outputType={outputType}
                        onApplyTitle={onApplyTitle}
                        onApplyTags={onApplyTags}
                        onApplyBody={onApplyBody}
                        onRegenerate={() => {
                          // 找到最后一条用户消息重发
                          const lastUser = [...messages].reverse().find((m) => m.role === "user");
                          if (lastUser) send(lastUser.content);
                        }}
                      />
                    )}
                  </div>
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
              <MdContent content={streaming} streaming />
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
                onClick={retry}
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

      {/* 快捷操作 — 常驻横向滚动，位于输入框上方 */}
      {aiReady && enabledActions.length > 0 && (
        <QuickActionBar actions={enabledActions} onSend={send} loading={loading} hasMessages={messages.length > 0} />
      )}

      {/* 输入框 */}
      <div className="border-t border-zinc-100 p-3 shrink-0">
        <div className="mb-2 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap">
          <span className="max-w-[70%] truncate rounded-md bg-zinc-100 px-2 py-1 text-[10px] text-zinc-500" title="当前页面上下文">
            当前页 · {pageContext.page}{pageContext.objectId != null ? ` · 对象 ${pageContext.objectId}` : ""}
          </span>
          {pageContext.selectedIds.length > 0 && (
            <span className="rounded-md bg-[#ff2442]/10 px-2 py-1 text-[10px] text-[#ff2442]">已选 {pageContext.selectedIds.length} 项</span>
          )}
        </div>
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
            <span className="ml-1 hidden max-w-[38%] truncate text-[10px] text-zinc-400 sm:inline" title="当前上下文已自动注入">
              {pageContext.page}{pageContext.objectId != null ? ` · 对象 ${pageContext.objectId}` : ""}
            </span>
            <ProviderModelPopover
              open={providerMenuOpen}
              onOpenChange={setProviderMenuOpen}
              search={providerSearch}
              onSearch={setProviderSearch}
              providers={localProviders}
              selectedId={selectedConnectionId || localProvider?.id || ""}
              onSelect={selectConnection}
              tauriRuntime={IS_TAURI_RUNTIME}
            />
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

function ProviderModelPopover({
  open,
  onOpenChange,
  search,
  onSearch,
  providers,
  selectedId,
  onSelect,
  tauriRuntime,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  search: string;
  onSearch: (value: string) => void;
  providers: LocalAIProviderStatus[];
  selectedId: string;
  onSelect: (id: string) => void;
  tauriRuntime: boolean;
}) {
  const modelApiDisabled = tauriRuntime;
  const selectedProvider = providers.find((provider) => provider.id === selectedId);
  const selectedLabel = selectedProvider?.label ?? (selectedId === "model-api" ? "Model API" : "选择模型");
  const query = search.trim().toLowerCase();
  const filteredProviders = providers.filter((provider) => `${provider.label} ${provider.id} ${provider.version ?? ""}`.toLowerCase().includes(query));
  return (
    <div className="relative ml-auto shrink-0">
      <button type="button" onClick={() => onOpenChange(!open)} aria-expanded={open} aria-label="选择 AI Provider 与模型" className={`flex max-w-[150px] items-center gap-1 rounded-lg border px-2 py-1 text-[11px] text-zinc-500 transition hover:border-[#ff2442]/50 hover:text-zinc-700 ${open ? "border-[#ff2442]/50 bg-[#fff7f8]" : "border-zinc-200 bg-white"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${selectedProvider?.state === "present" || selectedId === "model-api" ? "bg-emerald-500" : "bg-zinc-300"}`} />
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown size={12} className="shrink-0 text-zinc-300" />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-40 mb-2 w-72 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl">
          <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2">
            <Search size={13} className="text-zinc-400" />
        <input value={search} onChange={(event) => onSearch(event.target.value)} autoFocus placeholder="搜索 Provider 或模型…" className="ai-composer-search h-8 min-w-0 flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 text-xs text-zinc-700 outline-none transition-colors focus:border-zinc-300 focus:outline-none focus-visible:outline-none focus:ring-0 placeholder:text-zinc-300" />
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5">
            <p className="px-2 py-1 text-[10px] font-medium text-zinc-400">Model API</p>
            <button type="button" disabled={modelApiDisabled} onClick={() => onSelect("model-api")} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${selectedId === "model-api" ? "bg-[#fff0f2]" : "hover:bg-zinc-50"} disabled:cursor-not-allowed disabled:opacity-40`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-50 text-[10px] text-blue-600">API</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-xs text-zinc-700">兼容模型接口</span><span className="block text-[10px] text-zinc-400">{modelApiDisabled ? "桌面端当前使用 Agent CLI" : "服务端 Model API"}</span></span>
              {selectedId === "model-api" && <Check size={13} className="text-[#ff2442]" />}
            </button>
            <p className="px-2 pb-1 pt-3 text-[10px] font-medium text-zinc-400">Agent CLI</p>
            {filteredProviders.length === 0 ? <p className="px-2.5 py-3 text-xs text-zinc-400">未找到本地 CLI</p> : filteredProviders.map((provider) => (
              <button key={provider.id} type="button" disabled={provider.state !== "present"} onClick={() => onSelect(provider.id)} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${selectedId === provider.id ? "bg-[#fff0f2]" : "hover:bg-zinc-50"} disabled:cursor-not-allowed disabled:opacity-40`}>
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-50 text-[10px] text-emerald-700">CLI</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-xs text-zinc-700">{provider.label}</span><span className="block truncate text-[10px] text-zinc-400">{provider.version ?? provider.reason}</span></span>
                <span className={`text-[10px] ${provider.state === "present" ? "text-emerald-600" : "text-zinc-400"}`}>{provider.state === "present" ? "可用" : provider.state === "missing" ? "未安装" : "检测失败"}</span>
                {selectedId === provider.id && <Check size={13} className="text-[#ff2442]" />}
              </button>
            ))}
          </div>
        </div>
      )}
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
  hasMessages: boolean;
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
