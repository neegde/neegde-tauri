/**
 * Search store — owns the search engine instance, the active session, and
 * the reactive surface consumers (Results.vue, SearchBar.vue, intent hint)
 * read from. Hides the session-swap dance App.vue used to do inline.
 *
 * Every Entity the engine emits is also `registerEntity`'d in the global
 * registry, so queue / likes / playlists can resolve them by id later.
 */

import { ref, shallowRef, watch } from "vue";
import { createSearchEngine } from "../search/engine.js";
import { registerEntities } from "./entities.js";
import { appDebugLog } from "../appDebugLog.js";

// ── Reactive surface ─────────────────────────────────────────────────────────

/** Current search entities (mix of Track + Album). Results.vue reads this. */
/** @type {import("vue").ShallowRef<Array<import("../types/entities.js").Track | import("../types/entities.js").Album>>} */
export const searchEntities = shallowRef([]);

export const searchLoadingRt = ref(false);
export const searchLoadingSlsk = ref(false);
export const searchRtError = ref(null);
export const searchSlskError = ref(null);
export const searchError = ref(null);

/** Counter for Results.vue to reset infinite-scroll state when the query changes. */
export const searchResultsEpoch = ref(0);

/** True while the Rust resolver is running. */
export const searchResolving = ref(false);

/** Resolver output for the active query — drives the "Распознали как…" hint. */
export const searchResolved = shallowRef(null);

/** Effective query actually sent to providers — usually canonical from resolver. */
export const searchProviderQuery = ref("");

// ── Internals ────────────────────────────────────────────────────────────────

const engine = createSearchEngine({
  log: (tag, msg) => appDebugLog(`search:${tag}`, msg),
});

let _activeSession = null;
let _stopWatcher = null;
/** Monotonic guard so a stale resolver response after a new search started is ignored. */
let _epochSeq = 0;

function _detach() {
  _stopWatcher?.();
  _stopWatcher = null;
  _activeSession = null;
}

function _applyFromSession(session, { rtLoggedIn, slskConnected }) {
  if (_activeSession !== session) return;

  const entities = session.results.value;
  // Register freshly-emitted entities in the global registry so later
  // lookups by id (from queue, likes, playlists) always resolve.
  registerEntities(entities);
  searchEntities.value = entities;

  const ps = session.providerStatus.value;
  searchLoadingRt.value = ps.rutracker === "pending" || ps.rutracker === "streaming";
  searchLoadingSlsk.value = ps.soulseek === "pending" || ps.soulseek === "streaming";

  const pe = session.providerError.value;
  searchRtError.value = pe.rutracker ?? null;
  searchSlskError.value = pe.soulseek ?? null;

  // Empty-state error surfaces only after both providers have settled.
  const stillRunning = searchLoadingRt.value || searchLoadingSlsk.value;
  if (stillRunning) return;
  if (entities.length === 0) {
    if (!rtLoggedIn && !slskConnected) {
      searchError.value = null;
    } else if (searchRtError.value || searchSlskError.value) {
      searchError.value = searchRtError.value ?? searchSlskError.value;
    } else {
      searchError.value = "Ничего не найдено.";
    }
  } else {
    searchError.value = null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a search. `enabled` says which providers are active (rt / slsk);
 * opts.skipResolver forces the raw query to providers (no canonicalization).
 *
 * @param {string} rawQuery
 * @param {{ rtLoggedIn: boolean, slskConnected: boolean }} authFlags
 * @param {{ skipResolver?: boolean }} [opts]
 */
export async function runSearch(rawQuery, authFlags, opts = {}) {
  const trimmed = rawQuery?.trim();
  if (!trimmed) {
    _detach();
    searchEntities.value = [];
    searchRtError.value = null;
    searchSlskError.value = null;
    searchError.value = null;
    searchResolving.value = false;
    searchResolved.value = null;
    return;
  }

  _detach();

  // Preemptive UI state — resolver await below may take up to ~2 s.
  searchLoadingRt.value = Boolean(authFlags.rtLoggedIn);
  searchLoadingSlsk.value = Boolean(authFlags.slskConnected);
  searchEntities.value = [];
  searchResolving.value = true;
  searchResolved.value = null;
  searchRtError.value = null;
  searchSlskError.value = null;
  searchError.value = null;
  searchResultsEpoch.value += 1;

  const epoch = ++_epochSeq;
  let session;
  try {
    session = await engine.query(
      trimmed,
      { rutracker: Boolean(authFlags.rtLoggedIn), soulseek: Boolean(authFlags.slskConnected) },
      { skipResolver: Boolean(opts.skipResolver) },
    );
  } finally {
    if (epoch === _epochSeq) searchResolving.value = false;
  }
  // Another search kicked in during the await — drop this one.
  if (epoch !== _epochSeq) return;

  _activeSession = session;
  searchResolved.value = session.resolved ?? null;
  searchProviderQuery.value = session.query ?? trimmed;

  _stopWatcher = watch(
    [session.results, session.providerStatus, session.providerError],
    () => _applyFromSession(session, authFlags),
    { immediate: true },
  );
}

/** Clear search state without starting a new query. */
export function resetSearch() {
  _detach();
  searchEntities.value = [];
  searchRtError.value = null;
  searchSlskError.value = null;
  searchError.value = null;
  searchResolving.value = false;
  searchResolved.value = null;
  searchProviderQuery.value = "";
}

/** For debugging / external access. Do not mutate. */
export function _debugEngine() {
  return engine;
}
