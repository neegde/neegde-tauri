/**
 * Library store — likes + playlists, persisted in the v2 shape.
 *
 * Nothing is stored as "rich rows" here; the store holds track ids, and
 * metadata is resolved through the entities registry (which itself is
 * seeded from `trackCache` at boot). Every mutation immediately syncs its
 * snapshot to localStorage.
 */

import { computed, ref } from "vue";
import type { Track } from "../track/Track.js";
import type { Album } from "../album/Album.js";
import type { AlbumData } from "../album/types.js";
import {
  getTrack,
  getAlbum,
  registerEntity,
  entitiesVersion,
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
import { Library } from "../playlist/Library.js";
import type { Playlist } from "../playlist/Playlist.js";

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

export const likedAlbums = computed<Album[]>(() => {
  entitiesVersion.value;
  const ids = Array.from(likedAlbumIds.value);
  ids.sort((a, b) => (likedAt.value.get(b) ?? 0) - (likedAt.value.get(a) ?? 0));
  const out: Album[] = [];
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

export function toggleLikeAlbum(album: Album | AlbumData): boolean {
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

/**
 * Library singleton. Owns the reactive Playlist collection; named exports
 * below are thin delegates so existing call sites keep working.
 */
export const library = new Library(savePlaylistsSnapshot);

/** Reactive list of Playlist instances. UI components read .title / .trackIds directly. */
export const playlists = library.playlists;

export function getPlaylist(id: string): Playlist | null {
  return library.get(id);
}

export function getPlaylistTracks(playlistId: string): Track[] {
  entitiesVersion.value;
  const pl = library.get(playlistId);
  if (!pl) return [];
  const out: Track[] = [];
  for (const id of pl.trackIds) {
    const t = getTrack(id);
    if (t) out.push(t);
  }
  return out;
}

export function createPlaylist(title: string): Playlist {
  return library.create(title);
}

export function deletePlaylist(id: string): void {
  library.delete(id);
}

export function renamePlaylist(id: string, newTitle: string): void {
  library.rename(id, newTitle);
}

export function addTrackToPlaylist(playlistId: string, track: Track): void {
  if (!track?.id) return;
  registerEntity(track);
  putTrack(track);
  library.addTrackId(playlistId, track.id);
}

export function removeTrackFromPlaylist(playlistId: string, trackId: string): void {
  library.removeTrackId(playlistId, trackId);
}

export function movePlaylistTrack(playlistId: string, fromIdx: number, toIdx: number): void {
  library.reorder(playlistId, fromIdx, toIdx);
}

/** Populate from persistence snapshot (call once at boot). */
export function seedPlaylistsFromSnapshot(list: PlaylistSnapshot[]): void {
  library.seedFromSnapshots(list);
}
