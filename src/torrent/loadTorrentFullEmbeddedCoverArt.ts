import {
  addCoverReloadStep,
  beginCoverReload,
  finishCoverReload,
  updateCoverReloadSummary,
} from "../cover/coverReloadStatus.js";
import { fetchTorrentEmbeddedCoverFullFile } from "./embeddedCover.js";

export interface LoadTorrentFullEmbeddedCoverParams {
  torrentSource: string;
  torrentId: string | number | null | undefined;
  magnet: string;
  origIdx: number;
  trackName?: string;
}

export interface LoadTorrentFullEmbeddedCoverResult {
  embeddedDataUrl: string | null;
}

/**
 * Explicitly scans a whole torrent audio file for embedded cover art.
 *
 * @param params - Torrent identity and audio file index.
 * @returns Embedded `data:` URL when found.
 */
export async function loadTorrentFullEmbeddedCoverArt(
  params: LoadTorrentFullEmbeddedCoverParams,
): Promise<LoadTorrentFullEmbeddedCoverResult> {
  const { torrentSource, torrentId, magnet, origIdx, trackName } = params;
  const runId = beginCoverReload(trackName || `Трек #${origIdx}`, "Ищу встроенную обложку в полном аудиофайле…");
  if (!magnet) {
    addCoverReloadStep(runId, "У трека нет magnet-ссылки для чтения файла", "fail");
    finishCoverReload(runId, false, "Обложку не получилось искать: нет magnet-ссылки.");
    return { embeddedDataUrl: null };
  }

  addCoverReloadStep(runId, "Torrent: читаю аудиофайл целиком и ищу картинку в метатегах", "pending");
  updateCoverReloadSummary(runId, "Это может занять время: нужно скачать полный файл…");
  const embedded = await fetchTorrentEmbeddedCoverFullFile({
    magnet,
    fileIdx: origIdx,
    source: torrentSource,
    torrentId: torrentId ?? undefined,
  }).catch((err) => {
    addCoverReloadStep(runId, `Ошибка чтения полного файла: ${String(err)}`, "fail");
    return null;
  });

  if (embedded) {
    addCoverReloadStep(runId, "Найдена встроенная обложка в полном аудиофайле", "success");
    finishCoverReload(runId, true, "Готово: обложка взята из метатегов полного файла.");
    return { embeddedDataUrl: embedded };
  }

  addCoverReloadStep(runId, "Встроенная обложка в полном файле не найдена", "fail");
  finishCoverReload(runId, false, "Обложка не найдена в метатегах аудиофайла.");
  return { embeddedDataUrl: null };
}
