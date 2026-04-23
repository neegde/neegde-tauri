/**
 * Buffering watchdog: turns an infinite "buffering" state after a
 * vozduxan piece-timeout into an explicit "error", or restores "ready"
 * when `audio.currentTime` advanced despite the stall.
 *
 * Timeout is slightly larger than the C++ PIECE_TIMEOUT_MS (180 000 ms) so
 * we never pre-empt the Rust side.
 */

import { onUnmounted } from "vue";
import { appDebugLog } from "../appDebugLog.js";

export const BUFFERING_WATCHDOG_MS = 185_000;

/**
 * @param {{
 *   audioRef: import("vue").Ref<HTMLMediaElement | null>,
 *   streamPhase: import("vue").Ref<string>,
 *   streamError: import("vue").Ref<string>,
 *   src: import("vue").Ref<string>,
 *   track: import("vue").ComputedRef<object | null>,
 *   onStart?: () => void,
 * }} ctx
 */
export function useBufferingWatchdog(ctx) {
  let timer = null;

  function clearBufferingWatchdog() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function startBufferingWatchdog() {
    clearBufferingWatchdog();
    ctx.onStart?.();
    const startTime = ctx.audioRef.value?.currentTime ?? 0;
    void appDebugLog("player", `audio: buffering watchdog started (${BUFFERING_WATCHDOG_MS}ms) — "${ctx.track.value?.fileName?.slice?.(0,60)}"`);
    timer = setTimeout(() => {
      timer = null;
      if (ctx.streamPhase.value !== "buffering") return;
      const curTime = ctx.audioRef.value?.currentTime ?? 0;
      if (curTime > startTime) {
        void appDebugLog("player", `audio: buffering watchdog: playback advanced (${startTime.toFixed(2)}s → ${curTime.toFixed(2)}s) — restoring ready`);
        ctx.streamPhase.value = "ready";
        return;
      }
      void appDebugLog("player", `audio: buffering watchdog FIRED — stream stalled for ${BUFFERING_WATCHDOG_MS}ms currentTime=${curTime.toFixed(2)} src=${ctx.src.value?.slice?.(0,80)}`);
      ctx.streamError.value = "Поток прерван: не удалось получить данные от раздачи";
      ctx.streamPhase.value = "error";
    }, BUFFERING_WATCHDOG_MS);
  }

  onUnmounted(clearBufferingWatchdog);

  return { startBufferingWatchdog, clearBufferingWatchdog };
}
