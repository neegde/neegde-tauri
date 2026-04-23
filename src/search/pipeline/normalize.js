/**
 * Normalize stage — placeholder.
 *
 * Providers already emit Candidates in normalized shape, so on step 1
 * this is a no-op. The stage exists so later work (parsing artist/album
 * out of `title` when the provider didn't supply them, unifying format
 * names, stripping release-group tags like "[FLAC 24/96]") has a
 * dedicated home that does not require touching providers or UI.
 *
 * @param {import("../../types/entities.js").Entity[]} entities
 * @returns {import("../../types/entities.js").Entity[]}
 */
export function normalizeStage(entities) {
  return entities;
}
