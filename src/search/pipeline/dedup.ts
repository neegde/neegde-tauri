/**
 * Dedup stage — step 1: by entity.id only.
 *
 * Ids are prefixed per provider (`rt:album:…`, `slsk:track:…`) so cross-
 * provider collisions cannot happen here. Within one provider, ids are
 * stable per search; two snapshots from the same provider are simply
 * merged by id (we prefer the copy with higher `mergedFrom`).
 */
export function dedupStage<T extends { id: string; mergedFrom?: number }>(entities: T[]): T[] {
  const byId = new Map<string, T>();
  for (const e of entities) {
    const existing = byId.get(e.id);
    if (!existing) {
      byId.set(e.id, e);
      continue;
    }
    if ((e.mergedFrom ?? 0) > (existing.mergedFrom ?? 0)) byId.set(e.id, e);
  }
  return Array.from(byId.values());
}
