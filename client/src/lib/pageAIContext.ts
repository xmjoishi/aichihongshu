import { useSyncExternalStore } from "react";

export interface AIAction {
  id: string;
  label: string;
  description?: string;
  requiresConfirmation?: boolean;
}

export interface AIDraftContext {
  title?: string;
  body?: string;
  tags?: string;
  status?: string;
  dirty?: boolean;
}

export interface PageAIContext {
  route: string;
  page: string;
  accountId: number | null;
  objectType?: string;
  objectId?: string | number | null;
  objectVersion?: string | number | null;
  selectedIds: Array<string | number>;
  referenceIds?: Array<string | number>;
  draft?: AIDraftContext;
  availableActions: AIAction[];
  /** 当前上下文的来源，供后续 Agent/手机 Harness 串联追踪。 */
  source?: "page" | "selection" | "mobile-harness" | "import" | string;
  /** 一次页面动作链的关联 ID。 */
  requestId?: string;
  /** AI 在当前页可触达的能力边界，不等同于自动执行授权。 */
  permissionScope?: string[];
}

export const PAGE_AI_CONTEXT_EVENT = "aichihongshu:page-ai-context";

const DEFAULT_PAGE_CONTEXT: PageAIContext = {
  route: "/",
  page: "概览",
  accountId: null,
  selectedIds: [],
  availableActions: [],
  source: "page",
};

const ROUTE_CONTEXT_DEFAULTS: Array<{
  match: (route: string) => boolean;
  page: string;
  availableActions: AIAction[];
}> = [
  { match: (route) => route === "/" || route === "", page: "概览", availableActions: [
    { id: "summarize-workspace", label: "总结工作台", description: "汇总当前账号近期任务、笔记和待处理事项" },
    { id: "suggest-next-note", label: "规划下一篇", description: "结合人设、素材和近期表现给出选题建议" },
  ] },
  { match: (route) => route === "/library", page: "素材库", availableActions: [
    { id: "organize-assets", label: "整理素材", description: "按主题、场景和可用状态归类当前素材" },
    { id: "create-note-from-assets", label: "用素材生成笔记", description: "基于选中素材生成可编辑草稿" },
  ] },
  { match: (route) => route === "/inspire", page: "灵感", availableActions: [
    { id: "find-topics", label: "找选题", description: "从灵感、热点和账号定位中筛选可执行选题" },
    { id: "analyze-reference", label: "分析榜样", description: "拆解榜样账号的选题、结构和互动表现" },
    { id: "generate-draft", label: "生成草稿", description: "把当前选题转成符合人设的笔记草稿" },
  ] },
  { match: (route) => route === "/notes" || route.startsWith("/notes/"), page: "笔记", availableActions: [
    { id: "improve-note", label: "优化笔记", description: "检查标题、正文、标签和人设一致性" },
    { id: "check-publish", label: "检查发布", description: "检查素材、字段和发布条件", requiresConfirmation: true },
  ] },
  { match: (route) => route === "/profile", page: "我的账号", availableActions: [
    { id: "refine-persona", label: "优化人设", description: "结合账号定位和历史内容优化人设信息" },
    { id: "review-account", label: "查看账号资料", description: "整理当前账号的资料和同步状态" },
  ] },
  { match: (route) => route === "/data", page: "数据与复盘", availableActions: [
    { id: "review-data", label: "复盘数据", description: "总结笔记表现并提炼可复用规律" },
    { id: "find-content-patterns", label: "找内容规律", description: "从发布历史中找出选题和互动规律" },
  ] },
  { match: (route) => route === "/accounts/pool", page: "账号池", availableActions: [
    { id: "switch-account", label: "切换账号", description: "查看并切换当前运营账号", requiresConfirmation: true },
    { id: "inspect-account", label: "查看账号状态", description: "检查账号连接和最近同步状态" },
  ] },
  { match: (route) => route === "/settings", page: "设置", availableActions: [
    { id: "explain-settings", label: "解释当前设置", description: "解释当前 AI、账号和连接配置" },
  ] },
  { match: (route) => route === "/assistant", page: "AI 助手", availableActions: [
    { id: "plan-operation", label: "规划运营任务", description: "把目标拆解成可审阅的运营步骤" },
    { id: "organize-memory", label: "整理个人记忆", description: "从当前会话提炼可保存的人设和偏好" },
  ] },
];

function routeDefaults(route: string): Pick<PageAIContext, "page" | "availableActions"> {
  const match = ROUTE_CONTEXT_DEFAULTS.find((item) => item.match(route));
  return match ? { page: match.page, availableActions: match.availableActions } : {
    page: route || DEFAULT_PAGE_CONTEXT.page,
    availableActions: [],
  };
}

