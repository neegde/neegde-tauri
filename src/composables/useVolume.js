/**
 * Player volume state + persistence.
 *
 * Owns `volume` (0..1) and `volumeBeforeMute` (for mute-toggle restore).
 * Writes to localStorage on every change so the next app launch boots with
 * the same level. The caller still binds the value to `audio.volume` (or
 * to the equalizer output gain when one is active) — this composable stays
 * out of the audio graph.
 */

import { ref, watch } from "vue";

const STORAGE_KEY = "playerVolume";
const WHEEL_STEP = 0.06;

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function loadSavedVolume() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return 1;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return 1;
    return clamp01(n);
  } catch {
    return 1;
  }
}

export function useVolume() {
  const volume = ref(loadSavedVolume());
  /** Level before mute-click, for restore on unmute. */
  const volumeBeforeMute = ref(null);

  watch(volume, (v) => {
    try { localStorage.setItem(STORAGE_KEY, String(v)); } catch { /* ignore */ }
  });

  function toggleMute() {
    if (volume.value > 0) {
      volumeBeforeMute.value = volume.value;
      volume.value = 0;
    } else {
      const prev = volumeBeforeMute.value;
      volume.value = prev != null && prev > 0 ? prev : Math.max(loadSavedVolume(), 0.25);
    }
  }

  function onVolumeWheel(e) {
    e.preventDefault();
    const next = volume.value + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP);
    volume.value = clamp01(next);
  }

  return { volume, volumeBeforeMute, toggleMute, onVolumeWheel };
}
