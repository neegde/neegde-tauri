/**
 * Persisted Album cache — mirrors `trackCache.ts` for liked albums.
 *
 * Likes v2 stores only `albumIds`; this map holds the `AlbumData` blobs so
 * `hydrateAlbum(id)` can rebuild instances after a cold start.
 */

import { reactive } from "vue";
import type { Album } from "../album/Album.js";
import type { AlbumData } from "../album/types.js";
import { buildAlbum } from "../album/factory.js";

export interface AlbumCacheOptions {
  storageKey?: string;
  debounceMs?: number;
}

export class AlbumCache {
  private readonly _data: Map<string, AlbumData> = reactive(new Map());
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _storageKey: string;
  private readonly _debounceMs: number;

  constructor(opts: AlbumCacheOptions = {}) {
    this._storageKey = opts.storageKey ?? "neegde.albumCache.v1";
    this._debounceMs = opts.debounceMs ?? 250;
  }

  put(a: Album | AlbumData): void {
    const data = this._dataOf(a);
    const prev = this._data.get(data.id);
    if (prev && this._shallowEqual(prev, data)) return;
    this._data.set(data.id, data);
    this._scheduleSave();
  }

  putMany(as: Array<Album | AlbumData>): void {
    let changed = false;
    for (const a of as) {
      const data = this._dataOf(a);
      const prev = this._data.get(data.id);
      if (prev && this._shallowEqual(prev, data)) continue;
      this._data.set(data.id, data);
      changed = true;
    }
    if (changed) this._scheduleSave();
  }

  get(id: string): AlbumData | undefined {
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

  clear(): void {
    this._data.clear();
    try { localStorage.removeItem(this._storageKey); } catch { /* ignore */ }
  }

  hydrate(id: string): Album | null {
    const data = this._data.get(id);
    if (!data) return null;
    try {
      return buildAlbum(data);
    } catch {
      return null;
    }
  }

  load(): void {
    try {
      const raw = localStorage.getItem(this._storageKey);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, AlbumData>;
      for (const id in obj) {
        const v = obj[id];
        if (v && typeof v === "object" && v.type === "album" && v.id === id) this._data.set(id, v);
      }
    } catch {
      /* corrupt / quota */
    }
  }

  private _dataOf(a: Album | AlbumData): AlbumData {
    return typeof (a as Album).toJSON === "function" ? (a as Album).toJSON() : (a as AlbumData);
  }

  private _scheduleSave(): void {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        const obj: Record<string, AlbumData> = {};
        for (const [k, v] of this._data) obj[k] = v;
        localStorage.setItem(this._storageKey, JSON.stringify(obj));
      } catch {
        /* quota */
      }
    }, this._debounceMs);
  }

  private _shallowEqual(a: AlbumData, b: AlbumData): boolean {
    return (
      a.id === b.id &&
      a.title === b.title &&
      (a.artist ?? null) === (b.artist ?? null) &&
      JSON.stringify(a.trackIds) === JSON.stringify(b.trackIds) &&
      JSON.stringify(a.sources) === JSON.stringify(b.sources)
    );
  }
}

export const albumCache = new AlbumCache();

export function putAlbum(a: Album | AlbumData): void {
  albumCache.put(a);
}

export function putAlbums(as: Array<Album | AlbumData>): void {
  albumCache.putMany(as);
}

export function getAlbumData(id: string): AlbumData | undefined {
  return albumCache.get(id);
}

export function hasAlbumInCache(id: string): boolean {
  return albumCache.has(id);
}

export function removeAlbumFromCache(id: string): boolean {
  return albumCache.remove(id);
}

export function allAlbumIds(): string[] {
  return albumCache.ids();
}

export function clearAlbumCache(): void {
  albumCache.clear();
}

export function hydrateAlbum(id: string): Album | null {
  return albumCache.hydrate(id);
}

export function loadAlbumCache(): void {
  albumCache.load();
}
