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
 * minimum, the query and the enabled-provider set. Login state changes
 * change the enabled set, so a re-login → re-search will miss cache.
 */
export class SessionCache {
  /**
   * @param {number} [max] Default 30.
   */
  constructor(max = 30) {
    this.max = max;
    /** @type {Map<string, import("./session.js").SearchSession>} */
    this._map = new Map();
  }

  get(key) {
    const s = this._map.get(key);
    if (s === undefined) return undefined;
    // LRU touch
    this._map.delete(key);
    this._map.set(key, s);
    return s;
  }

  set(key, session) {
    if (this._map.has(key)) this._map.delete(key);
    while (this._map.size >= this.max) {
      const oldestKey = this._map.keys().next().value;
      this._map.delete(oldestKey);
    }
    this._map.set(key, session);
  }

  clear() {
    this._map.clear();
  }
}
