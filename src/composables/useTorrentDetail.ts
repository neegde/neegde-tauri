/**
 * useTorrentDetail — owns the torrent/album detail screen state and handlers.
 *
 * This is the v2 "what's currently open in the main pane" domain: an Album
 * entity from search (`currentAlbum`) OR a legacy RuTracker topic / magnet
 * (`selected` + `files` + `torrentMagnet` + `torrentCover`). The composable
 * also hosts the handlers that push/pop stuff from/to the queue, open legacy
 * topics, and synthesize Track instances on the fly from raw file rows.
 *
 * Dependencies flow in via the options object — nav-stack back/forward refs,
 * autoplay gate, the "open source" bridge, and the download overlay refs.
 * Nothing in here pokes at App.vue directly.
 */

import { ref, shallowRef, computed, type Ref, type ShallowRef, type ComputedRef } from "vue";
import type { Track } from "../track/Track.js";
import type { NavigationTarget } from "../track/types.js";
import {
  detectAlbums,
  orderedAudioFiles,
  trackDisplayBasename,
  type FileRow,
} from "../lib/utils.js";
import { parseBtihFromMagnet } from "../lib/magnet.js";
import {
  buildRtTrackEntity,
  buildSlskTrackEntity,
  registerAndGetId,
} from "../player/trackForQueue.js";
import { getTorrentDetails } from "../rutracker/search.js";
import { getTrack } from "../stores/entities.js";
import {
  replaceQueue,
  enqueueTrack,
  playTrackNow,
  jumpTo,
  queueIds as queueStoreIds,
} from "../stores/queue.js";
import {
  toggleLikeAlbum as libToggleLikeAlbum,
  isAlbumLiked as libIsAlbumLiked,
  likedAlbumIds as libraryLikedAlbumIds,
} from "../stores/library.js";
import { torrentFileB64ForTrack } from "../torrent/api.js";
import {
  addToRecentHistory,
  type RecentHistoryEntry,
} from "../lib/recentHistory.js";
import { appDebugLog } from "../appDebugLog.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Shape for the "selected" torrent row — used by legacy TorrentView. */
export interface LegacyTorrentRow {
  id: string | number;
  name?: string;
  source?: string;
  seeders?: string | number;
  artist?: string | null;
  size?: number;
  category?: string;
  added?: string;
  __topicId?: string | number;
  slsk_tracks?: Array<{
    slsk_filepath?: string;
    slsk_username?: string;
    size?: number;
    name?: string;
  }>;
  slsk_username?: string;
  slsk_filepath?: string;
  slsk_folder?: string;
  slsk_cover_username?: string | null;
  slsk_cover_filepath?: string | null;
  slsk_cover_size?: number;
}

/** Minimal navigation entry — mirrors useNavStack's discriminated union. */
export interface NavEntryLike {
  type: string;
  [k: string]: unknown;
}

/**
 * Payload forwarded to App.vue's "open torrent" bridge. Re-exported from
 * `track/types.ts` — same discriminated union used by Track.navigationTarget().
 */
export type OpenTorrentPayload = NavigationTarget;

export interface UseTorrentDetailOptions {
  // Nav stack
  backStack: Ref<NavEntryLike[]>;
  forwardStack: Ref<NavEntryLike[]>;
  snapshotSearchForBack: () => NavEntryLike;
  snapshotTorrentForBack: () => NavEntryLike;
  snapshotAlbumForBack: () => NavEntryLike;
  // Recent history ref — updated when the user opens an Album / legacy topic.
  recentHistory: Ref<RecentHistoryEntry[]>;
  // Autoplay gate — cleared when the user explicitly starts playback.
  allowPlayerAutoplay: () => void;
  // Player's "open source of this track" bridge — consumed by context menu on
  // the current TorrentView row.
  openTorrentFromPlayer: (payload: OpenTorrentPayload) => void;
  // Download overlay refs (from useDownloads) — we need them for AlbumView's
  // "download all" button which kicks off per-track exportToDisk.
  downloadOverlayExpanded: Ref<boolean>;
  downloadProgress: Ref<unknown>;
}

