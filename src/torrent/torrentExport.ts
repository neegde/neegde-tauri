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

// ── StreamingExporter ───────────────────────────────────────────────────────

/**
 * Wrapper for the listen → invoke → finally → message pattern shared by
 * every "save something from a backend stream" flow. Each caller supplies
 * its own pre-validation, destination picker, preparing-state setup, and
 * the `task()` closure that issues the actual invoke(s). The class owns
 * the progress-listener lifecycle, the error-dialog mapping (with a
 * "остановлено" special case), the success dialog, and the onProgress
 * null-cleanup.
 */
class StreamingExporter {
  /** Opens the shared "Select destination" dir picker. Returns null on cancel. */
  static async pickDestDir(): Promise<string | null> {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Выберите папку для сохранения",
    });
    if (picked === null) return null;
    return Array.isArray(picked) ? picked[0]! : picked;
  }

  /**
   * Run a streaming export. Attaches the progress listener, executes
   * `task()`, and cleans up in `finally`. Errors are shown as dialogs —
   * "остановлено" shows an info dialog, anything else shows as error.
   * On success, displays `successMessage(result)`. Returns the task
   * result on success, `undefined` on error.
   */
  async run<T>(opts: {
    eventName: string;
    task: () => Promise<T>;
    onProgress?: OnProgress;
    /** Optional transformer applied to each event payload before `onProgress`. */
    mapPayload?: (p: ExportProgress) => ExportProgress;
    successMessage: (result: T) => string;
  }): Promise<T | undefined> {
    let unlisten: () => void = () => {};
    try {
      unlisten = await listen<ExportProgress>(opts.eventName, (ev) => {
        const payload = opts.mapPayload ? opts.mapPayload(ev.payload) : ev.payload;
        opts.onProgress?.(payload);
      });
      const result = await opts.task();
      await message(opts.successMessage(result), { title: "Скачивание" });
      return result;
    } catch (e) {
      const s = String(e);
      if (/остановлен/i.test(s)) {
        await message("Скачивание остановлено.", { title: "Скачивание", kind: "info" });
      } else {
        await message(s, { title: "Ошибка скачивания", kind: "error" });
      }
      return undefined;
    } finally {
      unlisten();
      opts.onProgress?.(null);
    }
  }
}

const exporter = new StreamingExporter();

// ── Public export functions ─────────────────────────────────────────────────

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

  const destDir = await StreamingExporter.pickDestDir();
  if (destDir === null) return;

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

  let groupIdx = 0;
  await exporter.run({
    eventName: "torrent-export-progress",
    onProgress,
    mapPayload: (p) => ({ ...p, batchIndex: groupIdx + 1, batchTotal: groupTotal }),
    task: async () => {
      let totalCopied = 0;
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
      return totalCopied;
    },
    successMessage: (totalCopied) => `Сохранено файлов: ${totalCopied}.`,
  });
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

  const destDir = await StreamingExporter.pickDestDir();
  if (destDir === null) return;

  onProgress?.({
    phase: "preparing",
    torrentState: "",
    progressBytes: 0,
    totalBytes: filesize,
    pct: 0,
    queueLabels: [rawName],
    message: "Подключение к пиру…",
  });

  await exporter.run({
    eventName: "slsk-export-progress",
    onProgress,
    task: () => invoke<string>("soulseek_export_file", {
      username,
      filepath,
      filesize,
      destDir,
      fileName: rawName,
    }),
    successMessage: (savedPath) => {
      const saved = String(savedPath).split(/[\\/]/).pop() ?? savedPath;
      return `Сохранено: ${saved}`;
    },
  });
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

  const destDir = await StreamingExporter.pickDestDir();
  if (destDir === null) return;

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

  await exporter.run({
    eventName: "torrent-export-progress",
    onProgress,
    task: () => invoke<ExportResult>("torrent_export_files", {
      magnet: enrichMagnetWithOpenTrackers(magnet),
      fileIndices: indices,
      destDir,
      fileNames: names,
      albumDirName,
      torrentFileB64,
    }),
    successMessage: (result) => `Сохранено файлов: ${result?.copied?.length ?? 0}.`,
  });
}
