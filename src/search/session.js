import { ref, shallowRef } from "vue";
import { defaultPipeline, runPipeline } from "./pipeline/index.js";

let _sessionCounter = 0;

/**
 * One search operation. Owns:
 *  - an AbortController shared with all providers
 *  - a per-provider latest snapshot map
 *  - reactive `results`, `status`, `providerStatus`, `providerError`
 *  - a `completed` promise that resolves when every provider has settled
 *
 * Lifecycle:
 *   new SearchSession(q, { providers, pipeline, log })
 *     → status: "streaming"
 *     → providerStatus[kind]: "pending" → "streaming" → "done" | "error"
 *     → results: shallowRef<Entity[]> updated on RAF after each provider snapshot
 *   session.cancel()
 *     → aborts providers, status: "cancelled"
 *   await session.completed
 *     → all providers settled; status is "done" | "cancelled"
 */
export class SearchSession {
  /**
   * @param {string} query                     Query actually sent to providers (canonical if resolved).
   * @param {object} opts
   * @param {import("../types/entities.js").SearchProvider[]} opts.providers
   * @param {import("./pipeline/index.js").PipelineStage[]} [opts.pipeline]
   * @param {(tag: string, msg: string) => void} [opts.log]
   * @param {import("./resolver.js").ResolveResult|null} [opts.resolved]  Resolver output for UI hints & pipeline scoring.
   * @param {string}  [opts.rawQuery]          Original user input, before resolver.
   */
  constructor(query, opts) {
    this.query = query;
    this.rawQuery = opts.rawQuery ?? query;
    this.resolved = opts.resolved ?? null;
    this.requestId = ++_sessionCounter;

    this._pipeline = opts.pipeline ?? defaultPipeline();
    this._log = opts.log ?? (() => {});
    this._abort = new AbortController();

    this.results = shallowRef([]);
    this.status = ref("streaming");
    /** @type {import("vue").Ref<Record<string, import("../types/entities.js").ProviderRunStatus>>} */
    this.providerStatus = ref({});
    /** @type {import("vue").Ref<Record<string, string | null>>} */
    this.providerError = ref({});

    /** @type {Map<string, import("../types/entities.js").Entity[]>} */
    this._snapshots = new Map();
    this._rafPending = false;

    const providers = opts.providers ?? [];
    for (const p of providers) {
      this._snapshots.set(p.kind, []);
      this._setProviderStatus(p.kind, "pending");
    }

    const runs = providers.map((p) => this._runProvider(p));

    // `completed` resolves when every provider iterator has settled.
    // We mark session done / cancelled here; callers can await it.
    this.completed = Promise.allSettled(runs).then(() => {
      if (this.status.value !== "cancelled") this.status.value = "done";
      // Final synchronous flush — RAF debouncing can swallow the last update.
      this._flushImmediate();
    });

    if (providers.length === 0) {
      // Nothing to run — transition straight to done on next microtask.
      this.status.value = "done";
    }
  }

  cancel() {
    if (this._abort.signal.aborted) return;
    this._abort.abort();
    this.status.value = "cancelled";
  }

  _setProviderStatus(kind, s) {
    this.providerStatus.value = { ...this.providerStatus.value, [kind]: s };
  }

  _setProviderError(kind, msg) {
    this.providerError.value = { ...this.providerError.value, [kind]: msg };
  }

  async _runProvider(provider) {
    const ctx = {
      signal: this._abort.signal,
      log: (tag, msg) => this._log(tag, msg),
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
      const msg = err?.message ?? err?.toString?.() ?? String(err);
      this._setProviderError(provider.kind, msg);
      this._setProviderStatus(provider.kind, "error");
      this._log(provider.kind, `provider error: ${msg}`);
    }
  }

  _scheduleFlush() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      if (this._abort.signal.aborted) return;
      this._flushImmediate();
    });
  }

  _flushImmediate() {
    // Snapshots iterate in insertion order, which is provider-declaration order.
    // Within a snapshot, the provider controls ordering. Step 1 does not sort
    // by score (all scores are 0); later the score stage + a sort here will.
    const flat = [];
    for (const snap of this._snapshots.values()) flat.push(...snap);
    this.results.value = runPipeline(flat, this._pipeline);
  }
}