export interface UseTorrentDetailApi {
  // ── State refs ────────────────────────────────────────────────────────
  selected: Ref<LegacyTorrentRow | null>;
  torrentMagnet: Ref<string>;
  torrentCover: Ref<string | null>;
  files: ShallowRef<FileRow[]>;
  currentAlbum: ShallowRef<{ id: string; title: string; artist: string | null; trackIds: string[]; [k: string]: unknown } | null>;
  loadingFiles: Ref<boolean>;
  torrentFilesBeforeAlbumPreview: Ref<FileRow[] | null>;
  torrentSelectedBeforeAlbumPreview: Ref<LegacyTorrentRow | null>;

  // ── Album derived ─────────────────────────────────────────────────────
  currentAlbumLiked: ComputedRef<boolean>;
  currentAlbumTracks: () => Track[];

  // ── Torrent-view handlers ─────────────────────────────────────────────
  handleSelect: (album: unknown) => void;
  handleSelectLegacyTopic: (torrent: LegacyTorrentRow | null | undefined) => Promise<void>;
  handlePlay: (fileIdx: number) => void;
  handlePlayAll: () => void;
  handlePlayAlbum: (albumFiles: FileRow[]) => void;
  handleAddToQueueFromTorrent: (fileIdx: number) => void;
  handleOpenTorrentSourceFromView: (origIdx: number | null | undefined) => void;

  // ── AlbumView handlers ────────────────────────────────────────────────
  handleAlbumPlayAll: () => void;
  handleAlbumToggleLike: (album: { id: string } | null | undefined) => void;
  handleAlbumDownloadAll: () => void;

  // ── Track synthesis helpers (exposed for useMagnetDialog / etc) ───────
  makeTrackFromFile: (
    f: FileRow,
    torrent: LegacyTorrentRow | null | undefined,
    magnet: string,
    fileList: FileRow[],
    explicitCoverFileIdx?: number | null,
  ) => Track | null;
  tracksFromFiles: (fileArray: FileRow[], coverIdxOverride?: number | null) => Track[];
}

function isTrack(t: unknown): t is Track {
  return !!t && (t as { type?: string }).type === "track"
    && typeof (t as { prepareStream?: unknown }).prepareStream === "function";
}

// ── Composable ─────────────────────────────────────────────────────────────

