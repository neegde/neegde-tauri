/**
 * Back/forward navigation stacks with rich snapshot payloads.
 *
 * Entries carry enough state to restore an entire screen in one hop:
 *   - `search` — query text, entity list, error, SLSK peer filter
 *   - `torrent` — opened torrent row, file list, magnet, cover, album preview
 *   - `likes`   — nothing extra
 *   - `playlist` — playlistId
 *   - `album-preview` — pre-preview + current files/selected (forward only)
 *
 * Wholesale restore of these snapshots is not a migration target — moving to
 * id-based descriptors is a separate task. This composable just isolates the
 * stack manipulation so the rest of App.vue can stay clean.
 */

import { ref } from "vue";

/**
 * @param {{
 *   selected: import("vue").Ref<object | null>,
 *   files: import("vue").Ref<Array<object>>,
 *   torrentMagnet: import("vue").Ref<string>,
 *   torrentCover: import("vue").Ref<string | null>,
 *   torrentFilesBeforeAlbumPreview: import("vue").Ref<Array<object> | null>,
 *   torrentSelectedBeforeAlbumPreview: import("vue").Ref<object | null>,
 *   currentAlbum: import("vue").Ref<object | null>,
 *   view: import("vue").Ref<string>,
 *   returnView: import("vue").Ref<string>,
 *   currentPlaylistId: import("vue").Ref<string | null>,
 *   searchQuery: import("vue").Ref<string>,
 *   searchEntities: import("vue").Ref<Array<object>>,
 *   slskPeerBrowseUser: import("vue").Ref<string | null>,
 *   error: import("vue").Ref<string | null>,
 *   mainRef: import("vue").Ref<HTMLElement | null>,
 * }} ctx
 */
export function useNavStack(ctx) {
  const forwardStack = ref([]);
  const backStack = ref([]);

  function scrollMainToTop() {
    if (ctx.mainRef.value) ctx.mainRef.value.scrollTo(0, 0);
  }

  function snapshotSearchForBack() {
    return {
      type: "search",
      searchQuery: ctx.searchQuery.value,
      resultsEntities: [...ctx.searchEntities.value],
      error: ctx.error.value,
      slskPeerBrowseUser: ctx.slskPeerBrowseUser.value,
    };
  }

  function snapshotTorrentForBack() {
    return {
      type: "torrent",
      selected: { ...ctx.selected.value },
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

  /** Snapshot the AlbumView path. The Album entity lives in the registry,
   *  so only the id is stored — the ref is re-resolved on restore. */
  function snapshotAlbumForBack() {
    return { type: "album", album: ctx.currentAlbum.value };
  }

  function pushCurrentScreenToForwardStack() {
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

  function clearTorrentContext() {
    ctx.selected.value = null;
    ctx.files.value = [];
    ctx.torrentMagnet.value = "";
    ctx.torrentCover.value = null;
    ctx.torrentFilesBeforeAlbumPreview.value = null;
    ctx.torrentSelectedBeforeAlbumPreview.value = null;
    ctx.currentAlbum.value = null;
  }

  function handleBack() {
    if (ctx.torrentFilesBeforeAlbumPreview.value) {
      forwardStack.value.push({
        type: "album-preview",
        files: [...ctx.files.value],
        selected: { ...ctx.selected.value },
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
      const entry = backStack.value.pop();
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

  function handleForwardNav() {
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

  /** Alias kept for call sites that use the UI-facing name. */
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
