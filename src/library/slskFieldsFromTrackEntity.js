/**
 * SoulSeek streaming-field projection for a Track entity.
 *
 * Cover and peers ref resolution:
 *   - When the Track has an `albumId`, look up the parent Album in the entities
 *     registry; use its `sources[0].raw.cover` / `peers` when present.
 *   - Otherwise fall back to the Track's own `sources[0].raw`.
 */

import { getAlbum } from "../stores/entities.js";

/** @param {import("../types/entities.js").Track} track */
export function slskFieldsFromTrackEntity(track) {
  const src = track.sources?.[0] ?? {};
  const refs = src.refs ?? {};
  const raw = src.raw ?? {};
  const filepath = (refs.slskFilepath ?? "").replace(/\\/g, "/");
  const username = refs.slskUsername ?? "";
  const filename = filepath.split("/").pop() || track.fileName || track.title || "track";

  let cover = raw.cover ?? null;
  if (!cover && track.albumId) {
    const parent = getAlbum(track.albumId);
    cover = parent?.sources?.[0]?.raw?.cover ?? null;
  }
  const peers = raw.peers ?? getAlbum(track.albumId)?.peers ?? 1;

  return {
    filepath: refs.slskFilepath ?? filepath,
    username,
    filename,
    size: track.size ?? 0,
    peers,
    cover,
    artist: track.artist ?? null,
  };
}
