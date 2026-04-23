/**
 * Builders + registration helpers that attach a Track entity to the queue.
 *
 * These helpers synthesize TrackData (suitable for `buildTrack`) from whatever
 * shape the caller has (RT file + torrent row, SLSK file, magnet file) and
 * register it. Safe to call many times for the same id — `registerEntity` is
 * idempotent.
 */

import { registerEntity } from "../stores/entities.js";
import { trackDisplayBasename } from "../lib/utils.js";
import type { TrackData } from "../track/types.js";

/** Stable Track id for a RuTracker file. Prefers topic id; falls back to magnet btih. */
export function rtTrackId(
  topicId: string | number | null | undefined,
  magnetBtih: string | null | undefined,
  fileIdx: number,
): string | null {
  if (topicId != null && String(topicId).trim() !== "") {
    return `rt:track:${topicId}:${fileIdx}`;
  }
  if (magnetBtih) return `magnet:track:${magnetBtih}:${fileIdx}`;
  return null;
}

interface RtFile {
  origIdx: number;
  path: string;
  size?: number | null;
  [k: string]: unknown;
}

interface RtTorrentLike {
  id?: string | number;
  __topicId?: string | number;
  name?: string | null;
  artist?: string | null;
  source?: string;
  [k: string]: unknown;
}

export function buildRtTrackEntity(
  f: RtFile,
  torrent: RtTorrentLike | null | undefined,
  magnet: string,
  magnetBtih: string | null,
  coverFileIdx: number | null,
  albumDirPath: string | null,
): TrackData | null {
  const topicId = torrent?.__topicId ?? torrent?.id ?? null;
  const id = rtTrackId(topicId as string | number | null, magnetBtih, f.origIdx);
  if (!id) return null;
  const kind = torrent?.source === "magnet" ? "magnet" : "rutracker";
  return {
    type: "track",
    id,
    title: trackDisplayBasename(f.path),
    artist: torrent?.artist ?? null,
    albumTitle: torrent?.name ?? null,
    fileName: trackDisplayBasename(f.path),
    format: null,
    bitrate: null,
    duration: null,
    size: f.size ?? null,
    albumId: null,
    sources: [{
      kind,
      refs: {
        topicId: topicId != null ? String(topicId) : null,
        magnet,
        fileIdx: f.origIdx,
        coverFileIdx,
        albumDirPath,
      },
      raw: { file: f, torrent },
    }] as TrackData["sources"],
    score: 0,
    mergedFrom: 1,
  };
}

export interface SlskTrackInput {
  username: string | null | undefined;
  filepath: string | null | undefined;
  size?: number | null;
  filename: string;
  artist?: string | null;
  cover?: unknown;
  albumTitle?: string | null;
}

export function buildSlskTrackEntity({
  username, filepath, size, filename, artist, cover, albumTitle,
}: SlskTrackInput): TrackData | null {
  if (!username || !filepath) return null;
  const id = `slsk:track:${username}|${filepath}`;
  return {
    type: "track",
    id,
    title: filename,
    artist: artist ?? null,
    albumTitle: albumTitle ?? null,
    fileName: filename,
    format: null,
    bitrate: null,
    duration: null,
    size: size ?? null,
    albumId: null,
    sources: [{
      kind: "soulseek",
      refs: { slskUsername: username, slskFilepath: filepath },
      raw: { cover: cover ?? null },
    }] as TrackData["sources"],
    score: 0,
    mergedFrom: 1,
  };
}

/** Register + return the id. Null when the entity couldn't be built. */
export function registerAndGetId(entity: TrackData | null | undefined): string | null {
  if (!entity) return null;
  registerEntity(entity);
  return entity.id;
}
