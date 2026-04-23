/**
 * Next-track (and speculative track+2) prefetch orchestration.
 *
 * Two watchers:
 *   - primary: once playback is stable ≥ N seconds past the start of the
 *     current track, request the next track's stream URL in the background.
 *   - secondary: once primary succeeded, silently warm the track+2 torrent
 *     so its first pieces land before the user reaches it; its URL is
 *     released immediately — we just want cached data, not an open handle.
 *
 * Exposes `prefetchedStream` so the main stream-prepare path can claim a
 * pre-warmed URL for the next track. Imperative `resetOnTrackChange()` wipes
 * state when the current track key changes — the caller invokes it from its
 * own track-change watcher (where it already resets its own attempts).
 */

import { ref, watch } from "vue";
import { prefetchNextInQueue } from "../torrent/api.js";
import { releaseTorrentStreamUrl } from "../torrent/torrentSession.js";
import { appDebugLog } from "../appDebugLog.js";
import { prefetchFingerprint, queueTrackKey } from "../player/queueRowKey.js";

/** Cross-torrent next-track: start prefetch only after meaningful playback. */
const MIN_SEC = 4;
const MIN_RATIO = 0.08;
/** Same-torrent next track: start prefetch almost immediately. Piece-priority
 *  adjustment is virtually free once metadata is loaded. */
const MIN_SEC_SAME_TORRENT = 1.5;
const MIN_RATIO_SAME_TORRENT = 0.04;

/**
 * @param {{
 *   track: import("vue").ComputedRef<object | null>,
 *   nextTrack: import("vue").ComputedRef<object | null>,
 *   secondNextTrack: import("vue").ComputedRef<object | null>,
 *   playing: import("vue").Ref<boolean>,
 *   streamPhase: import("vue").Ref<string>,
 *   isLoading: import("vue").ComputedRef<boolean> | import("vue").Ref<boolean>,
 *   duration: import("vue").Ref<number>,
 *   current: import("vue").Ref<number>,
 * }} ctx
 */
export function usePrefetch(ctx) {
  /** Prepared URL for the next queue item, keyed by queueTrackKey. Claimed
   *  by the main prepare path when the user reaches that track. */
  const prefetchedStream = ref({ url: "", forKey: "" });
  /** Last fingerprint that actually produced a URL — prevents retry loops. */
  const prefetchOkFingerprint = ref("");
  let inFlight = false;

  let secondInFlight = false;
  let secondDoneFingerprint = "";

  async function maybeTriggerPrefetch() {
    const cur = ctx.track.value;
    const next = ctx.nextTrack.value;
    if (!next || !cur) return;
    if (cur.source === "soulseek" || next.source === "soulseek") return;
    if (!ctx.playing.value) return;
    if (ctx.streamPhase.value !== "ready") return;
    if (ctx.isLoading.value) return;
    const d = ctx.duration.value;
    const c = ctx.current.value;
    if (!Number.isFinite(d) || d <= 0) return;
    const sameTorrent = cur.magnet === next.magnet;
    const minSec   = sameTorrent ? MIN_SEC_SAME_TORRENT   : MIN_SEC;
    const minRatio = sameTorrent ? MIN_RATIO_SAME_TORRENT : MIN_RATIO;
    if (c < minSec && c / d < minRatio) return;

    // Skip if we already have a ready URL — starting again would call
    // torrent_prefetch_next_track, which releases the old prefetch_token
    // before prepareTrack() has a chance to use it.
    if (prefetchedStream.value.url) return;

    const fp = prefetchFingerprint(cur, next);
    if (!fp || fp === prefetchOkFingerprint.value) return;
    if (inFlight) return;

    inFlight = true;
    void appDebugLog("player", `prefetch next: start — "${next.fileName?.slice?.(0,60)}" fileIdx=${next.fileIdx} torrentId=${next.torrentId || "—"}`);
    try {
      const result = await prefetchNextInQueue(cur, next);
      if (result?.kind === "streamReady" && result.url) {
        prefetchedStream.value = { url: result.url, forKey: queueTrackKey(next) };
        void appDebugLog("player", `prefetch next: OK — stream ready url=${result.url} fileIdx=${next.fileIdx}`);
      } else {
        void appDebugLog("player", `prefetch next: done but no URL — kind=${result?.kind} fileIdx=${next.fileIdx}`);
      }
      // Mark fingerprint done only on completion so a transient error allows one retry.
      prefetchOkFingerprint.value = fp;
    } catch (e) {
      void appDebugLog("player", `prefetch next: ERROR — "${next.fileName?.slice?.(0,60)}" fileIdx=${next.fileIdx} err=${e?.message ?? String(e ?? "")}`);
    } finally {
      inFlight = false;
    }
  }

  async function maybeTriggerSecondPrefetch() {
    const next = ctx.nextTrack.value;
    const afterNext = ctx.secondNextTrack.value;
    if (!afterNext || !next) return;
    const fp = prefetchFingerprint(next, afterNext);
    if (!fp || fp === secondDoneFingerprint) return;
    if (secondInFlight) return;
    // Only start after the first prefetch (next track) has completed
    if (!prefetchOkFingerprint.value) return;

    secondInFlight = true;
    try {
      const result = await prefetchNextInQueue(next, afterNext, { warmOnly: true });
      if (result?.kind === "streamReady" && result.url) {
        void releaseTorrentStreamUrl(result.url);
      }
      secondDoneFingerprint = fp;
      void appDebugLog("player", `prefetch warm (track+2): OK — "${afterNext.fileName?.slice?.(0,60)}" fileIdx=${afterNext.fileIdx}`);
    } catch (e) {
      void appDebugLog("player", `prefetch warm (track+2): ERROR — "${afterNext.fileName?.slice?.(0,60)}" err=${e?.message ?? String(e ?? "")}`);
    } finally {
      secondInFlight = false;
    }
  }

  /** Called by the caller's track-change watcher. Releases a stale prefetched
   *  URL (unless it matches the new current key), clears fingerprints. */
  function resetOnTrackChange() {
    prefetchOkFingerprint.value = "";
    secondDoneFingerprint = "";
    const nk = queueTrackKey(ctx.track.value);
    if (prefetchedStream.value.url && prefetchedStream.value.forKey !== nk) {
      void releaseTorrentStreamUrl(prefetchedStream.value.url);
      prefetchedStream.value = { url: "", forKey: "" };
    }
  }

  /** Unconditional teardown (unmount / full reset). */
  function releasePrefetchedStream() {
    if (prefetchedStream.value.url) {
      void releaseTorrentStreamUrl(prefetchedStream.value.url);
      prefetchedStream.value = { url: "", forKey: "" };
    }
  }

  watch(
    () => [
      ctx.playing.value,
      ctx.current.value,
      ctx.duration.value,
      ctx.streamPhase.value,
      ctx.isLoading.value,
      ctx.nextTrack.value,
      queueTrackKey(ctx.track.value),
      ctx.track.value?.fileIdx,
    ],
    () => { void maybeTriggerPrefetch(); },
  );

  watch(
    () => [prefetchOkFingerprint.value, ctx.secondNextTrack.value, ctx.nextTrack.value],
    () => { void maybeTriggerSecondPrefetch(); },
  );

  return {
    prefetchedStream,
    resetOnTrackChange,
    releasePrefetchedStream,
    get inFlight() { return inFlight; },
  };
}
