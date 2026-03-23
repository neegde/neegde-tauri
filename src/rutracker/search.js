import { invoke } from "@tauri-apps/api/core";
import { getMirror } from "./config.js";

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

/**
 * Fetch full torrent details: file list, magnet link, and cover image.
 * The cover is returned as a base64 data: URL ready for use in <img src>.
 * @param {string} topicId
 * @returns {Promise<{id, cover_data_url: string|null, magnet: string|null, files: Array<{path: string[], size: number}>}>}
 */
export async function getTorrentDetails(topicId) {
  const mirror = getMirror();
  return invoke("rutracker_get_torrent_details", { mirror, topicId });
}

/**
 * Cover from the first post of a topic, as base64 data URL (for grid previews).
 * @param {string} topicId
 * @returns {Promise<string|null>}
 */
export async function getRutrackerCoverDataUrl(topicId) {
  const mirror = getMirror();
  return invoke("rutracker_get_cover", { mirror, topicId });
}
