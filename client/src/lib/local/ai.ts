import { invoke } from "@tauri-apps/api/core";

import { requireTauri } from "./runtime";

import type {
  LocalAIRunUpsert,
  LocalAIRunUpdate,
  LocalAIRunSummary,
  LocalAIRunArtifactCreate,
  LocalAIRunArtifactSummary,
} from "../localTypes";

export function saveLocalAIRun(run: LocalAIRunUpsert): Promise<LocalAIRunSummary> {
  requireTauri();
  return invoke<LocalAIRunSummary>("save_local_ai_run", { run });
}

export function updateLocalAIRun(run: LocalAIRunUpdate): Promise<LocalAIRunSummary> {
  requireTauri();
  return invoke<LocalAIRunSummary>("update_local_ai_run", { run });
}

export function readLocalAIRun(
  accountPoolId: number | null | undefined,
  noteId?: number,
  itemId?: number,
): Promise<LocalAIRunSummary | null> {
  requireTauri();
  return invoke<LocalAIRunSummary | null>("read_local_ai_run", {
    accountPoolId: accountPoolId ?? null,
    noteId: noteId ?? null,
    itemId: itemId ?? null,
  });
}

export function saveLocalAIRunArtifact(artifact: LocalAIRunArtifactCreate): Promise<LocalAIRunArtifactSummary> {
  requireTauri();
  return invoke<LocalAIRunArtifactSummary>("save_local_ai_artifact", { artifact });
}

export function readLocalAIRunArtifacts(
  accountPoolId: number | null | undefined,
  noteId?: number,
  itemId?: number,
): Promise<LocalAIRunArtifactSummary[]> {
  requireTauri();
  return invoke<LocalAIRunArtifactSummary[]>("read_local_ai_artifacts", {
    accountPoolId: accountPoolId ?? null,
    noteId: noteId ?? null,
    itemId: itemId ?? null,
  });
}
