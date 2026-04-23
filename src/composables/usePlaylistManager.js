/**
 * Playlist CRUD + "add to playlist" modal composable.
 *
 * Wraps the pure helpers in `lib/playlistStorage.js` so App.vue doesn't need
 * to know about the legacy persisted shape directly. The store (`playlists`
 * ref) and the current-open-playlist id are still owned by the caller — the
 * composable mutates them via refs passed in.
 */

import { ref } from "vue";
import {
  createPlaylist as storeCreatePlaylist,
  deletePlaylist as storeDeletePlaylist,
  renamePlaylist as storeRenamePlaylist,
  addTrackToPlaylist as storeAddTrackToPlaylist,
  removeTrackFromPlaylist as storeRemoveTrackFromPlaylist,
} from "../lib/playlistStorage.js";

/**
 * @param {{
 *   playlists: import("vue").Ref<Array<object>>,
 *   currentPlaylistId: import("vue").Ref<string | null>,
 *   view: import("vue").Ref<string>,
 * }} ctx
 */
export function usePlaylistManager(ctx) {
  const addToPlaylistModal = ref(false);
  const addToPlaylistTrack = ref(null);

  function openPlaylist(id) {
    ctx.currentPlaylistId.value = id;
    ctx.view.value = "playlist";
  }

  function handleCreatePlaylist() {
    ctx.playlists.value = storeCreatePlaylist(`Плейлист ${ctx.playlists.value.length + 1}`);
    const newPl = ctx.playlists.value[ctx.playlists.value.length - 1];
    openPlaylist(newPl.id);
  }

  function handleDeletePlaylist(id) {
    ctx.playlists.value = storeDeletePlaylist(id);
    if (ctx.currentPlaylistId.value === id) {
      ctx.currentPlaylistId.value = null;
      ctx.view.value = "home";
    }
  }

  function handleRenamePlaylist(id, name) {
    ctx.playlists.value = storeRenamePlaylist(id, name);
  }

  function handleRemoveTrackFromPlaylist(id, { magnet, fileIdx }) {
    ctx.playlists.value = storeRemoveTrackFromPlaylist(id, magnet, fileIdx);
  }

  function handleShowAddToPlaylist(track) {
    if (!track) return;
    addToPlaylistTrack.value = track;
    addToPlaylistModal.value = true;
  }

  function handleAddToPlaylist(playlistId) {
    if (!addToPlaylistTrack.value) return;
    ctx.playlists.value = storeAddTrackToPlaylist(playlistId, addToPlaylistTrack.value);
    addToPlaylistModal.value = false;
    addToPlaylistTrack.value = null;
  }

  function handleAddToPlaylistNew() {
    ctx.playlists.value = storeCreatePlaylist(`Плейлист ${ctx.playlists.value.length + 1}`);
    const newPl = ctx.playlists.value[ctx.playlists.value.length - 1];
    if (addToPlaylistTrack.value) {
      ctx.playlists.value = storeAddTrackToPlaylist(newPl.id, addToPlaylistTrack.value);
    }
    addToPlaylistModal.value = false;
    addToPlaylistTrack.value = null;
    openPlaylist(newPl.id);
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
