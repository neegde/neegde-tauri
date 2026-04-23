/**
 * Buffering watchdog: turns an infinite "buffering" state after a
 * vozduxan piece-timeout into an explicit "error", or restores "ready"
 * when `audio.currentTime` advanced despite the stall.
 */

import { onUnmounted, type Ref, type ComputedRef } from "vue";
import { appDebugLog } from "../appDebugLog.js";

export const BUFFERING_WATCHDOG_MS = 185_000;

interface WatchdogTrack {
  fileName?: string;
  [k: string]: unknown;
}

export interface UseBufferingWatchdogOptions {
  audioRef: Ref<HTMLMediaElement | null>;
  streamPhase: Ref<string>;
  streamError: Ref<string>;
  src: Ref<string>;
  track: ComputedRef<WatchdogTrack | null>;
  onStart?: () => void;
}

export function useBufferingWatchdog(ctx: UseBufferingWatchdogOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearBufferingWatchdog(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function startBufferingWatchdog(): void {
    clearBufferingWatchdog();
    ctx.onStart?.();
    const startTime = ctx.audioRef.value?.currentTime ?? 0;
    void appDebugLog(
      "player",
      `audio: buffering watchdog started (${BUFFERING_WATCHDOG_MS}ms) — "${ctx.track.value?.fileName?.slice?.(0, 60)}"`,
    );
    timer = setTimeout(() => {
      timer = null;
      if (ctx.streamPhase.value !== "buffering") return;
      const curTime = ctx.audioRef.value?.currentTime ?? 0;
      if (curTime > startTime) {
        void appDebugLog(
          "player",
          `audio: buffering watchdog: playback advanced (${startTime.toFixed(2)}s → ${curTime.toFixed(2)}s) — restoring ready`,
        );
        ctx.streamPhase.value = "ready";
        return;
      }
      void appDebugLog(
        "player",
        `audio: buffering watchdog FIRED — stream stalled for ${BUFFERING_WATCHDOG_MS}ms currentTime=${curTime.toFixed(2)} src=${ctx.src.value?.slice?.(0, 80)}`,
      );
      ctx.streamError.value = "Поток прерван: не удалось получить данные от раздачи";
      ctx.streamPhase.value = "error";
    }, BUFFERING_WATCHDOG_MS);
  }

  onUnmounted(clearBufferingWatchdog);

  return { startBufferingWatchdog, clearBufferingWatchdog };
}
