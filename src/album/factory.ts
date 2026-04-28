/**
 * `buildAlbum(data)` — the only public way to get an Album instance.
 * Mirrors `buildTrack` for the Track hierarchy.
 */

import type { AlbumData } from "./types.js";
import type { Album } from "./Album.js";
import { RutrackerAlbum } from "./RutrackerAlbum.js";
import { SoulseekAlbum } from "./SoulseekAlbum.js";

export function buildAlbum(data: AlbumData): Album {
  const kind = data.sources?.[0]?.kind;
  switch (kind) {
    case "rutracker": return new RutrackerAlbum(data);
    case "soulseek":  return new SoulseekAlbum(data);
    default:
      throw new Error(`buildAlbum: unsupported source kind "${kind}" on album "${data.id}"`);
  }
}

/** Accept already-hydrated Album or raw data. */
export function ensureAlbum(a: Album | AlbumData): Album {
  return typeof (a as Album).coverUrl === "function" ? (a as Album) : buildAlbum(a as AlbumData);
}
