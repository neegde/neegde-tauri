/**
 * Back/forward navigation stacks with rich snapshot payloads.
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
  | { type: "search"; searchQuery: string; resultsEntities: unknown[]; error: string | null; slskPeerBrowseUser: string | null }
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
  | { type: "playlist"; playlistId?: string | null };

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
  error: Ref<string | null>;
  mainRef: Ref<HTMLElement | null>;
}

export function useNavStack(ctx: UseNavStackCtx) {
  const forwardStack = ref<NavEntry[]>([]);
  const backStack = ref<NavEntry[]>([]);

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

  function pushCurrentScreenToForwardStack(): void {
    if (ctx.currentAlbum.value) {
      forwardStack.value.push({
        type: "album",
        album: ctx.currentAlbum.value,
        restoreLikesView: ctx.returnView.value === "likes",
      });
      return;
    }
    forwardStack.value.push({
      type: "torrent",
      selected: { ...(ctx.selected.value ?? {}) },
      files: [...ctx.files.value],
      magnet: ctx.torrentMagnet.value,
      cover: ctx.torrentCover.value,
      restoreLikesView: ctx.returnView.value === "likes",
      torrentFilesBeforeAlbumPreview: ctx.torrentFilesBeforeAlbumPreview.value
        ? [...ctx.torrentFilesBeforeAlbumPreview.value]
        : null,
      torrentSelectedBeforeAlbumPreview: ctx.torrentSelectedBeforeAlbumPreview.value
        ? { ...ctx.torrentSelectedBeforeAlbumPreview.value }
        : null,
    });
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

    if (backStack.value.length > 0) {
      pushCurrentScreenToForwardStack();
      const entry = backStack.value.pop()!;
      if (entry.type === "search") {
        ctx.searchQuery.value = entry.searchQuery;
        ctx.searchEntities.value = [...(entry.resultsEntities ?? [])];
        ctx.slskPeerBrowseUser.value = entry.slskPeerBrowseUser ?? null;
        ctx.error.value = entry.error;
        clearTorrentContext();
      } else if (entry.type === "torrent") {
        ctx.selected.value = { ...entry.selected };
        ctx.files.value = [...entry.files];
        ctx.torrentMagnet.value = entry.magnet;
        ctx.torrentCover.value = entry.cover;
        ctx.torrentFilesBeforeAlbumPreview.value = entry.torrentFilesBeforeAlbumPreview;
        ctx.torrentSelectedBeforeAlbumPreview.value = entry.torrentSelectedBeforeAlbumPreview;
        ctx.currentAlbum.value = null;
        ctx.view.value = "home";
      } else if (entry.type === "album") {
        ctx.currentAlbum.value = entry.album;
        ctx.selected.value = null;
        ctx.files.value = [];
        ctx.torrentMagnet.value = "";
        ctx.torrentCover.value = null;
        ctx.view.value = "home";
      } else if (entry.type === "likes") {
        ctx.view.value = "likes";
        ctx.returnView.value = "home";
        clearTorrentContext();
      } else if (entry.type === "playlist" && entry.playlistId) {
        ctx.currentPlaylistId.value = entry.playlistId;
        ctx.view.value = "playlist";
        ctx.returnView.value = "home";
        clearTorrentContext();
      }
      scrollMainToTop();
      return;
    }

    if (ctx.currentAlbum.value) {
      forwardStack.value.push({
        type: "album",
        album: ctx.currentAlbum.value,
        restoreLikesView: ctx.returnView.value === "likes",
      });
    } else if (ctx.selected.value) {
      forwardStack.value.push({
        type: "torrent",
        selected: { ...ctx.selected.value },
        files: [...ctx.files.value],
        magnet: ctx.torrentMagnet.value,
        cover: ctx.torrentCover.value,
        restoreLikesView: ctx.returnView.value === "likes",
        torrentFilesBeforeAlbumPreview: ctx.torrentFilesBeforeAlbumPreview.value
          ? [...ctx.torrentFilesBeforeAlbumPreview.value]
          : null,
        torrentSelectedBeforeAlbumPreview: ctx.torrentSelectedBeforeAlbumPreview.value
          ? { ...ctx.torrentSelectedBeforeAlbumPreview.value }
          : null,
      });
    }
    clearTorrentContext();
    if (ctx.returnView.value === "likes") {
      ctx.view.value = "likes";
      ctx.returnView.value = "home";
    } else if (ctx.returnView.value === "playlist") {
      ctx.view.value = "playlist";
      ctx.returnView.value = "home";
    }
  }

  function handleForwardNav(): void {
    const snap = forwardStack.value.pop();
    if (!snap) return;
    if (snap.type === "album-preview") {
      ctx.files.value = snap.files;
      ctx.selected.value = snap.selected;
      ctx.torrentMagnet.value = snap.magnet;
      ctx.torrentCover.value = snap.cover;
      ctx.torrentFilesBeforeAlbumPreview.value = snap.fullFiles;
      ctx.torrentSelectedBeforeAlbumPreview.value = snap.fullSelected;
    } else if (snap.type === "torrent") {
      ctx.view.value = "home";
      if (snap.restoreLikesView) ctx.returnView.value = "likes";
      ctx.selected.value = snap.selected;
      ctx.files.value = snap.files;
      ctx.torrentMagnet.value = snap.magnet;
      ctx.torrentCover.value = snap.cover;
      ctx.torrentFilesBeforeAlbumPreview.value = snap.torrentFilesBeforeAlbumPreview ?? null;
      ctx.torrentSelectedBeforeAlbumPreview.value = snap.torrentSelectedBeforeAlbumPreview ?? null;
      ctx.currentAlbum.value = null;
    } else if (snap.type === "album") {
      ctx.view.value = "home";
      if (snap.restoreLikesView) ctx.returnView.value = "likes";
      ctx.currentAlbum.value = snap.album;
      ctx.selected.value = null;
      ctx.files.value = [];
      ctx.torrentMagnet.value = "";
      ctx.torrentCover.value = null;
    }
    scrollMainToTop();
  }

  const handleNavBack = handleBack;

  return {
    forwardStack,
    backStack,
    snapshotSearchForBack,
    snapshotTorrentForBack,
    snapshotAlbumForBack,
    pushCurrentScreenToForwardStack,
    handleBack,
    handleForwardNav,
    handleNavBack,
  };
}
