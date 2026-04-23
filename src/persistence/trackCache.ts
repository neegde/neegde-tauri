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
 */

import { reactive } from "vue";
import type { Track } from "../track/Track.js";
import type { TrackData } from "../track/types.js";
import { buildTrack } from "../track/factory.js";

const STORAGE_KEY = "neegde.trackCache.v1";

/** Reactive map so consumers can observe changes (e.g. cover-url updates). */
const _data: Map<string, TrackData> = reactive(new Map());

/** Debounced save handle. */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 250;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const obj: Record<string, TrackData> = {};
      for (const [k, v] of _data) obj[k] = v;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      /* quota / disabled storage — ignore */
    }
  }, SAVE_DEBOUNCE_MS);
}

/** Deterministic serialization for a freshly-registered Track / TrackData. */
function dataOf(t: Track | TrackData): TrackData {
  return typeof (t as Track).toJSON === "function" ? (t as Track).toJSON() : (t as TrackData);
}

/** Put a track into the cache (idempotent on identical shape). */
export function putTrack(t: Track | TrackData): void {
  const data = dataOf(t);
  const prev = _data.get(data.id);
  if (prev && shallowEqualTracks(prev, data)) return;
  _data.set(data.id, data);
  scheduleSave();
}

export function putTracks(ts: Array<Track | TrackData>): void {
  for (const t of ts) {
    const data = dataOf(t);
    const prev = _data.get(data.id);
    if (prev && shallowEqualTracks(prev, data)) continue;
    _data.set(data.id, data);
  }
  scheduleSave();
}

/** Look up the raw data — useful when callers want to re-hydrate manually. */
export function getTrackData(id: string): TrackData | undefined {
  return _data.get(id);
}

/** Hydrate a `Track` instance from cache, or `null` when the id is unknown. */
export function hydrateTrack(id: string): Track | null {
  const data = _data.get(id);
  if (!data) return null;
  try {
    return buildTrack(data);
  } catch {
    return null;
  }
}

export function removeTrack(id: string): boolean {
  const existed = _data.delete(id);
  if (existed) scheduleSave();
  return existed;
}

export function hasTrack(id: string): boolean {
  return _data.has(id);
}

export function allTrackIds(): string[] {
  return Array.from(_data.keys());
}

/** Wipes everything — used by tests and explicit "forget me" actions. */
export function clearTrackCache(): void {
  _data.clear();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/**
 * Load the persisted cache into memory. Call once at app startup before any
 * consumer reads likedTrackIds / playlists / queue, so `hydrateTrack` can
 * resolve them.
 */
export function loadTrackCache(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, TrackData>;
    for (const id in obj) {
      const v = obj[id];
      if (v && typeof v === "object" && v.id === id) _data.set(id, v);
    }
  } catch {
    /* corrupt / quota — ignore, start empty */
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function shallowEqualTracks(a: TrackData, b: TrackData): boolean {
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
    a.sources[0].kind === b.sources[0].kind
  );
}
