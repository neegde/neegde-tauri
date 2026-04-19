/**
 * Torrent HTTP stream tokens (local player URL). Prefer `releaseTorrentStreamUrl` when clearing
 * `src` — do not call `torrent_dispose_preview` from navigation; it clears all tokens and breaks
 * background playback.
 */
import { invoke } from "@tauri-apps/api/core";
import { appDebugLog } from "../appDebugLog.js";

/** Clears every registered stream (e.g. cache purge). Not for normal navigation. */
export function disposeTorrentPreview() {
  return invoke("torrent_dispose_preview").catch(() => {});
}

/** Frees one stream by URL path token so LRU can evict the torrent. */
export function releaseTorrentStreamUrl(url) {
  if (!url || typeof url !== "string") return Promise.resolve();
  const slsk = "/slsk/";
  const si = url.indexOf(slsk);
  if (si >= 0) {
    const rest = url.slice(si + slsk.length);
    const token = rest.split(/[/?#]/)[0];
    if (!token) return Promise.resolve();
    void appDebugLog("stream", `release: soulseek token=${token}`);
    return invoke("soulseek_release_stream", { token }).catch((e) => {
      void appDebugLog("stream", `release: soulseek error — token=${token} err=${String(e)}`);
    });
  }
  const marker = "/stream/";
  const i = url.indexOf(marker);
  if (i < 0) return Promise.resolve();
  const rest = url.slice(i + marker.length);
  const token = rest.split(/[/?#]/)[0];
  if (!token) return Promise.resolve();
  void appDebugLog("stream", `release: token=${token}`);
  return invoke("torrent_release_stream", { token }).catch((e) => {
    void appDebugLog("stream", `release: invoke error — token=${token} err=${String(e)}`);
  });
}

/** Просит Tauri прервать долгий `torrent_prepare_stream` (prebuffer). */
export function torrentPrepareCancel() {
  void appDebugLog("stream", "prepare: cancel requested by user");
  return invoke("torrent_prepare_cancel").catch(() => {});
}

/** Extract the token from a stream URL like http://127.0.0.1:PORT/stream/TOKEN */
function tokenFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const marker = "/stream/";
  const i = url.indexOf(marker);
  if (i < 0) return null;
  const rest = url.slice(i + marker.length);
  return rest.split(/[/?#]/)[0] || null;
}

/**
 * Уведомляет движок о текущей позиции воспроизведения в байтах.
 * Вызывай при seek-е; движок сдвинет окно приоритета пьес.
 *
 * @param {string} url  URL потока вида http://127.0.0.1:PORT/stream/TOKEN
 * @param {number} byteOffset  Текущая позиция в байтах
 */
/**
 * Возвращает статистику скачивания для потока: { download_rate (bytes/sec), num_peers }.
 * Используй во время фазы buffering чтобы показать прогресс пользователю.
 *
 * @param {string} url  URL потока вида http://127.0.0.1:PORT/stream/TOKEN
 * @returns {Promise<{download_rate: number, num_peers: number}|null>}
 */
export function vozduxanStreamStats(url) {
  const token = tokenFromUrl(url);
  if (!token) return Promise.resolve(null);
  return invoke("vozduxan_stream_stats", { token }).catch(() => null);
}

export function vozduxanNotifyPosition(url, byteOffset) {
  if (!url || typeof url !== "string") return Promise.resolve();
  const marker = "/stream/";
  const i = url.indexOf(marker);
  if (i < 0) return Promise.resolve();
  const rest = url.slice(i + marker.length);
  const token = rest.split(/[/?#]/)[0];
  if (!token) return Promise.resolve();
  return invoke("vozduxan_notify_position", {
    token,
    byteOffset: Math.floor(byteOffset),
  }).catch(() => {});
}
