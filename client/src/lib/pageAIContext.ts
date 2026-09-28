import { useSyncExternalStore } from "react";

export interface AIAction {
  id: string;
  label: string;
  description?: string;
  requiresConfirmation?: boolean;
  /** UI handler declared by the page; an LLM may request the id but never supply this handler. */
  handler?: "apply-note-title" | "apply-note-body-replace" | "apply-note-body-append" | "apply-note-tags" | "save-note-draft" | "save-memory-entry" | "save-experience-prompt" | "navigate";
  /** Optional in-app destination used only by a page-declared navigate handler. */
  href?: string;
}

export interface AIDraftContext {
  title?: string;
  body?: string;
  tags?: string;
  status?: string;
  dirty?: boolean;
}

export interface AISelectionDetail {
  id: string | number;
  kind?: string;
  label?: string;
}

export interface PageAIContext {
  route: string;
  page: string;
  accountId: number | null;
  objectType?: string;
  objectId?: string | number | null;
  objectLabel?: string;
  objectVersion?: string | number | null;
  selectedIds: Array<string | number>;
  /** Human-readable detail for selected objects shown in the AI context UI. */
  selectedItems?: AISelectionDetail[];
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
export const PAGE_AI_ACTION_EVENT = "aichihongshu:execute-ai-action";

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
    { id: "open-persona", label: "打开人设信息", description: "切换到当前账号的人设信息页", handler: "navigate", href: "/profile?view=persona" },
  ] },
  { match: (route) => route === "/data", page: "数据与复盘", availableActions: [
    { id: "review-data", label: "复盘数据", description: "总结笔记表现并提炼可复用规律" },
    { id: "find-content-patterns", label: "找内容规律", description: "从发布历史中找出选题和互动规律" },
    { id: "open-note-ranking", label: "打开笔记排行", handler: "navigate", href: "/data?view=ranking" },
    { id: "open-content-insights", label: "打开内容规律", handler: "navigate", href: "/data?view=insights" },
    { id: "open-experience-library", label: "打开经验库", handler: "navigate", href: "/data?view=knowledge" },
  ] },
  { match: (route) => route === "/memory", page: "记忆", availableActions: [
    { id: "save-memory-entry", label: "存为记忆", description: "把事实/事件/偏好存入记忆（默认停用）", requiresConfirmation: true, handler: "save-memory-entry" },
    { id: "save-experience-prompt", label: "存为经验提示词", description: "把写法/口吻偏好存为可注入的经验条目", requiresConfirmation: true, handler: "save-experience-prompt" },
    { id: "open-memory-prompts", label: "打开经验提示词", handler: "navigate", href: "/memory?view=prompts" },
    { id: "open-memory-entries", label: "打开事实与事件", handler: "navigate", href: "/memory?view=entries" },
    { id: "open-memory-rules", label: "打开系统规则", handler: "navigate", href: "/memory?view=rules" },
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
    selectedItems: Array.isArray(value.selectedItems) ? value.selectedItems.slice(0, 100) : undefined,
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
  const selected = context.selectedItems?.length
    ? context.selectedItems.map((item) => `${item.kind ? `${item.kind} ` : ""}${item.label || `#${item.id}`}`).join("、")
    : context.selectedIds.length ? context.selectedIds.join(", ") : "无";
  const objectDescription = context.objectType === "note"
    ? `笔记「${context.draft?.title?.trim() || "未命名笔记"}」（ID ${context.objectId ?? "未知"}）`
    : `${context.objectType ? `${context.objectType} ` : ""}${context.objectLabel ? `「${context.objectLabel}」` : context.objectId ?? "无"}`;
  const buttons = context.availableActions.filter((action) => action.handler).map((action) => {
    const confirmation = action.requiresConfirmation ? "（执行前需要确认）" : "";
    return `${action.id}=${action.label}${confirmation}`;
  }).join("；") || "无";
  const draft = context.draft ? `草稿标题：${context.draft.title || "未填写"}；状态：${context.draft.status || "未标记"}` : "当前无草稿摘要";
  return [
    `当前页面：${context.page}（${context.route}）`,
    `上下文来源：${context.source || "page"}${context.requestId ? `；关联请求：${context.requestId}` : ""}`,
    `当前账号：${context.accountId ?? "待确认"}`,
    `当前对象：${objectDescription}${context.objectVersion != null ? `（版本 ${context.objectVersion}）` : ""}；已选对象：${selected}`,
    context.referenceIds?.length ? `引用对象：${context.referenceIds.join(", ")}` : "",
    draft,
    `当前页面可用命令：${actions}`,
    `当前页面已声明的可执行按钮（只能从这里选择 action id；不能创建新 id 或标签）：${buttons}`,
    "回复协议：优先只输出 JSON 对象，不要加代码围栏，字段为 intent、confidence、blocks、references、suggestions、actions。intent 可选 edit-note/create-note/conversation/data-analysis/persona-query/persona-update/other；confidence 为 0 到 1 的意图置信度，低于 0.45 时改用普通 Markdown。blocks 可包含 {type:markdown,content}、{type:note-draft,title,body,tags}、{type:metrics,items:[{label,value,detail}]}、{type:table,columns,rows}、{type:persona-fields,fields:[{label,value}]}、{type:diff,items:[{label,before,after}]}、{type:checklist,items:[{label,done}]}。编辑笔记用 note-draft 分开标题、正文和标签；新增笔记用 note-draft 并只提供页面声明过的保存草稿按钮；普通会话使用 markdown，不展示填标题等操作；数据分析优先用 metrics/table；人设查询用 persona-fields，人设补充用 diff。references 只列出上下文中真实提供的来源 ID、标题和类型；suggestions 是本轮动态生成的 0-4 条自然语言后续问题/回复，点击后会作为新消息发送，不要把页面操作放进 suggestions。actions 只能填写上方页面声明过的按钮 id，可带 params；没有合适按钮就返回空数组。不得臆造来源、按钮、标签或处理器；普通会话没有必要时返回空 suggestions/actions。JSON 无法保证时直接用普通 Markdown。",
    context.permissionScope?.length ? `当前权限范围：${context.permissionScope.join("、")}` : "",
  ].filter(Boolean).join("\n");
}
