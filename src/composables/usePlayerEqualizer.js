/**
 * Wires the equalizer audio graph to a player's `<audio>` element.
 *
 * Two concerns glued together:
 *   1. Volume routing — when the equalizer is active, `audio.volume = 1` and
 *      the user-level volume is applied through the graph's output gain.
 *      Otherwise the value lands on `audio.volume` directly.
 *   2. Graph lifecycle — re-created on audio element / src changes (so the
 *      Web Audio MediaElementSource is freshly bound), torn down on unmount.
 */

import { watch, watchEffect, onUnmounted, nextTick } from "vue";
import {
  ensureEqualizer,
  destroyEqualizer,
  resumeEqualizerContext,
  isEqualizerActive,
  setEqualizerOutputGain,
} from "../audio/equalizerGraph.js";
import { eqBandsDb } from "../audio/equalizerState.js";

/**
 * @param {{
 *   audioRef: import("vue").Ref<HTMLMediaElement | null>,
 *   src: import("vue").Ref<string>,
 *   volume: import("vue").Ref<number>,
 * }} ctx
 */
export function usePlayerEqualizer(ctx) {
  watchEffect(() => {
    const a = ctx.audioRef.value;
    if (!a) return;
    const v = ctx.volume.value;
    if (isEqualizerActive()) {
      a.volume = 1;
      setEqualizerOutputGain(v);
    } else {
      a.volume = v;
    }
  });

  // Only (re)build the graph when the audio element or its src changes.
  // Repeat calls to createMediaElementSource on the same element are illegal.
  watch(
    () => [ctx.audioRef.value, ctx.src.value],
    async () => {
      await nextTick();
      const a = ctx.audioRef.value;
      const s = ctx.src.value;
      if (!a) {
        destroyEqualizer();
        return;
      }
      if (!s) return;
      const handle = ensureEqualizer(a, [...eqBandsDb.value]);
      if (handle) {
        a.volume = 1;
        setEqualizerOutputGain(ctx.volume.value);
      }
      await resumeEqualizerContext();
    },
    { flush: "post" },
  );

  onUnmounted(destroyEqualizer);

  return { resumeEqualizerContext };
}
