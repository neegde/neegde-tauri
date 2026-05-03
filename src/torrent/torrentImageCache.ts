/**
 * In-torrent cover image cache. Backed by the shared `makeCoverCache` core,
 * so LRU eviction, negative-TTL, concurrent-fetch dedup and (if needed)
 * concurrency gating are all inherited from the same codepath RT / SLSK use.
 *
 * The wrinkle: `torrent_fetch_image` accepts an optional `torrentFileB64`
 * hint — when a `.torrent` is already in memory, the Rust side can skip the
 * DHT metadata wait. Since the factory's `fetch(key)` takes only the key,
 * the hint is threaded through a transient side-channel Map keyed by the
 * same cache key; callers set it just before the fetch and the fetcher
 * reads + clears it.
 */

import { invoke } from "@tauri-apps/api/core";
import { enrichMagnetWithOpenTrackers } from "../lib/utils.js";
import { appDebugLog } from "../appDebugLog.js";
import { makeCoverCache } from "../lib/coverCacheCore.js";

function cacheKey(magnet: string, fileIdx: number): string {
  return `${magnet}\n${fileIdx}`;
}

function parseKey(key: string): { magnet: string; fileIdx: number } {
  const nl = key.indexOf("\n");
  return {
    magnet: nl < 0 ? key : key.slice(0, nl),
    fileIdx: nl < 0 ? 0 : Number(key.slice(nl + 1)),
  };
}

const b64Hints = new Map<string, string | null>();

const cache = makeCoverCache({
  maxEntries: 200,
  maxBytes: 64 * 1024 * 1024,
  log: (_, msg) => void appDebugLog("cover", `torrent: ${msg}`),
  fetch: async (key) => {
    const { magnet, fileIdx } = parseKey(key);
    const magnetFp = magnet.slice(0, 80);
    const b64 = b64Hints.get(key) ?? null;
    void appDebugLog(
      "cover",
      `torrent cover: invoke start — fileIdx=${fileIdx} hasTorrentData=${!!b64} magnet=${magnetFp}…`,
    );
    const result = await invoke<string | null>("torrent_fetch_image", {
      magnet: enrichMagnetWithOpenTrackers(magnet),
      fileIdx,
      torrentFileB64: b64,
    });
    return result ?? null;
  },
});

export function peekTorrentImage(magnet: string, fileIdx: number): string | undefined {
  const v = cache.peek(cacheKey(magnet, fileIdx));
  // Shape-compat: callers expect `string | undefined` (never null). Treat
  // negative-TTL hits as misses; they'll retry on the next `getOrFetch`.
  return typeof v === "string" ? v : undefined;
}

export async function getTorrentImageDataUrl(
  magnet: string,
  fileIdx: number,
  torrentFileB64: string | null = null,
): Promise<string | null> {
  const key = cacheKey(magnet, fileIdx);
  b64Hints.set(key, torrentFileB64);
  try {
    return await cache.getOrFetch(key);
  } finally {
    b64Hints.delete(key);
  }
}

/** Drop every cached entry. Intended for logout / debug. */
export function clearTorrentImageCache(): void {
  cache.clear();
  b64Hints.clear();
}
