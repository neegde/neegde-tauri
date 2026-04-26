/**
 * One-shot migration from legacy v1 storage shapes to the v2 track-id model.
 *
 * Reads the old rich-row keys (`neegde.likes`, `neegde.playlists.v1`, the
 * player-session row blob), synthesises `TrackData` for each row via the
 * provider-agnostic `rowToTrackData` heuristic, populates `trackCache`,
 * populates `albumCache` for liked albums, and writes the new snapshots.
 * Legacy keys are kept untouched for one
 * release as a safety net; they can be removed by hand later.
 *
 * Safe to call on every boot — it bails out if the v2 keys already exist.
 */

import { parseBtihFromMagnet } from "../lib/magnet.js";
import { putTrack, hasTrack } from "./trackCache.js";
import { putAlbum, hasAlbumInCache } from "./albumCache.js";
import { legacyAlbumLikeRowToAlbumData } from "./legacyAlbumLikeRowToAlbumData.js";
import { LIKES_STORAGE_KEY, saveLikesSnapshot, loadLikesSnapshot } from "./likes.js";
import { PLAYLISTS_STORAGE_KEY, savePlaylistsSnapshot, loadPlaylistsSnapshot } from "./playlists.js";
import { QUEUE_STORAGE_KEY, saveQueueSnapshot, loadQueueSnapshot } from "./queue.js";
import type { TrackData, ProviderKind, TrackSource } from "../track/types.js";

// ── Legacy row shape (what v1 dumped into localStorage) ─────────────────────

interface LegacyRow {
  id?: string;
  type?: "track" | "album";
  source?: string;
  magnet?: string;
  fileIdx?: number;
  fileName?: string;
  torrentName?: string;
  torrentId?: string | number;
  artist?: string | null;
  coverFileIdx?: number | null;
  albumDirPath?: string | null;
  slskUsername?: string;
  slskFilepath?: string;
  slskFilesize?: number;
  addedAt?: number;
  /** Legacy album-like row (`makeAlbumLike`). */
  albumName?: string;
  dirPath?: string;
  audioFiles?: object[];
  [k: string]: unknown;
}

function rowSourceKind(row: LegacyRow): ProviderKind {
  const s = String(row.source ?? "").toLowerCase();
  if (s === "soulseek") return "soulseek";
  if (s === "magnet") return "magnet";
  return "rutracker";
}

/** Best-effort stable id. Falls back to a synthetic that mirrors v2 ids. */
function rowId(row: LegacyRow, kind: ProviderKind): string {
  if (typeof row.id === "string" && row.id.length) return row.id;
  if (kind === "soulseek") {
    return `slsk:track:${row.slskUsername ?? ""}|${row.slskFilepath ?? ""}`;
  }
  const topicId = row.torrentId != null ? String(row.torrentId) : null;
  const btih = kind === "magnet" ? parseBtihFromMagnet(row.magnet ?? "") : null;
  const head = topicId || btih || "unknown";
  return `${kind === "magnet" ? "magnet" : "rt"}:track:${head}:${row.fileIdx ?? 0}`;
}

function rowToTrackData(row: LegacyRow): TrackData | null {
  const kind = rowSourceKind(row);
  const id = rowId(row, kind);
  const fileName = String(row.fileName ?? "").split(/[\\\/]/).pop() || String(row.fileName ?? "");
  const albumTitle = typeof row.torrentName === "string" ? row.torrentName : null;

  if (kind === "soulseek") {
    if (!row.slskUsername || !row.slskFilepath) return null;
    return {
      type: "track",
      id,
      title: fileName,
      artist: row.artist ?? null,
      albumTitle,
      albumId: null,
      fileName,
      format: null,
      bitrate: null,
      duration: null,
      size: Number(row.slskFilesize ?? 0) || null,
      sources: [{
        kind: "soulseek",
        refs: { slskUsername: row.slskUsername, slskFilepath: row.slskFilepath },
        raw: { cover: null },
      }],
    };
  }

  // RT / magnet — need at least a magnet or a topicId to be playable later.
  const magnet = typeof row.magnet === "string" ? row.magnet : "";
  const topicId = row.torrentId != null && String(row.torrentId).trim() !== "" ? String(row.torrentId) : null;
  if (!magnet && !topicId) return null;

  const rtSource: TrackSource = kind === "magnet"
    ? {
        kind: "magnet",
        refs: {
          magnet,
          fileIdx: Number(row.fileIdx ?? 0),
          coverFileIdx: row.coverFileIdx ?? null,
          albumDirPath: row.albumDirPath ?? null,
        },
      }
    : {
        kind: "rutracker",
        refs: {
          topicId,
          magnet,
          fileIdx: Number(row.fileIdx ?? 0),
          coverFileIdx: row.coverFileIdx ?? null,
          albumDirPath: row.albumDirPath ?? null,
        },
      };

  return {
    type: "track",
    id,
    title: fileName,
    artist: row.artist ?? null,
    albumTitle,
    albumId: null,
    fileName,
    format: null,
    bitrate: null,
    duration: null,
    size: null,
    sources: [rtSource],
  };
}