const registry = new Map<string, PageAIContext>();
const fallbackContexts = new Map<string, PageAIContext>();
const listeners = new Set<() => void>();
let bridgeInstalled = false;

function notify(): void {
  listeners.forEach((listener) => listener());
}

function normalizeContext(value: Partial<PageAIContext>): PageAIContext {
  const route = value.route || DEFAULT_PAGE_CONTEXT.route;
  const fallback = routeDefaults(route);
  return {
    ...DEFAULT_PAGE_CONTEXT,
    ...fallback,
    ...value,
    route,
    page: value.page || fallback.page,
    accountId: typeof value.accountId === "number" ? value.accountId : null,
    selectedIds: Array.isArray(value.selectedIds) ? value.selectedIds.slice(0, 100) : [],
    availableActions: Array.isArray(value.availableActions) ? value.availableActions.slice(0, 50) : fallback.availableActions,
    permissionScope: Array.isArray(value.permissionScope) ? value.permissionScope.slice(0, 30) : undefined,
  };
}

function installBridge(): void {
  if (bridgeInstalled || typeof window === "undefined") return;
  bridgeInstalled = true;
  window.addEventListener(PAGE_AI_CONTEXT_EVENT, (event) => {
    const detail = (event as CustomEvent<Partial<PageAIContext>>).detail;
    if (!detail || typeof detail !== "object") return;
    const next = normalizeContext(detail);
    registry.set(next.route, next);
    notify();
  });
}

export function getPageAIContext(route?: string): PageAIContext {
  installBridge();
  const currentRoute = route ?? (typeof window !== "undefined" ? window.location.pathname : DEFAULT_PAGE_CONTEXT.route);
  const registered = registry.get(currentRoute);
  if (registered) return registered;
  const cached = fallbackContexts.get(currentRoute);
  if (cached) return cached;
  const fallback = { ...DEFAULT_PAGE_CONTEXT, ...routeDefaults(currentRoute), route: currentRoute };
  fallbackContexts.set(currentRoute, fallback);
  return fallback;
}

/** Register context for a route and broadcast it to global AI hosts. */
export function publishPageAIContext(context: Partial<PageAIContext>): PageAIContext {
  installBridge();
  const next = normalizeContext(context);
  registry.set(next.route, next);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PAGE_AI_CONTEXT_EVENT, { detail: next }));
  } else {
    notify();
  }
  return next;
}

export function updatePageAIContext(route: string, patch: Partial<Omit<PageAIContext, "route">>): PageAIContext {
  return publishPageAIContext({ ...getPageAIContext(route), ...patch, route });
}

export function clearPageAIContext(route: string): void {
  registry.delete(route);
  notify();
}

export function subscribePageAIContext(listener: () => void): () => void {
  installBridge();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React adapter used by AI hosts and direct page panels. */
export function usePageAIContext(route?: string): PageAIContext {
  return useSyncExternalStore(subscribePageAIContext, () => getPageAIContext(route), () => DEFAULT_PAGE_CONTEXT);
}

export function pageAIContextPrompt(context: PageAIContext): string {
  const actions = context.availableActions.map((action) => {
    const confirmation = action.requiresConfirmation ? "（执行前需确认）" : "";
    const description = action.description ? `：${action.description}` : "";
    return `/${action.id}=${action.label}${description}${confirmation}`;
  }).join("；") || "无";
  const selected = context.selectedIds.length ? context.selectedIds.join(", ") : "无";
  const draft = context.draft ? `草稿标题：${context.draft.title || "未填写"}；状态：${context.draft.status || "未标记"}` : "当前无草稿摘要";
  return [
    `当前页面：${context.page}（${context.route}）`,
    `上下文来源：${context.source || "page"}${context.requestId ? `；关联请求：${context.requestId}` : ""}`,
    `当前账号：${context.accountId ?? "待确认"}`,
    `当前对象：${context.objectType ? `${context.objectType} ` : ""}${context.objectId ?? "无"}${context.objectVersion != null ? `（版本 ${context.objectVersion}）` : ""}；已选对象：${selected}`,
    context.referenceIds?.length ? `引用对象：${context.referenceIds.join(", ")}` : "",
    draft,
    `当前页面可用命令：${actions}`,
    context.permissionScope?.length ? `当前权限范围：${context.permissionScope.join("、")}` : "",
  ].filter(Boolean).join("\n");
}
