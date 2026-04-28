/**
 * Next-track (and speculative track+2) prefetch orchestration.
 */

import { ref, watch, type Ref, type ComputedRef } from "vue";
import { prefetchNextInQueue } from "../torrent/api.js";
import { releaseTorrentStreamUrl } from "../torrent/torrentSession.js";
import { appDebugLog } from "../appDebugLog.js";
import { prefetchFingerprint, queueTrackKey } from "../player/queueRowKey.js";
import type { Track } from "../track/Track.js";

const MIN_SEC = 4;
const MIN_RATIO = 0.08;
const MIN_SEC_SAME_TORRENT = 1.5;
const MIN_RATIO_SAME_TORRENT = 0.04;

interface PrefetchTrack {
  fileIdx?: number;
  fileName?: string;
  torrentId?: string | number;
  magnet?: string;
  source?: string;
  [k: string]: unknown;
}

export interface UsePrefetchOptions {
  track: ComputedRef<Track | PrefetchTrack | null>;
  nextTrack: ComputedRef<Track | PrefetchTrack | null>;
  secondNextTrack: ComputedRef<Track | PrefetchTrack | null>;
  playing: Ref<boolean>;
  streamPhase: Ref<string>;
  isLoading: ComputedRef<boolean> | Ref<boolean>;
  duration: Ref<number>;
  current: Ref<number>;
}

export function usePrefetch(ctx: UsePrefetchOptions) {
  const prefetchedStream = ref<{ url: string; forKey: string }>({ url: "", forKey: "" });
  const prefetchOkFingerprint = ref<string>("");
  let inFlight = false;

  let secondInFlight = false;
  let secondDoneFingerprint = "";

  async function maybeTriggerPrefetch(): Promise<void> {
    const cur = ctx.track.value as PrefetchTrack | null;
    const next = ctx.nextTrack.value as PrefetchTrack | null;
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

    if (prefetchedStream.value.url) return;

    const fp = prefetchFingerprint(cur as unknown as Track, next as unknown as Track);
    if (!fp || fp === prefetchOkFingerprint.value) return;
    if (inFlight) return;

    inFlight = true;
    void appDebugLog(
      "player",
      `prefetch next: start — "${next.fileName?.slice?.(0, 60)}" fileIdx=${next.fileIdx} torrentId=${next.torrentId || "—"}`,
    );
    try {
      const result = await prefetchNextInQueue(cur as unknown as never, next as unknown as never);
      const r = result as { kind?: string; url?: string } | null;
      if (r?.kind === "streamReady" && r.url) {
        prefetchedStream.value = { url: r.url, forKey: queueTrackKey(next as unknown as Track) };
        void appDebugLog("player", `prefetch next: OK — stream ready url=${r.url} fileIdx=${next.fileIdx}`);
      } else {
        void appDebugLog("player", `prefetch next: done but no URL — kind=${r?.kind} fileIdx=${next.fileIdx}`);
      }
      prefetchOkFingerprint.value = fp;
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? String(e ?? "");
      void appDebugLog(
        "player",
        `prefetch next: ERROR — "${next.fileName?.slice?.(0, 60)}" fileIdx=${next.fileIdx} err=${msg}`,
      );
    } finally {
      inFlight = false;
    }
  }

  async function maybeTriggerSecondPrefetch(): Promise<void> {
    const next = ctx.nextTrack.value as PrefetchTrack | null;
    const afterNext = ctx.secondNextTrack.value as PrefetchTrack | null;
    if (!afterNext || !next) return;
    const fp = prefetchFingerprint(next as unknown as Track, afterNext as unknown as Track);
    if (!fp || fp === secondDoneFingerprint) return;
    if (secondInFlight) return;
    if (!prefetchOkFingerprint.value) return;

    secondInFlight = true;
    try {
      const result = await prefetchNextInQueue(
        next as unknown as never,
        afterNext as unknown as never,
        { warmOnly: true },
      );
      const r = result as { kind?: string; url?: string } | null;
      if (r?.kind === "streamReady" && r.url) {
        void releaseTorrentStreamUrl(r.url);
      }
      secondDoneFingerprint = fp;
      void appDebugLog(
        "player",
        `prefetch warm (track+2): OK — "${afterNext.fileName?.slice?.(0, 60)}" fileIdx=${afterNext.fileIdx}`,
      );
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? String(e ?? "");
      void appDebugLog(
        "player",
        `prefetch warm (track+2): ERROR — "${afterNext.fileName?.slice?.(0, 60)}" err=${msg}`,
      );
    } finally {
      secondInFlight = false;
    }
  }

  function resetOnTrackChange(): void {
    prefetchOkFingerprint.value = "";
    secondDoneFingerprint = "";
    const nk = queueTrackKey(ctx.track.value as unknown as Track);
    if (prefetchedStream.value.url && prefetchedStream.value.forKey !== nk) {
      void releaseTorrentStreamUrl(prefetchedStream.value.url);
      prefetchedStream.value = { url: "", forKey: "" };
    }
  }

  function releasePrefetchedStream(): void {
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
      queueTrackKey(ctx.track.value as unknown as Track),
      (ctx.track.value as PrefetchTrack | null)?.fileIdx,
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
