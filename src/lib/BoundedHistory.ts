/**
 * BoundedHistory<T> — a FIFO-like list persisted in localStorage, capped at
 * a maximum size, with unique entries.
 *
 * Shared base for the two history collections:
 *   - `recentHistory` — torrent entries (id-keyed)
 *   - `searchHistory` — raw query strings (self-keyed)
 *
 * All mutating operations commit to localStorage immediately. Each call
 * re-reads / re-writes the whole array — the bound is small (≤20) so the
 * cost is negligible.
 */

export interface BoundedHistoryOptions<T> {
  storageKey: string;
  max: number;
  /** Identity used for dedup on add / target match on remove. */
  keyOf: (entry: T) => string;
  /** Optional hook that shapes an entry before it's stored (e.g. stamping openedAt). */
  stamp?: (entry: T) => T;
  /** Runtime shape guard — discards parsed entries that fail validation. */
  isValid?: (value: unknown) => value is T;
}

export class BoundedHistory<T> {
  private readonly _storageKey: string;
  private readonly _max: number;
  private readonly _keyOf: (entry: T) => string;
  private readonly _stamp: (entry: T) => T;
  private readonly _isValid: (value: unknown) => value is T;

  constructor(opts: BoundedHistoryOptions<T>) {
    this._storageKey = opts.storageKey;
    this._max = opts.max;
    this._keyOf = opts.keyOf;
    this._stamp = opts.stamp ?? ((e) => e);
    this._isValid = opts.isValid ?? ((v): v is T => v != null);
  }

  load(): T[] {
    try {
      const raw = localStorage.getItem(this._storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(this._isValid);
    } catch {
      return [];
    }
  }

  /** Push entry to the front, dedup by key, clamp to max. Returns the new list. */
  add(entry: T): T[] {
    const key = this._keyOf(entry);
    const stamped = this._stamp(entry);
    const history = this.load().filter((h) => this._keyOf(h) !== key);
    history.unshift(stamped);
    const clamped = history.slice(0, this._max);
    this._save(clamped);
    return clamped;
  }

  /** Remove by key. Returns the new list. */
  remove(key: string): T[] {
    const history = this.load().filter((h) => this._keyOf(h) !== key);
    this._save(history);
    return history;
  }

  private _save(list: T[]): void {
    try {
      localStorage.setItem(this._storageKey, JSON.stringify(list));
    } catch {
      /* quota / disabled — ignore */
    }
  }
}
