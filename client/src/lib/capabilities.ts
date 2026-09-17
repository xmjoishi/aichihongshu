/**
 * Operation-level capability matrix.
 *
 * Runtime identity only selects the transport. Each operation keeps its own
 * availability and explains the next safe step when the local adapter has
 * not been migrated yet.
 */
export type CapabilityId =
  | "note.read"
  | "note.write"
  | "note.items.write"
  | "library.read"
  | "library.import"
  | "library.repair"
  | "library.metadata.write"
  | "ai.generate"
  | "collect"
  | "publish"
  | "note.status.write"
  | "note.delete"
  | "library.delete"
  | "library.analyze"
  | "note.createFromLibrary"
  | "note.export";

export type CapabilityTransport = "local" | "legacy-http";

export interface CapabilityState {
  id: CapabilityId;
  available: boolean;
  transport: CapabilityTransport;
  reason?: string;
  nextStep?: string;
}

const LOCAL_CAPABILITIES: Record<CapabilityId, CapabilityState> = {
  "note.read": { id: "note.read", available: true, transport: "local" },
  "note.write": { id: "note.write", available: true, transport: "local" },
  "note.items.write": { id: "note.items.write", available: true, transport: "local" },
  "note.status.write": { id: "note.status.write", available: true, transport: "local" },
  "library.read": { id: "library.read", available: true, transport: "local" },
  "library.import": {
    id: "library.import",
    available: true,
    transport: "local",
  },
  "library.repair": { id: "library.repair", available: true, transport: "local" },
  "library.metadata.write": { id: "library.metadata.write", available: true, transport: "local" },
  "ai.generate": {
    id: "ai.generate",
    available: false,
    transport: "local",
    reason: "本地 AI Provider 需要运行时检测",
    nextStep: "打开 AI 助手检测已安装 CLI，并完成一次真实文本调用",
  },
  "collect": {
    id: "collect",
    available: false,
    transport: "local",
    reason: "本地收集入口尚未迁移",
    nextStep: "完成来源快照和目标账号校验后开放",
  },
  "publish": {
    id: "publish",
    available: false,
    transport: "local",
    reason: "本地发布链路尚未迁移",
    nextStep: "完成发布准备、浏览器适配和结果核查后开放",
  },
  "note.delete": {
    id: "note.delete",
    available: true,
    transport: "local",
  },
  "library.delete": {
    id: "library.delete",
    available: true,
    transport: "local",
  },
  "library.analyze": {
    id: "library.analyze",
    available: false,
    transport: "local",
    reason: "本地图片分析任务尚未迁移",
    nextStep: "接入已验证的本地 AI 能力后开放",
  },
  "note.createFromLibrary": {
    id: "note.createFromLibrary",
    available: true,
    transport: "local",
  },
  "note.export": {
    id: "note.export",
    available: true,
    transport: "local",
  },
};

const LEGACY_CAPABILITIES: Record<CapabilityId, CapabilityState> = Object.fromEntries(
  (Object.keys(LOCAL_CAPABILITIES) as CapabilityId[]).map((id) => [
    id,
    { id, available: true, transport: "legacy-http" as const },
  ]),
) as Record<CapabilityId, CapabilityState>;

export function detectTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getCapabilityMatrix(isTauri = detectTauriRuntime()): Record<CapabilityId, CapabilityState> {
  return isTauri ? LOCAL_CAPABILITIES : LEGACY_CAPABILITIES;
}

export function getCapability(id: CapabilityId, isTauri = detectTauriRuntime()): CapabilityState {
  return getCapabilityMatrix(isTauri)[id];
}

/** Pure self-check used by static checks and future Rust/adapter contract tests. */
export function validateCapabilityMatrix(matrix: Record<CapabilityId, CapabilityState>): true {
  const required: CapabilityId[] = [
    "note.read",
    "note.write",
    "note.items.write",
    "library.read",
    "library.import",
    "ai.generate",
    "collect",
    "publish",
  ];
  for (const id of required) {
    if (!matrix[id] || matrix[id].id !== id || typeof matrix[id].available !== "boolean") {
      throw new Error(`能力矩阵缺少 ${id}`);
    }
    if (!matrix[id].available && (!matrix[id].reason || !matrix[id].nextStep)) {
      throw new Error(`不可用能力 ${id} 必须提供原因和下一步`);
    }
  }
  return true;
}

validateCapabilityMatrix(LOCAL_CAPABILITIES);
validateCapabilityMatrix(LEGACY_CAPABILITIES);
