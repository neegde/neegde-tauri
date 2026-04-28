import { invoke } from "@tauri-apps/api/core";
import { getMirror } from "./config.js";

export interface LoginResult {
  success: boolean;
  error?: string;
  username?: string;
  avatar_url?: string;
}

export interface SessionStatus {
  logged_in: boolean;
  username?: string;
  avatar_url?: string;
}

/** Log in to Rutracker via the currently configured mirror. */
export async function login(username: string, password: string): Promise<LoginResult> {
  const mirror = getMirror();
  return invoke<LoginResult>("rutracker_login", { mirror, username, password });
}

/** Open an embedded WebView at the rutracker login page (CAPTCHA / Cloudflare fallback). */
export async function loginViaWebview(): Promise<LoginResult> {
  const mirror = getMirror();
  return invoke<LoginResult>("rutracker_login_via_webview", { mirror });
}

export interface ConnectivityResult {
  reachable: boolean;
  status?: number;
  using_proxy?: string;
  error?: string;
}

/** Probe current mirror reachability using the live HTTP client (honours active proxy). */
export async function checkConnectivity(): Promise<ConnectivityResult> {
  const mirror = getMirror();
  return invoke<ConnectivityResult>("rutracker_check_connectivity", { mirror });
}

/** Clear session state and wipe persisted session files. */
export async function logout(): Promise<void> {
  return invoke<void>("rutracker_logout");
}

/** Validate saved cookies with a live HTTP request and restore logged-in state. */
export async function restoreSession(): Promise<SessionStatus> {
  const mirror = getMirror();
  return invoke<SessionStatus>("rutracker_restore_session", { mirror });
}

/** Read back the current in-memory session state (no network request). */
export async function getStatus(): Promise<SessionStatus> {
  return invoke<SessionStatus>("rutracker_status");
}
