/**
 * Wires the equalizer audio graph to a player's `<audio>` element.
 */

import { watch, watchEffect, onUnmounted, nextTick, type Ref } from "vue";
import {
  ensureEqualizer, destroyEqualizer, resumeEqualizerContext,
  isEqualizerActive, setEqualizerOutputGain,
} from "../audio/equalizerGraph.js";
import { eqBandsDb } from "../audio/equalizerState.js";

export interface UsePlayerEqualizerOptions {
  audioRef: Ref<HTMLMediaElement | null>;
  src: Ref<string>;
  volume: Ref<number>;
}

export function usePlayerEqualizer(ctx: UsePlayerEqualizerOptions) {
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
