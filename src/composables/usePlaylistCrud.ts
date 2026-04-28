/**
 * usePlaylistCrud — owns the "add track to playlist" modal and wraps the
 * library-store playlist CRUD handlers with App.vue-level side effects
 * (navigation to a just-opened playlist, clearing currentPlaylistId when
 * the active playlist is deleted).
 *
 * Composable boundaries:
 *   - `currentPlaylistId` / `view` are *inputs* (refs owned by view store /
 *     App.vue), so the composable stays navigation-agnostic beyond writing
 *     these two slots.
 *   - `resolveTrackFromPayload` is injected: multiple call sites in App.vue
 *     need this (likes / playlists / context menus), so it stays there and
 *     we take it as a dependency.
 */

import { ref, shallowRef, type Ref, type ShallowRef } from "vue";
import type { Track } from "../track/Track.js";
import {
  playlists as libraryPlaylists,
  addTrackToPlaylist as libAddTrackToPlaylist,
  removeTrackFromPlaylist as libRemoveTrackFromPlaylist,
  deletePlaylist as libDeletePlaylist,
  renamePlaylist as libRenamePlaylist,
  createPlaylist as libCreatePlaylist,
} from "../stores/library.js";

export interface UsePlaylistCrudOptions {
  currentPlaylistId: Ref<string | null>;
  view: Ref<string>;
  resolveTrackFromPayload: (payload: unknown) => Track | null;
}

export interface UsePlaylistCrudApi {
  addToPlaylistModal: Ref<boolean>;
  addToPlaylistTrack: ShallowRef<Track | null>;
  openPlaylist: (id: string) => void;
  handleCreatePlaylist: () => void;
  handleDeletePlaylist: (id: string) => void;
  handleRenamePlaylist: (id: string, name: string) => void;
  handleRemoveTrackFromPlaylist: (id: string, trackId: string) => void;
  handleShowAddToPlaylist: (payload: unknown) => void;
  handleAddToPlaylist: (playlistId: string) => void;
  handleAddToPlaylistNew: () => void;
}

export function usePlaylistCrud(opts: UsePlaylistCrudOptions): UsePlaylistCrudApi {
  const addToPlaylistModal = ref<boolean>(false);
  const addToPlaylistTrack = shallowRef<Track | null>(null);

  function openPlaylist(id: string): void {
    opts.currentPlaylistId.value = id;
    opts.view.value = "playlist";
  }

  function handleCreatePlaylist(): void {
    const pl = libCreatePlaylist(`Плейлист ${libraryPlaylists.value.length + 1}`);
    openPlaylist(pl.id);
  }

  function handleDeletePlaylist(id: string): void {
    libDeletePlaylist(id);
    if (opts.currentPlaylistId.value === id) {
      opts.currentPlaylistId.value = null;
      opts.view.value = "home";
    }
  }

  function handleRenamePlaylist(id: string, name: string): void {
    libRenamePlaylist(id, name);
  }

  function handleRemoveTrackFromPlaylist(id: string, trackId: string): void {
    libRemoveTrackFromPlaylist(id, trackId);
  }

  /** User picked a track for the "add to playlist" modal. */
  function handleShowAddToPlaylist(payload: unknown): void {
    const track = opts.resolveTrackFromPayload(payload);
    if (!track) return;
    addToPlaylistTrack.value = track;
    addToPlaylistModal.value = true;
  }

  function handleAddToPlaylist(playlistId: string): void {
    const t = addToPlaylistTrack.value;
    if (!t) return;
    libAddTrackToPlaylist(playlistId, t);
    addToPlaylistModal.value = false;
    addToPlaylistTrack.value = null;
  }

  function handleAddToPlaylistNew(): void {
    const pl = libCreatePlaylist(`Плейлист ${libraryPlaylists.value.length + 1}`);
    const t = addToPlaylistTrack.value;
    if (t) libAddTrackToPlaylist(pl.id, t);
    addToPlaylistModal.value = false;
    addToPlaylistTrack.value = null;
    openPlaylist(pl.id);
  }

  return {
    addToPlaylistModal,
    addToPlaylistTrack,
    openPlaylist,
    handleCreatePlaylist,
    handleDeletePlaylist,
    handleRenamePlaylist,
    handleRemoveTrackFromPlaylist,
    handleShowAddToPlaylist,
    handleAddToPlaylist,
    handleAddToPlaylistNew,
  };
}
