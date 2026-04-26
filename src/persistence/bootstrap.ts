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
 *   3. Hydrate every cached TrackData into a `Track` instance and register
 *      it in the entities store. Without this step, `likedTracks` / queue
 *      resolutions yield null on cold start (registry is empty).
 *   4. Return the snapshots so App.vue can push them into the library /
 *      queue stores.
 */

import { migrateLegacyStorage } from "./migrateLegacy.js";
import { loadTrackCache, allTrackIds, hydrateTrack } from "./trackCache.js";
import { registerEntity } from "../stores/entities.js";
import { loadLikesSnapshot, type LikesSnapshot } from "./likes.js";
import { loadPlaylistsSnapshot, type PlaylistSnapshot } from "./playlists.js";
import { loadQueueSnapshot, type QueueSnapshot } from "./queue.js";

export interface PersistenceSnapshot {
  likes: LikesSnapshot;
  playlists: PlaylistSnapshot[];
  queue: QueueSnapshot;
}

function emptyPersistenceSnapshot(): PersistenceSnapshot {
  return {
    likes: { trackIds: [], albumIds: [], likedAt: {} },
    playlists: [],
    queue: { trackIds: [], pos: 0 },
  };
}

export function loadPersistedState(): PersistenceSnapshot {
  try {
    migrateLegacyStorage();
    loadTrackCache();
    for (const id of allTrackIds()) {
      const track = hydrateTrack(id);
      if (track) registerEntity(track);
    }
    return {
      likes: loadLikesSnapshot(),
      playlists: loadPlaylistsSnapshot(),
      queue: loadQueueSnapshot(),
    };
  } catch {
    return emptyPersistenceSnapshot();
  }
}
