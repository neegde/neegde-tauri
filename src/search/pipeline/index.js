import { normalizeStage } from "./normalize.js";
import { dedupStage } from "./dedup.js";
import { scoreStage } from "./score.js";
import { filterStage } from "./filter.js";

/**
 * A pipeline is an ordered list of stage functions. Each stage takes
 * `Entity[]` and returns `Entity[]`. Stages MAY mutate entities
 * in place (score assignment does) but MUST NOT hold references across
 * invocations — the session calls `runPipeline` fresh on every flush.
 *
 * @typedef {(entities: import("../../types/entities.js").Entity[], opts?: object) => import("../../types/entities.js").Entity[]} PipelineStage
 */

/**
 * The default pipeline. Order matters: normalize → dedup → score → filter.
 * Callers (engine, tests) can build a custom pipeline by passing a
 * different array of stages.
 *
 * @returns {PipelineStage[]}
 */
export function defaultPipeline() {
  return [normalizeStage, dedupStage, scoreStage, filterStage];
}

/**
 * Run a flat list of candidates through a pipeline. `opts` is forwarded
 * verbatim to each stage — stages ignore keys they don't care about.
 *
 * @param {import("../../types/entities.js").Entity[]} entities
 * @param {PipelineStage[]} stages
 * @param {object} [opts]
 * @returns {import("../../types/entities.js").Entity[]}
 */
export function runPipeline(entities, stages, opts) {
  let out = entities;
  for (const stage of stages) out = stage(out, opts);
  return out;
}
