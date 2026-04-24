/**
 * `buildTrack(data)` — the only public way to get a Track instance.
 *
 * Use this at every data boundary: search provider emits, localStorage
 * rehydration, Tauri IPC responses that shape into `TrackData`. Once the
 * runtime owns a `Track` instance, the rest of the app never writes
 * `if (kind === "soulseek")` again.
 */

import type { TrackData } from "./types.js";
import type { Track } from "./Track.js";
import { SoulseekTrack } from "./SoulseekTrack.js";
import { RutrackerTrack, MagnetTrack } from "./RutrackerTrack.js";
import { resolveTrackNames, type NameConfidence } from "./nameResolver.js";

/**
 * Confidence tier for every track's resolver-derived names. Stage-2
 * enrichers (Deezer etc) read this to decide whether to re-query and
 * overwrite the stamped fields.
 */
export const nameConfidence = new Map<string, NameConfidence>();

/**
 * Fill in `title` / `artist` / `albumTitle` using the deterministic resolver
 * when the provider didn't stamp them (or stamped the raw filename). The
 * resolver already respects a provider-stamped `artist` — RT's "Исполнитель:"
 * label stays authoritative.
 */
function resolveNames(data: TrackData): TrackData {
  const r = resolveTrackNames(data);
  nameConfidence.set(data.id, r.confidence);
  const looksLikeRawFilename =
    !data.title || data.title === data.fileName;
  return {
    ...data,
    title: looksLikeRawFilename ? r.title : data.title,
    artist: data.artist ?? (r.artist || null),
    albumTitle: data.albumTitle ?? (r.album || null),
  };
}

export function buildTrack(data: TrackData): Track {
  const kind = data.sources?.[0]?.kind;
  const stamped = resolveNames(data);
  switch (kind) {
    case "soulseek":  return new SoulseekTrack(stamped);
    case "rutracker": return new RutrackerTrack(stamped);
    case "magnet":    return new MagnetTrack(stamped);
    default:
      throw new Error(`buildTrack: unsupported source kind "${kind}" on track "${data.id}"`);
  }
}

/**
 * Accepts either already-hydrated `Track` or raw `TrackData`. Useful at store
 * boundaries where data arrives from many origins.
 */
export function ensureTrack(t: Track | TrackData): Track {
  return typeof (t as Track).prepareStream === "function" ? (t as Track) : buildTrack(t as TrackData);
}
