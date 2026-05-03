/**
 * Persisted Track cache.
 *
 * The *only* place where `TrackData` gets written to disk. Every consumer
 * (likes, playlists, queue, recent history) references tracks by id and
 * reads the data out of this cache. When a track is liked, queued, added to
 * a playlist — we `put(track)` here; persistence is debounced.
 *
 * Rehydrating on boot:
 *   1. Read localStorage → `Map<id, TrackData>`
 *   2. `buildTrack(data)` for each → register in `stores/entities`
 *   3. Consumers that referenced ids now resolve to live Track instances.
 *
 * Eviction: the cache is NOT capped here. Sizes are tiny (Track JSON ~500 B)
 * and the upper bound is user likes + playlist tracks + persisted queue —
 * all human-scale numbers.
 *
 * The class lives in this file (can't split to `TrackCache.ts` on a
 * case-insensitive filesystem). A default singleton `trackCache` is created
 * below; the module-level functions are thin delegates.
 */

import { reactive } from "vue";
import type { Track } from "../track/Track.js";
import type { TrackData, SoulseekTrackRaw } from "../track/types.js";
import { buildTrack } from "../track/factory.js";

export interface TrackCacheOptions {
  /** localStorage key. Override for tests that need isolation. */
  storageKey?: string;
  /** Debounce window for the persistence write. */
  debounceMs?: number;
}

export class TrackCache {
  private readonly _data: Map<string, TrackData> = reactive(new Map());
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _storageKey: string;
  private readonly _debounceMs: number;

  constructor(opts: TrackCacheOptions = {}) {
    this._storageKey = opts.storageKey ?? "neegde.trackCache.v1";
    this._debounceMs = opts.debounceMs ?? 250;
  }

  /** Put a track into the cache (idempotent on identical shape). */
  put(t: Track | TrackData): void {
    const data = this._dataOf(t);
    const prev = this._data.get(data.id);
    if (prev && this._shallowEqual(prev, data)) return;
    this._data.set(data.id, data);
    this._scheduleSave();
  }

  /** Batch variant — one scheduled save at the end instead of per item. */
  putMany(ts: Array<Track | TrackData>): void {
    let changed = false;
    for (const t of ts) {
      const data = this._dataOf(t);
      const prev = this._data.get(data.id);
      if (prev && this._shallowEqual(prev, data)) continue;
      this._data.set(data.id, data);
      changed = true;
    }
    if (changed) this._scheduleSave();
  }

  /** Look up the raw data. */
  get(id: string): TrackData | undefined {
    return this._data.get(id);
  }

  has(id: string): boolean {
    return this._data.has(id);
  }

  remove(id: string): boolean {
    const existed = this._data.delete(id);
    if (existed) this._scheduleSave();
    return existed;
  }

  ids(): string[] {
    return Array.from(this._data.keys());
  }

  /** Wipes in-memory state and the persisted blob. */
  clear(): void {
    this._data.clear();
    try { localStorage.removeItem(this._storageKey); } catch { /* ignore */ }
  }

  /**
   * Synchronously write current cache to localStorage, cancelling any pending
   * debounce timer. Call this when the queue changes so the track data is
   * guaranteed to be on disk before the WebView can be destroyed.
   */
  flush(): void {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      const obj: Record<string, TrackData> = {};
      for (const [k, v] of this._data) obj[k] = v;
      localStorage.setItem(this._storageKey, JSON.stringify(obj));
    } catch { /* quota / disabled storage — ignore */ }
  }

  /** Hydrate a `Track` instance from cache, or `null` when id unknown / malformed. */
  hydrate(id: string): Track | null {
    const data = this._data.get(id);
    if (!data) return null;
    try {
      return buildTrack(data);
    } catch {
      return null;
    }
  }

  /**
   * Load the persisted blob into memory. Call once at startup before any
   * consumer reads `likedTrackIds` / playlists / queue.
   */
  load(): void {
    try {
      const raw = localStorage.getItem(this._storageKey);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, TrackData>;
      for (const id in obj) {
        const v = obj[id];
        if (v && typeof v === "object" && v.id === id) this._data.set(id, v);
      }
    } catch {
      /* corrupt / quota — ignore, start empty */
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private _dataOf(t: Track | TrackData): TrackData {
    return typeof (t as Track).toJSON === "function" ? (t as Track).toJSON() : (t as TrackData);
  }

  private _scheduleSave(): void {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        const obj: Record<string, TrackData> = {};
        for (const [k, v] of this._data) obj[k] = v;
        localStorage.setItem(this._storageKey, JSON.stringify(obj));
      } catch {
        /* quota / disabled storage — ignore */
      }
    }, this._debounceMs);
  }

  private _shallowEqual(a: TrackData, b: TrackData): boolean {
    return (
      a.id === b.id &&
      a.title === b.title &&
      a.artist === b.artist &&
      a.fileName === b.fileName &&
      a.size === b.size &&
      a.bitrate === b.bitrate &&
      a.duration === b.duration &&
      a.format === b.format &&
      a.albumId === b.albumId &&
      (a.coverUrl ?? null) === (b.coverUrl ?? null) &&
      a.sources.length === b.sources.length &&
      a.sources[0]!.kind === b.sources[0]!.kind &&
      !!(a.sources[0]!.raw as SoulseekTrackRaw | undefined)?.cover ===
        !!(b.sources[0]!.raw as SoulseekTrackRaw | undefined)?.cover
    );
  }
}

// ── Default singleton + back-compat delegates ─────────────────────────────────

export const trackCache = new TrackCache();

export function putTrack(t: Track | TrackData): void { trackCache.put(t); }
export function putTracks(ts: Array<Track | TrackData>): void { trackCache.putMany(ts); }
export function getTrackData(id: string): TrackData | undefined { return trackCache.get(id); }
export function hasTrack(id: string): boolean { return trackCache.has(id); }
export function removeTrack(id: string): boolean { return trackCache.remove(id); }
export function allTrackIds(): string[] { return trackCache.ids(); }
export function clearTrackCache(): void { trackCache.clear(); }
export function flushTrackCache(): void { trackCache.flush(); }
export function hydrateTrack(id: string): Track | null { return trackCache.hydrate(id); }
export function loadTrackCache(): void { trackCache.load(); }
