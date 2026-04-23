/**
 * Dedup stage — step 1: by entity.id only.
 *
 * Ids are prefixed per provider (`rt:album:…`, `slsk:track:…`) so cross-
 * provider collisions cannot happen here. Within one provider, ids are
 * stable per search; two snapshots from the same provider are simply
 * merged by id (we prefer the copy with higher `mergedFrom`).
 *
 * Cross-provider fuzzy merge (RT album ↔ SLSK folder with matching
 * artist/album/year) is intentionally deferred to a later stage — it
 * needs a deliberate key function and handling of the Track children
 * under each Album.
 *
 * @param {import("../../types/entities.js").Entity[]} entities
 * @returns {import("../../types/entities.js").Entity[]}
 */
export function dedupStage(entities) {
  const byId = new Map();
  for (const e of entities) {
    const existing = byId.get(e.id);
    if (!existing) {
      byId.set(e.id, e);
      continue;
    }
    if (e.mergedFrom > existing.mergedFrom) byId.set(e.id, e);
  }
  return Array.from(byId.values());
}
