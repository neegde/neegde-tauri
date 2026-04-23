/**
 * Lazy cover loader for Track and Album entities.
 *
 * Thin wrapper on top of `track/cover`:
 *   - `coverUrl` — reactive data URL (subscribes to the cover caches + entity
 *     registry version through `coverUrlOf`).
 *   - `coverErr` — image `@error` sink; auto-resets on entity change.
 *   - IntersectionObserver calls `startLazyCoverFetch` once the root ref
 *     enters the viewport (with a 400 px rootMargin so it warms ahead).
 *
 * The composable has no source-specific branching — adding a new source to
 * `track/cover` automatically reaches every card that uses this.
 */

import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { coverUrlOf, startLazyCoverFetch } from "../track/cover.js";

/**
 * @param {import("vue").Ref<import("../types/entities.js").Track | import("../types/entities.js").Album | null>} entityRef
 * @param {import("vue").Ref<HTMLElement | null>} rootRef
 */
export function useEntityCover(entityRef, rootRef) {
  const coverErr = ref(false);
  const coverUrl = computed(() => coverUrlOf(entityRef.value));

  let observer = null;
  function disconnectObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  function armObserver() {
    disconnectObserver();
    coverErr.value = false;
    const ent = entityRef.value;
    if (!ent || ent.coverUrl) return;           // nothing to lazy-fetch
    // If already cached (positive or still in negative-TTL), no observer needed.
    if (coverUrlOf(ent)) return;
    observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        disconnectObserver();
        startLazyCoverFetch(ent);
      },
      { rootMargin: "400px" },
    );
    if (rootRef.value) observer.observe(rootRef.value);
  }

  // Reset observer + error flag whenever the entity identity changes.
  watch(
    () => entityRef.value?.id,
    () => { coverErr.value = false; armObserver(); },
  );

  onMounted(armObserver);
  onUnmounted(disconnectObserver);

  return { coverUrl, coverErr };
}
