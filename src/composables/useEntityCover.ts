/**
 * Lazy cover loader for Track / Album entities.
 *
 * Both entity kinds expose `coverUrl()` / `startCoverFetch()` polymorphically
 * (Track hierarchy in `src/track/`, Album hierarchy in `src/album/`).
 *
 * IntersectionObserver kicks the lazy fetch when the root element enters
 * the viewport with a 400 px margin. Unmount tears it down.
 */

import { ref, computed, watch, onMounted, onUnmounted, type Ref } from "vue";
import type { Track } from "../track/Track.js";
import type { Album } from "../album/Album.js";
import { entitiesVersion } from "../stores/entities.js";

const FETCH_TIMEOUT_MS = 20_000;

type Entity = Track | Album | null | undefined;

/** Duck-type: both Track and Album expose `coverUrl()` + `startCoverFetch()`. */
function hasCoverApi(e: Entity): e is Track | Album {
  return !!e && typeof (e as Track | Album).coverUrl === "function" &&
    typeof (e as Track | Album).startCoverFetch === "function";
}

/** Reactive cover URL — delegates to the entity's polymorphic method. */
function coverOfEntity(entity: Entity): string | null {
  if (!hasCoverApi(entity)) return null;
  // Touch the version ref so album-registry updates refresh consumers.
  entitiesVersion.value;
  return entity.coverUrl();
}

export function useEntityCover(
  entityRef: Ref<Entity>,
  rootRef: Ref<HTMLElement | null>,
) {
  const coverErr = ref(false);
  const fetching = ref(false);
  const coverUrl = computed(() => coverOfEntity(entityRef.value));

  let observer: IntersectionObserver | null = null;
  let fetchTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (fetchTimer) { clearTimeout(fetchTimer); fetchTimer = null; }
  }

  function disconnect(): void {
    if (observer) { observer.disconnect(); observer = null; }
  }

  function arm(): void {
    disconnect();
    coverErr.value = false;
    fetching.value = false;
    clearTimer();
    const ent = entityRef.value;
    if (!hasCoverApi(ent)) return;
    if (ent.coverUrl()) return;  // cached already

    observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        disconnect();
        fetching.value = true;
        fetchTimer = setTimeout(() => { fetching.value = false; fetchTimer = null; }, FETCH_TIMEOUT_MS);
        ent.startCoverFetch();
      },
      { rootMargin: "400px" },
    );
    if (rootRef.value) observer.observe(rootRef.value);
  }

  watch(coverUrl, (v) => {
    if (v) { fetching.value = false; clearTimer(); }
  });

  watch(() => entityRef.value?.id, () => { coverErr.value = false; fetching.value = false; clearTimer(); arm(); });

  onMounted(arm);
  onUnmounted(() => { disconnect(); clearTimer(); });

  return { coverUrl, coverErr, fetching };
}
