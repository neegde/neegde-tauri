import { invalidateRutrackerCover } from "../rutracker/coverCache.js";
import { getTorrentImageDataUrl, invalidateTorrentImage } from "./torrentImageCache.js";
import { torrentFileB64ForTrack } from "./api.js";
import { fetchTorrentEmbeddedCoverBytes } from "./embeddedCover.js";
import {
  addCoverReloadStep,
  beginCoverReload,
  finishCoverReload,
  updateCoverReloadSummary,
} from "../cover/coverReloadStatus.js";

export interface ReloadTorrentRowCoverParams {
  torrentSource: string;
  torrentId: string | number | null | undefined;
  magnet: string;
  origIdx: number;
  trackName?: string;
  albums: Array<{
    audioFiles: Array<{ origIdx: number }>;
    coverFile: { origIdx: number } | null;
  }>;
}

export interface ReloadTorrentRowCoverResult {
  /** `data:` URL from embedded audio tags when folder/topic paths did not suffice. */
  embeddedDataUrl: string | null;
}

/**
 * Clears RuTracker topic + in-torrent folder cover caches for the album that
 * contains `origIdx`, then refetches the folder image so the UI updates.
 * Falls back to reading embedded cover art from the start of the audio file.
 *
 * @param params - Torrent identity, magnet, row index, and `detectAlbums` output.
 */
export async function reloadTorrentRowCoverArt(
  params: ReloadTorrentRowCoverParams,
): Promise<ReloadTorrentRowCoverResult> {
  const { torrentSource, torrentId, magnet, origIdx, trackName, albums } = params;
  const runId = beginCoverReload(trackName || `Трек #${origIdx}`, "Ищу обложку альбома в раздаче…");
  if (torrentSource === "rutracker" && torrentId != null && String(torrentId) !== "") {
    invalidateRutrackerCover(String(torrentId));
    addCoverReloadStep(runId, "RuTracker: сбросил кэш обложки темы", "success");
  }
  if (!magnet) {
    addCoverReloadStep(runId, "У трека нет magnet-ссылки для поиска картинки в раздаче", "fail");
    finishCoverReload(runId, false, "Обложку не получилось искать: нет magnet-ссылки.");
    return { embeddedDataUrl: null };
  }
  for (const al of albums) {
    const cf = al.coverFile;
    if (!cf) continue;
    if (!al.audioFiles.some((f) => f.origIdx === origIdx)) continue;
    invalidateTorrentImage(magnet, cf.origIdx);
    addCoverReloadStep(runId, `Torrent: нашёл файл обложки #${cf.origIdx} рядом с треком`, "success");
    updateCoverReloadSummary(runId, "Загружаю .torrent для быстрого чтения картинки…");
    const b64 = await torrentFileB64ForTrack({
      source: torrentSource,
      torrentId: torrentId ?? undefined,
    }).catch(() => null);
    addCoverReloadStep(runId, b64 ? ".torrent найден: читаю картинку без ожидания DHT" : ".torrent недоступен: пробую через magnet/DHT", "info");
    updateCoverReloadSummary(runId, "Скачиваю картинку обложки из раздачи…");
    const dataUrl = await getTorrentImageDataUrl(magnet, cf.origIdx, b64);
    if (dataUrl) {
      addCoverReloadStep(runId, "Картинка успешно загружена из раздачи", "success");
      finishCoverReload(runId, true, "Готово: обложка альбома обновлена.");
      return { embeddedDataUrl: null };
    }
    addCoverReloadStep(runId, "Источник не вернул картинку или файл недоступен", "fail");
    break;
  }

  addCoverReloadStep(runId, "Пробую извлечь обложку из метатегов аудиофайла (первые ~768 КБ)…", "pending");
  updateCoverReloadSummary(runId, "Читаю начало аудиотрека из торрента…");
  const embedded = await fetchTorrentEmbeddedCoverBytes({
    magnet,
    fileIdx: origIdx,
    source: torrentSource,
    torrentId: torrentId ?? undefined,
  });
  if (embedded) {
    addCoverReloadStep(runId, "Найдена встроенная обложка в метаданных аудиофайла", "success");
    finishCoverReload(runId, true, "Готово: обложка из тегов в начале файла.");
    return { embeddedDataUrl: embedded };
  }
  addCoverReloadStep(runId, "Встроенная обложка в доступном префиксе не найдена", "fail");
  finishCoverReload(
    runId,
    false,
    "Обложка не найдена: нет файла рядом с треком и нет картинки в начале аудиофайла (часть MP3 хранит теги только в конце).",
  );
  return { embeddedDataUrl: null };
}
