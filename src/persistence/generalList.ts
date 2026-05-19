/**
 * General List — debug registry of every track the user has ever seen.
 *
 * Persisted to localStorage under "neegde.generalList.v1". Each entry holds
 * the full TrackData, appearance metadata, logical cache keys, and a snapshot
 * of all related cache states captured at registration time.
 *
 * Callers should use {@link recordGeneralList} for every visible track and
 * {@link refreshGeneralListCache} after cover/enrichment loads complete.
 */

import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { TrackData } from "../track/types.js";
import { buildCacheKeys, probeCache } from "./generalListCacheProbe.js";

// ── Public types ──────────────────────────────────────────────────────────────

export type CacheState = "hit" | "miss" | "unknown";

export interface CacheEntry {
  state: CacheState;
  layer?: string;
  storage?: "localStorage" | "memory" | "rust_disk";
  storageKey?: string;
  payloadHint?: string;
  bytesApprox?: number;
}

export interface GeneralListCacheKeys {
  /** Key used by the persistent trackCache. Equals track.id. */
  trackCacheId: string;
  /** RuTracker cover logical key: "${mirror}\n${topicId}". */
  rutrackerTopicCover?: string;
  /** Deezer track canonical cache key: normalized "artist|title". */
  deezerCanonical?: string;
  /** Deezer album art cache key: "deezer-album-art|artist|album" normalized. */
  deezerAlbumArt?: string;
  /** RuTracker topicId used as the torrent-file B64 localStorage suffix. */
  torrentFileB64?: string;
  streamIdentity?: {
    magnet?: string;
    fileIdx?: number;
    slskUsername?: string;
    slskFilepath?: string;
  };
  /** SoulSeek cover cache key: "${username}\n${filepath}". */
  soulseekCover?: string;
}

export interface GeneralListCache {
  capturedAt: number;
  trackCache: CacheEntry;
  covers?: {
    rutrackerTopic?: CacheEntry;
    soulseekFile?: CacheEntry;
    inlinedOnTrack?: { present: boolean; kind: "data_url" | "https" | "other" };
  };
  enrichment?: {
    deezerCanonical?: CacheEntry;
    deezerAlbumArt?: CacheEntry;
  };
  torrent?: {
    fileListB64?: CacheEntry;
  };
  streaming?: {
    backendDiskCache?: "hit" | "partial" | "unknown" | "na";
    note?: string;
  };
}

export interface GeneralListMeta {
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
  contexts: string[];
  lastContext: string;
  lastSearchQuery?: string;
}

export interface GeneralListEntry {
  id: string;
  track: TrackData;
  meta: GeneralListMeta;
  cacheKeys: GeneralListCacheKeys;
  cache: GeneralListCache;
}

export interface GeneralListFile {
  schemaVersion: 1;
  updatedAt: number;
  entries: Record<string, GeneralListEntry>;
}

// ── Module state ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "neegde.generalList.v1";
const DEBOUNCE_MS = 500;

let _data: GeneralListFile = { schemaVersion: 1, updatedAt: 0, entries: {} };
let _loaded = false;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

// ── Internals ─────────────────────────────────────────────────────────────────

function _ensureLoaded(): void {
  if (_loaded) return;
  _loaded = true;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  // JSON.parse is intentionally unguarded — we only write valid JSON here, so
  // a SyntaxError indicates external corruption (acceptable for debug tooling).
  const parsed = JSON.parse(raw) as unknown;
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    (parsed as GeneralListFile).schemaVersion === 1 &&
    typeof (parsed as GeneralListFile).entries === "object"
  ) {
    _data = parsed as GeneralListFile;
  }
}

function _scheduleSave(): void {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const json = JSON.stringify(_data);
    localStorage.setItem(STORAGE_KEY, json);
    void (invoke("general_list_write", { json }) as Promise<void> | undefined)?.catch(() => {});
  }, DEBOUNCE_MS);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the current in-memory GeneralListFile. Loads from localStorage on
 * first call.
 */
export function loadGeneralList(): GeneralListFile {
  _ensureLoaded();
  return _data;
}

/**
 * Records a track as seen, creating or updating its entry. On update: the
 * track data is replaced with the latest version (which may carry freshly
 * enriched fields), seenCount is incremented, and the cache snapshot is
 * refreshed.
 *
 * @param data - Current TrackData for the track.
 * @param context - Caller context label, e.g. "search_results", "player".
 * @param query - Optional search query string in effect when the track was seen.
 */
export function recordGeneralList(data: TrackData, context: string, query?: string): void {
  _ensureLoaded();
  const now = Date.now();
  const id = data.id;
  const existing = _data.entries[id];
  const cacheKeys = buildCacheKeys(data);
  const cache = probeCache(data, cacheKeys);

  if (existing) {
    const contexts = existing.meta.contexts.includes(context)
      ? existing.meta.contexts
      : [...existing.meta.contexts, context];
    _data.entries[id] = {
      ...existing,
      track: data,
      meta: {
        ...existing.meta,
        lastSeenAt: now,
        seenCount: existing.meta.seenCount + 1,
        contexts,
        lastContext: context,
        ...(query !== undefined ? { lastSearchQuery: query } : {}),
      },
      cacheKeys,
      cache,
    };
  } else {
    _data.entries[id] = {
      id,
      track: data,
      meta: {
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 1,
        contexts: [context],
        lastContext: context,
        ...(query !== undefined ? { lastSearchQuery: query } : {}),
      },
      cacheKeys,
      cache,
    };
  }

  _data.updatedAt = now;
  _scheduleSave();
}

/**
 * Re-probes all caches for an existing entry and overwrites the cache snapshot.
 * Call this after a cover fetch or Deezer enrichment completes.
 *
 * @param id - Track id of the entry to refresh.
 */
export function refreshGeneralListCache(id: string): void {
  _ensureLoaded();
  const existing = _data.entries[id];
  if (!existing) return;
  const cacheKeys = buildCacheKeys(existing.track);
  const cache = probeCache(existing.track, cacheKeys);
  _data.entries[id] = { ...existing, cacheKeys, cache };
  _data.updatedAt = Date.now();
  _scheduleSave();
}

/**
 * Removes an entry from the general list and schedules a save.
 *
 * @param id - Track id to remove.
 */
export function removeGeneralListEntry(id: string): void {
  _ensureLoaded();
  if (!_data.entries[id]) return;
  const { [id]: _removed, ...rest } = _data.entries;
  _data = { ..._data, entries: rest, updatedAt: Date.now() };
  _scheduleSave();
}

/** Wipes the in-memory state and removes the localStorage key. For tests. */
export function clearGeneralList(): void {
  _data = { schemaVersion: 1, updatedAt: 0, entries: {} };
  _loaded = false;
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  localStorage.removeItem(STORAGE_KEY);
}

/** Flushes any pending debounced save: writes to localStorage and disk. */
export function flushGeneralList(): void {
  if (!_saveTimer) return;
  clearTimeout(_saveTimer);
  _saveTimer = null;
  const json = JSON.stringify(_data);
  localStorage.setItem(STORAGE_KEY, json);
  void (invoke("general_list_write", { json }) as Promise<void> | undefined)?.catch(() => {});
}

/**
 * Opens the folder containing the General List file in the system file
 * manager. Resolves the path via the Rust backend first.
 */
export async function revealGeneralListFile(): Promise<void> {
  const filePath = await invoke<string>("general_list_path");
  await openPath(filePath);
}
