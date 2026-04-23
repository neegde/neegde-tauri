import { invoke } from "@tauri-apps/api/core";
import { open, message } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { enrichMagnetWithOpenTrackers, trackDisplayBasename } from "../lib/utils.js";
import { torrentFileB64ForTrack, type TrackForB64 } from "./api.js";

export interface ExportProgress {
  phase: string;
  torrentState: string;
  progressBytes: number;
  totalBytes: number;
  pct: number;
  queueLabels: string[];
  message: string;
  copyIndex?: number;
  copyTotal?: number;
  copyLabel?: string;
  batchIndex?: number;
  batchTotal?: number;
}

type OnProgress = (p: ExportProgress | null) => void;

interface ExportResult {
  copied?: unknown[];
}

interface PlaylistTrack {
  magnet?: string | null;
  fileIdx?: number | string | null;
  fileName?: string;
}

interface SlskTrackInput {
  slsk_username?: string;
  slskUsername?: string;
  slsk_filepath?: string;
  slskFilepath?: string;
  size?: number;
  slskFilesize?: number;
  name?: string;
  [k: string]: unknown;
}

interface ExportTorrentOpts {
  albumDirName?: string | null;
  track?: TrackForB64;
  torrentFileB64?: string | null;
}

export async function exportPlaylistTracks(
  tracks: PlaylistTrack[] | null | undefined,
  onProgress?: OnProgress,
): Promise<void> {
  const downloadable = (tracks ?? []).filter(
    (t) =>
      String(t.magnet ?? "").trim().length > 0 &&
      t.fileIdx != null &&
      Number.isFinite(Number(t.fileIdx)),
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

  const groupOrder: string[] = [];
  const groupMap = new Map<string, PlaylistTrack[]>();
  for (const t of downloadable) {
    const magnet = String(t.magnet);
    let bucket = groupMap.get(magnet);
    if (!bucket) {
      bucket = [];
      groupMap.set(magnet, bucket);
      groupOrder.push(magnet);
    }
    bucket.push(t);
  }
  const groupTotal = groupOrder.length;

  const allLabels = downloadable.map((t) => trackDisplayBasename(t.fileName ?? ""));

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

  let unlisten: () => void = () => {};
  let totalCopied = 0;
  try {
    let groupIdx = 0;
    unlisten = await listen<ExportProgress>("torrent-export-progress", (ev) => {
      onProgress?.({ ...ev.payload, batchIndex: groupIdx + 1, batchTotal: groupTotal });
    });

    for (const magnet of groupOrder) {
      const groupTracks = groupMap.get(magnet)!;
      let torrentFileB64: string | null = null;
      try {
        torrentFileB64 = await torrentFileB64ForTrack(groupTracks[0] as unknown as TrackForB64);
      } catch {
        /* ignore */
      }

      const fileIndices = groupTracks.map((t) => Number(t.fileIdx));
      const fileNames = groupTracks.map((t) => trackDisplayBasename(t.fileName ?? ""));

      const result = await invoke<ExportResult>("torrent_export_files", {
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

export async function exportSlskTrack(
  track: SlskTrackInput,
  onProgress?: OnProgress,
): Promise<void> {
  const username = track.slsk_username ?? track.slskUsername ?? "";
  const filepath = track.slsk_filepath ?? track.slskFilepath ?? "";
  const filesize = Number(track.size ?? track.slskFilesize ?? 0);

  if (!username || !filepath) {
    await message("Нет данных SoulSeek для скачивания.", { title: "Скачивание", kind: "error" });
    return;
  }

  const rawName = filepath.split(/[\\/]/).pop() || track.name || "track";

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

  let unlisten: () => void = () => {};
  try {
    unlisten = await listen<ExportProgress>("slsk-export-progress", (ev) => {
      onProgress?.(ev.payload);
    });

    const savedPath = await invoke<string>("soulseek_export_file", {
      username,
      filepath,
      filesize,
      destDir,
      fileName: rawName,
    });

    const saved = String(savedPath).split(/[\\/]/).pop() ?? savedPath;
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

export async function exportTorrentFiles(
  magnet: string,
  fileIndices: number[] | null | undefined,
  fileNames: string[] | null | undefined,
  opts?: ExportTorrentOpts,
  onProgress?: OnProgress,
): Promise<void> {
  if (!magnet?.trim()) {
    await message("Нет magnet-ссылки. Откройте раздачу заново.", {
      title: "Скачивание",
      kind: "error",
    });
    return;
  }
  const indices = (fileIndices ?? []).filter(
    (i) => typeof i === "number" && Number.isFinite(i) && i >= 0,
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

  let torrentFileB64: string | null = null;
  if (opts?.torrentFileB64) {
    torrentFileB64 = opts.torrentFileB64;
  } else if (opts?.track) {
    torrentFileB64 = await torrentFileB64ForTrack(opts.track);
  }

  let unlisten: () => void = () => {};
  try {
    unlisten = await listen<ExportProgress>("torrent-export-progress", (ev) => {
      onProgress?.(ev.payload);
    });

    const result = await invoke<ExportResult>("torrent_export_files", {
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
