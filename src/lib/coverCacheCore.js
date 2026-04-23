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
 */

import { reactive } from "vue";

/**
 * @typedef {Object} CoverCacheOptions
 * @property {(key: string) => Promise<string | null>} fetch        Network fetcher.
 * @property {(tag: string, msg: string) => void}      [log]        Optional logger.
 * @property {number} [maxEntries=1024]                              Soft cap; FIFO eviction when exceeded.
 * @property {number} [maxBytes=64*1024*1024]                        Soft cap on retained data-URL bytes.
 * @property {number} [negativeTtlMs=90_000]                         How long to cache a fetch failure.
 * @property {number} [maxConcurrent=0]                              0 = unlimited.
 */

/**
 * Build a cover cache with the given fetcher.
 *
 * @param {CoverCacheOptions} opts
 */
export function makeCoverCache(opts) {
  const {
    fetch: networkFetch,
    log = () => {},
    maxEntries = 1024,
    maxBytes = 64 * 1024 * 1024,
    negativeTtlMs = 90_000,
    maxConcurrent = 0,
  } = opts;

  /** @type {Map<string, string>} — reactive; all positives live here. */
  const positives = reactive(new Map());
  /** @type {Map<string, number>} — negative-cache expiry timestamps. */
  const negatives = new Map();
  /** @type {Map<string, Promise<string | null>>} — in-flight dedup. */
  const pending = new Map();
  /** Soft size accounting for positives. */
  let totalBytes = 0;

  // ── Concurrency gate ──
  let running = 0;
  /** @type {Array<() => void>} */
  const waiters = [];
  function gateAcquire() {
    if (maxConcurrent <= 0) return Promise.resolve();
    if (running < maxConcurrent) { running++; return Promise.resolve(); }
    return new Promise((resolve) => { waiters.push(resolve); });
  }
  function gateRelease() {
    if (maxConcurrent <= 0) return;
    const next = waiters.shift();
    if (next) next();
    else running = Math.max(0, running - 1);
  }

  function bytesOf(v) { return v == null ? 0 : v.length; }

  function evictIfNeeded() {
    while (positives.size > 0 && (positives.size > maxEntries || totalBytes > maxBytes)) {
      const firstKey = positives.keys().next().value;
      if (firstKey === undefined) return;
      totalBytes -= bytesOf(positives.get(firstKey));
      positives.delete(firstKey);
    }
  }

  /**
   * Synchronous read.
   * @returns {string | null | undefined} — positive URL, `null` if still in negative TTL, `undefined` on miss.
   */
  function peek(key) {
    const v = positives.get(key);
    if (v !== undefined) return v;
    const exp = negatives.get(key);
    if (exp != null) {
      if (Date.now() < exp) return null;
      negatives.delete(key);
    }
    return undefined;
  }

  /** Reactive read for Vue templates/computeds. Returns the positive URL or null. */
  function getReactive(key) {
    return positives.get(key) ?? null;
  }

  /**
   * Stores a fetch outcome.
   *
   * `dataUrl` truthy → positive cache (evicts oldest positives if over caps).
   * `dataUrl` null-ish → negative cache with TTL; does NOT remove existing positive.
   */
  function remember(key, dataUrl) {
    if (dataUrl) {
      const prev = positives.get(key);
      if (prev === dataUrl) return;                     // same value, noop
      if (prev != null) totalBytes -= bytesOf(prev);
      positives.set(key, dataUrl);
      totalBytes += bytesOf(dataUrl);
      negatives.delete(key);
      evictIfNeeded();
    } else if (!positives.has(key)) {
      // Only mark negative when we never had a positive.
      negatives.set(key, Date.now() + negativeTtlMs);
    }
  }

  /**
   * One-shot request: cache-hit fast path, dedup per key, concurrency-gate for
   * misses. Returns the data URL, or null on negative / failed fetch.
   *
   * @returns {Promise<string | null>}
   */
  async function getOrFetch(key) {
    const hit = peek(key);
    if (hit !== undefined) return hit;

    let p = pending.get(key);
    if (p) return p;

    p = (async () => {
      await gateAcquire();
      try {
        const v = await networkFetch(key);
        remember(key, v);
        log("cover", v ? `OK — len=${v.length}` : `null (negative TTL ${negativeTtlMs}ms)`);
        return v;
      } catch (e) {
        remember(key, null);
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

  function clear() {
    positives.clear();
    negatives.clear();
    pending.clear();
    waiters.length = 0;
    running = 0;
    totalBytes = 0;
  }

  return { peek, getReactive, remember, getOrFetch, clear };
}
