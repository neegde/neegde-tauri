import { invoke } from "@tauri-apps/api/core";
import { reactive } from "vue";
import { enrichMagnetWithOpenTrackers } from "../lib/utils.js";
import { appDebugLog } from "../appDebugLog.js";

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
    const magnetFp = magnet.slice(0, 80);
    void appDebugLog("cover", `torrent cover: invoke start — fileIdx=${fileIdx} hasTorrentData=${!!torrentFileB64} magnet=${magnetFp}…`);
    p = invoke("torrent_fetch_image", {
      magnet: enrichMagnetWithOpenTrackers(magnet),
      fileIdx,
      torrentFileB64: torrentFileB64 ?? null,
    })
      .then((u) => {
        const v = u ?? null;
        if (v) {
          void appDebugLog("cover", `torrent cover: invoke OK — fileIdx=${fileIdx} dataUrlLen=${v.length}`);
          cache.set(key, v);
          if (cache.size > TORRENT_IMAGE_CACHE_MAX) {
            cache.delete(cache.keys().next().value);
          }
        } else {
          void appDebugLog("cover", `torrent cover: invoke returned null — fileIdx=${fileIdx} (Rust returned None, see vozduxan logs for reason)`);
        }
        return v;
      })
      .catch((e) => {
        void appDebugLog("cover", `torrent cover: invoke error — fileIdx=${fileIdx} err=${String(e)}`);
        return null;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, p);
  }
  return p;
}
