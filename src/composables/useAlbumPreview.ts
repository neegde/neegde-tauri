import { detectAlbums, type FileRow } from "../lib/utils.js";
import type { Ref } from "vue";

interface TorrentLike {
  id?: string | number;
  name?: string;
  artist?: string | null;
  fromLikes?: boolean;
  [k: string]: unknown;
}

export interface UseAlbumPreviewCtx {
  selected: Ref<TorrentLike | null>;
  files: Ref<FileRow[]>;
  torrentFilesBeforeAlbumPreview: Ref<FileRow[] | null>;
  torrentSelectedBeforeAlbumPreview: Ref<TorrentLike | null>;
  mainRef: Ref<HTMLElement | null>;
}

export interface AlbumPreviewInput {
  album: {
    audioFiles: FileRow[];
    coverFile?: FileRow | null;
    dirPath?: string;
    [k: string]: unknown;
  };
  displayName: string;
}

export function useAlbumPreview(ctx: UseAlbumPreviewCtx) {
  function handleOpenAlbumPreview({ album, displayName }: AlbumPreviewInput): void {
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
      ...(base ?? {}),
      name: displayName,
      fromLikes: true,
      artist: m ? m[1]!.trim() : "",
    };
    if (ctx.mainRef.value) ctx.mainRef.value.scrollTo(0, 0);
  }

  function applyAlbumScopeForTrack(
    fileIdx: number | null | undefined,
    albumDirPath: string | null | undefined,
  ): void {
    const albs = detectAlbums(ctx.files.value);
    if (albs.length <= 1) return;
    let album: typeof albs[number] | null = null;
    if (fileIdx != null) {
      album = albs.find((a) => a.audioFiles.some((f) => f.origIdx === fileIdx)) ?? null;
    }
    if (!album && albumDirPath) {
      album = albs.find((a) => a.dirPath === albumDirPath) ?? null;
    }
    if (!album?.audioFiles?.length) return;
    ctx.torrentFilesBeforeAlbumPreview.value = ctx.files.value;
    ctx.torrentSelectedBeforeAlbumPreview.value = { ...(ctx.selected.value ?? {}) };
    ctx.files.value = album.coverFile
      ? [...album.audioFiles, album.coverFile]
      : [...album.audioFiles];
    const dirName = album.dirPath.split("/").filter(Boolean).pop() || "";
    const base = ctx.torrentSelectedBeforeAlbumPreview.value;
    const m = base?.name?.match(/^(.+?)\s+[-–—]\s+/);
    ctx.selected.value = {
      ...(base ?? {}),
      name: dirName || base?.name || "",
      fromLikes: true,
      artist: m ? m[1]!.trim() : (base?.artist ?? ""),
    };
  }

  return { handleOpenAlbumPreview, applyAlbumScopeForTrack };
}
