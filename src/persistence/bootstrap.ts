/**
 * App-boot hook for the persistence layer.
 *
 * Call exactly once from `onMounted` in App.vue, before any consumer reads
 * `stores/library` or the queue. Order matters:
 *
 *   1. Run the v1 → v2 migration (reads legacy rows, writes v2 snapshots +
 *      seeds trackCache). Idempotent via a `migration.v2.done` flag.
 *   2. Load trackCache from localStorage — this populates the in-memory
 *      cache so `hydrateTrack(id)` can resolve ids referenced by likes /
 *      playlists / queue snapshots.
 *   3. Return the snapshots so App.vue can push them into the library /
 *      queue stores.
 */

import { migrateLegacyStorage } from "./migrateLegacy.js";
import { loadTrackCache } from "./trackCache.js";
import { loadLikesSnapshot, type LikesSnapshot } from "./likes.js";
import { loadPlaylistsSnapshot, type PlaylistSnapshot } from "./playlists.js";
import { loadQueueSnapshot, type QueueSnapshot } from "./queue.js";

export interface PersistenceSnapshot {
  likes: LikesSnapshot;
  playlists: PlaylistSnapshot[];
  queue: QueueSnapshot;
}

export function loadPersistedState(): PersistenceSnapshot {
  migrateLegacyStorage();
  loadTrackCache();
  return {
    likes: loadLikesSnapshot(),
    playlists: loadPlaylistsSnapshot(),
    queue: loadQueueSnapshot(),
  };
}
