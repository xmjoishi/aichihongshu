import { invoke } from "@tauri-apps/api/core";

import { requireTauri } from "./runtime";

import type {
  LocalActiveAccount,
  LocalAccountPoolSnapshot,
  LocalAccountCreate,
  LocalAccountUpdate,
  LocalProfileUpdate,
} from "../localTypes";

export function readLocalAccountPool(): Promise<LocalAccountPoolSnapshot> {
  requireTauri();
  return invoke<LocalAccountPoolSnapshot>("read_account_pool");
}

export function activateLocalAccount(accountId: number): Promise<LocalActiveAccount> {
  requireTauri();
  return invoke<LocalActiveAccount>("activate_local_account", { accountId });
}

export function createLocalAccount(account: LocalAccountCreate): Promise<void> {
  requireTauri();
  return invoke<void>("create_local_account", { account });
}

export function updateLocalAccount(account: LocalAccountUpdate): Promise<void> {
  requireTauri();
  return invoke<void>("update_local_account", { account });
}

export function retireLocalAccount(accountId: number): Promise<void> {
  requireTauri();
  return invoke<void>("retire_local_account", { accountId });
}

export function updateLocalProfile(update: LocalProfileUpdate): Promise<void> {
  requireTauri();
  return invoke<void>("update_local_profile", { update });
}
