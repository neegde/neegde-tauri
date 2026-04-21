/**
 * Module-level SoulSeek metadata store.
 * Lives outside any Vue component so state survives navigation / remounts.
 */
import { reactive } from "vue";

/** Map<trackId, { artist, title, coverUrl?, albumUrl? }> */
export const slskMeta = reactive(new Map());

/** Monotonic counter — bumped to cancel in-flight iTunes fetches on new search. */
export let coverGeneration = 0;
export function bumpCoverGeneration() { return ++coverGeneration; }

/** Pending debounce timer for cover fetches. */
export let coverTimer = null;
export function setCoverTimer(id) { coverTimer = id; }
export function clearCoverTimer() { clearTimeout(coverTimer); coverTimer = null; }
