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

export function buildTrack(data: TrackData): Track {
  const kind = data.sources?.[0]?.kind;
  switch (kind) {
    case "soulseek":  return new SoulseekTrack(data);
    case "rutracker": return new RutrackerTrack(data);
    case "magnet":    return new MagnetTrack(data);
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
