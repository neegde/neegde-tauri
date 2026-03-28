import { invoke } from "@tauri-apps/api/core";
import { enrichMagnetWithOpenTrackers } from "../lib/utils.js";
import { getMirror } from "../rutracker/config.js";

/**
 * In-memory cache: topicId → Promise<string|null>.
 * Prevents re-downloading the same .torrent file when switching tracks or during prefetch.
 * Capped at 30 entries (FIFO) to avoid unbounded growth in long sessions.
 */
const _torrentFileCache = new Map();
const TORRENT_FILE_CACHE_MAX = 30;

function _cachedTorrentFileB64(tid) {
  if (!_torrentFileCache.has(tid)) {
    if (_torrentFileCache.size >= TORRENT_FILE_CACHE_MAX) {
      _torrentFileCache.delete(_torrentFileCache.keys().next().value);
    }
    _torrentFileCache.set(
      tid,
      invoke("rutracker_download_torrent_file_b64", {
        mirror: getMirror(),
        topicId: tid,
      }).catch(() => null),
    );
  }
  return _torrentFileCache.get(tid);
}

/**
 * URL для воспроизведения или превью файла из торрента (обложка в папке, трек и т.д.).
 * Запускает нативный torrent-stream backend:
 * magnet -> open -> optional prebuffer -> local HTTP URL (default: no blocking pre-read).
 * Для RuTracker при наличии `torrentId` подгружает `.torrent` по HTTP, чтобы librqbit не ждал
 * метаданные по magnet (DHT/трекеры).
 * @param {string} magnet
 * @param {number} fileIdx
 * @param {{ source?: string, torrentId?: string | number }} [opts]
 */
export async function streamUrl(magnet, fileIdx, opts = {}) {
  if (!magnet || fileIdx == null || fileIdx < 0) return "";
  const m = enrichMagnetWithOpenTrackers(magnet);
  let torrentFileB64 = null;
  const src = opts.source != null ? String(opts.source) : "";
  const tid = opts.torrentId != null ? String(opts.torrentId) : "";
  if (src === "rutracker" && tid !== "") {
    torrentFileB64 = await _cachedTorrentFileB64(tid);
  }
  const ready = await invoke("torrent_prepare_stream", {
    magnet: m,
    fileIdx,
    torrentFileB64,
  });
  return ready?.url ?? "";
}

/**
 * Fetches RuTracker .torrent base64 when needed (same rules as `streamUrl`).
 * Uses an in-memory cache so repeated calls for the same track are instant.
 *
 * Args:
 *     track: Queue item with optional `source` and `torrentId`.
 *
 * Returns:
 *     Base64 string or null.
 */
export async function torrentFileB64ForTrack(track) {
  if (!track) return null;
  const src = track.source != null ? String(track.source) : "";
  const tid = track.torrentId != null ? String(track.torrentId) : "";
  if (src !== "rutracker" || tid === "") return null;
  return _cachedTorrentFileB64(tid);
}

/**
 * Warms the next queue item while the current track plays (same-torrent file union or silent prepare).
 *
 * Args:
 *     current: Current queue item (`magnet`, `fileIdx`, optional `source` / `torrentId`).
 *     next: Next queue item.
 *
 * Returns:
 *     `{ kind: 'sameTorrentMerged' }` or `{ kind: 'streamReady', url }`, or null on invalid input.
 */
export async function prefetchNextInQueue(current, next) {
  if (!current?.magnet || next?.magnet == null || next.fileIdx == null || next.fileIdx < 0) {
    return null;
  }
  const m0 = enrichMagnetWithOpenTrackers(current.magnet);
  const m1 = enrichMagnetWithOpenTrackers(next.magnet);
  const nextTorrentFileB64 = await torrentFileB64ForTrack(next);
  return invoke("torrent_prefetch_next_track", {
    currentMagnet: m0,
    currentFileIdx: current.fileIdx,
    nextMagnet: m1,
    nextFileIdx: next.fileIdx,
    nextTorrentFileB64,
  });
}
