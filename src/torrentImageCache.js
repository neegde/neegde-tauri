import { invoke } from "@tauri-apps/api/core";

/** @type {Map<string, Promise<string | null>>} */
const pending = new Map();
/** @type {Map<string, string>} — только успешные data URL */
const cache = new Map();

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
 * @returns {Promise<string | null>}
 */
export async function getTorrentImageDataUrl(magnet, fileIdx) {
  const key = cacheKey(magnet, fileIdx);
  if (cache.has(key)) return cache.get(key);

  let p = pending.get(key);
  if (!p) {
    p = invoke("torrent_fetch_image", { magnet, fileIdx })
      .then((u) => {
        const v = u ?? null;
        if (v) cache.set(key, v);
        return v;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, p);
  }
  return p;
}
