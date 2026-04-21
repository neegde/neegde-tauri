import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { appDebugLog } from "../appDebugLog.js";

function soulseekCoverPreviewInvoke(username, filepath, filesize) {
  return invoke("soulseek_cover_preview", {
    username,
    filepath,
    filesize: Number(filesize) || 0,
  });
}

/** Max entries — same order of magnitude as RuTracker cover cache. */
const MAX_ENTRIES = 64;
/** Rough cap on retained `data:` string bytes. */
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_SINGLE_BYTES = 4 * 1024 * 1024;

/** @type {Map<string, string | null>} */
const lru = new Map();
/** @type {Map<string, Promise<string | null>>} */
const pending = new Map();

/**
 * Reactive store keyed by `slskCoverKey(username, filepath)` — use `getSlskCoverReactive()`.
 * @type {Map<string, string>}
 */
const _reactive = reactive(new Map());

let totalBytes = 0;

/**
 * Stable cache key for a SoulSeek shared file (cover image).
 *
 * Args:
 *     username: SoulSeek username.
 *     filepath: Full path as in search results.
 *
 * Returns:
 *     Normalized string key.
 */
export function slskCoverKey(username, filepath) {
  return `${String(username)}\n${String(filepath ?? "").replace(/\\/g, "/")}`;
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

function touch(key) {
  const v = lru.get(key);
  if (v === undefined) return undefined;
  lru.delete(key);
  lru.set(key, v);
  return v;
}

/**
 * Synchronous read for already-fetched covers (incl. negative cache: `null`).
 *
 * Returns:
 *     `undefined` if never requested; otherwise data URL or `null`.
 */
export function peekSlskCover(username, filepath) {
  return touch(slskCoverKey(username, filepath));
}

/**
 * Store a cover from another code path (optional).
 *
 * Args:
 *     dataUrl: `data:…` string or null for negative cache.
 */
export function rememberSlskCover(username, filepath, dataUrl) {
  const key = slskCoverKey(username, filepath);
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

  if (normalized) {
    _reactive.set(key, normalized);
  } else {
    _reactive.delete(key);
  }
}

/**
 * Reactive read for Vue: data URL for this user/path, or null if not loaded.
 */
export function getSlskCoverReactive(username, filepath) {
  return _reactive.get(slskCoverKey(username, filepath)) ?? null;
}

export function clearSlskCoverCache() {
  lru.clear();
  pending.clear();
  _reactive.clear();
  totalBytes = 0;
}

/**
 * Cover for grid: cache hit / in-flight dedup / one peer download per key.
 *
 * Returns:
 *     Promise resolving to data URL or null.
 */
export async function getSlskCoverDataUrl(username, filepath, filesize) {
  const key = slskCoverKey(username, filepath);
  const hit = touch(key);
  if (hit !== undefined) return hit;

  let p = pending.get(key);
  if (!p) {
    void appDebugLog("cover", `slsk cover: fetching — user=${username} file=${String(filepath).slice(0, 80)}`);
    p = soulseekCoverPreviewInvoke(username, filepath, filesize)
      .then((r) => {
        const v = r ? `data:${r.mime};base64,${r.base64}` : null;
        void appDebugLog(
          "cover",
          v
            ? `slsk cover: OK — dataUrlLen=${v.length}`
            : "slsk cover: empty response",
        );
        rememberSlskCover(username, filepath, v);
        return v;
      })
      .catch((e) => {
        void appDebugLog("cover", `slsk cover: error — ${String(e)}`);
        rememberSlskCover(username, filepath, null);
        return null;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, p);
  }
  return p;
}
