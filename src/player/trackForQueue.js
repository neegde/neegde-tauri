/**
 * Builders + registration helpers that attach a Track entity to the queue.
 *
 * The legacy queue stores rich rows (fields like `magnet`, `fileIdx`, `torrentId`,
 * `slskUsername`, etc.). The refactor wants every queue item to also carry a
 * `trackId` that resolves through the entities registry — Player.vue can then
 * migrate to reading Track entities incrementally.
 *
 * These helpers synthesize a Track entity from whatever shape the caller has
 * (RT file + torrent row, SLSK file, magnet file) and register it. Safe to
 * call many times for the same id — `registerEntity` is idempotent.
 */

import { registerEntity } from "../stores/entities.js";
import { trackDisplayBasename } from "../lib/utils.js";

/**
 * Stable Track id for a RuTracker file. Prefers the topic id (torrents are
 * keyed by topic in the cache); falls back to magnet btih for magnet-only
 * links. Returns null when neither is available.
 */
export function rtTrackId(topicId, magnetBtih, fileIdx) {
  if (topicId != null && String(topicId).trim() !== "") {
    return `rt:track:${topicId}:${fileIdx}`;
  }
  if (magnetBtih) return `magnet:track:${magnetBtih}:${fileIdx}`;
  return null;
}

/**
 * @param {object} f                File object from TorrentView's flat list (`origIdx`, `path`, `size`, ...).
 * @param {object} torrent          Selected torrent row (`id`, `name`, `artist`, `source`, `__topicId`, ...).
 * @param {string} magnet           Magnet URI in use.
 * @param {string|null} magnetBtih  Optional pre-parsed btih for magnet-only sources.
 * @param {number|null} coverFileIdx
 * @param {string|null} albumDirPath
 * @returns {import("../types/entities.js").Track | null}
 */
export function buildRtTrackEntity(f, torrent, magnet, magnetBtih, coverFileIdx, albumDirPath) {
  const topicId = torrent?.__topicId ?? torrent?.id ?? null;
  const id = rtTrackId(topicId, magnetBtih, f.origIdx);
  if (!id) return null;
  return {
    type: "track",
    id,
    title: trackDisplayBasename(f.path),
    artist: torrent?.artist ?? null,
    albumTitle: torrent?.name ?? null,
    fileName: trackDisplayBasename(f.path),
    format: null,
    bitrate: null,
    duration: null,
    size: f.size ?? null,
    albumId: null,
    sources: [{
      kind: torrent?.source === "magnet" ? "magnet" : "rutracker",
      refs: {
        topicId: topicId != null ? String(topicId) : null,
        magnet,
        fileIdx: f.origIdx,
        coverFileIdx,
        albumDirPath,
      },
      raw: { file: f, torrent },
    }],
    score: 0,
    mergedFrom: 1,
  };
}

/**
 * @returns {import("../types/entities.js").Track | null}
 */
export function buildSlskTrackEntity({ username, filepath, size, filename, artist, cover, albumTitle }) {
  if (!username || !filepath) return null;
  const id = `slsk:track:${username}|${filepath}`;
  return {
    type: "track",
    id,
    title: filename,
    artist: artist ?? null,
    albumTitle: albumTitle ?? null,
    fileName: filename,
    format: null,
    bitrate: null,
    duration: null,
    size: size ?? null,
    albumId: null,
    sources: [{
      kind: "soulseek",
      refs: { slskUsername: username, slskFilepath: filepath },
      raw: { cover: cover ?? null },
    }],
    score: 0,
    mergedFrom: 1,
  };
}

/** Register + return the id. Null when the entity couldn't be built. */
export function registerAndGetId(entity) {
  if (!entity) return null;
  registerEntity(entity);
  return entity.id;
}
