/**
 * Filter stage — step 1: pass-through.
 *
 * Existing UI filters (`isLikelyPlayable`, SoulSeek peer filter) still
 * live in `Results.vue` for now; they'll migrate here once the UI is
 * rewritten to consume Candidates directly.
 */
export function filterStage<T>(entities: T[], _opts?: Record<string, unknown>): T[] {
  return entities;
}
