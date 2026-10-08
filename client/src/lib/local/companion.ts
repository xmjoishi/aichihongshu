import { invoke } from "@tauri-apps/api/core";
import { requireTauri } from "./runtime";

export interface LocalPcHarnessStatus {
  running: boolean;
  bindAddress?: string | null;
  lanAddresses: string[];
  port: number;
  pairingToken?: string | null;
  protocolVersion: string;
  activeAccountId?: number | null;
  mobileConnected: boolean;
}

export type MobileMemoryCommandOperation =
  | "createEntry"
  | "updateEntry"
  | "setEntryEnabled"
  | "deleteEntry"
  | "createPrompt"
  | "updatePrompt"
  | "setPromptEnabled"
  | "deletePrompt"
  | "seedExamples";

export interface MobileMemoryCommandReceipt {
  cacheSynced: boolean;
  message?: string | null;
  systemRules?: MobileSystemRulesSnapshot | null;
}

export function readPcHarnessStatus(): Promise<LocalPcHarnessStatus> {
  return invoke("pc_harness_status");
}

export function readPcHarnessMobileConnection(): Promise<boolean> {
  return invoke("pc_harness_mobile_connection");
}

export function startPcHarness(): Promise<LocalPcHarnessStatus> {
  return invoke("start_pc_harness");
}

export function stopPcHarness(): Promise<LocalPcHarnessStatus> {
  return invoke("stop_pc_harness");
}

export function rotatePcHarnessToken(): Promise<LocalPcHarnessStatus> {
  return invoke("rotate_pc_harness_token");
}

export function writeMobileMemoryCommand(
  operation: MobileMemoryCommandOperation,
  payload: unknown,
): Promise<MobileMemoryCommandReceipt> {
  requireTauri();
  return invoke("pc_harness_mobile_memory_command", { operation, payload });
}


export interface MobileSystemRulesSnapshot {
  origin: "mobile";
  accountId: number;
  source: string;
  version: string;
  readAt: string;
  editable: false;
  defaultExperience: string;
  outputRules: string;
}

export async function readMobileSystemRules(accountId: number): Promise<MobileSystemRulesSnapshot> {
  requireTauri();
  const result = await invoke<MobileMemoryCommandReceipt>("pc_harness_mobile_memory_command", {
    operation: "readSystemRules", payload: {},
  });
  const rules = result.systemRules;
  if (!rules || rules.origin !== "mobile" || rules.accountId !== accountId || rules.editable !== false
      || !rules.source || !rules.version || !rules.readAt
      || typeof rules.defaultExperience !== "string" || !rules.defaultExperience.trim()
      || typeof rules.outputRules !== "string" || !rules.outputRules.trim()) {
    throw new Error("手机未返回当前账号的系统规则，请更新手机应用并保持前台连接后重试");
  }
  return rules;
}
