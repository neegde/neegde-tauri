/**
 * useSearchUI — owns UI-local search state (current query text, home-vs-recent
 * toggle, per-peer filter) and wraps `runSearch` / `resetSearch` with the
 * App.vue navigation-reset side effects.
 *
 * The search *results* stream itself lives in `src/stores/search.ts`; this
 * composable just manages the input side and the view-resetting glue around
 * `runSearch`. Callers from outside the composable (e.g. sidebar "home",
 * peer-browse navigation) can freely mutate the exposed refs.
 */

import { ref, computed, type Ref, type ComputedRef } from "vue";
import {
  runSearch,
  resetSearch,
  searchEntities,
  searchError,
  searchLoadingRt,
  searchLoadingSlsk,
} from "../stores/search.js";
import { addToSearchHistory } from "../lib/searchHistory.js";
import { appDebugLog } from "../appDebugLog.js";

export interface UseSearchUIOptions {
  /**
   * Reset the main-pane view (selected/files/torrentCover + back/forward
   * stacks) before / after a search. Called on every `handleSearch(query)`:
   * both the empty-query short-circuit and the normal path.
   */
  resetViewForSearch: () => void;
  /** Current auth flags — consulted at each handleSearch invocation. */
  authFlags: () => { rtLoggedIn: boolean; slskConnected: boolean };
  /** Search history ref — updated on non-empty queries via addToSearchHistory. */
  searchHistory: Ref<string[]>;
}

export interface UseSearchUIApi {
  searchQuery: Ref<string>;
  homeSearchActive: Ref<boolean>;
  slskPeerBrowseUser: Ref<string | null>;
  loading: ComputedRef<boolean>;
  hasSearchResults: ComputedRef<boolean>;
  /** Alias of the search store's error ref; exposed for UI convenience. */
  error: Ref<string | null>;
  handleSearch: (query: string, opts?: { skipResolver?: boolean }) => Promise<void>;
  handleRevertToRaw: () => Promise<void>;
  handleSearchCandidate: (cand: { artist: string; title?: string | null }) => Promise<void>;
}

export function useSearchUI(opts: UseSearchUIOptions): UseSearchUIApi {
  const searchQuery = ref<string>("");
  const homeSearchActive = ref<boolean>(false);
  const slskPeerBrowseUser = ref<string | null>(null);

  const loading = computed<boolean>(
    () => searchLoadingRt.value || searchLoadingSlsk.value,
  );
  const hasSearchResults = computed<boolean>(() => searchEntities.value.length > 0);

  async function handleSearch(
    query: string,
    searchOpts: { skipResolver?: boolean } = {},
  ): Promise<void> {
    if (!query?.trim()) {
      resetSearch();
      homeSearchActive.value = false;
      slskPeerBrowseUser.value = null;
      opts.resetViewForSearch();
      return;
    }
    homeSearchActive.value = true;
    const q = query.trim();
    const qn = q.toLowerCase();
    if (slskPeerBrowseUser.value) {
      const pu = String(slskPeerBrowseUser.value).trim().toLowerCase();
      if (qn !== pu) slskPeerBrowseUser.value = null;
    }
    opts.resetViewForSearch();

    opts.searchHistory.value = addToSearchHistory(q);

    const flags = opts.authFlags();
    await runSearch(
      q,
      { rtLoggedIn: flags.rtLoggedIn, slskConnected: flags.slskConnected },
      { skipResolver: Boolean(searchOpts.skipResolver) },
    );
    appDebugLog("search", `query "${q}": dispatched`);
  }

  /** «Искать как строку» — повторяем текущий запрос минуя резолвер. */
  async function handleRevertToRaw(): Promise<void> {
    const q = searchQuery.value;
    if (!q?.trim()) return;
    await handleSearch(q, { skipResolver: true });
  }

  /**
   * Run a fresh search for one of the resolver's alternate candidates.
   *
   * Builds an `"Artist - Title"` (or just `"Artist"` for artist-only candidates)
   * string and dispatches it with the resolver bypassed — the user already
   * picked the canonical pair, so a second normalization round would only
   * obscure it.
   *
   * Args:
   *   cand: A `{artist, title}` pair as emitted by `SearchIntentHint`.
   */
  async function handleSearchCandidate(
    cand: { artist: string; title?: string | null },
  ): Promise<void> {
    const artist = String(cand?.artist ?? "").trim();
    if (!artist) return;
    const title = String(cand?.title ?? "").trim();
    const q = title ? `${artist} - ${title}` : artist;
    searchQuery.value = q;
    await handleSearch(q, { skipResolver: true });
  }

  return {
    searchQuery,
    homeSearchActive,
    slskPeerBrowseUser,
    loading,
    hasSearchResults,
    error: searchError,
    handleSearch,
    handleRevertToRaw,
    handleSearchCandidate,
  };
}
