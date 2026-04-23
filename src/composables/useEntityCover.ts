/**
 * Lazy cover loader for Track / Album entities.
 *
 * Reads the entity's current cover URL through a reactive path:
 *   - `Track` instances expose `coverUrl()` / `startCoverFetch()`
 *   - Album data (plain object) still carries an `coverUrl` field or
 *     `sources[0].raw.cover` / `sources[0].refs.topicId` — handled by the
 *     album branch below.
 *
 * IntersectionObserver kicks the lazy fetch when the root element enters
 * the viewport with a 400 px margin. Unmount tears it down.
 */

import { ref, computed, watch, onMounted, onUnmounted, type Ref } from "vue";
import type { Track } from "../track/Track.js";
import type { AlbumData } from "../stores/entities.js";
import { getAlbum, entitiesVersion } from "../stores/entities.js";
import {
  getCoverReactive,
  peekRutrackerCover,
  getRutrackerCoverDataUrl,
} from "../rutracker/coverCache.js";
import {
  getSlskCoverReactive,
  peekSlskCover,
  getSlskCoverDataUrl,
} from "../soulseek/coverCache.js";

type Entity = Track | AlbumData | null | undefined;

/**
 * HMR-safe Track check. `instanceof Track` breaks when Vite re-imports the
 * Track module: instances created by the old module stop matching the new
 * class prototype. Duck-type on the API instead so covers keep loading after
 * a hot-reload.
 */
function isTrack(e: Entity): e is Track {
  return !!e && e.type === "track" && typeof (e as Track).coverUrl === "function";
}

/** Reactive cover URL for Track (class) or Album (plain data). */
function coverOfEntity(entity: Entity): string | null {
  if (!entity) return null;
  // Touch the version ref so album-registry updates refresh consumers.
  entitiesVersion.value;
  if (isTrack(entity)) return entity.coverUrl();
  // AlbumData path
  if (entity.coverUrl) return entity.coverUrl;
  const src = entity.sources?.[0];
  if (!src) return null;
  if (src.kind === "soulseek") {
    const cover = src.raw?.cover;
    if (!cover?.slsk_username || !cover?.slsk_filepath) return null;
    return getSlskCoverReactive(cover.slsk_username, cover.slsk_filepath);
  }
  if (src.kind === "rutracker") {
    const topicId = src.refs?.topicId;
    if (typeof topicId !== "string" || !topicId) return null;
    return getCoverReactive(topicId);
  }
  return null;
}

/** Kick the fetch for an Album that has no cached cover yet. */
function startAlbumFetch(album: AlbumData): void {
  if (album.coverUrl) return;
  const src = album.sources?.[0];
  if (!src) return;
  if (src.kind === "soulseek") {
    const cover = src.raw?.cover;
    if (!cover?.slsk_username || !cover?.slsk_filepath) return;
    if (peekSlskCover(cover.slsk_username, cover.slsk_filepath) !== undefined) return;
    void getSlskCoverDataUrl(cover.slsk_username, cover.slsk_filepath, cover.size ?? 0).catch(() => {});
    return;
  }
  if (src.kind === "rutracker") {
    const topicId = src.refs?.topicId;
    if (typeof topicId !== "string" || !topicId) return;
    if (peekRutrackerCover(topicId) !== undefined) return;
    void getRutrackerCoverDataUrl(topicId).catch(() => {});
  }
}

export function useEntityCover(
  entityRef: Ref<Entity>,
  rootRef: Ref<HTMLElement | null>,
) {
  const coverErr = ref(false);
  const coverUrl = computed(() => coverOfEntity(entityRef.value));

  let observer: IntersectionObserver | null = null;
  function disconnect(): void {
    if (observer) { observer.disconnect(); observer = null; }
  }

  function arm(): void {
    disconnect();
    coverErr.value = false;
    const ent = entityRef.value;
    if (!ent) return;
    if (coverOfEntity(ent)) return;  // cached already

    observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        disconnect();
        if (isTrack(ent)) ent.startCoverFetch();
        else startAlbumFetch(ent);
      },
      { rootMargin: "400px" },
    );
    if (rootRef.value) observer.observe(rootRef.value);
  }

  watch(() => entityRef.value?.id, () => { coverErr.value = false; arm(); });

  onMounted(arm);
  onUnmounted(disconnect);

  return { coverUrl, coverErr };
}
