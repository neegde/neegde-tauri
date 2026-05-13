import { invoke } from "@tauri-apps/api/core";
import { enrichMagnetWithOpenTrackers } from "../lib/utils.js";
import { torrentFileB64ForTrack } from "./api.js";
import type { Track } from "../track/Track.js";
import { RutrackerTrack } from "../track/RutrackerTrack.js";
import type { MagnetRefs, RutrackerRefs } from "../track/types.js";

/** Peer + size for a SoulSeek full-file embedded cover download (duck-typed on {@link Track}). */
export type SoulseekFullEmbedParams = { username: string; filepath: string; filesize: number };

function soulseekFullEmbedParamsFromTrack(track: Track): SoulseekFullEmbedParams | null {
  if (track.kind !== "soulseek") return null;
  const t = track as Track & { embedFullFileTarget?: () => SoulseekFullEmbedParams | null };
  if (typeof t.embedFullFileTarget !== "function") return null;
  return t.embedFullFileTarget() ?? null;
}

/**
 * Fetches embedded cover art from the leading bytes of a torrent audio file.
 *
 * @param params - Magnet, audio `fileIdx`, and optional `.torrent` hint source.
 * @returns `data:` URL or `null` when none is embedded in the readable prefix.
 */
export async function fetchTorrentEmbeddedCoverBytes(params: {
  magnet: string;
  fileIdx: number;
  source: string;
  torrentId?: string | number | null;
}): Promise<string | null> {
  const b64 = await torrentFileB64ForTrack({
    source: params.source,
    torrentId: params.torrentId ?? undefined,
  }).catch(() => null);
  const url = await invoke<string | null>("torrent_embedded_cover", {
    magnet: enrichMagnetWithOpenTrackers(params.magnet),
    fileIdx: params.fileIdx,
    torrentFileB64: b64,
  });
  return url ?? null;
}

/**
 * Fetches embedded cover art by reading the whole torrent audio file.
 *
 * @param params - Magnet, audio `fileIdx`, and optional `.torrent` hint source.
 * @returns `data:` URL or `null` when the full file has no embedded artwork.
 */
export async function fetchTorrentEmbeddedCoverFullFile(params: {
  magnet: string;
  fileIdx: number;
  source: string;
  torrentId?: string | number | null;
}): Promise<string | null> {
  const b64 = await torrentFileB64ForTrack({
    source: params.source,
    torrentId: params.torrentId ?? undefined,
  }).catch(() => null);
  const url = await invoke<string | null>("torrent_embedded_cover_full_file", {
    magnet: enrichMagnetWithOpenTrackers(params.magnet),
    fileIdx: params.fileIdx,
    torrentFileB64: b64,
  });
  return url ?? null;
}

/**
 * Fetches embedded cover art by downloading the whole SoulSeek audio file.
 *
 * @param params - Peer username, share path, and declared file size.
 * @returns `data:` URL or `null` when the file has no embedded artwork.
 */
export async function fetchSoulseekEmbeddedCoverFullFile(params: {
  username: string;
  filepath: string;
  filesize: number;
}): Promise<string | null> {
  const url = await invoke<string | null>("soulseek_embedded_cover_full_file", {
    username: params.username,
    filepath: params.filepath,
    filesize: params.filesize,
  });
  return url ?? null;
}

/**
 * Resolves SoulSeek peer coordinates for a full-file embedded cover read.
 *
 * @param track - Concrete track instance.
 * @returns Invoke parameters or `null` when no live peer or invalid size.
 */
export function soulseekFullEmbeddedParamsForTrack(track: Track): SoulseekFullEmbedParams | null {
  return soulseekFullEmbedParamsFromTrack(track);
}

/**
 * Whether the full-file embedded cover action applies to this track (torrent or SoulSeek).
 *
 * @param track - Any track subclass.
 * @returns True when a backend full read can be attempted.
 */
export function fullFileEmbeddedCoverAvailableForTrack(track: Track): boolean {
  return torrentEmbeddedParamsForTrack(track) != null || soulseekFullEmbedParamsFromTrack(track) != null;
}

/**
 * Resolves magnet + audio index from a RuTracker / magnet-backed track entity.
 *
 * @param track - Concrete track instance.
 * @returns Invoke parameters or `null` when embedded extraction does not apply.
 */
export function torrentEmbeddedParamsForTrack(
  track: Track,
): { magnet: string; fileIdx: number; source: string; torrentId?: string | number | null } | null {
  if (!(track instanceof RutrackerTrack)) return null;
  const s = track.sources[0];
  if (!s || (s.kind !== "rutracker" && s.kind !== "magnet")) return null;
  const refs = s.refs as RutrackerRefs | MagnetRefs;
  const magnet = refs.magnet ?? "";
  if (!magnet) return null;
  const fileIdx = Number(refs.fileIdx ?? 0);
  const topicId = s.kind === "rutracker" ? (refs as RutrackerRefs).topicId : null;
  return {
    magnet,
    fileIdx,
    source: s.kind,
    torrentId: topicId ?? undefined,
  };
}

/**
 * Runs {@link fetchTorrentEmbeddedCoverBytes} for a torrent-backed track entity.
 *
 * @param track - Track with RuTracker or magnet primary source.
 * @returns `data:` URL or `null`.
 */
export async function fetchTorrentEmbeddedCoverForTrack(track: Track): Promise<string | null> {
  const p = torrentEmbeddedParamsForTrack(track);
  if (!p) return null;
  return fetchTorrentEmbeddedCoverBytes(p);
}
