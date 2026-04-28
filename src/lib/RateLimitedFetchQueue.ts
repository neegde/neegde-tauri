/**
 * RateLimitedFetchQueue — serial task runner with a minimum inter-request gap.
 *
 * Callers enqueue arbitrary inputs and receive a promise. The queue pops one
 * task at a time, waits until at least `intervalMs` has elapsed since the
 * previous task started, then invokes the user-supplied executor. Executor
 * errors reject the individual task — they do NOT halt the queue.
 *
 * Used by external-API adapters that must respect a polite rate limit
 * (MusicBrainz ~1 req/s, iTunes ~1 req/s). Each call site instantiates its
 * own queue with its own interval and executor.
 */

export class RateLimitedFetchQueue<TInput, TResult> {
  private readonly _intervalMs: number;
  private readonly _executor: (input: TInput) => Promise<TResult>;
  private _lastSent = 0;
  private readonly _pending: Array<{
    input: TInput;
    resolve: (v: TResult) => void;
    reject: (e: unknown) => void;
  }> = [];
  private _draining = false;

  constructor(opts: {
    intervalMs: number;
    executor: (input: TInput) => Promise<TResult>;
  }) {
    this._intervalMs = opts.intervalMs;
    this._executor = opts.executor;
  }

  enqueue(input: TInput): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      this._pending.push({ input, resolve, reject });
      if (!this._draining) void this._drain();
    });
  }

  private async _drain(): Promise<void> {
    this._draining = true;
    while (this._pending.length) {
      const gap = this._lastSent + this._intervalMs - Date.now();
      if (gap > 0) await new Promise<void>((r) => setTimeout(r, gap));
      const task = this._pending.shift()!;
      this._lastSent = Date.now();
      try {
        task.resolve(await this._executor(task.input));
      } catch (e) {
        task.reject(e);
      }
    }
    this._draining = false;
  }
}
