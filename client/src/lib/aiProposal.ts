export type AIProposalField = "title" | "body" | "tags";
export type AIProposalStatus = "pending" | "applied" | "conflict";

const AI_PROPOSAL_VERSION = "v1";
const MAX_PROPOSAL_HISTORY = 40;
const MAX_PROPOSAL_VALUE_CHARS = 16_000;

export interface AIProposal {
  id: string;
  accountId: number | null;
  noteId: number;
  baseVersion: number;
  field: AIProposalField;
  /** 采用前编辑器中的字段值，用于可回看的 before/after 差异。 */
  previousValue: string;
  value: string;
  createdAt: string;
  status: AIProposalStatus;
}

export function createProposal(input: Omit<AIProposal, "id" | "createdAt" | "status">): AIProposal {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `proposal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return { ...input, id, createdAt: new Date().toISOString(), status: "pending" };
}

function persistentStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function storageKey(databaseIdentity: string, accountId: number | null, noteId: number): string {
  const accountScope = accountId === null ? "unresolved" : String(accountId);
  return `ai-proposals-${AI_PROPOSAL_VERSION}-db-${encodeURIComponent(databaseIdentity)}-account-${accountScope}-note-${noteId}`;
}

function normalizeProposal(value: unknown): AIProposal | null {
  if (!value || typeof value !== "object") return null;
  const proposal = value as Partial<AIProposal>;
  const fields: AIProposalField[] = ["title", "body", "tags"];
  const statuses: AIProposalStatus[] = ["pending", "applied", "conflict"];
  if (
    typeof proposal.id !== "string" || !proposal.id ||
    (typeof proposal.accountId !== "number" && proposal.accountId !== null) ||
    typeof proposal.noteId !== "number" || !Number.isInteger(proposal.noteId) || proposal.noteId <= 0 ||
    typeof proposal.baseVersion !== "number" || !Number.isInteger(proposal.baseVersion) || proposal.baseVersion < 1 ||
    !fields.includes(proposal.field as AIProposalField) ||
    typeof proposal.previousValue !== "string" || typeof proposal.value !== "string" ||
    typeof proposal.createdAt !== "string" ||
    !statuses.includes(proposal.status as AIProposalStatus)
  ) return null;
  return {
    id: proposal.id,
    accountId: proposal.accountId!,
    noteId: proposal.noteId as number,
    baseVersion: proposal.baseVersion as number,
    field: proposal.field as AIProposalField,
    previousValue: proposal.previousValue.slice(0, MAX_PROPOSAL_VALUE_CHARS),
    value: proposal.value.slice(0, MAX_PROPOSAL_VALUE_CHARS),
    createdAt: proposal.createdAt,
    status: proposal.status!,
  };
}

/**
 * Reads the latest bounded proposal history for one database/account/note scope.
 * AI output is deliberately kept in localStorage only; no credentials or
 * provider request metadata are included in this record.
 */
export function listProposals(databaseIdentity: string, accountId: number | null, noteId: number): AIProposal[] {
  if (!databaseIdentity || !Number.isInteger(noteId) || noteId <= 0) return [];
  try {
    const raw = persistentStorage()?.getItem(storageKey(databaseIdentity, accountId, noteId));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeProposal)
      .filter((proposal): proposal is AIProposal => proposal !== null && proposal.accountId === accountId && proposal.noteId === noteId)
      .slice(0, MAX_PROPOSAL_HISTORY);
  } catch {
    return [];
  }
}

/** Saves one proposal at the front of its scoped, bounded local history. */
export function saveProposal(databaseIdentity: string, proposal: AIProposal): void {
  const normalized = normalizeProposal(proposal);
  if (!normalized || !databaseIdentity) return;
  const current = listProposals(databaseIdentity, normalized.accountId, normalized.noteId);
  const next = [normalized, ...current.filter((item) => item.id !== normalized.id)].slice(0, MAX_PROPOSAL_HISTORY);
  try {
    persistentStorage()?.setItem(storageKey(databaseIdentity, normalized.accountId, normalized.noteId), JSON.stringify(next));
  } catch {
    // Storage may be unavailable or full; the current in-memory proposal still works.
  }
}

export function isProposalCurrent(proposal: AIProposal, current: { accountId: number | null; noteId: number; version: number }): boolean {
  return proposal.accountId === current.accountId && proposal.noteId === current.noteId && proposal.baseVersion === current.version;
}
