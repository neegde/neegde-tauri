/**
 * Auth state store — RuTracker and SoulSeek login state.
 *
 * Pure reactive refs; side effects (actually logging in, invoking Tauri
 * commands, persisting credentials) live in the respective subsystem
 * modules (`rutracker/auth.js`, `soulseek/api.js`). This store just
 * holds the *current observed state* so UI and other stores can react.
 *
 * The state itself is owned by an {@link AuthManager} instance which
 * composes per-provider {@link AuthProvider} subclasses. The module-level
 * exports below are thin delegates so existing consumers keep working.
 */

import { AuthManager } from "../auth/AuthManager.js";

export const authManager = new AuthManager();

// ── RuTracker ────────────────────────────────────────────────────────────────

export const rtLoggedIn  = authManager.rutracker.connected;
export const rtUsername  = authManager.rutracker.username;
export const rtAvatarUrl = authManager.rutracker.avatarUrl;

export function setRtLoggedIn(
  username: string | null | undefined,
  avatarUrl: string | null | undefined,
): void {
  authManager.rutracker.connect(username, avatarUrl);
}

export function setRtLoggedOut(): void {
  authManager.rutracker.disconnect();
}

// ── SoulSeek ─────────────────────────────────────────────────────────────────

export const slskConnected  = authManager.soulseek.connected;
export const slskUsername   = authManager.soulseek.username;
export const slskLoggingIn  = authManager.soulseek.loggingIn;
export const slskLoginError = authManager.soulseek.loginError;

export function setSlskConnected(username: string | null | undefined): void {
  authManager.soulseek.connect(username);
}

export function setSlskDisconnected(): void {
  authManager.soulseek.disconnect();
}
