import { invoke } from "@tauri-apps/api/core";

/**
 * URL для воспроизведения или превью файла из торрента (обложка в папке, трек и т.д.).
 * Запускает нативный torrent-stream backend:
 * magnet -> open -> prebuffer(512KB) -> local HTTP URL.
 * @param {string} magnet
 * @param {number} fileIdx
 */
export async function streamUrl(magnet, fileIdx) {
  if (!magnet || fileIdx == null || fileIdx < 0) return "";
  const ready = await invoke("torrent_prepare_stream", { magnet, fileIdx });
  return ready?.url ?? "";
}
