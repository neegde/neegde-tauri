import { ref, shallowRef, type Ref, type ShallowRef } from "vue";
import { defaultPipeline, runPipeline, type PipelineStage, type PipelineEntity } from "./pipeline/index.js";
import type { ResolveResult } from "./resolver.js";

let _sessionCounter = 0;

export type ProviderStatus = "pending" | "streaming" | "done" | "error";

export interface SearchProviderCtx {
  signal: AbortSignal;
  log: (tag: string, msg: string) => void;
  requestId: number;
}

export interface SearchProvider {
  kind: string;
  search: (query: string, ctx: SearchProviderCtx) => AsyncGenerator<PipelineEntity[]>;
}

export interface SearchSessionOptions {
  providers: SearchProvider[];
  pipeline?: PipelineStage[];
  log?: (tag: string, msg: string) => void;
  resolved?: ResolveResult | null;
  rawQuery?: string;
}

/**
 * One search operation. Owns:
 *  - an AbortController shared with all providers
 *  - a per-provider latest snapshot map
 *  - reactive `results`, `status`, `providerStatus`, `providerError`
 *  - a `completed` promise that resolves when every provider has settled
 */
export class SearchSession {
  public readonly query: string;
  public readonly rawQuery: string;
  public readonly resolved: ResolveResult | null;
  public readonly requestId: number;
  public readonly results: ShallowRef<PipelineEntity[]>;
  public readonly status: Ref<"streaming" | "done" | "cancelled">;
  public readonly providerStatus: Ref<Record<string, ProviderStatus>>;
  public readonly providerError: Ref<Record<string, string | null>>;
  public readonly completed: Promise<void>;

  private readonly _pipeline: PipelineStage[];
  private readonly _log: (tag: string, msg: string) => void;
  private readonly _abort: AbortController;
  private readonly _snapshots: Map<string, PipelineEntity[]>;
  private _rafPending: boolean;

  constructor(query: string, opts: SearchSessionOptions) {
    this.query = query;
    this.rawQuery = opts.rawQuery ?? query;
    this.resolved = opts.resolved ?? null;
    this.requestId = ++_sessionCounter;

    this._pipeline = opts.pipeline ?? defaultPipeline();
    this._log = opts.log ?? (() => {});
    this._abort = new AbortController();

    this.results = shallowRef<PipelineEntity[]>([]);
    this.status = ref<"streaming" | "done" | "cancelled">("streaming");
    this.providerStatus = ref<Record<string, ProviderStatus>>({});
    this.providerError = ref<Record<string, string | null>>({});

    this._snapshots = new Map<string, PipelineEntity[]>();
    this._rafPending = false;

    const providers = opts.providers ?? [];
    for (const p of providers) {
      this._snapshots.set(p.kind, []);
      this._setProviderStatus(p.kind, "pending");
    }

    const runs = providers.map((p) => this._runProvider(p));

    this.completed = Promise.allSettled(runs).then(() => {
      if (this.status.value !== "cancelled") this.status.value = "done";
      this._flushImmediate();
    });

    if (providers.length === 0) {
      this.status.value = "done";
    }
  }

  cancel(): void {
    if (this._abort.signal.aborted) return;
    this._abort.abort();
    this.status.value = "cancelled";
  }

  private _setProviderStatus(kind: string, s: ProviderStatus): void {
    this.providerStatus.value = { ...this.providerStatus.value, [kind]: s };
  }

  private _setProviderError(kind: string, msg: string | null): void {
    this.providerError.value = { ...this.providerError.value, [kind]: msg };
  }

  private async _runProvider(provider: SearchProvider): Promise<void> {
    const ctx: SearchProviderCtx = {
      signal: this._abort.signal,
      log: (tag: string, msg: string) => this._log(tag, msg),
      requestId: this.requestId,
    };

    try {
      for await (const snapshot of provider.search(this.query, ctx)) {
        if (this._abort.signal.aborted) break;
        this._snapshots.set(provider.kind, snapshot);
        this._setProviderStatus(provider.kind, "streaming");
        this._scheduleFlush();
      }
      if (!this._abort.signal.aborted) this._setProviderStatus(provider.kind, "done");
    } catch (err) {
      if (this._abort.signal.aborted) return;
      const msg = (err as { message?: string })?.message ?? String(err);
      this._setProviderError(provider.kind, msg);
      this._setProviderStatus(provider.kind, "error");
      this._log(provider.kind, `provider error: ${msg}`);
    }
  }

  private _scheduleFlush(): void {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      if (this._abort.signal.aborted) return;
      this._flushImmediate();
    });
  }

  private _flushImmediate(): void {
    const flat: PipelineEntity[] = [];
    for (const snap of this._snapshots.values()) flat.push(...snap);
    this.results.value = runPipeline(flat, this._pipeline);
  }
}
