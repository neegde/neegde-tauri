/**
 * View / navigation store.
 *
 * Centralises which "screen" is visible, what's selected, and the
 * back/forward stacks. Entities are referenced by id so stacks stay small
 * and don't snapshot stale state.
 *
 * `selectedAlbumId` is the id of an Album currently open in detail view.
 * `currentPlaylistId` is the id of an open Playlist. Exactly one of those
 * (or none) is meaningful for the detail-view surface.
 *
 * The back/forward stacks store lightweight state descriptors:
 *   { kind: "search",   query: string }
 *   { kind: "album",    albumId: string }
 *   { kind: "playlist", playlistId: string }
 *   { kind: "likes" }
 *   { kind: "settings" }
 *   { kind: "home" }
 */

import { ref } from "vue";

/** @type {import("vue").Ref<"home" | "likes" | "settings" | "playlist">} */
export const view = ref("home");

/** Which playlist is open in PlaylistView, if any. */
export const currentPlaylistId = ref(null);

/** Which album is currently open in detail view (TorrentView/AlbumDetailView). */
export const selectedAlbumId = ref(null);

/** What to come back to after a sub-screen closes (e.g. settings → likes). */
export const returnView = ref("home");

/** @type {import("vue").Ref<Array<{ kind: string, [k: string]: any }>>} */
export const backStack = ref([]);
export const forwardStack = ref([]);

export function navigateTo(screenSpec) {
  if (!screenSpec || !screenSpec.kind) return;
  // Save current to back-stack if not a duplicate of last entry.
  const prev = _currentDescriptor();
  if (prev && !_sameDescriptor(prev, screenSpec)) {
    backStack.value = [...backStack.value, prev];
    forwardStack.value = [];
  }
  _applyDescriptor(screenSpec);
}

export function goBack() {
  const stack = backStack.value;
  if (stack.length === 0) return false;
  const target = stack[stack.length - 1];
  const cur = _currentDescriptor();
  forwardStack.value = cur ? [...forwardStack.value, cur] : forwardStack.value;
  backStack.value = stack.slice(0, -1);
  _applyDescriptor(target);
  return true;
}

export function goForward() {
  const stack = forwardStack.value;
  if (stack.length === 0) return false;
  const target = stack[stack.length - 1];
  const cur = _currentDescriptor();
  backStack.value = cur ? [...backStack.value, cur] : backStack.value;
  forwardStack.value = stack.slice(0, -1);
  _applyDescriptor(target);
  return true;
}

export function clearHistory() {
  backStack.value = [];
  forwardStack.value = [];
}

function _currentDescriptor() {
  if (view.value === "playlist" && currentPlaylistId.value) {
    return { kind: "playlist", playlistId: currentPlaylistId.value };
  }
  if (selectedAlbumId.value) {
    return { kind: "album", albumId: selectedAlbumId.value };
  }
  return { kind: view.value };
}

function _sameDescriptor(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "album") return a.albumId === b.albumId;
  if (a.kind === "playlist") return a.playlistId === b.playlistId;
  return true;
}

function _applyDescriptor(desc) {
  if (desc.kind === "album") {
    selectedAlbumId.value = desc.albumId;
    view.value = "home";
    currentPlaylistId.value = null;
    return;
  }
  if (desc.kind === "playlist") {
    currentPlaylistId.value = desc.playlistId;
    view.value = "playlist";
    selectedAlbumId.value = null;
    return;
  }
  selectedAlbumId.value = null;
  currentPlaylistId.value = null;
  if (desc.kind === "home" || desc.kind === "likes" || desc.kind === "settings") {
    view.value = desc.kind;
  }
}
