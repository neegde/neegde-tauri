/**
 * Pure identity helpers for queue rows (both legacy rich shape and
 * entity-augmented). Used by Player.vue for stream-key matching, prefetch
 * fingerprints, and "do we have enough to play this" checks.
 */

/** True when `streamUrl` can be invoked for this item. */
export function trackHasPlaybackIdentity(t) {
  if (!t) return false;
  if (t.source === "soulseek") {
    return Boolean(t.slskUsername && t.slskFilepath);
  }
  return Boolean(t.magnet);
}

/** Stable key for matching a queue item to a prepared stream URL. */
export function queueTrackKey(t) {
  if (!t) return "";
  if (t.source === "soulseek") {
    if (!t.slskUsername || !t.slskFilepath) return "";
    const raw = t.fileIdx;
    const n = raw != null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : 0;
    return `slsk\0${t.slskUsername}\0${t.slskFilepath}\0${n}`;
  }
  if (!t.magnet || t.fileIdx == null || t.fileIdx === "") return "";
  const n = Number(t.fileIdx);
  if (!Number.isFinite(n)) return "";
  return `${t.magnet}\0${n}`;
}

/** Fingerprint for the current → next prefetch attempt. */
export function prefetchFingerprint(cur, next) {
  if (!cur?.magnet || next?.magnet == null || next.fileIdx == null) return "";
  return `${cur.magnet}\0${cur.fileIdx}\0${next.magnet}\0${next.fileIdx}`;
}
