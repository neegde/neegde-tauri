import { invoke } from "@tauri-apps/api/core";
import { getMirror } from "./config.js";
import { rememberRutrackerCover, getRutrackerCoverDataUrl, peekRutrackerCover, getCoverReactive, clearRutrackerCoverCache } from "./coverCache.js";

export { getRutrackerCoverDataUrl, peekRutrackerCover, getCoverReactive, clearRutrackerCoverCache };

/**
 * Search Rutracker music sections.
 * @param {string} query
 * @returns {Promise<Array<{id, name, category, size, seeders, leechers, added, source}>>}
 * @throws if not authenticated or on network error
 */
export async function searchMusic(query) {
  const mirror = getMirror();
  return invoke("rutracker_search", { mirror, query });
}

const TOPIC_AUDIO_CHECK_WORKERS = 8;

/**
 * Runs async mapper over items with at most `limit` concurrent operations.
 *
 * Args:
 *     items: Input array.
 *     limit: Max parallel tasks (minimum 1).
 *     mapper: `(item, index) => Promise<result>`.
 *
 * Returns:
 *     Promise resolving to an array of mapper results in original order.
 */
async function mapPool(items, limit, mapper) {
  if (!items.length) return [];
  const n = items.length;
  const out = new Array(n);
  let slot = 0;
  const cap = Math.max(1, Math.min(limit, n));

  const worker = async () => {
    for (;;) {
      const idx = slot;
      slot += 1;
      if (idx >= n) return;
      out[idx] = await mapper(items[idx], idx);
    }
  };

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return out;
}

/**
 * Drops Rutracker search rows whose `.torrent` does not list any playable audio file.
 * Uses one lightweight `dl.php` fetch per row; on RPC error the row is kept.
 *
 * Args:
 *     rows: Results from `searchMusic` (Rutracker-only rows).
 *
 * Returns:
 *     Filtered rows.
 */
export async function filterRutrackerRowsWithPlayableAudio(rows) {
  if (!rows?.length) return [];
  const mirror = getMirror();
  const flags = await mapPool(rows, TOPIC_AUDIO_CHECK_WORKERS, (row) =>
    invoke("rutracker_topic_has_playable_audio", {
      mirror,
      topicId: String(row.id),
    })
      .then((v) => Boolean(v))
      .catch(() => true),
  );
  return rows.filter((_, j) => flags[j]);
}

// ── Torrent details LRU cache ─────────────────────────────────────────────────
// Keyed by topicId. Stores resolved details or an in-flight Promise (dedup).
const _detailsCache = new Map();
const DETAILS_CACHE_MAX = 25;

function _detailsCacheEvict() {
  if (_detailsCache.size >= DETAILS_CACHE_MAX) {
    _detailsCache.delete(_detailsCache.keys().next().value);
  }
}

/**
 * Fetch full torrent details: file list, magnet link, and cover image.
 * The cover is returned as a base64 data: URL ready for use in <img src>.
 * In-flight requests are deduplicated; resolved results are cached in memory.
 * @param {string} topicId
 * @returns {Promise<{id, cover_data_url: string|null, magnet: string|null, files: Array<{path: string[], size: number}>}>}
 */
export function getTorrentDetails(topicId) {
  const key = String(topicId);
  const hit = _detailsCache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);

  const mirror = getMirror();
  const p = invoke("rutracker_get_torrent_details", { mirror, topicId })
    .then((details) => {
      rememberRutrackerCover(topicId, details.cover_data_url ?? null);
      _detailsCacheEvict();
      _detailsCache.set(key, details);
      return details;
    })
    .catch((err) => {
      _detailsCache.delete(key);
      throw err;
    });

  _detailsCacheEvict();
  _detailsCache.set(key, p);
  return p;
}

/**
 * Warm the details cache on hover — so clicking the card feels instant.
 * Safe to call speculatively; ignores errors silently.
 * @param {string} topicId
 */
export function prefetchTorrentDetails(topicId) {
  if (!topicId) return;
  const key = String(topicId);
  if (_detailsCache.has(key)) return;
  getTorrentDetails(topicId).catch(() => {});
}
