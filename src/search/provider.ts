/**
 * Abstract base class for search providers.
 *
 * Each provider implements `search()` as an async generator yielding
 * progressive snapshots of `PipelineEntity[]`. The SearchSession drives the
 * generator and merges its output into the shared results state.
 *
 * Subclasses set `kind` to their literal provider id. The base class exposes
 * a `log()` helper that tag-prefixes messages with `kind`, so implementations
 * don't have to repeat the provider name on every call.
 */

import type { PipelineEntity } from "./pipeline/index.js";

export type ProviderKind = "rutracker" | "soulseek";

export interface SearchProviderCtx {
  signal: AbortSignal;
  log: (tag: string, msg: string) => void;
  requestId: number;
}

export abstract class SearchProvider {
  abstract readonly kind: string;

  abstract search(
    query: string,
    ctx: SearchProviderCtx,
  ): AsyncGenerator<PipelineEntity[]>;

  /** Emit a log line tagged with this provider's kind. */
  protected log(ctx: SearchProviderCtx, msg: string): void {
    ctx.log(this.kind, msg);
  }
}
