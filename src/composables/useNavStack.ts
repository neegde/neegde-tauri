/**
 * Back/forward navigation stacks with rich snapshot payloads.
 *
 * Modeled after Spotify / browser history: one linear stack of screen
 * identities. Each navigation pushes the previous screen onto `backStack`
 * and clears `forwardStack`; Back/Forward are symmetric — each pushes the
 * current screen onto the opposite stack before applying the popped one.
 *
 * Every top-level surface participates: home (search / torrent / album),
 * likes, settings, and individual playlists. The album-preview mid-step
 * (album scope inside an open torrent) is the one entry that is *not*
 * a top-level screen — it's an intra-screen drill-down popped by the
 * first Back press before the cross-screen stack is touched.
 */

import { ref, type Ref } from "vue";
import type { FileRow } from "../lib/utils.js";

interface TorrentLike {
  id?: string | number;
  source?: string;
  name?: string;
  artist?: string | null;
  [k: string]: unknown;
}

type NavEntry =
  | {
      type: "search";
      searchQuery: string;
      resultsEntities: unknown[];
      error: string | null;
      slskPeerBrowseUser: string | null;
      searchResultsTab: "tracks" | "albums";
    }
  | {
      type: "torrent"; selected: TorrentLike; files: FileRow[];
      magnet: string; cover: string | null;
      torrentFilesBeforeAlbumPreview: FileRow[] | null;
      torrentSelectedBeforeAlbumPreview: TorrentLike | null;
      restoreLikesView?: boolean;
    }
  | { type: "album"; album: object | null; restoreLikesView?: boolean }
  | { type: "album-preview"; files: FileRow[]; selected: TorrentLike; magnet: string; cover: string | null; fullFiles: FileRow[] | null; fullSelected: TorrentLike | null }
  | { type: "likes" }
  | { type: "settings" }
  | { type: "playlist"; playlistId?: string | null };

/** Top-level view names a sidebar / direct nav can target. */
export type TopLevelView = "home" | "likes" | "settings" | "playlist";

export interface UseNavStackCtx {
  selected: Ref<TorrentLike | null>;
  files: Ref<FileRow[]>;
  torrentMagnet: Ref<string>;
  torrentCover: Ref<string | null>;
  torrentFilesBeforeAlbumPreview: Ref<FileRow[] | null>;
  torrentSelectedBeforeAlbumPreview: Ref<TorrentLike | null>;
  currentAlbum: Ref<object | null>;
  view: Ref<string>;
  returnView: Ref<string>;
  currentPlaylistId: Ref<string | null>;
  searchQuery: Ref<string>;
  searchEntities: Ref<unknown[]>;
  slskPeerBrowseUser: Ref<string | null>;
  searchResultsTab: Ref<"tracks" | "albums">;
  error: Ref<string | null>;
  mainRef: Ref<HTMLElement | null>;
  /**
   * Optional external refs — lets other composables share the same stacks so
   * mutations (push on navigate, reset on fresh search) stay in sync across
   * all callers.
   */
  backStack?: Ref<NavEntry[]>;
  forwardStack?: Ref<NavEntry[]>;
}

