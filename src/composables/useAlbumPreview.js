/**
 * Album-preview mode: narrow the current torrent's file list to a single
 * album-shaped folder (as identified by `detectAlbums`), stashing the full
 * list in `torrentFilesBeforeAlbumPreview` so "back" can restore it.
 *
 * Two entry points:
 *   - `handleOpenAlbumPreview({album, displayName})` — explicit (click on
 *     album card in the Likes grid of a currently-open torrent).
 *   - `applyAlbumScopeForTrack(fileIdx, albumDirPath)` — automatic when the
 *     user clicks "open torrent source" on a currently-playing track and
 *     the list contains multiple albums.
 */

import { detectAlbums } from "../lib/utils.js";

/**
 * @param {{
 *   selected: import("vue").Ref<object | null>,
 *   files: import("vue").Ref<Array<object>>,
 *   torrentFilesBeforeAlbumPreview: import("vue").Ref<Array<object> | null>,
 *   torrentSelectedBeforeAlbumPreview: import("vue").Ref<object | null>,
 *   mainRef: import("vue").Ref<HTMLElement | null>,
 * }} ctx
 */
export function useAlbumPreview(ctx) {
  function handleOpenAlbumPreview({ album, displayName }) {
    if (!ctx.selected.value || !album?.audioFiles?.length) return;

    if (!ctx.torrentFilesBeforeAlbumPreview.value) {
      ctx.torrentFilesBeforeAlbumPreview.value = ctx.files.value;
      ctx.torrentSelectedBeforeAlbumPreview.value = { ...ctx.selected.value };
    }

    ctx.files.value = album.coverFile
      ? [...album.audioFiles, album.coverFile]
      : [...album.audioFiles];

    const base = ctx.torrentSelectedBeforeAlbumPreview.value;
    const m = base?.name?.match(/^(.+?)\s+[-–—]\s+/);
    ctx.selected.value = {
      ...base,
      name: displayName,
      fromLikes: true,
      artist: m ? m[1].trim() : "",
    };
    if (ctx.mainRef.value) ctx.mainRef.value.scrollTo(0, 0);
  }

  /**
   * Locate the album containing `fileIdx` (or `albumDirPath` fallback) and
   * narrow the visible file list to it. No-op when the torrent only exposes
   * one album or no match is found.
   */
  function applyAlbumScopeForTrack(fileIdx, albumDirPath) {
    const albs = detectAlbums(ctx.files.value);
    if (albs.length <= 1) return;
    let album = null;
    if (fileIdx != null) {
      album = albs.find((a) => a.audioFiles.some((f) => f.origIdx === fileIdx)) ?? null;
    }
    if (!album && albumDirPath) {
      album = albs.find((a) => a.dirPath === albumDirPath) ?? null;
    }
    if (!album?.audioFiles?.length) return;
    ctx.torrentFilesBeforeAlbumPreview.value = ctx.files.value;
    ctx.torrentSelectedBeforeAlbumPreview.value = { ...ctx.selected.value };
    ctx.files.value = album.coverFile
      ? [...album.audioFiles, album.coverFile]
      : [...album.audioFiles];
    const dirName = album.dirPath.split("/").filter(Boolean).pop() || "";
    const base = ctx.torrentSelectedBeforeAlbumPreview.value;
    const m = base?.name?.match(/^(.+?)\s+[-–—]\s+/);
    ctx.selected.value = {
      ...base,
      name: dirName || base?.name || "",
      fromLikes: true,
      artist: m ? m[1].trim() : (base?.artist ?? ""),
    };
  }

  return { handleOpenAlbumPreview, applyAlbumScopeForTrack };
}