// ── Legacy queue/player session shape ───────────────────────────────────────

interface LegacyPlayerSession {
  queue?: LegacyRow[];
  queuePos?: number;
}

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const MIGRATION_DONE_FLAG = "neegde.migration.v2.done";

export function migrateLegacyStorage(): void {
  if (localStorage.getItem(MIGRATION_DONE_FLAG) === "1") return;

  migrateLikes();
  migratePlaylists();
  migrateQueue();

  try { localStorage.setItem(MIGRATION_DONE_FLAG, "1"); } catch { /* ignore */ }
}

function migrateLikes(): void {
  // Don't clobber an existing v2 snapshot.
  const existing = loadLikesSnapshot();
  if (existing.trackIds.length > 0 || existing.albumIds.length > 0) return;

  const legacy = readJSON<Record<string, LegacyRow>>("neegde.likes");
  if (!legacy || typeof legacy !== "object") return;

  const trackIds: string[] = [];
  const albumIds: string[] = [];
  const likedAt: Record<string, number> = {};
  const seenTrackIds = new Set<string>();
  const seenAlbumIds = new Set<string>();

  for (const key in legacy) {
    const row = legacy[key];
    if (!row) continue;
    if (row.type === "album") {
      const idStr = row.id != null && String(row.id) !== "" ? String(row.id) : key;
      const albumData = legacyAlbumLikeRowToAlbumData({
        type: "album",
        id: idStr,
        source: row.source,
        magnet: row.magnet,
        torrentId: row.torrentId,
        torrentName: row.torrentName,
        albumName: row.albumName,
        dirPath: row.dirPath,
        audioFiles: Array.isArray(row.audioFiles) ? (row.audioFiles as object[]) : [],
      });
      if (!albumData) continue;
      if (seenAlbumIds.has(albumData.id)) continue;
      seenAlbumIds.add(albumData.id);
      if (!hasAlbumInCache(albumData.id)) putAlbum(albumData);
      albumIds.push(albumData.id);
      likedAt[albumData.id] = Number(row.addedAt ?? Date.now());
      continue;
    }
    const data = rowToTrackData(row);
    if (!data) continue;
    if (seenTrackIds.has(data.id)) continue;
    seenTrackIds.add(data.id);
    if (!hasTrack(data.id)) putTrack(data);
    trackIds.push(data.id);
    likedAt[data.id] = Number(row.addedAt ?? Date.now());
  }

  if (trackIds.length === 0 && albumIds.length === 0) return;
  saveLikesSnapshot({ trackIds, albumIds, likedAt });
}

interface LegacyPlaylist {
  id: string;
  name?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  tracks?: LegacyRow[];
}

function migratePlaylists(): void {
  const existing = loadPlaylistsSnapshot();
  if (existing.length > 0) return;

  const legacy = readJSON<LegacyPlaylist[]>("neegde.playlists.v1");
  if (!Array.isArray(legacy) || legacy.length === 0) return;

  const migrated = legacy.map((pl) => {
    const trackIds: string[] = [];
    for (const row of pl.tracks ?? []) {
      const data = rowToTrackData(row);
      if (!data) continue;
      if (!hasTrack(data.id)) putTrack(data);
      trackIds.push(data.id);
    }
    return {
      id: pl.id,
      title: pl.name ?? pl.title ?? "Без названия",
      coverUrl: null,
      createdAt: pl.createdAt ?? Date.now(),
      updatedAt: pl.updatedAt ?? Date.now(),
      trackIds,
    };
  });

  savePlaylistsSnapshot(migrated);
}

function migrateQueue(): void {
  const existing = loadQueueSnapshot();
  if (existing.trackIds.length > 0) return;

  const session = readJSON<LegacyPlayerSession>("neegde.playerSession");
  if (!session?.queue?.length) return;

  const trackIds: string[] = [];
  for (const row of session.queue) {
    const data = rowToTrackData(row);
    if (!data) continue;
    if (!hasTrack(data.id)) putTrack(data);
    trackIds.push(data.id);
  }
  if (trackIds.length === 0) return;
  const pos = Math.max(0, Math.min(Number(session.queuePos ?? 0), trackIds.length - 1));
  saveQueueSnapshot({ trackIds, pos });
}