export function useNavStack(ctx: UseNavStackCtx) {
  const forwardStack = ctx.forwardStack ?? ref<NavEntry[]>([]);
  const backStack = ctx.backStack ?? ref<NavEntry[]>([]);

  function scrollMainToTop(): void {
    if (ctx.mainRef.value) ctx.mainRef.value.scrollTo(0, 0);
  }

  function snapshotSearchForBack(): NavEntry {
    return {
      type: "search",
      searchQuery: ctx.searchQuery.value,
      resultsEntities: [...ctx.searchEntities.value],
      error: ctx.error.value,
      slskPeerBrowseUser: ctx.slskPeerBrowseUser.value,
      searchResultsTab: ctx.searchResultsTab.value,
    };
  }

  function snapshotTorrentForBack(): NavEntry {
    return {
      type: "torrent",
      selected: { ...(ctx.selected.value ?? {}) },
      files: [...ctx.files.value],
      magnet: ctx.torrentMagnet.value,
      cover: ctx.torrentCover.value,
      torrentFilesBeforeAlbumPreview: ctx.torrentFilesBeforeAlbumPreview.value
        ? [...ctx.torrentFilesBeforeAlbumPreview.value]
        : null,
      torrentSelectedBeforeAlbumPreview: ctx.torrentSelectedBeforeAlbumPreview.value
        ? { ...ctx.torrentSelectedBeforeAlbumPreview.value }
        : null,
    };
  }

  function snapshotAlbumForBack(): NavEntry {
    return { type: "album", album: ctx.currentAlbum.value };
  }

  /**
   * Single source of truth for "what screen is the user looking at right
   * now?" — used by both back and forward to record the screen they're
   * leaving. Maps the live (view, currentAlbum, selected, …) tuple to
   * exactly one NavEntry.
   */
  function snapshotCurrentScreen(): NavEntry {
    if (ctx.view.value === "settings") return { type: "settings" };
    if (ctx.view.value === "likes")    return { type: "likes" };
    if (ctx.view.value === "playlist") {
      return { type: "playlist", playlistId: ctx.currentPlaylistId.value };
    }
    if (ctx.currentAlbum.value) return snapshotAlbumForBack();
    if (ctx.selected.value)     return snapshotTorrentForBack();
    return snapshotSearchForBack();
  }

  /**
   * Identity check: do two snapshots represent the same screen? Used to
   * suppress duplicate stack entries when the user clicks a sidebar item
   * for a screen they're already on (Spotify-style no-op).
   */
  function _sameScreen(a: NavEntry, b: NavEntry): boolean {
    if (a.type !== b.type) return false;
    if (a.type === "playlist" && b.type === "playlist") {
      return (a.playlistId ?? null) === (b.playlistId ?? null);
    }
    if (a.type === "album" && b.type === "album") {
      const ai = (a.album as { id?: string } | null)?.id ?? null;
      const bi = (b.album as { id?: string } | null)?.id ?? null;
      return ai === bi;
    }
    if (a.type === "torrent" && b.type === "torrent") {
      return (a.selected?.id ?? null) === (b.selected?.id ?? null);
    }
    return true;
  }

  function pushCurrentScreenToForwardStack(): void {
    forwardStack.value.push(snapshotCurrentScreen());
  }

  function clearTorrentContext(): void {
    ctx.selected.value = null;
    ctx.files.value = [];
    ctx.torrentMagnet.value = "";
    ctx.torrentCover.value = null;
    ctx.torrentFilesBeforeAlbumPreview.value = null;
    ctx.torrentSelectedBeforeAlbumPreview.value = null;
    ctx.currentAlbum.value = null;
  }

  /**
   * Apply a NavEntry — the inverse of `snapshotCurrentScreen`. Restores
   * every reactive ref so the popped screen renders correctly. Used by
   * both `handleBack` and `handleForwardNav`.
   */
  function _applyEntry(entry: NavEntry): void {
    if (entry.type === "search") {
      ctx.searchQuery.value = entry.searchQuery;
      ctx.searchEntities.value = [...(entry.resultsEntities ?? [])];
      ctx.slskPeerBrowseUser.value = entry.slskPeerBrowseUser ?? null;
      ctx.searchResultsTab.value = entry.searchResultsTab === "albums" ? "albums" : "tracks";
      ctx.error.value = entry.error;
      ctx.view.value = "home";
      clearTorrentContext();
      return;
    }
    if (entry.type === "torrent") {
      ctx.selected.value = { ...entry.selected };
      ctx.files.value = [...entry.files];
      ctx.torrentMagnet.value = entry.magnet;
      ctx.torrentCover.value = entry.cover;
      ctx.torrentFilesBeforeAlbumPreview.value = entry.torrentFilesBeforeAlbumPreview;
      ctx.torrentSelectedBeforeAlbumPreview.value = entry.torrentSelectedBeforeAlbumPreview;
      ctx.currentAlbum.value = null;
      ctx.view.value = "home";
      return;
    }
    if (entry.type === "album") {
      ctx.currentAlbum.value = entry.album as UseNavStackCtx["currentAlbum"]["value"];
      ctx.selected.value = null;
      ctx.files.value = [];
      ctx.torrentMagnet.value = "";
      ctx.torrentCover.value = null;
      ctx.view.value = "home";
      return;
    }
    if (entry.type === "likes") {
      ctx.view.value = "likes";
      ctx.returnView.value = "home";
      return;
    }
    if (entry.type === "settings") {
      ctx.view.value = "settings";
      ctx.returnView.value = "home";
      return;
    }
    if (entry.type === "playlist") {
      ctx.currentPlaylistId.value = entry.playlistId ?? null;
      ctx.view.value = "playlist";
      ctx.returnView.value = "home";
      return;
    }
  }

  /**
   * Top-level navigation entry point — wired to sidebar buttons (Home,
   * Likes, Settings, individual playlists). Records the screen the user
   * is leaving on `backStack`, clears `forwardStack` (browser semantics:
   * a fresh nav forks history), and applies the new screen.
   *
   * Args:
   *   target: Top-level view to switch to.
   *   playlistId: Required when `target === "playlist"`.
   *
   * No-op when the user is already on the target screen — duplicate
   * sidebar clicks shouldn't grow the history stack.
   */
  function navigateToTopLevelView(
    target: TopLevelView,
    playlistId: string | null = null,
  ): void {
    const next: NavEntry =
      target === "playlist" ? { type: "playlist", playlistId }
      : target === "likes"    ? { type: "likes" }
      : target === "settings" ? { type: "settings" }
      : {
          type: "search",
          searchQuery: ctx.searchQuery.value,
          resultsEntities: [...ctx.searchEntities.value],
          error: ctx.error.value,
          slskPeerBrowseUser: ctx.slskPeerBrowseUser.value,
          searchResultsTab: ctx.searchResultsTab.value,
        };

    const cur = snapshotCurrentScreen();
    if (_sameScreen(cur, next)) return;

    backStack.value.push(cur);
    forwardStack.value = [];

    if (target === "home") {
      // Home keeps whatever search / torrent / album state was already
      // there — don't blow away the user's open work, just flip the view
      // flag back so the home surface renders.
      ctx.view.value = "home";
      ctx.returnView.value = "home";
    } else {
      _applyEntry(next);
    }
    scrollMainToTop();
  }

  /**
   * Restore an album-preview snapshot — the only entry type that's
   * intra-screen rather than a full screen identity. Caller decides
   * which stack the snapshot came from; this just applies it.
   */
  function _applyAlbumPreview(snap: Extract<NavEntry, { type: "album-preview" }>): void {
    ctx.files.value = snap.files;
    ctx.selected.value = snap.selected;
    ctx.torrentMagnet.value = snap.magnet;
    ctx.torrentCover.value = snap.cover;
    ctx.torrentFilesBeforeAlbumPreview.value = snap.fullFiles;
    ctx.torrentSelectedBeforeAlbumPreview.value = snap.fullSelected;
  }

  /**
   * Back arrow — symmetric counterpart of `handleForwardNav`.
   *
   * Order of operations:
   *   1. Album-preview drill-down (if open) is popped first — same as
   *      Spotify's "back inside an album restores its parent context"
   *      behavior. The preview is pushed onto `forwardStack` so a Forward
   *      press re-enters it.
   *   2. Otherwise pop the top of `backStack`, push current screen onto
   *      `forwardStack`, and apply the popped entry.
   */
  function handleBack(): void {
    if (ctx.torrentFilesBeforeAlbumPreview.value) {
      forwardStack.value.push({
        type: "album-preview",
        files: [...ctx.files.value],
        selected: { ...(ctx.selected.value ?? {}) },
        magnet: ctx.torrentMagnet.value,
        cover: ctx.torrentCover.value,
        fullFiles: ctx.torrentFilesBeforeAlbumPreview.value,
        fullSelected: ctx.torrentSelectedBeforeAlbumPreview.value,
      });
      ctx.files.value = ctx.torrentFilesBeforeAlbumPreview.value;
      ctx.selected.value = ctx.torrentSelectedBeforeAlbumPreview.value;
      ctx.torrentFilesBeforeAlbumPreview.value = null;
      ctx.torrentSelectedBeforeAlbumPreview.value = null;
      scrollMainToTop();
      return;
    }

    if (backStack.value.length === 0) return;

    forwardStack.value.push(snapshotCurrentScreen());
    const entry = backStack.value.pop()!;
    _applyEntry(entry);
    scrollMainToTop();
  }

  /**
   * Forward arrow — symmetric counterpart of `handleBack`. Pops the top
   * of `forwardStack`, pushes current screen onto `backStack`, applies
   * the popped entry. Album-preview snapshots route to a separate
   * applier since they're intra-screen, not a full screen swap.
   */
  function handleForwardNav(): void {
    const snap = forwardStack.value.pop();
    if (!snap) return;
    if (snap.type === "album-preview") {
      _applyAlbumPreview(snap);
      scrollMainToTop();
      return;
    }
    backStack.value.push(snapshotCurrentScreen());
    _applyEntry(snap);
    scrollMainToTop();
  }

  const handleNavBack = handleBack;

  return {
    forwardStack,
    backStack,
    snapshotSearchForBack,
    snapshotTorrentForBack,
    snapshotAlbumForBack,
    snapshotCurrentScreen,
    pushCurrentScreenToForwardStack,
    navigateToTopLevelView,
    handleBack,
    handleForwardNav,
    handleNavBack,
  };
}
