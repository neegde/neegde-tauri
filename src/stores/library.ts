/**
 * Library store — likes + playlists, persisted in the v2 shape.
 *
 * Nothing is stored as "rich rows" here; the store holds track ids, and
 * metadata is resolved through the entities registry (which itself is
 * seeded from `trackCache` at boot). Every mutation immediately syncs its
 * snapshot to localStorage.
 */

import { ref, computed } from "vue";
import type { Track } from "../track/Track.js";
import {
  getTrack,
  getAlbum,
  registerEntity,
  entitiesVersion,
  type AlbumData,
} from "./entities.js";
import { putTrack } from "../persistence/trackCache.js";
import {
  saveLikesSnapshot,
  type LikesSnapshot,
} from "../persistence/likes.js";
import {
  savePlaylistsSnapshot,
  type PlaylistSnapshot,
} from "../persistence/playlists.js";

// ── Likes ───────────────────────────────────────────────────────────────────

export const likedTrackIds = ref<Set<string>>(new Set());
export const likedAlbumIds = ref<Set<string>>(new Set());
export const likedAt = ref<Map<string, number>>(new Map());

export const likedTracks = computed<Track[]>(() => {
  entitiesVersion.value;
  const ids = Array.from(likedTrackIds.value);
  ids.sort((a, b) => (likedAt.value.get(b) ?? 0) - (likedAt.value.get(a) ?? 0));
  const out: Track[] = [];
  for (const id of ids) {
    const t = getTrack(id);
    if (t) out.push(t);
  }
  return out;
});

export const likedAlbums = computed<AlbumData[]>(() => {
  entitiesVersion.value;
  const ids = Array.from(likedAlbumIds.value);
  ids.sort((a, b) => (likedAt.value.get(b) ?? 0) - (likedAt.value.get(a) ?? 0));
  const out: AlbumData[] = [];
  for (const id of ids) {
    const a = getAlbum(id);
    if (a) out.push(a);
  }
  return out;
});

export function isTrackLiked(trackId: string): boolean {
  return likedTrackIds.value.has(trackId);
}

export function isAlbumLiked(albumId: string): boolean {
  return likedAlbumIds.value.has(albumId);
}

/**
 * Toggle like for a Track. Returns true when the track is liked after the call.
 * Side effect: registers the track in the entities registry + trackCache so
 * a restart can rehydrate it offline.
 */
export function toggleLikeTrack(track: Track): boolean {
  if (!track?.id) return false;
  registerEntity(track);
  putTrack(track);
  const set = new Set(likedTrackIds.value);
  const at = new Map(likedAt.value);
  let liked: boolean;
  if (set.has(track.id)) {
    set.delete(track.id); at.delete(track.id); liked = false;
  } else {
    set.add(track.id); at.set(track.id, Date.now()); liked = true;
  }
  likedTrackIds.value = set;
  likedAt.value = at;
  persistLikes();
  return liked;
}

export function toggleLikeAlbum(album: AlbumData): boolean {
  if (!album?.id) return false;
  registerEntity(album);
  const set = new Set(likedAlbumIds.value);
  const at = new Map(likedAt.value);
  let liked: boolean;
  if (set.has(album.id)) {
    set.delete(album.id); at.delete(album.id); liked = false;
  } else {
    set.add(album.id); at.set(album.id, Date.now()); liked = true;
  }
  likedAlbumIds.value = set;
  likedAt.value = at;
  persistLikes();
  return liked;
}

function persistLikes(): void {
  const at: Record<string, number> = {};
  for (const [id, ts] of likedAt.value) at[id] = ts;
  saveLikesSnapshot({
    trackIds: Array.from(likedTrackIds.value),
    albumIds: Array.from(likedAlbumIds.value),
    likedAt: at,
  });
}

/** Populate from persistence snapshot (call once at boot). */
export function seedLikesFromSnapshot(s: LikesSnapshot): void {
  likedTrackIds.value = new Set(s.trackIds);
  likedAlbumIds.value = new Set(s.albumIds);
  likedAt.value = new Map(Object.entries(s.likedAt));
}

// ── Playlists ───────────────────────────────────────────────────────────────

export const playlists = ref<PlaylistSnapshot[]>([]);

export function getPlaylist(id: string): PlaylistSnapshot | null {
  return playlists.value.find((p) => p.id === id) ?? null;
}

export function getPlaylistTracks(playlistId: string): Track[] {
  entitiesVersion.value;
  const pl = getPlaylist(playlistId);
  if (!pl) return [];
  const out: Track[] = [];
  for (const id of pl.trackIds) {
    const t = getTrack(id);
    if (t) out.push(t);
  }
  return out;
}

function uuid(): string {
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createPlaylist(title: string): PlaylistSnapshot {
  const now = Date.now();
  const pl: PlaylistSnapshot = {
    id: uuid(),
    title: title?.trim() || "Без названия",
    coverUrl: null,
    createdAt: now,
    updatedAt: now,
    trackIds: [],
  };
  playlists.value = [...playlists.value, pl];
  persistPlaylists();
  return pl;
}

export function deletePlaylist(id: string): void {
  playlists.value = playlists.value.filter((p) => p.id !== id);
  persistPlaylists();
}

export function renamePlaylist(id: string, newTitle: string): void {
  const trimmed = newTitle?.trim();
  if (!trimmed) return;
  playlists.value = playlists.value.map((p) =>
    p.id === id ? { ...p, title: trimmed, updatedAt: Date.now() } : p,
  );
  persistPlaylists();
}

export function addTrackToPlaylist(playlistId: string, track: Track): void {
  if (!track?.id) return;
  registerEntity(track);
  putTrack(track);
  playlists.value = playlists.value.map((p) => {
    if (p.id !== playlistId) return p;
    if (p.trackIds.includes(track.id)) return p;
    return { ...p, trackIds: [...p.trackIds, track.id], updatedAt: Date.now() };
  });
  persistPlaylists();
}

export function removeTrackFromPlaylist(playlistId: string, trackId: string): void {
  playlists.value = playlists.value.map((p) => {
    if (p.id !== playlistId) return p;
    if (!p.trackIds.includes(trackId)) return p;
    return { ...p, trackIds: p.trackIds.filter((id) => id !== trackId), updatedAt: Date.now() };
  });
  persistPlaylists();
}

export function movePlaylistTrack(playlistId: string, fromIdx: number, toIdx: number): void {
  playlists.value = playlists.value.map((p) => {
    if (p.id !== playlistId) return p;
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return p;
    if (fromIdx >= p.trackIds.length || toIdx >= p.trackIds.length) return p;
    const next = p.trackIds.slice();
    const [id] = next.splice(fromIdx, 1);
    if (id != null) next.splice(toIdx, 0, id);
    return { ...p, trackIds: next, updatedAt: Date.now() };
  });
  persistPlaylists();
}

function persistPlaylists(): void {
  savePlaylistsSnapshot(playlists.value);
}

/** Populate from persistence snapshot (call once at boot). */
export function seedPlaylistsFromSnapshot(list: PlaylistSnapshot[]): void {
  playlists.value = list;
}
