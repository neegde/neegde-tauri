/**
 * Small helpers for the "per-track row action" labels repeated across views
 * (LikesView, PlaylistView, AlbumView, TorrentView tooltips). Each is a
 * one-liner — a separate composable would be overkill.
 */

import type { Track } from "./Track.js";

/** Short source label for tooltips: "SoulSeek" | "RuTracker". */
export function sourceShortLabel(track: Track): string {
  return track.kind === "soulseek" ? "SoulSeek" : "RuTracker";
}

/** Context-menu item label for the "open source" row. */
export function sourceContextLabel(track: Track): string {
  return track.kind === "soulseek" ? "Источник (SoulSeek)" : "Источник (Torrent)";
}

/** Whether the Play action should be enabled for this track. */
export function canPlay(track: Track): boolean {
  return track.hasPlaybackIdentity();
}

/** Whether the Download action should be enabled for this track. */
export function canDownload(track: Track): boolean {
  return track.hasPlaybackIdentity();
}
