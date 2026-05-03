/**
 * Score stage — step 1: no scoring, preserves provider order.
 *
 * Real scoring (weighted: text-match quality, format, bitrate,
 * log(seeders+1), cross-source bonus) lands here later. The session
 * sorts by `score` DESC; for now all scores are 0, so the session
 * falls back to insertion order, which matches today's behavior.
 */
export function scoreStage<T extends { score?: number }>(entities: T[]): T[] {
  for (const e of entities) e.score = 0;
  return entities;
}
