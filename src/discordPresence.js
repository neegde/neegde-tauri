import { invoke } from "@tauri-apps/api/core";

const DEBOUNCE_MS = 4500;
let debounceTimer = null;

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Pushes the current playback state to Discord (debounced unless `immediate`).
 *
 * @param {object} payload
 * @param {string} payload.title
 * @param {string} payload.subtitle
 * @param {boolean} payload.playing
 * @param {number | null | undefined} payload.positionSec
 * @param {number | null | undefined} payload.durationSec
 * @param {{ immediate?: boolean }} [options]
 * @returns {Promise<void>}
 */
export function syncDiscordPresence(payload, options = {}) {
  if (!isTauriRuntime()) return Promise.resolve();
  const { immediate = false } = options;
  const run = () => {
    debounceTimer = null;
    return invoke("discord_presence_sync", { payload }).catch(() => {});
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

/**
 * Clears Discord Rich Presence and cancels any pending debounced sync.
 *
 * @returns {Promise<void>}
 */
export function clearDiscordPresence() {
  if (!isTauriRuntime()) return Promise.resolve();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  return invoke("discord_presence_clear").catch(() => {});
}
