/**
 * Shared core for cover data-URL caches (RuTracker, SoulSeek, in-torrent).
 *
 * Design principles:
 *
 *   1. Two separate spaces:
 *        - `positives` — successfully-loaded data URLs. Reactive (Vue 3 Map).
 *          Never evicted by a failed re-fetch. Only cleared explicitly
 *          (user logout / `clear()`) or by size-cap soft eviction.
 *        - `negatives` — keys that failed with a TTL timestamp. Plain Map.
 *          Used to avoid hammering a dead peer; expires so live peers retry.
 *
 *   2. `remember(key, null)` never removes an existing positive. This is the
 *      fix for "cover disappears": a failed re-fetch (after the LRU evicted
 *      the happy cache) used to wipe the reactive entry.
 *
 *   3. Soft size cap on `positives` at much larger limits than before
 *      (covers are small, browsers handle megabytes easily). Eviction is
 *      FIFO by insertion order — Map preserves it, so no extra bookkeeping.
 *
 *   4. `getOrFetch` dedupes concurrent requests per key and can apply a
 *      concurrency cap (`maxConcurrent`) so we don't fire 50 SLSK peer
 *      connections at once.
 *
 *   5. If `fetch` **throws**, the key is not negative-cached — only a resolved
 *      `null` outcome is. Transient errors (SoulSeek not connected yet) must
 *      not make `peek` return `null` and skip retries for the TTL window.
 */

import { reactive } from "vue";

export interface CoverCacheOptions {
  /** Network fetcher. */
  fetch: (key: string) => Promise<string | null>;
  /** Optional logger. */
  log?: (tag: string, msg: string) => void;
  /** Soft cap; FIFO eviction when exceeded. */
  maxEntries?: number;
  /** Soft cap on retained data-URL bytes. */
  maxBytes?: number;
  /** How long to cache a fetch failure. */
  negativeTtlMs?: number;
  /** 0 = unlimited. */
  maxConcurrent?: number;
}

export interface CoverCache {
  /** Sync read. positive URL | `null` (neg TTL active) | `undefined` (miss). */
  peek: (key: string) => string | null | undefined;
  /** Reactive read for templates/computeds. positive URL or `null`. */
  getReactive: (key: string) => string | null;
  /** Store outcome. truthy → positive; null-ish → neg-cache (no-op if positive exists). */
  remember: (key: string, dataUrl: string | null) => void;
  /** Cache-hit fast path + dedup + concurrency gate. */
  getOrFetch: (key: string) => Promise<string | null>;
  /** Drop cached state for one key so the next fetch is a real network round-trip. */
  invalidate: (key: string) => void;
  /** Wipe everything (positives, negatives, pending, waiters). */
  clear: () => void;
  /** Drop only negative-TTL rows so misses can be re-fetched (e.g. after SoulSeek login). */
  clearNegatives: () => void;
}

export function makeCoverCache(opts: CoverCacheOptions): CoverCache {
  const {
    fetch: networkFetch,
    log = () => {},
    maxEntries = 1024,
    maxBytes = 64 * 1024 * 1024,
    negativeTtlMs = 90_000,
    maxConcurrent = 0,
  } = opts;

  const positives = reactive(new Map<string, string>());
  const negatives = new Map<string, number>();
  const pending = new Map<string, Promise<string | null>>();
  /** Bumped on {@link invalidate} so in-flight fetches from before the bump skip `remember`. */
  const invalidateGen = new Map<string, number>();
  let totalBytes = 0;

  let running = 0;
  const waiters: Array<() => void> = [];
  function gateAcquire(): Promise<void> {
    if (maxConcurrent <= 0) return Promise.resolve();
    if (running < maxConcurrent) { running++; return Promise.resolve(); }
    return new Promise<void>((resolve) => { waiters.push(resolve); });
  }
  function gateRelease(): void {
    if (maxConcurrent <= 0) return;
    const next = waiters.shift();
    if (next) next();
    else running = Math.max(0, running - 1);
  }

  function bytesOf(v: string | null | undefined): number { return v == null ? 0 : v.length; }

  function evictIfNeeded(): void {
    while (positives.size > 0 && (positives.size > maxEntries || totalBytes > maxBytes)) {
      const firstKey = positives.keys().next().value;
      if (firstKey === undefined) return;
      totalBytes -= bytesOf(positives.get(firstKey));
      positives.delete(firstKey);
    }
  }

  function peek(key: string): string | null | undefined {
    const v = positives.get(key);
    if (v !== undefined) return v;
    const exp = negatives.get(key);
    if (exp != null) {
      if (Date.now() < exp) return null;
      negatives.delete(key);
    }
    return undefined;
  }

  function getReactive(key: string): string | null {
    return positives.get(key) ?? null;
  }

  function remember(key: string, dataUrl: string | null): void {
    if (dataUrl) {
      const prev = positives.get(key);
      if (prev === dataUrl) return;
      if (prev != null) totalBytes -= bytesOf(prev);
      positives.set(key, dataUrl);
      totalBytes += bytesOf(dataUrl);
      negatives.delete(key);
      evictIfNeeded();
    } else if (!positives.has(key)) {
      negatives.set(key, Date.now() + negativeTtlMs);
    }
  }

  function invalidate(key: string): void {
    invalidateGen.set(key, (invalidateGen.get(key) ?? 0) + 1);
    const prev = positives.get(key);
    if (prev != null) totalBytes -= bytesOf(prev);
    positives.delete(key);
    negatives.delete(key);
    pending.delete(key);
  }

  async function getOrFetch(key: string): Promise<string | null> {
    const hit = peek(key);
    if (hit !== undefined) return hit;

    const existing = pending.get(key);
    if (existing) return existing;

    const startGen = invalidateGen.get(key) ?? 0;

    const p = (async () => {
      await gateAcquire();
      try {
        const v = await networkFetch(key);
        if ((invalidateGen.get(key) ?? 0) !== startGen) {
          log("cover", "invalidate discard — stale fetch");
          return null;
        }
        remember(key, v);
        log("cover", v ? `OK — len=${v.length}` : `null (negative TTL ${negativeTtlMs}ms)`);
        return v;
      } catch (e) {
        if ((invalidateGen.get(key) ?? 0) !== startGen) {
          log("cover", "invalidate discard — stale error");
          return null;
        }
        // Do not negative-cache throws — e.g. SoulSeek "not connected" would
        // block folder.jpg for the TTL and skip retries via peek===null.
        log("cover", `error — ${String(e)}`);
        return null;
      } finally {
        gateRelease();
        pending.delete(key);
      }
    })();
    pending.set(key, p);
    return p;
  }

  function clear(): void {
    positives.clear();
    negatives.clear();
    pending.clear();
    invalidateGen.clear();
    waiters.length = 0;
    running = 0;
    totalBytes = 0;
  }

  function clearNegatives(): void {
    negatives.clear();
  }

  return { peek, getReactive, remember, getOrFetch, invalidate, clear, clearNegatives };
}
