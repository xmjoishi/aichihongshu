import { invoke } from "@tauri-apps/api/core";

import { requireTauri } from "./runtime";

import type {
  LocalKnowledgePreferences,
  LocalKnowledgePreferencesUpdate,
  LocalKnowledgeMySample,
  LocalKnowledgeReferenceGroup,
  LocalKnowledgeReferenceSampleSaveResult,
  LocalPromptConfig,
  LocalPromptConfigUpsert,
  MemoryOrigin,
  LocalMemoryEntry,
  LocalMemoryEntryCreate,
  LocalMemoryEntryUpdate,
  LocalMemoryEntryTransition,
  LocalMemoryEntryFilter,
  LocalExperiencePrompt,
  LocalExperiencePromptUpsert,
  LocalMemorySystemRules,
  LocalNoteStatsUpdate,
  LocalNoteSummary,
} from "../localTypes";

export function readLocalKnowledgePreferences(accountPoolId?: number): Promise<LocalKnowledgePreferences> {
  requireTauri();
  return invoke<LocalKnowledgePreferences>("read_local_knowledge_preferences", { accountPoolId });
}

export function saveLocalKnowledgePreferences(preferences: LocalKnowledgePreferencesUpdate): Promise<LocalKnowledgePreferences> {
  requireTauri();
  return invoke<LocalKnowledgePreferences>("save_local_knowledge_preferences", { preferences });
}

export function readLocalKnowledgeMySamples(accountPoolId?: number): Promise<LocalKnowledgeMySample[]> {
  requireTauri();
  return invoke<LocalKnowledgeMySample[]>("read_local_knowledge_my_samples", { accountPoolId });
}

export function setLocalKnowledgeSampleEnabled(
  noteId: number,
  accountPoolId: number,
  enabled: boolean,
): Promise<void> {
  requireTauri();
  return invoke<void>("set_local_knowledge_sample_enabled", { noteId, accountPoolId, enabled });
}

export function readLocalKnowledgeReferenceSamples(accountPoolId?: number): Promise<LocalKnowledgeReferenceGroup[]> {
  requireTauri();
  return invoke<LocalKnowledgeReferenceGroup[]>("read_local_knowledge_reference_samples", { accountPoolId });
}

export function addLocalKnowledgeReferenceSample(input: {
  accountId: string;
  accountPoolId: number;
  title: string;
  body?: string;
  likes: number;
  noteUrl?: string;
}): Promise<LocalKnowledgeReferenceSampleSaveResult> {
  requireTauri();
  return invoke<LocalKnowledgeReferenceSampleSaveResult>("add_local_knowledge_reference_sample", {
    accountId: input.accountId,
    accountPoolId: input.accountPoolId,
    title: input.title,
    body: input.body,
    likes: input.likes,
    noteUrl: input.noteUrl,
  });
}

export function deleteLocalKnowledgeReferenceSample(
  accountId: string,
  index: number,
  accountPoolId: number,
): Promise<number> {
  requireTauri();
  return invoke<number>("delete_local_knowledge_reference_sample", { accountId, index, accountPoolId });
}

export function listPromptConfigs(accountPoolId?: number): Promise<LocalPromptConfig[]> {
  requireTauri();
  return invoke<LocalPromptConfig[]>("list_prompt_configs", { accountPoolId });
}

export function upsertPromptConfig(config: LocalPromptConfigUpsert): Promise<LocalPromptConfig[]> {
  requireTauri();
  return invoke<LocalPromptConfig[]>("upsert_prompt_config", {
    payload: {
      accountPoolId: config.accountPoolId,
      key: config.key,
      label: config.label,
      prompt: config.prompt,
      sortOrder: config.sortOrder,
      enabled: config.enabled,
    },
  });
}

export function deletePromptConfig(key: string, accountPoolId: number): Promise<LocalPromptConfig[]> {
  requireTauri();
  return invoke<LocalPromptConfig[]>("delete_prompt_config", { key, accountPoolId });
}

export function listMemoryEntries(filter: LocalMemoryEntryFilter = {}): Promise<LocalMemoryEntry[]> {
  requireTauri();
  return invoke<LocalMemoryEntry[]>("list_memory_entries", {
    filter: {
      accountPoolId: filter.accountPoolId,
      origin: filter.origin,
      kind: filter.kind,
      confirmStatus: filter.confirmStatus,
      enabled: filter.enabled,
    },
  });
}

export function createMemoryEntry(entry: LocalMemoryEntryCreate): Promise<LocalMemoryEntry> {
  requireTauri();
  return invoke<LocalMemoryEntry>("create_memory_entry", { entry });
}

export function updateMemoryEntry(entry: LocalMemoryEntryUpdate): Promise<LocalMemoryEntry> {
  requireTauri();
  return invoke<LocalMemoryEntry>("update_memory_entry", { entry });
}

export function deleteMemoryEntry(id: number, accountPoolId: number): Promise<void> {
  requireTauri();
  return invoke<void>("delete_memory_entry", { id, accountPoolId });
}

export function setMemoryEntryEnabled(
  id: number,
  accountPoolId: number,
  enabled: boolean,
): Promise<LocalMemoryEntry> {
  requireTauri();
  return invoke<LocalMemoryEntry>("set_memory_entry_enabled", { id, accountPoolId, enabled });
}

export function transitionMemoryEntryStatus(
  transition: LocalMemoryEntryTransition,
): Promise<LocalMemoryEntry> {
  requireTauri();
  return invoke<LocalMemoryEntry>("transition_memory_entry_status", { transition });
}

export function listExperiencePrompts(
  accountPoolId?: number,
  origin?: MemoryOrigin,
): Promise<LocalExperiencePrompt[]> {
  requireTauri();
  return invoke<LocalExperiencePrompt[]>("list_experience_prompts", { accountPoolId, origin });
}

export function upsertExperiencePrompt(
  prompt: LocalExperiencePromptUpsert,
): Promise<LocalExperiencePrompt[]> {
  requireTauri();
  return invoke<LocalExperiencePrompt[]>("upsert_experience_prompt", { prompt });
}

export function deleteExperiencePrompt(
  id: number,
  accountPoolId: number,
  origin: MemoryOrigin,
): Promise<LocalExperiencePrompt[]> {
  requireTauri();
  return invoke<LocalExperiencePrompt[]>("delete_experience_prompt", { id, accountPoolId, origin });
}

export function readMemorySystemRules(): Promise<LocalMemorySystemRules> {
  requireTauri();
  return invoke<LocalMemorySystemRules>("read_memory_system_rules");
}

export function saveMemoryL1Override(content: string): Promise<LocalMemorySystemRules> {
  requireTauri();
  return invoke<LocalMemorySystemRules>("save_memory_l1_override", { content });
}

export function resetMemoryL1Override(): Promise<LocalMemorySystemRules> {
  requireTauri();
  return invoke<LocalMemorySystemRules>("reset_memory_l1_override");
}

export function updateLocalNoteStats(update: LocalNoteStatsUpdate): Promise<LocalNoteSummary> {
  requireTauri();
  return invoke<LocalNoteSummary>("update_local_note_stats", {
    update: {
      noteId: update.noteId,
      accountPoolId: update.accountPoolId,
      expectedVersion: update.expectedVersion,
      field: update.field,
      value: update.value,
    },
  });
}
