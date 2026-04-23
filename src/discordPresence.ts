import { invoke } from "@tauri-apps/api/core";

const DEBOUNCE_MS = 4500;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface DiscordPresencePayload {
  title: string;
  subtitle: string;
  playing: boolean;
  positionSec?: number | null;
  durationSec?: number | null;
}

/** Pushes the current playback state to Discord (debounced unless `immediate`). */
export function syncDiscordPresence(
  payload: DiscordPresencePayload,
  options: { immediate?: boolean } = {},
): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  const { immediate = false } = options;
  const run = (): Promise<void> => {
    debounceTimer = null;
    return invoke<void>("discord_presence_sync", { payload }).catch(() => {});
  };
  if (immediate) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    return run();
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(run, DEBOUNCE_MS);
  return Promise.resolve();
}

/** Clears Discord Rich Presence and cancels any pending debounced sync. */
export function clearDiscordPresence(): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  return invoke<void>("discord_presence_clear").catch(() => {});
}
