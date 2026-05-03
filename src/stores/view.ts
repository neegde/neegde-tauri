/**
 * View / navigation store.
 *
 * Centralises which "screen" is visible, what's selected, and the
 * back/forward stacks. Entities are referenced by id so stacks stay small
 * and don't snapshot stale state.
 */

import { ref } from "vue";

export type ViewName = "home" | "likes" | "settings" | "playlist";

export type ScreenDescriptor =
  | { kind: "search"; query?: string }
  | { kind: "album"; albumId: string }
  | { kind: "playlist"; playlistId: string }
  | { kind: "likes" }
  | { kind: "settings" }
  | { kind: "home" };

export const view = ref<ViewName>("home");

/** Which playlist is open in PlaylistView, if any. */
export const currentPlaylistId = ref<string | null>(null);

/** Which album is currently open in detail view. */
export const selectedAlbumId = ref<string | null>(null);

/** What to come back to after a sub-screen closes (e.g. settings → likes). */
export const returnView = ref<ViewName>("home");

export const backStack = ref<ScreenDescriptor[]>([]);
export const forwardStack = ref<ScreenDescriptor[]>([]);

export function navigateTo(screenSpec: ScreenDescriptor | null | undefined): void {
  if (!screenSpec || !("kind" in screenSpec)) return;
  const prev = _currentDescriptor();
  if (prev && !_sameDescriptor(prev, screenSpec)) {
    backStack.value = [...backStack.value, prev];
    forwardStack.value = [];
  }
  _applyDescriptor(screenSpec);
}

export function goBack(): boolean {
  const stack = backStack.value;
  if (stack.length === 0) return false;
  const target = stack[stack.length - 1]!;
  const cur = _currentDescriptor();
  forwardStack.value = cur ? [...forwardStack.value, cur] : forwardStack.value;
  backStack.value = stack.slice(0, -1);
  _applyDescriptor(target);
  return true;
}

export function goForward(): boolean {
  const stack = forwardStack.value;
  if (stack.length === 0) return false;
  const target = stack[stack.length - 1]!;
  const cur = _currentDescriptor();
  backStack.value = cur ? [...backStack.value, cur] : backStack.value;
  forwardStack.value = stack.slice(0, -1);
  _applyDescriptor(target);
  return true;
}

export function clearHistory(): void {
  backStack.value = [];
  forwardStack.value = [];
}

function _currentDescriptor(): ScreenDescriptor {
  if (view.value === "playlist" && currentPlaylistId.value) {
    return { kind: "playlist", playlistId: currentPlaylistId.value };
  }
  if (selectedAlbumId.value) {
    return { kind: "album", albumId: selectedAlbumId.value };
  }
  if (view.value === "likes") return { kind: "likes" };
  if (view.value === "settings") return { kind: "settings" };
  return { kind: "home" };
}

function _sameDescriptor(a: ScreenDescriptor, b: ScreenDescriptor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "album" && b.kind === "album") return a.albumId === b.albumId;
  if (a.kind === "playlist" && b.kind === "playlist") return a.playlistId === b.playlistId;
  return true;
}

function _applyDescriptor(desc: ScreenDescriptor): void {
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
