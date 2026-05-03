/**
 * Lazy cover loader for Track / Album entities.
 *
 * Both entity kinds expose `coverUrl()` / `startCoverFetch()` polymorphically
 * (Track hierarchy in `src/track/`, Album hierarchy in `src/album/`).
 *
 * IntersectionObserver (400 px margin) kicks the lazy fetch when the root
 * element enters the viewport and cancels it when the element leaves — this
 * prevents wasted requests when SoulSeek search results shift rapidly.
 * Unmount tears everything down.
 */

import { ref, computed, watch, onMounted, onUnmounted, type Ref } from "vue";
import type { Track } from "../track/Track.js";
import type { Album } from "../album/Album.js";
import { entitiesVersion } from "../stores/entities.js";
import { appDebugLog } from "../appDebugLog.js";

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
  let abortCtrl: AbortController | null = null;

  function clearTimer(): void {
    if (fetchTimer) { clearTimeout(fetchTimer); fetchTimer = null; }
  }

  function cancelFetch(): void {
    abortCtrl?.abort();
    abortCtrl = null;
  }

  function disconnect(): void {
    if (observer) { observer.disconnect(); observer = null; }
  }

  function arm(): void {
    disconnect();
    cancelFetch();
    coverErr.value = false;
    fetching.value = false;
    clearTimer();
    const ent = entityRef.value;
    if (!hasCoverApi(ent)) return;
    if (ent.coverUrl()) return;  // already cached

    observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          cancelFetch();
          abortCtrl = new AbortController();
          fetching.value = true;
          clearTimer();
          fetchTimer = setTimeout(() => {
            void appDebugLog("cover", `entity: timeout 20s — ${ent.kind}:${ent.id}`);
            fetching.value = false;
            fetchTimer = null;
          }, FETCH_TIMEOUT_MS);
          void appDebugLog("cover", `entity: visible — ${ent.kind}:${ent.id}`);
          ent.startCoverFetch(abortCtrl.signal);
        } else {
          // Left the visible zone — stop any in-progress guess
          if (abortCtrl) {
            void appDebugLog("cover", `entity: left viewport — ${ent.kind}:${ent.id}`);
            cancelFetch();
            clearTimer();
            if (!coverUrl.value) fetching.value = false;
          }
        }
      },
      { rootMargin: "400px" },
    );
    if (rootRef.value) observer.observe(rootRef.value);
  }

  watch(coverUrl, (v) => {
    if (v) {
      const ent = entityRef.value;
      void appDebugLog("cover", `entity: loaded — ${ent?.kind}:${ent?.id}`);
      fetching.value = false;
      clearTimer();
      cancelFetch();
      // Cover found — observer no longer needed
      disconnect();
    }
  });

  watch(() => entityRef.value, (newEnt, oldEnt) => {
    if (newEnt === oldEnt) return;
    coverErr.value = false;
    fetching.value = false;
    clearTimer();
    arm();
  });

  onMounted(arm);
  onUnmounted(() => { disconnect(); clearTimer(); cancelFetch(); });

  return { coverUrl, coverErr, fetching };
}
