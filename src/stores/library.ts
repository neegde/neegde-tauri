/**
 * Library store — likes + playlists, persisted in the v2 shape.
 *
 * Nothing is stored as "rich rows" here; the store holds track / album ids,
 * and metadata is resolved through the entities registry (seeded from
 * `trackCache` + `albumCache` at boot). Every mutation immediately syncs its
 * snapshot to localStorage.
 */

import { computed } from "vue";
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
import { putAlbum } from "../persistence/albumCache.js";
import {
  saveLikesSnapshot,
  type LikesSnapshot,
} from "../persistence/likes.js";
import {
  savePlaylistsSnapshot,
  type PlaylistSnapshot,
} from "../persistence/playlists.js";
import { LikesCollection } from "../likes/LikesCollection.js";
import { Library } from "../playlist/Library.js";
import type { Playlist } from "../playlist/Playlist.js";

// ── Likes ───────────────────────────────────────────────────────────────────

/**
 * Likes singleton. Owns the reactive liked-track / liked-album state.
 * Named exports below are thin delegates so call sites keep working.
 */
export const likes = new LikesCollection(saveLikesSnapshot);

export const likedTrackIds = likes.trackIds;
export const likedAlbumIds = likes.albumIds;
export const likedAt = likes.likedAt;

export const likedTracks = computed<Track[]>(() => {
  entitiesVersion.value;
  const at = likes.likedAt.value;
  const ids = Array.from(likes.trackIds.value);
  ids.sort((a, b) => (at.get(b) ?? 0) - (at.get(a) ?? 0));
  const out: Track[] = [];
  for (const id of ids) {
    const t = getTrack(id);
    if (t) out.push(t);
  }
  return out;
});

export const likedAlbums = computed<Album[]>(() => {
  entitiesVersion.value;
  const at = likes.likedAt.value;
  const ids = Array.from(likes.albumIds.value);
  ids.sort((a, b) => (at.get(b) ?? 0) - (at.get(a) ?? 0));
  const out: Album[] = [];
  for (const id of ids) {
    const a = getAlbum(id);
    if (a) out.push(a);
  }
  return out;
});

export function isTrackLiked(trackId: string): boolean {
  return likes.isTrackLiked(trackId);
}

export function isAlbumLiked(albumId: string): boolean {
  return likes.isAlbumLiked(albumId);
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
  return likes.toggleTrack(track.id);
}

export function toggleLikeAlbum(album: Album | AlbumData): boolean {
  if (!album?.id) return false;
  registerEntity(album);
  putAlbum(album);
  return likes.toggleAlbum(album.id);
}

/** Populate from persistence snapshot (call once at boot). */
export function seedLikesFromSnapshot(s: LikesSnapshot): void {
  likes.seedFromSnapshot(s);
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
