/**
 * Export/download composable.
 *
 * Owns `downloadProgress` and `downloadOverlayExpanded` and provides handlers
 * for every download entry point: single track, full torrent, album, playlist,
 * SoulSeek track from search, and rows from likes / playlists / queue.
 *
 * Reactive inputs are passed in so the composable has no hidden dependency on
 * the caller's state: it reads the current torrent selection, file list, and
 * open playlist via the refs the caller provides.
 */

import { ref } from "vue";
import {
  exportTorrentFiles,
  exportPlaylistTracks,
  exportSlskTrack,
} from "../torrent/torrentExport.js";
import { isAudio, trackDisplayBasename } from "../lib/utils.js";
import { exportTrackFor } from "../track/ops.js";

/**
 * @param {{
 *   selected: import("vue").Ref<object | null>,
 *   torrentMagnet: import("vue").Ref<string>,
 *   files: import("vue").Ref<Array<object>>,
 *   currentPlaylist: import("vue").ComputedRef<object | null>,
 * }} ctx
 */
export function useDownloads(ctx) {
  const downloadProgress = ref(null);
  const downloadOverlayExpanded = ref(true);

  function setProgress(p) { downloadProgress.value = p; }

  /**
   * When exporting from a RuTracker-sourced selection, pass the topic id so
   * the backend pulls the `.torrent` the same way streaming does (no DHT wait).
   */
  function rutrackerTorrentFileOpts() {
    const s = ctx.selected.value;
    if (!s || String(s.source) !== "rutracker") return {};
    const tid = s.id != null && String(s.id).trim() !== "" ? s.id : null;
    if (tid == null) return {};
    return { track: { source: "rutracker", torrentId: tid } };
  }

  function handleDownloadTrack(origIdx) {
    downloadOverlayExpanded.value = true;
    const f = ctx.files.value.find((x) => x.origIdx === origIdx);
    const label = f ? trackDisplayBasename(f.path) : `Файл ${origIdx}`;
    if (ctx.selected.value?.source === "soulseek" && f?.slskUsername && f?.slskFilepath) {
      exportSlskTrack(
        { slskUsername: f.slskUsername, slskFilepath: f.slskFilepath, slskFilesize: f.slskFilesize ?? f.size ?? 0, name: label },
        setProgress,
      );
      return;
    }
    exportTorrentFiles(ctx.torrentMagnet.value, [origIdx], [label], rutrackerTorrentFileOpts(), setProgress);
  }

  function handleDownloadTrackFromLike(like) {
    if (!like) return;
    downloadOverlayExpanded.value = true;
    if (like.source === "soulseek") {
      exportSlskTrack(like, setProgress);
      return;
    }
    if (!like.magnet || like.fileIdx == null) return;
    const idx = Number(like.fileIdx);
    const label = trackDisplayBasename(like.fileName);
    exportTorrentFiles(like.magnet, [idx], [label], { track: like }, setProgress);
  }

  /** Download a track from search results (Track entity, any source). */
  function handleDownloadSlskTrack(track) {
    if (!track || track.type !== "track") return;
    downloadOverlayExpanded.value = true;
    void exportTrackFor(track, setProgress);
  }

  function handleDownloadPlaylist() {
    const tracks = ctx.currentPlaylist.value?.tracks;
    if (!tracks?.length) return;
    downloadOverlayExpanded.value = true;
    exportPlaylistTracks(tracks, setProgress);
  }

  /** Download a queue row (context menu on player). */
  function handleDownloadFromQueue(q) {
    if (!q?.magnet?.trim() || q.fileIdx == null) return;
    downloadOverlayExpanded.value = true;
    const idx = Number(q.fileIdx);
    const label = trackDisplayBasename(q.fileName);
    exportTorrentFiles(q.magnet, [idx], [label], { track: q }, setProgress);
  }

  /** Sequentially export SLSK files (no batch API — each file is a separate peer transfer). */
  async function exportSlskBatch(audio) {
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

  function handleDownloadAll() {
    downloadOverlayExpanded.value = true;
    const audio = ctx.files.value.filter((f) => isAudio(f.path));
    if (ctx.selected.value?.source === "soulseek") {
      void exportSlskBatch(audio);
      return;
    }
    const idxs = audio.map((f) => f.origIdx);
    const labels = audio.map((f) => trackDisplayBasename(f.path));
    exportTorrentFiles(ctx.torrentMagnet.value, idxs, labels, rutrackerTorrentFileOpts(), setProgress);
  }

  function handleDownloadAlbum(albumFiles, albumName = "") {
    downloadOverlayExpanded.value = true;
    const audio = (albumFiles ?? []).filter((f) => isAudio(f.path));
    if (ctx.selected.value?.source === "soulseek") {
      void exportSlskBatch(audio);
      return;
    }
    const idxs = audio.map((f) => f.origIdx);
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
