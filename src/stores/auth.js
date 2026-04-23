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

export const rtLoggedIn = ref(false);
export const rtUsername = ref(null);
export const rtAvatarUrl = ref(null);

export function setRtLoggedIn(username, avatarUrl) {
  rtLoggedIn.value = true;
  rtUsername.value = username || null;
  rtAvatarUrl.value = avatarUrl || null;
}

export function setRtLoggedOut() {
  rtLoggedIn.value = false;
  rtUsername.value = null;
  rtAvatarUrl.value = null;
}

// ── SoulSeek ─────────────────────────────────────────────────────────────────

export const slskConnected = ref(false);
export const slskUsername = ref(null);
export const slskLoggingIn = ref(false);
export const slskLoginError = ref(null);

export function setSlskConnected(username) {
  slskConnected.value = true;
  slskUsername.value = username || null;
  slskLoginError.value = null;
}

export function setSlskDisconnected() {
  slskConnected.value = false;
  slskUsername.value = null;
}
