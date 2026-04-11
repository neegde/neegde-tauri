/**
 * Torrent HTTP stream tokens (local player URL). Prefer `releaseTorrentStreamUrl` when clearing
 * `src` — do not call `torrent_dispose_preview` from navigation; it clears all tokens and breaks
 * background playback.
 */
import { invoke } from "@tauri-apps/api/core";

/** Clears every registered stream (e.g. cache purge). Not for normal navigation. */
export function disposeTorrentPreview() {
  return invoke("torrent_dispose_preview").catch(() => {});
}

/** Frees one stream by URL path token so LRU can evict the torrent. */
export function releaseTorrentStreamUrl(url) {
  if (!url || typeof url !== "string") return Promise.resolve();
  const marker = "/stream/";
  const i = url.indexOf(marker);
  if (i < 0) return Promise.resolve();
  const rest = url.slice(i + marker.length);
  const token = rest.split(/[/?#]/)[0];
  if (!token) return Promise.resolve();
  return invoke("torrent_release_stream", { token }).catch(() => {});
}

/** Просит Tauri прервать долгий `torrent_prepare_stream` (prebuffer). */
export function torrentPrepareCancel() {
  return invoke("torrent_prepare_cancel").catch(() => {});
}

/**
 * Уведомляет движок о текущей позиции воспроизведения в байтах.
 * Вызывай при seek-е; движок сдвинет окно приоритета пьес.
 *
 * @param {string} url  URL потока вида http://127.0.0.1:PORT/stream/TOKEN
 * @param {number} byteOffset  Текущая позиция в байтах
 */
export function blizNotifyPosition(url, byteOffset) {
  if (!url || typeof url !== "string") return Promise.resolve();
  const marker = "/stream/";
  const i = url.indexOf(marker);
  if (i < 0) return Promise.resolve();
  const rest = url.slice(i + marker.length);
  const token = rest.split(/[/?#]/)[0];
  if (!token) return Promise.resolve();
  return invoke("bliz_notify_position", {
    token,
    byteOffset: Math.floor(byteOffset),
  }).catch(() => {});
}
