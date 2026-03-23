import { invoke } from "@tauri-apps/api/core";
import { getMirror } from "./config.js";

/** Max entries — only covers that were actually loaded (see IntersectionObserver in UI). */
const MAX_ENTRIES = 64;
/** Rough cap on retained `data:` string bytes (URLs are ~4/3 of raw image size). */
const MAX_BYTES = 12 * 1024 * 1024;
/** Do not cache a single payload larger than this (still returned to the caller). */
const MAX_SINGLE_BYTES = 4 * 1024 * 1024;

/** @type {Map<string, string | null>} */
const lru = new Map();
/** @type {Map<string, Promise<string | null>>} */
const pending = new Map();

let totalBytes = 0;

function cacheKey(topicId) {
  return `${getMirror()}\n${String(topicId)}`;
}

function entryBytes(v) {
  return v == null ? 0 : v.length;
}

function evictOldest() {
  const first = lru.keys().next().value;
  if (first === undefined) return;
  totalBytes -= entryBytes(lru.get(first));
  lru.delete(first);
}

/**
 * Move entry to MRU position (end of Map).
 * @returns {string | null | undefined} undefined if missing
 */
function touch(key) {
  const v = lru.get(key);
  if (v === undefined) return undefined;
  lru.delete(key);
  lru.set(key, v);
  return v;
}

/**
 * Synchronous read for already-fetched covers (incl. negative cache: `null`).
 * @returns {string | null | undefined}
 */
export function peekRutrackerCover(topicId) {
  return touch(cacheKey(topicId));
}

/**
 * Store a cover from another code path (e.g. full torrent details).
 * @param {string | null | undefined} dataUrl
 */
export function rememberRutrackerCover(topicId, dataUrl) {
  const key = cacheKey(topicId);
  const normalized = dataUrl == null ? null : dataUrl;
  const b = entryBytes(normalized);
  if (b > MAX_SINGLE_BYTES) return;

  if (lru.has(key)) {
    totalBytes -= entryBytes(lru.get(key));
    lru.delete(key);
  }
  while (lru.size > 0 && (lru.size >= MAX_ENTRIES || totalBytes + b > MAX_BYTES)) {
    evictOldest();
  }
  lru.set(key, normalized);
  totalBytes += b;
}

export function clearRutrackerCoverCache() {
  lru.clear();
  pending.clear();
  totalBytes = 0;
}

/**
 * Cover for grid: cache hit / in-flight dedup / network only once per topic per mirror.
 * @returns {Promise<string | null>}
 */
export async function getRutrackerCoverDataUrl(topicId) {
  const key = cacheKey(topicId);
  const hit = touch(key);
  if (hit !== undefined) return hit;

  let p = pending.get(key);
  if (!p) {
    const mirror = getMirror();
    p = invoke("rutracker_get_cover", { mirror, topicId: String(topicId) })
      .then((u) => {
        rememberRutrackerCover(topicId, u ?? null);
        return u ?? null;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, p);
  }
  return p;
}
