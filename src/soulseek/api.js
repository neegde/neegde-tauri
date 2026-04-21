import { invoke } from "@tauri-apps/api/core";

/**
 * Log in to SoulSeek network.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{success: boolean, error: string|null, username: string|null}>}
 */
export function soulseekLogin(username, password) {
  return invoke("soulseek_login", { username, password });
}

/**
 * Disconnect from SoulSeek network and release all streams.
 */
export function soulseekLogout() {
  return invoke("soulseek_logout");
}

/**
 * Get current connection status.
 * @returns {Promise<{connected: boolean, username: string|null}>}
 */
export function soulseekStatus() {
  return invoke("soulseek_status");
}

/**
 * Search the SoulSeek network for audio files.
 * Blocks up to ~12s while collecting results; batches arrive earlier as `soulseek-search-batch` events.
 * @param {string} query
 * @param {number} [requestId] - Match `payload.requestId` on incremental events (use same id as in `listen`).
 * @returns {Promise<Array>}
 */
export function soulseekSearch(query, requestId = 0) {
  return invoke("soulseek_search", { query, requestId });
}

/**
 * Begin downloading a file from a SoulSeek peer and expose it via local HTTP.
 * @param {string} username  - SoulSeek username of the file owner
 * @param {string} filepath  - Full file path as reported in search results (backslash-separated)
 * @param {number} filesize  - File size in bytes (0 if unknown)
 * @returns {Promise<{url: string, token: string}>}
 */
export function soulseekPrepareStream(username, filepath, filesize) {
  return invoke("soulseek_prepare_stream", {
    username,
    filepath,
    filesize: Number(filesize) || 0,
  });
}

/**
 * Download a prefix of an image file from a peer for cover art (≤512 KiB).
 *
 * @param {string} username
 * @param {string} filepath
 * @param {number} filesize
 * @returns {Promise<{ mime: string, base64: string }>}
 */
export function soulseekCoverPreview(username, filepath, filesize) {
  return invoke("soulseek_cover_preview", {
    username,
    filepath,
    filesize: Number(filesize) || 0,
  });
}

/**
 * Stop streaming and clean up a file by token.
 * @param {string} token
 */
export function soulseekReleaseStream(token) {
  return invoke("soulseek_release_stream", { token });
}

/**
 * Save SoulSeek credentials to disk.
 */
export function soulseekSaveCredentials(username, password) {
  return invoke("soulseek_save_credentials", { username, password });
}

/**
 * Load saved SoulSeek credentials from disk.
 * @returns {Promise<[string, string] | null>}
 */
export function soulseekLoadCredentials() {
  return invoke("soulseek_load_credentials");
}

/**
 * Removes saved SoulSeek username/password from disk (used after «Выйти» in settings).
 */
export function soulseekClearSavedCredentials() {
  return invoke("soulseek_clear_saved_credentials");
}

export {
  clearSlskCoverCache,
  getSlskCoverDataUrl,
  peekSlskCover,
  getSlskCoverReactive,
  slskCoverKey,
} from "./coverCache.js";
