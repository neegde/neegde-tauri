/**
 * Auth state store — RuTracker and SoulSeek login state.
 *
 * Pure reactive refs; side effects (actually logging in, invoking Tauri
 * commands, persisting credentials) live in the respective subsystem
 * modules (`rutracker/auth.js`, `soulseek/api.js`). This store just
 * holds the *current observed state* so UI and other stores can react.
 */

import { ref } from "vue";

// ── RuTracker ────────────────────────────────────────────────────────────────

export const rtLoggedIn = ref<boolean>(false);
export const rtUsername = ref<string | null>(null);
export const rtAvatarUrl = ref<string | null>(null);

export function setRtLoggedIn(username: string | null | undefined, avatarUrl: string | null | undefined): void {
  rtLoggedIn.value = true;
  rtUsername.value = username || null;
  rtAvatarUrl.value = avatarUrl || null;
}

export function setRtLoggedOut(): void {
  rtLoggedIn.value = false;
  rtUsername.value = null;
  rtAvatarUrl.value = null;
}

// ── SoulSeek ─────────────────────────────────────────────────────────────────

export const slskConnected = ref<boolean>(false);
export const slskUsername = ref<string | null>(null);
export const slskLoggingIn = ref<boolean>(false);
export const slskLoginError = ref<string | null>(null);

export function setSlskConnected(username: string | null | undefined): void {
  slskConnected.value = true;
  slskUsername.value = username || null;
  slskLoginError.value = null;
}

export function setSlskDisconnected(): void {
  slskConnected.value = false;
  slskUsername.value = null;
}
