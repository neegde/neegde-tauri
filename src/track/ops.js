/**
 * Single-dispatch API for Track entities.
 *
 * Every operation (play, download, build-like-row, …) lives here. Callers
 * never branch on `track.source` — they just import the verb they need.
 *
 * Internally we use a per-source handler table. Adding a new source (YouTube,
 * Spotify mirror, whatever) is one table entry, not ten scattered `if` checks.
 *
 * Keep the surface minimal: if an op has no meaningful source-specific path,
 * don't add it here.
 */

import { invoke } from "@tauri-apps/api/core";
import { message, open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { streamUrl as rawStreamUrl } from "../torrent/api.js";
import { parseBtihFromMagnet } from "../lib/magnet.js";
import { slskFieldsFromTrackEntity } from "../library/slskFieldsFromTrackEntity.js";

/** @typedef {import("../types/entities.js").Track} Track */

function sourceKindOf(track) {
  return track?.sources?.[0]?.kind ?? null;
}

// ── Playback ────────────────────────────────────────────────────────────────

/**
 * Ready-to-assign stream URL for this track. Empty string when unresolvable.
 * @param {Track} track
 * @returns {Promise<string>}
 */
export async function streamUrlFor(track) {
  const h = handlerFor(track);
  return h ? h.stream(track) : "";
}

/**
 * Whether `streamUrlFor` can be meaningfully invoked right now (i.e. the
 * entity carries enough refs to start a transfer).
 * @param {Track} track
 */
export function playbackIdentityOf(track) {
  const h = handlerFor(track);
  return h ? h.hasPlaybackIdentity(track) : false;
}

// ── Download ────────────────────────────────────────────────────────────────

/**
 * Prompts for a destination folder and exports this track to disk.
 * Progress reported through `onProgress` (same contract as `exportSlskTrack` /
 * `exportTorrentFiles`). Swallows user cancellation silently.
 *
 * @param {Track} track
 * @param {(p: object | null) => void} [onProgress]
 */
export async function exportTrackFor(track, onProgress) {
  const h = handlerFor(track);
  if (!h) return;
  return h.exportToDisk(track, onProgress);
}

// ── Navigation ──────────────────────────────────────────────────────────────

/**
 * Payload for "open source of this track" — consumed by
 * `handleOpenTorrentFromPlayer` / `handleNavigateSoulseekPeer`. The caller
 * still decides what to do with it.
 * @param {Track} track
 */
export function navigationTargetFor(track) {
  const h = handlerFor(track);
  return h ? h.navTarget(track) : null;
}

// ── Library shape adapters ──────────────────────────────────────────────────

/**
 * Build a "like" row in the legacy persisted shape.
 * @param {Track} track
 */
export function asLikeRowFor(track) {
  const h = handlerFor(track);
  return h ? h.asLikeRow(track) : null;
}

/**
 * Build a playlist-track row in the legacy persisted shape.
 * @param {Track} track
 */
export function asPlaylistRowFor(track) {
  const h = handlerFor(track);
  return h ? h.asPlaylistRow(track) : null;
}

/**
 * Build a queue row — still includes the legacy fields playerrv.vue reads until
 * Phase 4 finishes, plus `trackId` for the future id-only model.
 * @param {Track} track
 */
export function asQueueItemFor(track) {
  const h = handlerFor(track);
  return h ? h.asQueueItem(track) : null;
}

// ── Dispatch ────────────────────────────────────────────────────────────────

function handlerFor(track) {
  return handlers[sourceKindOf(track)] ?? null;
}

/** @type {Record<string, {
 *    stream: (t: Track) => Promise<string>,
 *    hasPlaybackIdentity: (t: Track) => boolean,
 *    exportToDisk: (t: Track, onProgress?: Function) => Promise<void>,
 *    navTarget: (t: Track) => object | null,
 *    asLikeRow: (t: Track) => object,
 *    asPlaylistRow: (t: Track) => object,
 *    asQueueItem: (t: Track) => object,
 * }>} */
const handlers = {
  soulseek: soulseekHandler(),
  rutracker: rutrackerHandler(),
  magnet: magnetHandler(),
};

// ── SoulSeek ────────────────────────────────────────────────────────────────

function soulseekHandler() {
  return {
    stream(track) {
      return rawStreamUrl("", 0, {
        source: "soulseek",
        slskUsername: track.sources[0]?.refs?.slskUsername,
        slskFilepath: track.sources[0]?.refs?.slskFilepath,
        slskFilesize: track.size ?? 0,
      });
    },
    hasPlaybackIdentity(track) {
      const r = track.sources?.[0]?.refs;
      return Boolean(r?.slskUsername && r?.slskFilepath);
    },
    async exportToDisk(track, onProgress) {
      const f = slskFieldsFromTrackEntity(track);
      if (!f.username || !f.filepath) {
        await message("У трека нет данных SoulSeek.", { title: "Скачивание", kind: "error" });
        return;
      }
      const picked = await open({ directory: true, multiple: false, title: "Выберите папку" });
      if (picked === null) return;
      const destDir = Array.isArray(picked) ? picked[0] : picked;
      onProgress?.({
        phase: "preparing",
        torrentState: "",
        progressBytes: 0,
        totalBytes: f.size,
        pct: 0,
        queueLabels: [f.filename],
        message: "Подключение к пиру…",
      });
      let unlisten = () => {};
      try {
        unlisten = await listen("slsk-export-progress", (ev) => onProgress?.(ev.payload));
        const savedPath = await invoke("soulseek_export_file", {
          username: f.username,
          filepath: f.filepath,
          filesize: f.size,
          destDir,
          fileName: f.filename,
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
    },
    navTarget(track) {
      const f = slskFieldsFromTrackEntity(track);
      if (!f.username) return null;
      return {
        torrentId: track.id,
        torrentName: track.fileName ?? track.title ?? "",
        source: "soulseek",
        magnet: "",
        fileIdx: 0,
        albumDirPath: null,
        slskUsername: f.username,
        slskFilepath: f.filepath ?? null,
      };
    },
    asLikeRow(track) {
      const f = slskFieldsFromTrackEntity(track);
      return {
        id: track.id,
        type: "track",
        source: "soulseek",
        magnet: "",
        fileIdx: 0,
        fileName: f.filepath || f.filename,
        torrentName: f.filename,
        torrentId: track.id,
        artist: f.artist,
        slskUsername: f.username,
        slskFilepath: f.filepath,
        slskFilesize: f.size,
      };
    },
    asPlaylistRow(track) {
      const f = slskFieldsFromTrackEntity(track);
      return {
        magnet: "",
        fileIdx: 0,
        fileName: f.filepath || f.filename,
        torrentName: f.filename,
        torrentId: String(track.id ?? ""),
        source: "soulseek",
        artist: f.artist,
        coverFileIdx: null,
        slskUsername: f.username,
        slskFilepath: f.filepath,
        slskFilesize: f.size,
      };
    },
    asQueueItem(track) {
      const f = slskFieldsFromTrackEntity(track);
      return {
        trackId: track.id,
        magnet: "",
        fileIdx: 0,
        fileName: f.filename,
        torrentName: f.filename,
        torrentId: track.id,
        source: "soulseek",
        artist: f.artist,
        coverFileIdx: null,
        albumDirPath: null,
        seeders: f.peers,
        slskUsername: f.username,
        slskFilepath: f.filepath,
        slskFilesize: f.size,
        slskMetaTrackId: track.id,
        slskFolderCoverUsername: f.cover?.slsk_username ?? null,
        slskFolderCoverFilepath: f.cover?.slsk_filepath ?? null,
        slskFolderCoverSize: f.cover?.size ?? 0,
      };
    },
  };
}

// ── RuTracker (BT topic, synthetic torrents carry the same shape) ───────────

function rutrackerHandler() {
  return {
    stream(track) {
      const src = track.sources[0];
      return rawStreamUrl(src.refs?.magnet ?? "", src.refs?.fileIdx, {
        source: "rutracker",
        torrentId: src.refs?.topicId ?? null,
      });
    },
    hasPlaybackIdentity(track) {
      const r = track.sources?.[0]?.refs;
      return Boolean(r?.magnet);
    },
    async exportToDisk() {
      // RT per-track export is done via exportTorrentFiles at the TorrentView
      // level; single-track export from a Track entity happens rarely and
      // callers that need it currently go through useDownloads.handleDownloadTrack.
      await message("Экспорт трека из Track entity пока не реализован.", { title: "Скачивание", kind: "info" });
    },
    navTarget(track) {
      const src = track.sources[0];
      return {
        torrentId: src.refs?.topicId ?? track.id,
        torrentName: track.albumTitle ?? "",
        source: "rutracker",
        magnet: src.refs?.magnet ?? "",
        artist: track.artist ?? null,
        seeders: null,
        fileIdx: src.refs?.fileIdx ?? 0,
        albumDirPath: src.refs?.albumDirPath ?? null,
      };
    },
    asLikeRow(track) { return legacyRtLikeRow(track, "rutracker"); },
    asPlaylistRow(track) { return legacyRtPlaylistRow(track, "rutracker"); },
    asQueueItem(track) { return legacyRtQueueItem(track, "rutracker"); },
  };
}

function magnetHandler() {
  return {
    stream: rutrackerHandler().stream,               // same invoke, no topicId
    hasPlaybackIdentity: rutrackerHandler().hasPlaybackIdentity,
    exportToDisk: rutrackerHandler().exportToDisk,
    navTarget(track) {
      const v = rutrackerHandler().navTarget(track);
      return v ? { ...v, source: "magnet" } : null;
    },
    asLikeRow(track) { return legacyRtLikeRow(track, "magnet"); },
    asPlaylistRow(track) { return legacyRtPlaylistRow(track, "magnet"); },
    asQueueItem(track) { return legacyRtQueueItem(track, "magnet"); },
  };
}

function legacyRtLikeRow(track, source) {
  const src = track.sources[0];
  return {
    id: `track:${source}:${src.refs?.topicId ?? parseBtihFromMagnet(src.refs?.magnet ?? "") ?? track.id}:${src.refs?.fileIdx ?? 0}`,
    type: "track",
    source,
    magnet: src.refs?.magnet ?? "",
    fileIdx: src.refs?.fileIdx ?? 0,
    fileName: track.fileName,
    torrentName: track.albumTitle ?? "",
    torrentId: src.refs?.topicId ?? "",
    artist: track.artist ?? null,
    coverFileIdx: src.refs?.coverFileIdx ?? null,
  };
}

function legacyRtPlaylistRow(track, source) {
  const src = track.sources[0];
  return {
    magnet: src.refs?.magnet ?? "",
    fileIdx: src.refs?.fileIdx ?? 0,
    fileName: track.fileName,
    torrentName: track.albumTitle ?? "",
    torrentId: src.refs?.topicId ?? "",
    source,
    artist: track.artist ?? null,
    coverFileIdx: src.refs?.coverFileIdx ?? null,
    albumDirPath: src.refs?.albumDirPath ?? null,
  };
}

function legacyRtQueueItem(track, source) {
  const src = track.sources[0];
  return {
    trackId: track.id,
    magnet: src.refs?.magnet ?? "",
    fileIdx: src.refs?.fileIdx ?? 0,
    fileName: track.fileName,
    torrentName: track.albumTitle ?? "",
    torrentId: src.refs?.topicId ?? "",
    source,
    artist: track.artist ?? null,
    coverFileIdx: src.refs?.coverFileIdx ?? null,
    albumDirPath: src.refs?.albumDirPath ?? null,
    seeders: null,
  };
}
