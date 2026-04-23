/**
 * Score stage — step 1: no scoring, preserves provider order.
 *
 * Real scoring (weighted: text-match quality, format, bitrate,
 * log(seeders+1), cross-source bonus) lands here later. The session
 * sorts by `score` DESC; for now all scores are 0, so the session
 * falls back to insertion order, which matches today's behavior.
 *
 * @param {import("../../types/entities.js").Entity[]} entities
 * @returns {import("../../types/entities.js").Entity[]}
 */
export function scoreStage(entities) {
  for (const e of entities) e.score = 0;
  return entities;
}
