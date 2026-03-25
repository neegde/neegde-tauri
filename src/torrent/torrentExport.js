import { invoke } from "@tauri-apps/api/core";
import { open, message } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { enrichMagnetWithOpenTrackers } from "../lib/utils.js";

/**
 * @typedef {Object} ExportProgress
 * @property {string} phase — preparing | downloading | copying | done
 * @property {string} torrentState
 * @property {number} progressBytes
 * @property {number} totalBytes
 * @property {number} pct
 * @property {string[]} queueLabels
 * @property {string} message
 * @property {number} [copyIndex]
 * @property {number} [copyTotal]
 * @property {string} [copyLabel]
 */

/**
 * Выбор папки и копирование выбранных файлов торрента.
 * @param {string} magnet
 * @param {number[]} fileIndices — origIdx
 * @param {string[]} fileNames — подписи для очереди (тот же порядок)
 * @param {(p: ExportProgress) => void} [onProgress]
 */
export async function exportTorrentFiles(magnet, fileIndices, fileNames, onProgress) {
  if (!magnet?.trim()) {
    await message("Нет magnet-ссылки. Откройте раздачу заново.", {
      title: "Скачивание",
      kind: "error",
    });
    return;
  }
  const indices = (fileIndices ?? []).filter(
    (i) => typeof i === "number" && Number.isFinite(i) && i >= 0
  );
  if (!indices.length) return;

  const names = indices.map((_, i) => String(fileNames?.[i] ?? ""));

  const picked = await open({
    directory: true,
    multiple: false,
    title: "Выберите папку для сохранения",
  });
  if (picked === null) return;
  const destDir = Array.isArray(picked) ? picked[0] : picked;

  onProgress?.({
    phase: "preparing",
    torrentState: "",
    progressBytes: 0,
    totalBytes: 0,
    pct: 0,
    queueLabels: names,
    message: "Запуск загрузки…",
  });

  let unlisten = () => {};
  try {
    unlisten = await listen("torrent-export-progress", (ev) => {
      onProgress?.(ev.payload);
    });

    const result = await invoke("torrent_export_files", {
      magnet: enrichMagnetWithOpenTrackers(magnet),
      fileIndices: indices,
      destDir,
      fileNames: names,
    });
    const n = result?.copied?.length ?? 0;
    await message(`Сохранено файлов: ${n}.`, { title: "Скачивание" });
  } catch (e) {
    const s = String(e);
    if (/остановлен/i.test(s)) {
      await message("Скачивание остановлено.", { title: "Скачивание", kind: "info" });
    } else {
      await message(s, { title: "Ошибка скачивания", kind: "error" });
    }
  } finally {
    unlisten();
    onProgress?.(null);
  }
}
