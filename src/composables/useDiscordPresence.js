/**
 * Discord Rich Presence sync for the player.
 *
 * Watches the playback identity (track + playing + stream phase) and calls
 * `syncDiscordPresence` / `clearDiscordPresence`. Also throttles progress-only
 * updates so we don't spam the IPC endpoint every audio tick.
 */

import { watch, watchEffect } from "vue";
import { syncDiscordPresence, clearDiscordPresence } from "../discordPresence.js";

/** Minimum delay between progress-only presence updates. */
const PROGRESS_MIN_MS = 4500;

/**
 * @param {{
 *   track: import("vue").ComputedRef<object | null> | import("vue").Ref<object | null>,
 *   playing: import("vue").Ref<boolean>,
 *   streamPhase: import("vue").Ref<string>,
 *   current: import("vue").Ref<number>,
 *   duration: import("vue").Ref<number>,
 *   hasIdentity: (t: object | null) => boolean,
 *   queueTrackKey: (t: object | null) => string,
 *   displayTitle: import("vue").ComputedRef<string> | import("vue").Ref<string>,
 *   currentArtist: import("vue").ComputedRef<string> | import("vue").Ref<string>,
 * }} ctx
 */
export function useDiscordPresence(ctx) {
  let lastSyncMs = 0;

  function buildPayload() {
    const t = ctx.track.value;
    if (!ctx.hasIdentity(t)) return null;
    return {
      title: ctx.displayTitle.value || "Трек",
      subtitle: ctx.currentArtist.value || "",
      playing: ctx.playing.value,
      positionSec: Number.isFinite(ctx.current.value) ? ctx.current.value : null,
      durationSec:
        Number.isFinite(ctx.duration.value) && ctx.duration.value > 0 ? ctx.duration.value : null,
    };
  }

  // Track / playing / phase transitions — immediate sync or clear.
  watch(
    () => [ctx.track.value, ctx.playing.value, ctx.streamPhase.value],
    () => {
      const t = ctx.track.value;
      if (!ctx.hasIdentity(t) || ctx.streamPhase.value === "error" || !ctx.playing.value) {
        void clearDiscordPresence();
        return;
      }
      const p = buildPayload();
      if (!p) return;
      lastSyncMs = Date.now();
      void syncDiscordPresence(p, { immediate: true });
    },
    { flush: "post", immediate: true },
  );

  // Progress-only updates — throttled.
  watch(
    () => [
      ctx.current.value,
      ctx.duration.value,
      ctx.playing.value,
      ctx.queueTrackKey(ctx.track.value),
      ctx.streamPhase.value,
    ],
    () => {
      const t = ctx.track.value;
      if (!ctx.hasIdentity(t) || ctx.streamPhase.value === "error" || !ctx.playing.value) return;
      const now = Date.now();
      if (now - lastSyncMs < PROGRESS_MIN_MS) return;
      const p = buildPayload();
      if (!p) return;
      lastSyncMs = now;
      void syncDiscordPresence(p, { immediate: true });
    },
    { flush: "post" },
  );
}
