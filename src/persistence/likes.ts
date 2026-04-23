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
 * All metadata lives in `trackCache`. Loading order on boot:
 *   1. `loadTrackCache()` first — populates `id → TrackData`
 *   2. `loadLikesSnapshot()` — returns ids
 *   3. Caller hydrates each id into a `Track` via `hydrateTrack(id)`
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
    localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
