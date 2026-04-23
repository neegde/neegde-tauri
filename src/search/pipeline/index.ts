import { normalizeStage } from "./normalize.js";
import { dedupStage } from "./dedup.js";
import { scoreStage } from "./score.js";
import { filterStage } from "./filter.js";

export type PipelineEntity = { id: string; score?: number; mergedFrom?: number };

export type PipelineStage<T extends PipelineEntity = PipelineEntity> =
  (entities: T[], opts?: Record<string, unknown>) => T[];

/**
 * The default pipeline. Order matters: normalize → dedup → score → filter.
 */
export function defaultPipeline<T extends PipelineEntity = PipelineEntity>(): PipelineStage<T>[] {
  return [
    normalizeStage as PipelineStage<T>,
    dedupStage as PipelineStage<T>,
    scoreStage as PipelineStage<T>,
    filterStage as PipelineStage<T>,
  ];
}

/** Run a flat list through a pipeline; `opts` forwarded verbatim to each stage. */
export function runPipeline<T extends PipelineEntity>(
  entities: T[],
  stages: PipelineStage<T>[],
  opts?: Record<string, unknown>,
): T[] {
  let out = entities;
  for (const stage of stages) out = stage(out, opts);
  return out;
}
