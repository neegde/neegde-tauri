/**
 * Module-level SoulSeek metadata store.
 * Lives outside any Vue component so state survives navigation / remounts.
 */
import { reactive } from "vue";

export interface SlskMetaRecord {
  artist?: string;
  title?: string;
  coverUrl?: string | null;
  albumUrl?: string | null;
}

/** Map<trackId, metadata> */
export const slskMeta = reactive(new Map<string, SlskMetaRecord>());

/** Monotonic counter — bumped to cancel in-flight iTunes fetches on new search. */
export let coverGeneration = 0;
export function bumpCoverGeneration(): number { return ++coverGeneration; }

/** Pending debounce timer for cover fetches. */
export let coverTimer: ReturnType<typeof setTimeout> | null = null;
export function setCoverTimer(id: ReturnType<typeof setTimeout> | null): void {
  coverTimer = id;
}
export function clearCoverTimer(): void {
  if (coverTimer != null) clearTimeout(coverTimer);
  coverTimer = null;
}

/**
 * Track ids for which Deezer canonical-name enrichment has already been
 * dispatched in the current query. Lives at module scope (next to slskMeta)
 * so a Results.vue remount preserves it — re-mounting the search panel
 * mid-query shouldn't re-iterate the per-track resolve/cache path.
 *
 * Cleared by the searchEpoch / empty-rows watchers in `Results.vue`.
 */
export const enrichedIds = new Set<string>();
