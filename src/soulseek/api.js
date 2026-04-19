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
 * Blocks for ~8 seconds collecting results from peers.
 * @param {string} query
 * @returns {Promise<Array>}
 */
export function soulseekSearch(query) {
  return invoke("soulseek_search", { query });
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
