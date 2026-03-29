import { invoke } from "@tauri-apps/api/core";
import { getMirror } from "./config.js";
import { rememberRutrackerCover, getRutrackerCoverDataUrl, peekRutrackerCover, clearRutrackerCoverCache } from "./coverCache.js";

export { getRutrackerCoverDataUrl, peekRutrackerCover, clearRutrackerCoverCache };

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
