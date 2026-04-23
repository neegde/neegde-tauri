import { invoke } from "@tauri-apps/api/core";
import { getMirror } from "./config.js";
import { appDebugLog } from "../appDebugLog.js";
import { makeCoverCache } from "../lib/coverCacheCore.js";

/**
 * RuTracker cover cache — keyed by `${mirror}\n${topicId}` so a mirror switch
 * does not poison a different mirror's URLs.
 *
 * Caps are generous (covers are tiny): 1024 entries / 64 MB. Negative TTL
 * 90 s — a transient proxy hiccup doesn't kill the cover for the session.
 */

function cacheKey(topicId) {
  return `${getMirror()}\n${String(topicId)}`;
}

const cache = makeCoverCache({
  async fetch(key) {
    const [, topicId] = key.split("\n", 2);
    const mirror = getMirror();
    void appDebugLog("cover", `rutracker cover: fetching — topicId=${topicId} mirror=${mirror}`);
    const u = await invoke("rutracker_get_cover", { mirror, topicId });
    return u ?? null;
  },
  log: (tag, msg) => void appDebugLog(tag, `rutracker ${msg}`),
  maxEntries: 1024,
  maxBytes: 64 * 1024 * 1024,
  negativeTtlMs: 90_000,
});

/** Synchronous read: positive URL, null (negative TTL), or undefined (miss). */
export function peekRutrackerCover(topicId) {
  return cache.peek(cacheKey(topicId));
}

/** Reactive read for Vue — positive URL or null. */
export function getCoverReactive(topicId) {
  return cache.getReactive(cacheKey(topicId));
}

/** Remember a cover from an external code path (e.g. full torrent details). */
export function rememberRutrackerCover(topicId, dataUrl) {
  cache.remember(cacheKey(topicId), dataUrl);
}

/** Request-or-hit for grid rendering. Dedupes concurrent requests per key. */
export function getRutrackerCoverDataUrl(topicId) {
  return cache.getOrFetch(cacheKey(topicId));
}

export function clearRutrackerCoverCache() {
  cache.clear();
}
