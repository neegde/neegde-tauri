/**
 * Buffered-% polling loop for the player.
 */

import { ref, watch, onUnmounted, type Ref, type ComputedRef } from "vue";

export interface UseBufferPollOptions {
  audioRef: Ref<HTMLMediaElement | null>;
  isLoading: ComputedRef<boolean> | Ref<boolean>;
  streamPhase: Ref<string>;
  duration: Ref<number>;
}

export function useBufferPoll(ctx: UseBufferPollOptions) {
  const bufferedPercent = ref<number>(0);
  let rafId = 0;

  function updateBufferStats(): void {
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

  function stopBufferPoll(): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function tick(): void {
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

  function start(): void {
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
