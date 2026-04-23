/**
 * Shape converters between legacy rich row formats (queue rows, like rows,
 * playlist track rows) and the simpler API expected by library write ops.
 *
 * These are pure — they neither read stores nor mutate state. `likesForCover`
 * is passed in when the caller needs the cover-file lookup, so callers that
 * don't care can pass `null`.
 *
 * SoulSeek variants keep the source-specific fields the streaming / export
 * code paths still read directly.
 */

import { trackCoverFileIdxForLike } from "./likesCover.js";
import { slskFieldsFromTrackEntity } from "./slskFieldsFromTrackEntity.js";

/** @param {import("../types/entities.js").Track} track */
export function soulseekSearchResultToLike(track) {
  if (!track || track.type !== "track") return null;
  const f = slskFieldsFromTrackEntity(track);
  return {
    id: track.id,
    type: "track",
    source: "soulseek",
    magnet: "",
    fileIdx: 0,
    fileName: f.filepath || f.filename,
    torrentName: f.filename,
    torrentId: track.id,
    artist: f.artist,
    slskUsername: f.username,
    slskFilepath: f.filepath,
    slskFilesize: f.size,
  };
}

/** @param {import("../types/entities.js").Track} track */
export function soulseekSearchResultToPlaylistTrack(track) {
  if (!track || track.type !== "track") return null;
  const f = slskFieldsFromTrackEntity(track);
  return {
    magnet: "",
    fileIdx: 0,
    fileName: f.filepath || f.filename,
    torrentName: f.filename,
    torrentId: String(track.id ?? ""),
    source: "soulseek",
    artist: f.artist,
    coverFileIdx: null,
    slskUsername: f.username,
    slskFilepath: f.filepath,
    slskFilesize: f.size,
  };
}

/**
 * Like row → playlist track row.
 *
 * @param {object} like
 * @param {object} likesForCover  Current likes dict (for cover-file inheritance).
 */
export function playlistTrackFromLike(like, likesForCover) {
  const base = {
    magnet: like.magnet ?? "",
    fileIdx: like.fileIdx,
    fileName: like.fileName,
    torrentName: like.torrentName,
    torrentId: like.torrentId,
    source: like.source,
    artist: like.artist ?? null,
    coverFileIdx: trackCoverFileIdxForLike(like, likesForCover ?? {}),
    albumDirPath: like.albumDirPath ?? null,
  };
  if (like.source === "soulseek" && like.slskUsername && like.slskFilepath) {
    return {
      ...base,
      slskUsername: like.slskUsername,
      slskFilepath: like.slskFilepath,
      slskFilesize: like.slskFilesize ?? 0,
    };
  }
  return base;
}

/** Queue row → playlist track row. */
export function queueItemToPlaylistTrack(q) {
  if (!q) return null;
  const base = {
    magnet: q.magnet ?? "",
    fileIdx: q.fileIdx,
    fileName: q.fileName,
    torrentName: q.torrentName,
    torrentId: q.torrentId,
    source: q.source,
    artist: q.artist ?? null,
    coverFileIdx: q.coverFileIdx ?? null,
    albumDirPath: q.albumDirPath ?? null,
  };
  if (q.source === "soulseek" && q.slskUsername && q.slskFilepath) {
    return {
      ...base,
      slskUsername: q.slskUsername,
      slskFilepath: q.slskFilepath,
      slskFilesize: q.slskFilesize ?? 0,
    };
  }
  return base;
}
