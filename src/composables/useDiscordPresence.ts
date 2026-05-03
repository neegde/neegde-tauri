/**
 * Discord Rich Presence sync for the player.
 */

import { watch, type Ref, type ComputedRef } from "vue";
import { syncDiscordPresence, clearDiscordPresence } from "../discordPresence.js";

const PROGRESS_MIN_MS = 4500;

interface PresenceTrack {
  [k: string]: unknown;
}

export interface UseDiscordPresenceOptions {
  enabled: Ref<boolean> | ComputedRef<boolean>;
  track: Ref<PresenceTrack | null> | ComputedRef<PresenceTrack | null>;
  playing: Ref<boolean>;
  streamPhase: Ref<string>;
  current: Ref<number>;
  duration: Ref<number>;
  hasIdentity: (t: PresenceTrack | null) => boolean;
  queueTrackKey: (t: PresenceTrack | null) => string;
  displayTitle: Ref<string> | ComputedRef<string>;
  currentArtist: Ref<string> | ComputedRef<string>;
}

export function useDiscordPresence(ctx: UseDiscordPresenceOptions): void {
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

  watch(
    () => [ctx.enabled.value, ctx.track.value, ctx.playing.value, ctx.streamPhase.value],
    () => {
      if (!ctx.enabled.value) {
        void clearDiscordPresence();
        return;
      }
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

  watch(
    () => [
      ctx.enabled.value,
      ctx.current.value,
      ctx.duration.value,
      ctx.playing.value,
      ctx.queueTrackKey(ctx.track.value),
      ctx.streamPhase.value,
    ],
    () => {
      if (!ctx.enabled.value) return;
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
