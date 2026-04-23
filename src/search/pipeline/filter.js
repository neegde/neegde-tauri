/**
 * Filter stage — step 1: pass-through.
 *
 * Existing UI filters (`isLikelyPlayable`, SoulSeek peer filter) still
 * live in `Results.vue` for now; they'll migrate here once the UI is
 * rewritten to consume Candidates directly. Keeping the stage in the
 * pipeline now means that migration is an edit to one function, not
 * a structural change.
 *
 * @param {import("../../types/entities.js").Entity[]} entities
 * @param {object} [opts]
 * @returns {import("../../types/entities.js").Entity[]}
 */
export function filterStage(entities, _opts) {
  return entities;
}
