import { invoke } from "@tauri-apps/api/core";
import { getMirror } from "./config.js";
import {
  rememberRutrackerCover, getRutrackerCoverDataUrl,
  peekRutrackerCover, getCoverReactive, clearRutrackerCoverCache,
} from "./coverCache.js";

export { getRutrackerCoverDataUrl, peekRutrackerCover, getCoverReactive, clearRutrackerCoverCache };

export interface RutrackerSearchRow {
  id: string | number;
  name?: string;
  category?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  added?: string;
  source?: string;
  [k: string]: unknown;
}

/** Search Rutracker music sections. */
export async function searchMusic(query: string): Promise<RutrackerSearchRow[]> {
  const mirror = getMirror();
  return invoke<RutrackerSearchRow[]>("rutracker_search", { mirror, query });
}

const TOPIC_AUDIO_CHECK_WORKERS = 8;

async function mapPool<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const n = items.length;
  const out: R[] = new Array(n);
  let slot = 0;
  const cap = Math.max(1, Math.min(limit, n));

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = slot;
      slot += 1;
      if (idx >= n) return;
      out[idx] = await mapper(items[idx]!);
    }
  };

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return out;
}

/** Drops rows whose `.torrent` has no playable audio. Kept on RPC error. */
export async function filterRutrackerRowsWithPlayableAudio(
  rows: RutrackerSearchRow[] | null | undefined,
): Promise<RutrackerSearchRow[]> {
  if (!rows?.length) return [];
  const mirror = getMirror();
  const flags = await mapPool(rows, TOPIC_AUDIO_CHECK_WORKERS, (row) =>
    invoke<boolean>("rutracker_topic_has_playable_audio", {
      mirror,
      topicId: String(row.id),
    })
      .then((v) => Boolean(v))
      .catch(() => true),
  );
  return rows.filter((_, j) => flags[j]);
}

// ── Torrent details LRU cache ─────────────────────────────────────────────

export interface TorrentDetails {
  id?: string | number;
  cover_data_url: string | null;
  magnet: string | null;
  files: Array<{ path: string[]; size: number }>;
  artist?: string | null;
  [k: string]: unknown;
}

const _detailsCache = new Map<string, TorrentDetails | Promise<TorrentDetails>>();
const DETAILS_CACHE_MAX = 25;

function _detailsCacheEvict(): void {
  if (_detailsCache.size >= DETAILS_CACHE_MAX) {
    const first = _detailsCache.keys().next().value;
    if (first !== undefined) _detailsCache.delete(first);
  }
}

/** Fetch full torrent details. Dedupes concurrent requests, caches resolved. */
export function getTorrentDetails(topicId: string | number): Promise<TorrentDetails> {
  const key = String(topicId);
  const hit = _detailsCache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);

  const mirror = getMirror();
  const p = invoke<TorrentDetails>("rutracker_get_torrent_details", { mirror, topicId })
    .then((details) => {
      rememberRutrackerCover(topicId, details.cover_data_url ?? null);
      _detailsCacheEvict();
      _detailsCache.set(key, details);
      return details;
    })
    .catch((err) => {
      _detailsCache.delete(key);
      throw err;
    });

  _detailsCacheEvict();
  _detailsCache.set(key, p);
  return p;
}

/** Warm the details cache on hover. Safe to call speculatively. */
export function prefetchTorrentDetails(topicId: string | number): void {
  if (!topicId) return;
  const key = String(topicId);
  if (_detailsCache.has(key)) return;
  getTorrentDetails(topicId).catch(() => {});
}
