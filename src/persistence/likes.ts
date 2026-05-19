import { invoke } from "@tauri-apps/api/core";

/**
 * Persisted liked tracks / albums.
 *
 * Storage shape is intentionally minimal:
 *   {
 *     trackIds: string[],
 *     albumIds: string[],
 *     likedAt:  Record<id, number>,  // epoch ms
 *   }
 *
 * Track metadata lives in `trackCache`; album metadata in `albumCache`.
 * Loading order on boot:
 *   1. `loadTrackCache()` / `loadAlbumCache()` — populate id → data maps
 *   2. Hydrate + `registerEntity` for every cached row
 *   3. `loadLikesSnapshot()` — returns ids; `likedTracks` / `likedAlbums`
 *      resolve through the registry
 */

export const LIKES_STORAGE_KEY = "neegde.likes.v2";

export interface LikesSnapshot {
  trackIds: string[];
  albumIds: string[];
  likedAt: Record<string, number>;
}

export function loadLikesSnapshot(): LikesSnapshot {
  const empty: LikesSnapshot = { trackIds: [], albumIds: [], likedAt: {} };
  try {
    const raw = localStorage.getItem(LIKES_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<LikesSnapshot>;
    return {
      trackIds: Array.isArray(parsed.trackIds) ? parsed.trackIds.filter((x) => typeof x === "string") : [],
      albumIds: Array.isArray(parsed.albumIds) ? parsed.albumIds.filter((x) => typeof x === "string") : [],
      likedAt: parsed.likedAt && typeof parsed.likedAt === "object" ? parsed.likedAt : {},
    };
  } catch {
    return empty;
  }
}

export function saveLikesSnapshot(s: LikesSnapshot): void {
  try {
    const json = JSON.stringify(s);
    localStorage.setItem(LIKES_STORAGE_KEY, json);
    void (invoke("likes_write", { json }) as Promise<void>).catch(() => {});
  } catch {
    /* ignore */
  }
}
