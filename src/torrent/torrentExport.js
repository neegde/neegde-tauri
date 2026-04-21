import { invoke } from "@tauri-apps/api/core";
import { open, message } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { enrichMagnetWithOpenTrackers, trackDisplayBasename } from "../lib/utils.js";
import { torrentFileB64ForTrack } from "./api.js";

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
 * Скачивание всех треков плейлиста в выбранную папку.
 * Треки из одного торрента группируются и качаются одним вызовом.
 * @param {object[]} tracks — массив объектов плейлиста (magnet, fileIdx, fileName, source, torrentId)
 * @param {(p: ExportProgress | null) => void} [onProgress]
 */
export async function exportPlaylistTracks(tracks, onProgress) {
  const downloadable = (tracks ?? []).filter(
    (t) =>
      String(t.magnet ?? "").trim().length > 0 &&
      t.fileIdx != null &&
      Number.isFinite(Number(t.fileIdx))
  );

  if (!downloadable.length) {
    await message("Нет треков для скачивания.", { title: "Скачивание", kind: "info" });
    return;
  }

  const picked = await open({
    directory: true,
    multiple: false,
    title: "Выберите папку для сохранения",
  });
  if (picked === null) return;
  const destDir = Array.isArray(picked) ? picked[0] : picked;

  // Group tracks by magnet so files from the same torrent are fetched together
  const groupOrder = [];
  const groupMap = new Map();
  for (const t of downloadable) {
    if (!groupMap.has(t.magnet)) {
      groupMap.set(t.magnet, []);
      groupOrder.push(t.magnet);
    }
    groupMap.get(t.magnet).push(t);
  }
  const groupTotal = groupOrder.length;

  const allLabels = downloadable.map((t) => trackDisplayBasename(t.fileName));

  onProgress?.({
    phase: "preparing",
    torrentState: "",
    progressBytes: 0,
    totalBytes: 0,
    pct: 0,
    queueLabels: allLabels,
    message: "Подготовка…",
    batchIndex: 1,
    batchTotal: groupTotal,
  });

  let unlisten = () => {};
  let totalCopied = 0;
  try {
    let groupIdx = 0;
    unlisten = await listen("torrent-export-progress", (ev) => {
      onProgress?.({ ...ev.payload, batchIndex: groupIdx + 1, batchTotal: groupTotal });
    });

    for (const magnet of groupOrder) {
      const groupTracks = groupMap.get(magnet);
      let torrentFileB64 = null;
      try {
        torrentFileB64 = await torrentFileB64ForTrack(groupTracks[0]);
      } catch (_) {}

      const fileIndices = groupTracks.map((t) => Number(t.fileIdx));
      const fileNames = groupTracks.map((t) => trackDisplayBasename(t.fileName));

      const result = await invoke("torrent_export_files", {
        magnet: enrichMagnetWithOpenTrackers(magnet),
        fileIndices,
        destDir,
        fileNames,
        albumDirName: null,
        torrentFileB64,
      });
      totalCopied += result?.copied?.length ?? 0;
      groupIdx++;
    }

    await message(`Сохранено файлов: ${totalCopied}.`, { title: "Скачивание" });
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

/**
 * Скачивание трека из SoulSeek на диск с прогрессом.
 * Поддерживает объекты из поиска (slsk_username / slsk_filepath / size)
 * и из очереди / избранного / плейлиста (slskUsername / slskFilepath / slskFilesize).
 * @param {object} track
 * @param {(p: ExportProgress | null) => void} [onProgress]
 */
export async function exportSlskTrack(track, onProgress) {
  const username = track.slsk_username ?? track.slskUsername ?? "";
  const filepath = track.slsk_filepath ?? track.slskFilepath ?? "";
  const filesize = Number(track.size ?? track.slskFilesize ?? 0);

  if (!username || !filepath) {
    await message("Нет данных SoulSeek для скачивания.", { title: "Скачивание", kind: "error" });
    return;
  }

  // Extract original filename from path (preserve extension)
  const rawName = filepath.split(/[\\\/]/).pop() || track.name || "track";

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
    totalBytes: filesize,
    pct: 0,
    queueLabels: [rawName],
    message: "Подключение к пиру…",
  });

  let unlisten = () => {};
  try {
    unlisten = await listen("slsk-export-progress", (ev) => {
      onProgress?.(ev.payload);
    });

    const savedPath = await invoke("soulseek_export_file", {
      username,
      filepath,
      filesize,
      destDir,
      fileName: rawName,
    });

    const saved = String(savedPath).split(/[\\\/]/).pop() ?? savedPath;
    await message(`Сохранено: ${saved}`, { title: "Скачивание" });
  } catch (e) {
    const s = String(e);
    if (/остановлено/i.test(s)) {
      await message("Скачивание остановлено.", { title: "Скачивание", kind: "info" });
    } else {
      await message(s, { title: "Ошибка скачивания", kind: "error" });
    }
  } finally {
    unlisten();
    onProgress?.(null);
  }
}

/**
 * Выбор папки и копирование выбранных файлов торрента.
 * @param {string} magnet
 * @param {number[]} fileIndices — origIdx
 * @param {string[]} fileNames — подписи для очереди (тот же порядок)
 * @param {{ albumDirName?: string | null, track?: object }} [opts]
 *     `track` — optional queue/like row (`source`, `torrentId`) to fetch RuTracker `.torrent`
 *     like streaming (avoids DHT-only stalls).
 * @param {(p: ExportProgress) => void} [onProgress]
 */
export async function exportTorrentFiles(magnet, fileIndices, fileNames, opts, onProgress) {
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
  const albumDirNameRaw = opts?.albumDirName;
  const albumDirName =
    typeof albumDirNameRaw === "string" && albumDirNameRaw.trim()
      ? albumDirNameRaw.trim()
      : null;

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

  let torrentFileB64 = null;
  if (opts?.torrentFileB64) {
    torrentFileB64 = opts.torrentFileB64;
  } else if (opts?.track) {
    torrentFileB64 = await torrentFileB64ForTrack(opts.track);
  }

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
      albumDirName,
      torrentFileB64,
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
