/**
 * Persisted playlists.
 *
 * Playlists are lists of track ids + their own metadata (title, timestamps).
 * Track contents are resolved through `trackCache` / `hydrateTrack`.
 */

export const PLAYLISTS_STORAGE_KEY = "neegde.playlists.v2";

export interface PlaylistSnapshot {
  id: string;
  title: string;
  coverUrl: string | null;
  createdAt: number;
  updatedAt: number;
  trackIds: string[];
}

export function loadPlaylistsSnapshot(): PlaylistSnapshot[] {
  try {
    const raw = localStorage.getItem(PLAYLISTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is PlaylistSnapshot =>
        Boolean(p && typeof p === "object" && typeof (p as { id: unknown }).id === "string"))
      .map((p) => ({
        id: p.id,
        title: p.title ?? "Без названия",
        coverUrl: p.coverUrl ?? null,
        createdAt: p.createdAt ?? Date.now(),
        updatedAt: p.updatedAt ?? Date.now(),
        trackIds: Array.isArray(p.trackIds) ? p.trackIds.filter((x) => typeof x === "string") : [],
      }));
  } catch {
    return [];
  }
}

export function savePlaylistsSnapshot(list: PlaylistSnapshot[]): void {
  try {
    localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
