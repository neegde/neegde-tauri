/**
 * Queue navigation / shuffle / repeat controls.
 *
 * Operates on the legacy queue row shape (not `{trackId}` yet). Natural track
 * end and explicit "next" share the same advance rule; separate handlers are
 * kept so the caller can wire distinct events.
 */

export function useQueueControls(ctx) {
  /**
   * Randomise the queue in place, keeping the current track at position 0.
   */
  function shuffleQueueInPlaceKeepingCurrent() {
    const q = ctx.queue.value;
    const len = q.length;
    if (len < 2) return;
    const pos = ctx.queuePos.value;
    if (pos < 0 || pos >= len) return;
    const cur = q[pos];
    const rest = q.filter((_, i) => i !== pos);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = rest[i];
      rest[i] = rest[j];
      rest[j] = t;
    }
    ctx.queue.value = [cur, ...rest];
    ctx.queuePos.value = 0;
  }

  function toggleShuffle() {
    if (ctx.queue.value.length < 2) return;
    if (ctx.shuffleOn.value) {
      ctx.shuffleOn.value = false;
      localStorage.setItem("neegde.player.shuffle", "0");
      return;
    }
    ctx.shuffleOn.value = true;
    localStorage.setItem("neegde.player.shuffle", "1");
    shuffleQueueInPlaceKeepingCurrent();
  }

  function cycleRepeatMode() {
    const order = ["off", "all", "one"];
    const i = order.indexOf(ctx.repeatMode.value);
    ctx.repeatMode.value = order[(i + 1) % order.length];
  }

  function advance() {
    ctx.allowPlayerAutoplay();
    const len = ctx.queue.value.length;
    if (len === 0) return;
    if (ctx.queuePos.value < len - 1) ctx.queuePos.value++;
    else if (ctx.repeatMode.value === "all") ctx.queuePos.value = 0;
    else {
      ctx.queue.value = [];
      ctx.queuePos.value = 0;
    }
  }

  /** Explicit next (UI / media keys / skip). */
  function handlePlayerNext() { advance(); }

  /** Natural track end — `repeat-one` is handled inside the Player. */
  function handleTrackEnded() { advance(); }

  function handlePrev() {
    ctx.allowPlayerAutoplay();
    const len = ctx.queue.value.length;
    if (len === 0) return;
    if (ctx.queuePos.value > 0) ctx.queuePos.value--;
    else if (ctx.repeatMode.value === "all" && len > 1) ctx.queuePos.value = len - 1;
  }

  return {
    shuffleQueueInPlaceKeepingCurrent,
    toggleShuffle,
    cycleRepeatMode,
    handlePlayerNext,
    handleTrackEnded,
    handlePrev,
  };
}
