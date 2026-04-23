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
