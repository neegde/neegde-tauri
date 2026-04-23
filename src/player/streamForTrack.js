/**
 * Stream URL resolver that consumes a Track entity directly.
 *
 * Wraps `streamUrl` from torrent/api.js, reading the source-specific fields
 * out of `track.sources[0].refs` instead of the legacy queue row shape. This
 * is the single place Player.vue should call once it migrates off the row.
 */

import { streamUrl } from "../torrent/api.js";

/**
 * @param {import("../types/entities.js").Track} track
 * @returns {Promise<string>} Local HTTP URL or empty string on failure.
 */
export async function streamForTrack(track) {
  if (!track || track.type !== "track") return "";
  const src = track.sources?.[0];
  if (!src) return "";

  if (src.kind === "soulseek") {
    return streamUrl("", 0, {
      source: "soulseek",
      slskUsername: src.refs?.slskUsername,
      slskFilepath: src.refs?.slskFilepath,
      slskFilesize: track.size ?? 0,
    });
  }

  // RuTracker / magnet
  const magnet = src.refs?.magnet ?? "";
  const fileIdx = src.refs?.fileIdx;
  return streamUrl(magnet, fileIdx, {
    source: src.kind === "magnet" ? "magnet" : "rutracker",
    torrentId: src.refs?.topicId ?? null,
  });
}
