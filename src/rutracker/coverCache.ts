import { invoke } from "@tauri-apps/api/core";
import { ref, watch } from "vue";
import { getMirror } from "./config.js";
import { appDebugLog } from "../appDebugLog.js";
import { makeCoverCache } from "../lib/coverCacheCore.js";
import { rtLoggedIn } from "../stores/auth.js";

/**
 * RuTracker cover cache — keyed by `${mirror}\n${topicId}` so a mirror switch
 * does not poison a different mirror's URLs.
 */

/**
 * Counter bumped when Rutracker auth transitions to logged-in.
 *
 * `CoverThumb` watches this so its `IntersectionObserver` can be re-attached
 * after a failed pre-auth render — the observer disconnects on first
 * intersection and would not otherwise retry once auth becomes available.
 */
export const rutrackerCoverFetchEpoch = ref(0);

function cacheKey(topicId: unknown): string {
  return `${getMirror()}\n${String(topicId)}`;
}

const cache = makeCoverCache({
  async fetch(key) {
    const parts = key.split("\n", 2);
    const topicId = parts[1] ?? "";
    const mirror = getMirror();
    void appDebugLog("cover", `rutracker cover: fetching — topicId=${topicId} mirror=${mirror}`);
    const u = await invoke<string | null>("rutracker_get_cover", { mirror, topicId });
    return u ?? null;
  },
  log: (tag, msg) => void appDebugLog(tag, `rutracker ${msg}`),
  maxEntries: 1024,
  maxBytes: 64 * 1024 * 1024,
  negativeTtlMs: 90_000,
});

watch(rtLoggedIn, (next, prev) => {
  if (next && !prev) {
    rutrackerCoverFetchEpoch.value += 1;
    cache.clearNegatives();
  }
});

export function peekRutrackerCover(topicId: unknown): string | null | undefined {
  return cache.peek(cacheKey(topicId));
}

export function getCoverReactive(topicId: unknown): string | null {
  return cache.getReactive(cacheKey(topicId));
}

export function rememberRutrackerCover(topicId: unknown, dataUrl: string | null): void {
  cache.remember(cacheKey(topicId), dataUrl);
}

export function getRutrackerCoverDataUrl(topicId: unknown): Promise<string | null> {
  return cache.getOrFetch(cacheKey(topicId));
}

export function clearRutrackerCoverCache(): void {
  cache.clear();
}

/** Clears negative-TTL rows so thumbnails retry (e.g. after RuTracker login). */
export function clearRutrackerCoverNegatives(): void {
  cache.clearNegatives();
}

/** Clears one topic's cover so the next read hits the network again. */
export function invalidateRutrackerCover(topicId: unknown): void {
  cache.invalidate(cacheKey(topicId));
}
