/**
 * Identity helpers for queue items. In v2 a queue item is always a Track
 * instance — the helpers just delegate to `track.id` / `track.hasPlaybackIdentity()`.
 * Kept as separate helpers so the Player's pre-Track-migration watches keep
 * reading "stable key" semantics without caring about the underlying shape.
 */

import type { Track } from "../track/Track.js";

/** True when `track.prepareStream()` can be meaningfully invoked right now. */
export function trackHasPlaybackIdentity(t: Track | null | undefined): boolean {
  return t ? t.hasPlaybackIdentity() : false;
}

/** Stable key — Track `id`s are already globally unique. */
export function queueTrackKey(t: Track | null | undefined): string {
  return t?.id ?? "";
}

/** Ordered pair "cur → next" fingerprint for prefetch dedup. */
export function prefetchFingerprint(
  cur: Track | null | undefined,
  next: Track | null | undefined,
): string {
  if (!cur || !next) return "";
  return `${cur.id}\0${next.id}`;
}
