/**
 * Horizontal-marquee controller for title + artist text in the player strip.
 */

import { ref, watch, watchEffect, nextTick, type Ref, type ComputedRef } from "vue";

export interface UseMarqueeOptions {
  outer: Ref<HTMLElement | null>;
  titleWrap: Ref<HTMLElement | null>;
  artistWrap: Ref<HTMLElement | null>;
  displayTitle: Ref<string> | ComputedRef<string>;
  fileName: ComputedRef<string>;
  currentArtist: Ref<string> | ComputedRef<string>;
  hasTrack: Ref<boolean> | ComputedRef<boolean>;
}

export function useMarquee(ctx: UseMarqueeOptions) {
  const titleScroll = ref<boolean>(false);
  const artistScroll = ref<boolean>(false);
  const titleMarqueeStyle = ref<Record<string, string>>({});
  const artistMarqueeStyle = ref<Record<string, string>>({});

  function measure(
    wrapEl: Ref<HTMLElement | null>,
    scrollRef: Ref<boolean>,
    styleRef: Ref<Record<string, string>>,
  ): void {
    const wrap = wrapEl.value;
    if (!wrap) return;
    const first = wrap.querySelector(".player-marquee-chunk") as HTMLElement | null;
    if (!first) return;
    const overflow = first.scrollWidth > wrap.clientWidth + 1;
    if (overflow !== scrollRef.value) {
      scrollRef.value = overflow;
      void nextTick(() => measure(wrapEl, scrollRef, styleRef));
      return;
    }
    if (overflow) {
      const w = first.scrollWidth;
      const sec = Math.max(8, Math.min(48, w / 28));
      styleRef.value = { "--marquee-duration": `${sec}s` };
    } else {
      styleRef.value = {};
    }
  }

  const measureTitle = (): void => measure(ctx.titleWrap, titleScroll, titleMarqueeStyle);
  const measureArtist = (): void => measure(ctx.artistWrap, artistScroll, artistMarqueeStyle);

  const ro =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          void nextTick(() => {
            measureTitle();
            measureArtist();
          });
        })
      : null;

  watch(
    () => [ctx.displayTitle.value, ctx.fileName.value],
    () => {
      titleScroll.value = false;
      void nextTick(measureTitle);
    },
  );

  watch(ctx.currentArtist, () => {
    artistScroll.value = false;
    void nextTick(measureArtist);
  });

  watch(ctx.hasTrack, (v) => {
    if (v) void nextTick(() => { measureTitle(); measureArtist(); });
  });

  watchEffect((onCleanup) => {
    const el = ctx.outer.value;
    if (el && ro) {
      ro.observe(el);
      onCleanup(() => ro.unobserve(el));
    }
  });

  return { titleScroll, artistScroll, titleMarqueeStyle, artistMarqueeStyle };
}
