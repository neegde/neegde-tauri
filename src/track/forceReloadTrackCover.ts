import { Track } from "./Track.js";
import { RutrackerTrack } from "./RutrackerTrack.js";
import { SoulseekTrack } from "./SoulseekTrack.js";
import type { MagnetRefs, RutrackerRefs, SoulseekTrackSource } from "./types.js";
import { invalidateRutrackerCover } from "../rutracker/coverCache.js";
import { invalidateSlskCover } from "../soulseek/coverCache.js";
import { invalidateTorrentImage } from "../torrent/torrentImageCache.js";
import { bumpEntitiesVersion } from "../stores/entities.js";
import { putTrack } from "../persistence/trackCache.js";
import {
  addCoverReloadStep,
  beginCoverReload,
  coverReloadToast,
  finishCoverReload,
  updateCoverReloadSummary,
} from "../cover/coverReloadStatus.js";
import {
  fetchTorrentEmbeddedCoverBytes,
  fetchTorrentEmbeddedCoverFullFile,
  fetchSoulseekEmbeddedCoverFullFile,
  soulseekFullEmbeddedParamsForTrack,
  torrentEmbeddedParamsForTrack,
} from "../torrent/embeddedCover.js";
import { SLSK_FOLDER_COVER_NAMES_EXHAUSTIVE } from "../soulseek/slskFolderCoverGuess.js";

function clearStoredExternalCover(track: Track): boolean {
  const d = track.toJSON();
  if (!d.coverUrl) return false;
  d.coverUrl = null;
  putTrack(track);
  bumpEntitiesVersion();
  return true;
}

function invalidateSoulseekCoverKeys(track: SoulseekTrack): void {
  const ref = track.getCoverRef();
  if (ref?.slsk_username && ref?.slsk_filepath) {
    invalidateSlskCover(ref.slsk_username, ref.slsk_filepath);
  }
  const src = track.sources[0] as SoulseekTrackSource;
  const u = src.refs.slskUsername;
  const fp = src.refs.slskFilepath;
  if (!u || !fp) return;
  const lastSep = Math.max(fp.lastIndexOf("\\"), fp.lastIndexOf("/"));
  if (lastSep < 0) return;
  const dir = fp.slice(0, lastSep + 1);
  for (const name of SLSK_FOLDER_COVER_NAMES_EXHAUSTIVE) {
    invalidateSlskCover(u, dir + name);
  }
}

function invalidateRutrackerFamilyCoverKeys(track: RutrackerTrack): void {
  const s = track.sources[0];
  if (!s || (s.kind !== "rutracker" && s.kind !== "magnet")) return;
  if (s.kind === "rutracker") {
    const r = s.refs as RutrackerRefs;
    if (r.topicId) invalidateRutrackerCover(r.topicId);
    const magnet = r.magnet ?? "";
    if (magnet && r.coverFileIdx != null && Number.isFinite(Number(r.coverFileIdx))) {
      invalidateTorrentImage(magnet, Number(r.coverFileIdx));
    }
    return;
  }
  const m = s.refs as MagnetRefs;
  const magnet = m.magnet ?? "";
  if (magnet && m.coverFileIdx != null && Number.isFinite(Number(m.coverFileIdx))) {
    invalidateTorrentImage(magnet, Number(m.coverFileIdx));
  }
}

/**
 * Builds the human-readable title for the floating cover reload card.
 *
 * @param track - Track being refreshed.
 * @returns Short title suitable for a toast.
 */
function coverReloadTitle(track: Track): string {
  return track.title || track.fileName || "Трек";
}

/**
 * Waits for the next polling tick.
 *
 * @param ms - Delay in milliseconds.
 * @returns Promise resolved after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persists a `data:` cover URL on the track entity so {@link Track.coverUrl} picks it up.
 *
 * @param track - Track receiving the embedded artwork.
 * @param dataUrl - `data:image/...;base64,...` string from the backend.
 * @returns void
 */
function applyPersistedCoverUrl(track: Track, dataUrl: string): void {
  const d = track.toJSON();
  d.coverUrl = dataUrl;
  putTrack(track);
  bumpEntitiesVersion();
}

/**
 * Polls for a refreshed cover, then falls back to reading embedded artwork from the
 * leading bytes of a torrent audio file when applicable.
 *
 * @param runId - Active toast run id.
 * @param track - Track being refreshed.
 * @returns Promise resolved when the flow finishes.
 */
async function runCoverReload(runId: number, track: Track): Promise<void> {
  const embParams = torrentEmbeddedParamsForTrack(track);
  const embedP = embParams
    ? (async () => {
        addCoverReloadStep(
          runId,
          "Torrent: читаю ~768 КБ с начала аудиофайла и ищу картинку в метатегах (ID3 / FLAC / MP4)…",
          "pending",
        );
        updateCoverReloadSummary(runId, "Параллельно: встроенная обложка из аудио…");
        const u = await fetchTorrentEmbeddedCoverBytes(embParams);
        if (!coverReloadToast.value.done) {
          if (u) {
            addCoverReloadStep(runId, "Встроенная обложка из метаданных найдена", "success");
          } else {
            addCoverReloadStep(runId, "В префиксе файла встроенной обложки нет", "fail");
          }
        }
        return u;
      })()
    : Promise.resolve(null);

  for (let i = 0; i < 80; i++) {
    await delay(500);
    if (track.coverUrl()) {
      if (!coverReloadToast.value.done) {
        addCoverReloadStep(runId, "Обложка появилась из основного источника", "success");
        finishCoverReload(runId, true, "Готово: обложка найдена и обновлена.");
      }
      return;
    }
  }

  const emb = await embedP;

  if (track.coverUrl()) {
    if (!coverReloadToast.value.done) {
      addCoverReloadStep(runId, "Обложка появилась из основного источника", "success");
      finishCoverReload(runId, true, "Готово: обложка найдена и обновлена.");
    }
    return;
  }

  if (emb) {
    applyPersistedCoverUrl(track, emb);
    if (!coverReloadToast.value.done) {
      finishCoverReload(runId, true, "Готово: картинка взята из метатегов аудиофайла (начало файла).");
    }
    return;
  }

  if (!coverReloadToast.value.done) {
    addCoverReloadStep(
      runId,
      "Обложка не найдена (внешние источники и встроенные теги в доступном префиксе файла)",
      "fail",
    );
    finishCoverReload(
      runId,
      false,
      "Обложка не найдена. Для части MP3 обложка может быть только в конце файла — тогда этот способ её не увидит.",
    );
  }
}

