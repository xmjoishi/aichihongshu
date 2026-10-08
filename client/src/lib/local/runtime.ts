export const IS_TAURI_RUNTIME =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const LOCAL_INSPIRATIONS_UPDATED_EVENT = "aichihongshu-local-inspirations-updated";

export function requireTauri() {
  if (!IS_TAURI_RUNTIME) {
    throw new Error("本地 Rust command 仅在 Tauri 桌面端可用");
  }
}
