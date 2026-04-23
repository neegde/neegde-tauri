/**
 * Horizontal-marquee controller for title + artist text in the player strip.
 *
 * Watches the display refs and re-measures on next tick. When the inner chunk
 * overflows the wrap element, enables `*Scroll = true` and sets a CSS var for
 * animation duration proportional to width. Re-runs on window / element
 * resize via ResizeObserver.
 */

import { ref, watch, watchEffect, nextTick } from "vue";

/**
 * @param {{
 *   outer: import("vue").Ref<HTMLElement | null>,
 *   titleWrap: import("vue").Ref<HTMLElement | null>,
 *   artistWrap: import("vue").Ref<HTMLElement | null>,
 *   displayTitle: import("vue").Ref<string> | import("vue").ComputedRef<string>,
 *   fileName: import("vue").ComputedRef<string>,
 *   currentArtist: import("vue").Ref<string> | import("vue").ComputedRef<string>,
 *   hasTrack: import("vue").Ref<boolean> | import("vue").ComputedRef<boolean>,
 * }} ctx
 */
export function useMarquee(ctx) {
  const titleScroll = ref(false);
  const artistScroll = ref(false);
  const titleMarqueeStyle = ref({});
  const artistMarqueeStyle = ref({});

  function measure(wrapEl, scrollRef, styleRef) {
    const wrap = wrapEl.value;
    if (!wrap) return;
    const first = wrap.querySelector(".player-marquee-chunk");
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

  const measureTitle = () => measure(ctx.titleWrap, titleScroll, titleMarqueeStyle);
  const measureArtist = () => measure(ctx.artistWrap, artistScroll, artistMarqueeStyle);

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