/**
 * Drops cached cover layers for `track` (RuTracker topic, in-torrent file,
 * SoulSeek peer file, optional enriched URL) and kicks an asynchronous refetch.
 *
 * @param track - Concrete `Track` subclass instance from the entities registry.
 */
export function forceReloadTrackCover(track: Track): void {
  const runId = beginCoverReload(coverReloadTitle(track), "Сбрасываю старую обложку и запускаю поиск…");
  if (clearStoredExternalCover(track)) {
    addCoverReloadStep(runId, "Убрал сохранённую внешнюю обложку трека", "success");
  }
  if (track instanceof SoulseekTrack) {
    invalidateSoulseekCoverKeys(track);
    addCoverReloadStep(runId, "SoulSeek: сброшен кэш текущего cover-ref", "success");
    addCoverReloadStep(
      runId,
      "SoulSeek: полный обход типичных имён обложки в папке (folder/cover/front/album, png)",
      "pending",
    );
  } else if (track instanceof RutrackerTrack) {
    invalidateRutrackerFamilyCoverKeys(track);
    addCoverReloadStep(runId, "Torrent: сброшена обложка темы и/или картинка из раздачи", "success");
    addCoverReloadStep(runId, "RuTracker: заново запрашиваю обложку темы", "pending");
  } else {
    addCoverReloadStep(runId, "Источник трека попросили заново найти обложку", "pending");
  }
  updateCoverReloadSummary(runId, "Жду ответ источника обложек…");
  if (track instanceof SoulseekTrack) {
    track.startCoverFetch(undefined, { peerGuess: "exhaustive" });
  } else {
    track.startCoverFetch();
  }
  void runCoverReload(runId, track);
}

/**
 * Explicitly scans a whole local or torrent-backed audio file for embedded artwork and persists it.
 *
 * @param track - RuTracker / magnet / SoulSeek track with downloadable audio identity.
 */
export function forceReloadTrackCoverFromFullFile(track: Track): void {
  const runId = beginCoverReload(coverReloadTitle(track), "Ищу встроенную обложку в полном аудиофайле…");
  const slskParams = soulseekFullEmbeddedParamsForTrack(track);
  const embParams = torrentEmbeddedParamsForTrack(track);
  if (!slskParams && !embParams) {
    addCoverReloadStep(runId, "Нет данных для скачивания полного файла (torrent или SoulSeek)", "fail");
    finishCoverReload(
      runId,
      false,
      "Нужны magnet+индекс файла в раздаче или активный пир SoulSeek с путём к аудио.",
    );
    return;
  }

  if (slskParams) {
    addCoverReloadStep(runId, "SoulSeek: скачиваю аудиофайл целиком с пира…", "pending");
    updateCoverReloadSummary(runId, "Это может занять время…");
    void fetchSoulseekEmbeddedCoverFullFile(slskParams)
      .then((embedded) => {
        if (!embedded) {
          addCoverReloadStep(runId, "Встроенная обложка в полном файле не найдена", "fail");
          finishCoverReload(runId, false, "Обложка не найдена в метатегах аудиофайла.");
          return;
        }
        applyPersistedCoverUrl(track, embedded);
        addCoverReloadStep(runId, "Найдена встроенная обложка в полном аудиофайле", "success");
        finishCoverReload(runId, true, "Готово: обложка взята из метатегов полного файла.");
      })
      .catch((err) => {
        addCoverReloadStep(runId, `Ошибка чтения полного файла: ${String(err)}`, "fail");
        finishCoverReload(runId, false, "Не удалось скачать или прочитать полный аудиофайл с SoulSeek.");
      });
    return;
  }

  addCoverReloadStep(runId, "Torrent: читаю аудиофайл целиком и ищу картинку в метатегах", "pending");
  updateCoverReloadSummary(runId, "Это может занять время: нужно скачать полный файл…");
  if (!embParams) {
    finishCoverReload(runId, false, "Нет параметров torrent для чтения файла.");
    return;
  }
  void fetchTorrentEmbeddedCoverFullFile(embParams)
    .then((embedded) => {
      if (!embedded) {
        addCoverReloadStep(runId, "Встроенная обложка в полном файле не найдена", "fail");
        finishCoverReload(runId, false, "Обложка не найдена в метатегах аудиофайла.");
        return;
      }
      applyPersistedCoverUrl(track, embedded);
      addCoverReloadStep(runId, "Найдена встроенная обложка в полном аудиофайле", "success");
      finishCoverReload(runId, true, "Готово: обложка взята из метатегов полного файла.");
    })
    .catch((err) => {
      addCoverReloadStep(runId, `Ошибка чтения полного файла: ${String(err)}`, "fail");
      finishCoverReload(runId, false, "Не удалось прочитать полный аудиофайл.");
    });
}
