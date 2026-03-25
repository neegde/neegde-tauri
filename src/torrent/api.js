import { invoke } from "@tauri-apps/api/core";
import { enrichMagnetWithOpenTrackers } from "../lib/utils.js";
import { getMirror } from "../rutracker/config.js";

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
    torrentFileB64 = await invoke("rutracker_download_torrent_file_b64", {
      mirror: getMirror(),
      topicId: tid,
    }).catch(() => null);
  }
  const ready = await invoke("torrent_prepare_stream", {
    magnet: m,
    fileIdx,
    torrentFileB64,
  });
  return ready?.url ?? "";
}