export function useTorrentDetail(opts: UseTorrentDetailOptions): UseTorrentDetailApi {
  const selected = ref<LegacyTorrentRow | null>(null);
  const torrentMagnet = ref("");
  const torrentCover = ref<string | null>(null);
  const files = shallowRef<FileRow[]>([]);
  const currentAlbum = shallowRef<UseTorrentDetailApi["currentAlbum"]["value"]>(null);
  const loadingFiles = ref(false);
  const torrentFilesBeforeAlbumPreview = ref<FileRow[] | null>(null);
  const torrentSelectedBeforeAlbumPreview = ref<LegacyTorrentRow | null>(null);

  // ── Album derivations ────────────────────────────────────────────────────

  function currentAlbumTracks(): Track[] {
    const alb = currentAlbum.value;
    if (!alb) return [];
    const out: Track[] = [];
    for (const id of alb.trackIds ?? []) {
      const t = getTrack(id);
      if (t) out.push(t);
    }
    return out;
  }

  const currentAlbumLiked = computed<boolean>(() => {
    const alb = currentAlbum.value;
    if (!alb) return false;
    libraryLikedAlbumIds.value; // reactive dep
    return libIsAlbumLiked(alb.id);
  });

  // ── Track synthesis ──────────────────────────────────────────────────────

  function makeTrackFromFile(
    f: FileRow,
    torrent: LegacyTorrentRow | null | undefined,
    magnet: string,
    fileList: FileRow[],
    explicitCoverFileIdx: number | null = null,
  ): Track | null {
    let coverFileIdx: number | null = explicitCoverFileIdx ?? null;
    let albumDirPath: string | null = null;
    if (fileList?.length) {
      const albs = detectAlbums(fileList);
      for (const a of albs) {
        if (a.audioFiles.some((af) => af.origIdx === f.origIdx)) {
          if (coverFileIdx == null) coverFileIdx = a.coverFile?.origIdx ?? null;
          albumDirPath = a.dirPath || null;
          break;
        }
      }
    }
    if (torrent?.source === "soulseek") {
      const fSlskUser = f.slskUsername as string | undefined;
      const fSlskPath = f.slskFilepath as string | undefined;
      const fSlskSize = f.slskFilesize as number | undefined;
      const fCoverUser = f.slskFolderCoverUsername as string | undefined;
      const fCoverPath = f.slskFolderCoverFilepath as string | undefined;
      const fCoverSize = f.slskFolderCoverSize as number | undefined;
      const ent = buildSlskTrackEntity({
        username: fSlskUser ?? torrent.slsk_username ?? null,
        filepath: fSlskPath ?? f.path ?? null,
        size: fSlskSize ?? f.size ?? torrent.size ?? 0,
        filename: trackDisplayBasename(f.path),
        artist: torrent.artist ?? null,
        cover: (fCoverUser && fCoverPath)
          ? {
              slsk_username: fCoverUser,
              slsk_filepath: fCoverPath,
              size: fCoverSize,
            }
          : null,
        albumTitle: torrent.name ?? "",
      });
      const id = registerAndGetId(ent);
      return id ? getTrack(id) : null;
    }
    const synthTorrent = {
      id: torrent?.__topicId ?? torrent?.id ?? "",
      name: torrent?.name ?? "",
      artist: torrent?.artist ?? null,
      source: torrent?.source ?? "rutracker",
    };
    const btih = torrent?.source === "magnet" ? parseBtihFromMagnet(magnet) : null;
    const rtFile = { ...f, origIdx: f.origIdx ?? 0 };
    const ent = buildRtTrackEntity(rtFile, synthTorrent, magnet, btih, coverFileIdx, albumDirPath);
    const id = registerAndGetId(ent);
    return id ? getTrack(id) : null;
  }

  function tracksFromFiles(fileArray: FileRow[], coverIdxOverride: number | null = null): Track[] {
    return fileArray
      .map((f) => makeTrackFromFile(f, selected.value, torrentMagnet.value, files.value, coverIdxOverride))
      .filter((t): t is Track => t != null);
  }

  // ── Torrent-view handlers ────────────────────────────────────────────────

  function handleSelect(album: unknown): void {
    if (!album || (album as { type?: string }).type !== "album") {
      void handleSelectLegacyTopic(album as LegacyTorrentRow | null | undefined);
      return;
    }
    const a = album as {
      id: string; title: string; artist: string | null; trackIds: string[];
      sources?: Array<{ kind?: string; refs?: { topicId?: string }; raw?: { topicRow?: { name?: string; id?: string | number }; details?: { artist?: string; magnet?: string } } }>;
    };

    // Toggle off if clicking the already-open album.
    if (currentAlbum.value?.id === a.id) {
      opts.forwardStack.value = [];
      opts.backStack.value = [];
      currentAlbum.value = null;
      appDebugLog("search", `album deselected: ${a.id}`);
      return;
    }

    appDebugLog("search", `album opened: ${a.id} "${a.title}"`);
    if (currentAlbum.value) opts.backStack.value.push(opts.snapshotAlbumForBack());
    else if (selected.value) opts.backStack.value.push(opts.snapshotTorrentForBack());
    else                     opts.backStack.value.push(opts.snapshotSearchForBack());
    opts.forwardStack.value = [];

    // Clear legacy TorrentView state — the two paths are mutually exclusive.
    selected.value = null;
    files.value = [];
    torrentMagnet.value = "";
    torrentCover.value = null;
    torrentFilesBeforeAlbumPreview.value = null;
    torrentSelectedBeforeAlbumPreview.value = null;

    currentAlbum.value = a;

    // RT: prewarm torrent file cache + record recent history (topic-level).
    const src = a.sources?.[0];
    if (src?.kind === "rutracker") {
      const topicId = src.refs?.topicId;
      const topicRow = src.raw?.topicRow;
      const details = src.raw?.details;
      if (topicId) {
        void torrentFileB64ForTrack({ source: "rutracker", torrentId: topicId });
        if (topicRow) {
          opts.recentHistory.value = addToRecentHistory({
            id: String(topicId),
            name: topicRow.name ?? a.title,
            source: "rutracker",
            artist: a.artist ?? details?.artist ?? "",
            magnet: details?.magnet ?? "",
          });
        }
      }
    }
  }

  async function handleSelectLegacyTopic(torrent: LegacyTorrentRow | null | undefined): Promise<void> {
    if (!torrent?.id) return;
    if (selected.value?.id === torrent.id) {
      opts.forwardStack.value = [];
      opts.backStack.value = [];
      selected.value = null; files.value = []; torrentMagnet.value = ""; torrentCover.value = null;
      torrentFilesBeforeAlbumPreview.value = null;
      torrentSelectedBeforeAlbumPreview.value = null;
      return;
    }
    if (selected.value) opts.backStack.value.push(opts.snapshotTorrentForBack());
    else                opts.backStack.value.push(opts.snapshotSearchForBack());
    opts.forwardStack.value = [];
    torrentFilesBeforeAlbumPreview.value = null;
    torrentSelectedBeforeAlbumPreview.value = null;
    selected.value      = torrent;
    files.value         = [];
    torrentMagnet.value = "";
    torrentCover.value  = null;
    loadingFiles.value  = true;

    if (torrent.source === "soulseek") {
      // Likes / history can pre-populate slsk_tracks (fallback when Album entity missing)
      const trackList = (torrent.slsk_tracks?.length
        ? torrent.slsk_tracks
        : [{
            slsk_filepath: torrent.slsk_filepath,
            slsk_username: torrent.slsk_username,
            size: torrent.size,
          }]) as Array<{
            slsk_filepath?: string;
            slsk_username?: string;
            size?: number;
            name?: string;
          }>;
      const albumFolder =
        (torrent.slsk_folder?.split("/").pop() || torrent.name || "album").trim();
      files.value = trackList.map((t, i) => {
        const normalized = (t.slsk_filepath ?? "").replace(/\\/g, "/");
        const filename = normalized.split("/").pop() || t.name || `track_${i}`;
        return {
          name: filename,
          path: `${albumFolder}/${filename}`,
          size: t.size ?? 0,
          idx: i, origIdx: i,
          slskUsername: t.slsk_username ?? torrent.slsk_username,
          slskFilepath: t.slsk_filepath ?? normalized,
          slskFilesize: t.size ?? 0,
          slskMetaTrackId: torrent.id,
          slskFolderCoverUsername: torrent.slsk_cover_username ?? null,
          slskFolderCoverFilepath: torrent.slsk_cover_filepath ?? null,
          slskFolderCoverSize: torrent.slsk_cover_size ?? 0,
        } as FileRow;
      });
      loadingFiles.value = false;
      return;
    }

    try {
      const details = await getTorrentDetails(String(torrent.id));
      torrentMagnet.value = details.magnet ?? "";
      torrentCover.value  = details.cover_data_url ?? null;
      if (details.artist && selected.value) {
        selected.value = { ...selected.value, artist: details.artist };
      }
      files.value = (details.files ?? []).map((f, i) => ({
        name: f.path[f.path.length - 1] ?? "",
        path: f.path.join("/"),
        size: f.size,
        idx: i,
        origIdx: i,
      }));
      void torrentFileB64ForTrack({ source: torrent.source, torrentId: torrent.id });
      opts.recentHistory.value = addToRecentHistory({
        id: String(torrent.id),
        name: torrent.name ?? "",
        source: torrent.source ?? "rutracker",
        artist: details.artist ?? torrent.artist ?? "",
        magnet: details.magnet ?? "",
      });
    } catch (e) {
      console.error("handleSelectLegacyTopic:", e);
      void appDebugLog("search", `torrent open error: #${torrent.id} — ${String(e)}`);
    } finally {
      loadingFiles.value = false;
    }
  }

  function handlePlay(fileIdx: number): void {
    opts.allowPlayerAutoplay();
    const audioFiles = orderedAudioFiles(files.value);
    const startIdx = Math.max(0, audioFiles.findIndex((f) => f.origIdx === fileIdx));
    const tracks = tracksFromFiles(audioFiles);
    if (tracks.length === 0) return;
    // If the user clicked the same file that's already first in queue, just jump.
    const sameQueue = queueStoreIds.value.length === tracks.length
      && queueStoreIds.value.every((id, i) => id === tracks[i]?.id);
    if (sameQueue) {
      jumpTo(startIdx);
      return;
    }
    replaceQueue(tracks, startIdx);
  }

  function handlePlayAll(): void {
    opts.allowPlayerAutoplay();
    const audioFiles = orderedAudioFiles(files.value);
    if (!audioFiles.length) return;
    const tracks = tracksFromFiles(audioFiles);
    if (tracks.length === 0) return;
    replaceQueue(tracks, 0);
  }

  function handlePlayAlbum(albumFiles: FileRow[]): void {
    if (!albumFiles.length) return;
    opts.allowPlayerAutoplay();
    const albs = detectAlbums(files.value);
    const first = albumFiles[0]!;
    let coverIdx: number | null = null;
    for (const a of albs) {
      if (a.audioFiles.some((af) => af.origIdx === first.origIdx)) {
        coverIdx = a.coverFile?.origIdx ?? null;
        break;
      }
    }
    const tracks = tracksFromFiles(albumFiles, coverIdx);
    if (tracks.length === 0) return;
    replaceQueue(tracks, 0);
  }

  function handleAddToQueueFromTorrent(fileIdx: number): void {
    const audioFiles = orderedAudioFiles(files.value);
    const f = audioFiles.find((x) => x.origIdx === fileIdx);
    if (!f || !selected.value) return;
    const track = makeTrackFromFile(f, selected.value, torrentMagnet.value, files.value);
    if (track) enqueueTrack(track);
  }

  function handleOpenTorrentSourceFromView(origIdx: number | null | undefined): void {
    const t = selected.value;
    if (!t) return;
    const list = files.value ?? [];
    const f = origIdx != null ? list.find((x) => x.origIdx === origIdx) : null;

    if (t.source === "soulseek") {
      const fUser = f?.slskUsername as string | undefined;
      const fPath = f?.slskFilepath as string | undefined;
      const firstUser = list[0]?.slskUsername as string | undefined;
      const slskUsername = fUser ?? t.slsk_username ?? firstUser ?? null;
      if (!slskUsername) return;
      opts.openTorrentFromPlayer({
        source: "soulseek",
        slskUsername,
        slskFilepath: fPath ?? null,
      });
      return;
    }

    let albumDirPath: string | null = null;
    if (list.length && f) {
      const albs = detectAlbums(list);
      const album = albs.find((a) => a.audioFiles.some((af) => af.origIdx === f.origIdx));
      albumDirPath = album?.dirPath ?? null;
    }
    opts.openTorrentFromPlayer({
      source: t.source === "magnet" ? "magnet" : "rutracker",
      torrentId: String(t.id),
      torrentName: t.name ?? "",
      magnet: torrentMagnet.value ?? "",
      artist: t.artist ?? null,
      seeders: (t.seeders ?? null) as number | string | null,
      fileIdx: f?.origIdx ?? origIdx ?? 0,
      albumDirPath,
    });
  }

  // ── AlbumView handlers ──────────────────────────────────────────────────

  function handleAlbumPlayAll(): void {
    const tracks = currentAlbumTracks();
    if (!tracks.length) return;
    opts.allowPlayerAutoplay();
    replaceQueue(tracks, 0);
  }

  function handleAlbumToggleLike(album: { id: string } | null | undefined): void {
    if (!album) return;
    libToggleLikeAlbum(album as unknown as Parameters<typeof libToggleLikeAlbum>[0]);
  }

  function handleAlbumDownloadAll(): void {
    const tracks = currentAlbumTracks();
    if (!tracks.length) return;
    opts.downloadOverlayExpanded.value = true;
    for (const t of tracks) {
      void t.exportToDisk((p) => { opts.downloadProgress.value = p; });
    }
  }

  // ── Ambient: satisfy `isTrack` type import so TS keeps it tree-shakable.
  void isTrack;

  return {
    selected,
    torrentMagnet,
    torrentCover,
    files,
    currentAlbum,
    loadingFiles,
    torrentFilesBeforeAlbumPreview,
    torrentSelectedBeforeAlbumPreview,

    currentAlbumLiked,
    currentAlbumTracks,

    handleSelect,
    handleSelectLegacyTopic,
    handlePlay,
    handlePlayAll,
    handlePlayAlbum,
    handleAddToQueueFromTorrent,
    handleOpenTorrentSourceFromView,

    handleAlbumPlayAll,
    handleAlbumToggleLike,
    handleAlbumDownloadAll,

    makeTrackFromFile,
    tracksFromFiles,
  };
}
