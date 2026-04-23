import { invoke } from "@tauri-apps/api/core";
import { reactive, ref } from "vue";
import { getMirror } from "./config.js";
import { appDebugLog } from "../appDebugLog.js";

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

/**
 * Reactive store keyed by raw topicId — Vue components read from this via getCoverReactive().
 * Updated whenever rememberRutrackerCover() stores a successful cover.
 * @type {Map<string, string>}
 */
const _reactive = reactive(new Map());

let totalBytes = 0;

/**
 * Auth state gate for Rutracker cover fetches.
 *
 * "unknown" — before `restoreSession` / login has resolved. Fetches wait here so
 *             we don't spam the backend with "Необходимо войти" errors during
 *             the startup race window.
 * "in"      — user is authenticated; fetches proceed normally.
 * "out"     — user is confirmed not logged in; fetches short-circuit to null
 *             (no backend call, no negative-cache poisoning).
 *
 * @type {import("vue").Ref<"unknown" | "in" | "out">}
 */
const authState = ref("unknown");

/**
 * Counter bumped when auth transitions "out"/"unknown" → "in". CoverThumb
 * watches this so its IntersectionObserver can be re-attached after a failed
 * pre-auth render (the observer disconnects on first intersection and wouldn't
 * otherwise retry once auth becomes available).
 *
 * @type {import("vue").Ref<number>}
 */
export const rutrackerCoverFetchEpoch = ref(0);

/** Pending awaiters for the auth gate to leave "unknown". */
let authGateWaiters = [];

/**
 * Update the current auth state gate.
 *
 * Arguments:
 *     state: "unknown" | "in" | "out" — latest known Rutracker auth state.
 */
export function setRutrackerAuthState(state) {
  const prev = authState.value;
  if (prev === state) return;
  authState.value = state;

  if (state !== "unknown") {
    const waiters = authGateWaiters;
    authGateWaiters = [];
    for (const resolve of waiters) resolve();
  }

  if (state === "in" && prev !== "in") {
    // Wake up CoverThumbs that gave up pre-auth so their observers re-attach.
    rutrackerCoverFetchEpoch.value += 1;
  }
}

function waitForAuthResolved() {
  if (authState.value !== "unknown") return Promise.resolve();
  return new Promise((resolve) => { authGateWaiters.push(resolve); });
}

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

  // Sync to reactive store so Vue components auto-update
  const tid = String(topicId);
  if (normalized) {
    _reactive.set(tid, normalized);
  } else {
    _reactive.delete(tid);
  }
}

/**
 * Reactive read for Vue components: returns the cover data URL for topicId,
 * or null if not yet loaded. Reading this inside a computed/watchEffect is tracked.
 * @param {string | number} topicId
 * @returns {string | null}
 */
export function getCoverReactive(topicId) {
  return _reactive.get(String(topicId)) ?? null;
}

export function clearRutrackerCoverCache() {
  lru.clear();
  pending.clear();
  _reactive.clear();
  totalBytes = 0;
}

/** True when the err message from backend means the call hit the auth gate. */
function isNotLoggedInError(err) {
  const m = String(err?.message || err || "");
  return m.includes("Необходимо войти");
}

/**
 * Cover for grid: cache hit / in-flight dedup / network only once per topic per mirror.
 *
 * If the auth state is still "unknown" (startup race with `restoreSession`), the
 * call awaits the gate so we don't poison the cache with null entries that
 * would stick around long after the user actually logged in. If auth is "out",
 * we short-circuit to null without touching the backend or the cache.
 *
 * Returns:
 *     Promise resolving to a data-URL string or null when no cover is available.
 */
export async function getRutrackerCoverDataUrl(topicId) {
  const key = cacheKey(topicId);
  const hit = touch(key);
  if (hit !== undefined) return hit;

  await waitForAuthResolved();
  if (authState.value !== "in") return null;

  let p = pending.get(key);
  if (!p) {
    const mirror = getMirror();
    void appDebugLog("cover", `rutracker cover: fetching — topicId=${topicId} mirror=${mirror}`);
    p = invoke("rutracker_get_cover", { mirror, topicId: String(topicId) })
      .then((u) => {
        const v = u ?? null;
        void appDebugLog(
          "cover",
          v
            ? `rutracker cover: OK — topicId=${topicId} dataUrlLen=${v.length}`
            : `rutracker cover: not found — topicId=${topicId} (server returned null/empty)`,
        );
        rememberRutrackerCover(topicId, v);
        return v;
      })
      .catch((e) => {
        void appDebugLog("cover", `rutracker cover: error — topicId=${topicId} err=${String(e)}`);
        // Do not negative-cache auth errors — the user may be about to log in,
        // and we want the retry triggered by the CoverThumb epoch to succeed.
        if (!isNotLoggedInError(e)) {
          rememberRutrackerCover(topicId, null);
        }
        return null;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, p);
  }
  return p;
}
