/**
 * Export/download composable.
 */

import { ref, type Ref, type ComputedRef } from "vue";
import {
  exportTorrentFiles, exportPlaylistTracks, exportSlskTrack,
} from "../torrent/torrentExport.js";
import { isAudio, trackDisplayBasename, type FileRow } from "../lib/utils.js";
import type { Track } from "../track/Track.js";

/** HMR-safe Track check — duck-typed on the API surface. */
function isTrack(t: unknown): t is Track {
  return !!t && (t as { type?: string }).type === "track" &&
    typeof (t as { exportToDisk?: unknown }).exportToDisk === "function";
}

interface SelectedLike {
  source?: string;
  id?: string | number;
  name?: string;
  [k: string]: unknown;
}

interface PlaylistWithTracks {
  tracks: Track[];
  [k: string]: unknown;
}

export interface UseDownloadsOptions {
  selected: Ref<SelectedLike | null>;
  torrentMagnet: Ref<string>;
  files: Ref<FileRow[]>;
  currentPlaylist: ComputedRef<PlaylistWithTracks | null>;
}

interface LegacyLikeRow {
  source?: string;
  magnet?: string;
  fileIdx?: number | string | null;
  fileName?: string;
  slskUsername?: string;
  slskFilepath?: string;
  slskFilesize?: number;
  [k: string]: unknown;
}

export function useDownloads(ctx: UseDownloadsOptions) {
  const downloadProgress = ref<unknown>(null);
  const downloadOverlayExpanded = ref<boolean>(true);

  function setProgress(p: unknown): void { downloadProgress.value = p; }

  function rutrackerTorrentFileOpts(): Record<string, unknown> {
    const s = ctx.selected.value;
    if (!s || String(s.source) !== "rutracker") return {};
    const tid = s.id != null && String(s.id).trim() !== "" ? s.id : null;
    if (tid == null) return {};
    return { track: { source: "rutracker", torrentId: tid } };
  }

  function handleDownloadTrack(origIdx: number): void {
    downloadOverlayExpanded.value = true;
    const f = ctx.files.value.find((x) => x.origIdx === origIdx);
    const label = f ? trackDisplayBasename(f.path) : `Файл ${origIdx}`;
    const fx = f as (FileRow & Partial<LegacyLikeRow>) | undefined;
    if (ctx.selected.value?.source === "soulseek" && fx?.slskUsername && fx?.slskFilepath) {
      exportSlskTrack(
        {
          slskUsername: fx.slskUsername,
          slskFilepath: fx.slskFilepath,
          slskFilesize: fx.slskFilesize ?? fx.size ?? 0,
          name: label,
        },
        setProgress,
      );
      return;
    }
    exportTorrentFiles(
      ctx.torrentMagnet.value,
      [origIdx],
      [label],
      rutrackerTorrentFileOpts(),
      setProgress,
    );
  }

  function handleDownloadTrackFromLike(like: LegacyLikeRow | null | undefined): void {
    if (!like) return;
    downloadOverlayExpanded.value = true;
    if (like.source === "soulseek") {
      exportSlskTrack(like, setProgress);
      return;
    }
    if (!like.magnet || like.fileIdx == null) return;
    const idx = Number(like.fileIdx);
    const label = trackDisplayBasename(like.fileName ?? "");
    exportTorrentFiles(like.magnet, [idx], [label], { track: like }, setProgress);
  }

  function handleDownloadSlskTrack(track: unknown): void {
    if (!isTrack(track)) return;
    downloadOverlayExpanded.value = true;
    void track.exportToDisk(setProgress);
  }

  function handleDownloadPlaylist(): void {
    const tracks = ctx.currentPlaylist.value?.tracks;
    if (!tracks?.length) return;
    downloadOverlayExpanded.value = true;
    exportPlaylistTracks(tracks, setProgress);
  }

  function handleDownloadFromQueue(q: LegacyLikeRow | null | undefined): void {
    if (!q?.magnet?.trim() || q.fileIdx == null) return;
    downloadOverlayExpanded.value = true;
    const idx = Number(q.fileIdx);
    const label = trackDisplayBasename(q.fileName ?? "");
    exportTorrentFiles(q.magnet, [idx], [label], { track: q }, setProgress);
  }

  async function exportSlskBatch(audio: Array<FileRow & Partial<LegacyLikeRow>>): Promise<void> {
    for (const f of audio) {
      if (!f?.slskUsername || !f?.slskFilepath) continue;
      await exportSlskTrack(
        {
          slskUsername: f.slskUsername,
          slskFilepath: f.slskFilepath,
          slskFilesize: f.slskFilesize ?? f.size ?? 0,
          name: trackDisplayBasename(f.path),
        },
        setProgress,
      );
    }
  }

  function handleDownloadAll(): void {
    downloadOverlayExpanded.value = true;
    const audio = ctx.files.value.filter((f) => isAudio(f.path));
    if (ctx.selected.value?.source === "soulseek") {
      void exportSlskBatch(audio as Array<FileRow & Partial<LegacyLikeRow>>);
      return;
    }
    const idxs = audio.map((f) => f.origIdx!);
    const labels = audio.map((f) => trackDisplayBasename(f.path));
    exportTorrentFiles(
      ctx.torrentMagnet.value, idxs, labels, rutrackerTorrentFileOpts(), setProgress,
    );
  }

  function handleDownloadAlbum(
    albumFiles: FileRow[] | null | undefined,
    albumName = "",
  ): void {
    downloadOverlayExpanded.value = true;
    const audio = (albumFiles ?? []).filter((f) => isAudio(f.path));
    if (ctx.selected.value?.source === "soulseek") {
      void exportSlskBatch(audio as Array<FileRow & Partial<LegacyLikeRow>>);
      return;
    }
    const idxs = audio.map((f) => f.origIdx!);
    const labels = audio.map((f) => trackDisplayBasename(f.path));
    exportTorrentFiles(
      ctx.torrentMagnet.value,
      idxs,
      labels,
      { albumDirName: albumName || ctx.selected.value?.name || "Альбом", ...rutrackerTorrentFileOpts() },
      setProgress,
    );
  }

  return {
    downloadProgress,
    downloadOverlayExpanded,
    handleDownloadTrack,
    handleDownloadTrackFromLike,
    handleDownloadSlskTrack,
    handleDownloadPlaylist,
    handleDownloadFromQueue,
    handleDownloadAll,
    handleDownloadAlbum,
  };
}
