/**
 * Search store — owns the search engine instance, the active session, and
 * the reactive surface consumers (Results.vue, SearchBar.vue, intent hint)
 * read from. Hides the session-swap dance App.vue used to do inline.
 *
 * Every Entity the engine emits is also `registerEntity`'d in the global
 * registry, so queue / likes / playlists can resolve them by id later.
 */

import { ref, shallowRef, watch, type WatchStopHandle } from "vue";
import { createSearchEngine, type SearchEngine } from "../search/engine.js";
import type { SearchSession } from "../search/session.js";
import { registerEntities, type Entity, type AlbumData } from "./entities.js";
import type { Track } from "../track/Track.js";
import type { TrackData } from "../track/types.js";
import { appDebugLog } from "../appDebugLog.js";

// ── Reactive surface ─────────────────────────────────────────────────────────

export const searchEntities = shallowRef<Entity[]>([]);

export const searchLoadingRt = ref<boolean>(false);
export const searchLoadingSlsk = ref<boolean>(false);
export const searchRtError = ref<string | null>(null);
export const searchSlskError = ref<string | null>(null);
export const searchError = ref<string | null>(null);

/** Counter for Results.vue to reset infinite-scroll state when the query changes. */
export const searchResultsEpoch = ref<number>(0);

/** True while the Rust resolver is running. */
export const searchResolving = ref<boolean>(false);

export const searchResolved = shallowRef<unknown>(null);

/** Effective query actually sent to providers — usually canonical from resolver. */
export const searchProviderQuery = ref<string>("");

// ── Internals ────────────────────────────────────────────────────────────────

const engine: SearchEngine = createSearchEngine({
  log: (tag: string, msg: string) => appDebugLog(`search:${tag}`, msg),
});

let _activeSession: SearchSession | null = null;
let _stopWatcher: WatchStopHandle | null = null;
/** Monotonic guard so a stale resolver response after a new search started is ignored. */
let _epochSeq = 0;

function _detach(): void {
  _stopWatcher?.();
  _stopWatcher = null;
  _activeSession = null;
}

function _applyFromSession(session: SearchSession, authFlags: { rtLoggedIn: boolean; slskConnected: boolean }): void {
  if (_activeSession !== session) return;

  const entities = session.results.value as Array<Track | TrackData | AlbumData>;
  searchEntities.value = registerEntities(entities);

  const ps = session.providerStatus.value;
  searchLoadingRt.value = ps.rutracker === "pending" || ps.rutracker === "streaming";
  searchLoadingSlsk.value = ps.soulseek === "pending" || ps.soulseek === "streaming";

  const pe = session.providerError.value;
  searchRtError.value = pe.rutracker ?? null;
  searchSlskError.value = pe.soulseek ?? null;

  const stillRunning = searchLoadingRt.value || searchLoadingSlsk.value;
  if (stillRunning) return;
  if (entities.length === 0) {
    if (!authFlags.rtLoggedIn && !authFlags.slskConnected) {
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
 * Run a search. `authFlags` says which providers are active;
 * `opts.skipResolver` forces the raw query to providers (no canonicalization).
 */
export async function runSearch(
  rawQuery: string | null | undefined,
  authFlags: { rtLoggedIn: boolean; slskConnected: boolean },
  opts: { skipResolver?: boolean } = {},
): Promise<void> {
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
  let session: SearchSession;
  try {
    session = await engine.query(
      trimmed,
      { rutracker: Boolean(authFlags.rtLoggedIn), soulseek: Boolean(authFlags.slskConnected) },
      { skipResolver: Boolean(opts.skipResolver) },
    );
  } finally {
    if (epoch === _epochSeq) searchResolving.value = false;
  }
  if (epoch !== _epochSeq) return;

  _activeSession = session;
  searchResolved.value = session.resolved ?? null;
  // Empty string from the resolver means "no canonicalization"; treat it like
  // missing and fall back to the user's trimmed input rather than blanking
  // the effective query in UI.
  searchProviderQuery.value = session.query || trimmed;

  _stopWatcher = watch(
    [session.results, session.providerStatus, session.providerError],
    () => _applyFromSession(session, authFlags),
    { immediate: true },
  );
}

/** Clear search state without starting a new query. */
export function resetSearch(): void {
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
export function _debugEngine(): SearchEngine {
  return engine;
}
