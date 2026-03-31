import { invoke } from "@tauri-apps/api/core";
import { reactive } from "vue";
import { enrichMagnetWithOpenTrackers } from "../lib/utils.js";

/** @type {Map<string, Promise<string | null>>} */
const pending = new Map();
/** @type {Map<string, string>} — только успешные data URL; reactive so Vue computed auto-updates */
const cache = reactive(new Map());
const TORRENT_IMAGE_CACHE_MAX = 200;

function cacheKey(magnet, fileIdx) {
  return `${magnet}\n${fileIdx}`;
}

/**
 * @returns {string | undefined} undefined if not cached
 */
export function peekTorrentImage(magnet, fileIdx) {
  return cache.get(cacheKey(magnet, fileIdx));
}

/**
 * @param {string} magnet
 * @param {number} fileIdx
 * @param {string | null} [torrentFileB64] - optional .torrent bytes (base64); skips DHT wait in Rust
 * @returns {Promise<string | null>}
 */
export async function getTorrentImageDataUrl(magnet, fileIdx, torrentFileB64 = null) {
  const key = cacheKey(magnet, fileIdx);
  if (cache.has(key)) return cache.get(key);

  let p = pending.get(key);
  if (!p) {
    p = invoke("torrent_fetch_image", {
      magnet: enrichMagnetWithOpenTrackers(magnet),
      fileIdx,
      torrentFileB64: torrentFileB64 ?? null,
    })
      .then((u) => {
        const v = u ?? null;
        if (v) {
          cache.set(key, v);
          if (cache.size > TORRENT_IMAGE_CACHE_MAX) {
            cache.delete(cache.keys().next().value);
          }
        }
        return v;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, p);
  }
  return p;
}
