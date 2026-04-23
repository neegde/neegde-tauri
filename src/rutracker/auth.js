import { invoke } from "@tauri-apps/api/core";
import { getMirror } from "./config.js";

/**
 * Log in to Rutracker via the currently configured mirror.
 * @returns {Promise<{ success: boolean, error?: string, username?: string, avatar_url?: string }>}
 * @throws on network-level errors (no connection, DNS failure, etc.)
 */
export async function login(username, password) {
  const mirror = getMirror();
  return invoke("rutracker_login", { mirror, username, password });
}

/**
 * Open an embedded WebView against the rutracker login page.
 * The user signs in visually (including CAPTCHA / Cloudflare challenges) and
 * the resulting session cookies are transferred into the app's HTTP client.
 *
 * Resolves as soon as the backend detects a logged-in session, when the user
 * closes the browser window, or after a 10-minute timeout.
 *
 * Returns:
 *     Login result payload (same shape as `login()`).
 */
export async function loginViaWebview() {
  const mirror = getMirror();
  return invoke("rutracker_login_via_webview", { mirror });
}

/**
 * Probe current mirror reachability with the live HTTP client
 * (so any active proxy preset is honoured).
 *
 * Returns:
 *     `{ reachable, status?, using_proxy?, error? }`.
 */
export async function checkConnectivity() {
  const mirror = getMirror();
  return invoke("rutracker_check_connectivity", { mirror });
}

/**
 * Clear session state and wipe persisted session files.
 * @returns {Promise<void>}
 */
export async function logout() {
  return invoke("rutracker_logout");
}

/**
 * Validate saved cookies with a live HTTP request and restore logged-in state.
 * Call once on app startup. Returns the current session status.
 * @returns {Promise<{ logged_in: boolean, username?: string, avatar_url?: string }>}
 */
export async function restoreSession() {
  const mirror = getMirror();
  return invoke("rutracker_restore_session", { mirror });
}

/**
 * Read back the current in-memory session state (no network request).
 * @returns {Promise<{ logged_in: boolean, username?: string, avatar_url?: string }>}
 */
export async function getStatus() {
  return invoke("rutracker_status");
}
