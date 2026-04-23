/**
 * Buffered-% polling loop for the player.
 *
 * While `isLoading` is true, reads `audio.buffered` once per animation frame
 * and updates `bufferedPercent` + live-syncs `duration` when the element
 * exposes a finite duration. Stops automatically when `isLoading` flips false
 * or the component unmounts.
 *
 * Caller still wires explicit `updateBufferStats()` / `stopBufferPoll()`
 * calls from `canplay` / `error` handlers — those take immediate effect
 * without waiting for the next frame.
 */

import { ref, watch, onUnmounted } from "vue";

/**
 * @param {{
 *   audioRef: import("vue").Ref<HTMLMediaElement | null>,
 *   isLoading: import("vue").ComputedRef<boolean> | import("vue").Ref<boolean>,
 *   streamPhase: import("vue").Ref<string>,
 *   duration: import("vue").Ref<number>,
 * }} ctx
 */
export function useBufferPoll(ctx) {
  const bufferedPercent = ref(0);
  let rafId = 0;

  function updateBufferStats() {
    const a = ctx.audioRef.value;
    if (!a) {
      bufferedPercent.value = 0;
      return;
    }
    const metaDur = a.duration;
    if (Number.isFinite(metaDur) && metaDur > 0) {
      ctx.duration.value = metaDur;
    }
    if (!a.buffered?.length) {
      bufferedPercent.value = 0;
      return;
    }
    const end = a.buffered.end(a.buffered.length - 1);
    const dur = Number.isFinite(ctx.duration.value) && ctx.duration.value > 0 ? ctx.duration.value : 0;
    if (dur > 0 && Number.isFinite(end)) {
      bufferedPercent.value = Math.max(0, Math.min(100, (end / dur) * 100));
    }
  }

  function stopBufferPoll() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function tick() {
    rafId = 0;
    updateBufferStats();
    if (
      ctx.isLoading.value &&
      ctx.streamPhase.value !== "error" &&
      ctx.streamPhase.value !== "idle" &&
      ctx.audioRef.value
    ) {
      rafId = requestAnimationFrame(tick);
    }
  }

  function start() {
    stopBufferPoll();
    rafId = requestAnimationFrame(tick);
  }

  watch(
    () => ctx.isLoading.value,
    (loading) => {
      stopBufferPoll();
      if (loading) start();
    },
    { immediate: true },
  );

  onUnmounted(stopBufferPoll);

  return { bufferedPercent, updateBufferStats, stopBufferPoll, startBufferPoll: start };
}
