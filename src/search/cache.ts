/**
 * LRU cache of SearchSession by normalized query key.
 *
 * Holds sessions regardless of status — a re-query while the original
 * is still streaming returns the same live session (consumers subscribe
 * to its reactive `results`, no double-work). Evicted sessions are NOT
 * cancelled; consumers that already captured a reference continue
 * working, we just can't look it up for new callers.
 *
 * Cache key must include anything that changes result identity — at
 * minimum, the query and the enabled-provider set.
 */
export class SessionCache<S = unknown> {
  public max: number;
  private _map: Map<string, S>;

  constructor(max = 30) {
    this.max = max;
    this._map = new Map<string, S>();
  }

  get(key: string): S | undefined {
    const s = this._map.get(key);
    if (s === undefined) return undefined;
    // LRU touch
    this._map.delete(key);
    this._map.set(key, s);
    return s;
  }

  set(key: string, session: S): void {
    if (this._map.has(key)) this._map.delete(key);
    while (this._map.size >= this.max) {
      const oldestKey = this._map.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this._map.delete(oldestKey);
    }
    this._map.set(key, session);
  }

  clear(): void {
    this._map.clear();
  }
}
