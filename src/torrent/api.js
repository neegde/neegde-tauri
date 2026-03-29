import { invoke } from "@tauri-apps/api/core";
import { enrichMagnetWithOpenTrackers } from "../lib/utils.js";
import { getMirror } from "../rutracker/config.js";

/**
 * Resolves torrent file list from a magnet URI (DHT/trackers). Same row shape as Rutracker details.files.
 *
 * Args:
 *     magnet: Magnet URI (optionally enriched with open trackers).
 *
 * Returns:
 *     Array of `{ path: string[], size: number }`.
 */
export async function magnetListFiles(magnet) {
  return invoke("torrent_magnet_list_files", { magnet });
}

/**
 * In-memory LRU cache: topicId → Promise<string|null>.
 * Prevents re-downloading the same .torrent file when switching tracks or during prefetch.
 * Capped at 30 entries (LRU). Persisted to localStorage so restarts skip the network.
 */
const _torrentFileCache = new Map();
const TORRENT_FILE_CACHE_MAX = 30;
const _TORRENT_LS_PREFIX = "torrent_file_b64_v1_";

function _loadPersistedTorrentFiles() {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(_TORRENT_LS_PREFIX));
    for (const key of keys) {
      const tid = key.slice(_TORRENT_LS_PREFIX.length);
      const b64 = localStorage.getItem(key);
      if (b64) _torrentFileCache.set(tid, Promise.resolve(b64));
    }
  } catch {
    // localStorage unavailable
  }
}

function _persistTorrentFile(tid, b64) {
  try {
    localStorage.setItem(`${_TORRENT_LS_PREFIX}${tid}`, b64);
    // Trim localStorage to max entries
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(_TORRENT_LS_PREFIX));
    if (keys.length > TORRENT_FILE_CACHE_MAX) {
      keys.slice(0, keys.length - TORRENT_FILE_CACHE_MAX).forEach((k) => localStorage.removeItem(k));
    }
  } catch {
    // localStorage full or unavailable
  }
}

_loadPersistedTorrentFiles();

function _cachedTorrentFileB64(tid) {
  if (_torrentFileCache.has(tid)) {
    // LRU touch: move to end
    const p = _torrentFileCache.get(tid);
    _torrentFileCache.delete(tid);
    _torrentFileCache.set(tid, p);
    return p;
  }
  if (_torrentFileCache.size >= TORRENT_FILE_CACHE_MAX) {
    _torrentFileCache.delete(_torrentFileCache.keys().next().value);
  }
  const p = invoke("rutracker_download_torrent_file_b64", {
    mirror: getMirror(),
    topicId: tid,
  })
    .then((b64) => {
      if (b64) _persistTorrentFile(tid, b64);
      return b64 ?? null;
    })
    .catch(() => null);
  _torrentFileCache.set(tid, p);
  return p;
}

/**
 * URL для воспроизведения или превью файла из торрента (обложка в папке, трек и т.д.).
 * Запускает нативный torrent-stream слой (Tauri):
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
