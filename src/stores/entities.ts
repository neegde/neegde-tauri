/**
 * Global entity registry — one source of truth for every Track / Album
 * the user has ever touched (search feed, likes, playlists, queue).
 *
 * Track instances are class-backed (`Track` + subclasses); Album stays plain
 * for now until we OOP-ify it in a later pass. Both are looked up by `id`;
 * queues, likes, playlists store ids and resolve here.
 *
 * Reactivity: the backing `Map` is wrapped in `shallowRef` + `triggerRef`
 * on every mutation. Consumers that read `getTrack(id)` inside a `computed`
 * should also touch `entitiesVersion.value` so Vue tracks the registry
 * mutation dep (plain `Map.get` is not reactive).
 */

import { shallowRef, triggerRef } from "vue";
import type { Track } from "../track/Track.js";
import type { TrackData } from "../track/types.js";
import { buildTrack } from "../track/factory.js";
import { putTrack } from "../persistence/trackCache.js";

/**
 * Plain album data. Kept non-class for now; one migration at a time.
 * `sources` uses a loose shape so legacy provider payloads still typecheck —
 * a future pass will tighten this when Album becomes a class.
 */
export interface AlbumData {
  type: "album";
  id: string;
  title: string;
  artist: string | null;
  trackIds: string[];
  peers?: number | null;
  seeders?: number | null;
  coverUrl?: string | null;
  format?: string | null;
  bitrate?: number | null;
  size?: number | null;
  year?: number | null;
  sources?: Array<{
    kind: string;
    refs?: Record<string, unknown>;
    raw?: { cover?: { slsk_username?: string; slsk_filepath?: string; size?: number } | null; [k: string]: unknown };
  }>;
  [key: string]: unknown;
}

export type Entity = Track | AlbumData;

const _byId = shallowRef<Map<string, Entity>>(new Map());
export const entitiesVersion = shallowRef(0);

function bump(): void {
  triggerRef(_byId);
  entitiesVersion.value += 1;
}

/** Coerce raw data to a class instance when needed. */
function normalize(entity: Track | TrackData | AlbumData): Entity | null {
  if (!entity) return null;
  if (entity.type === "album") return entity as AlbumData;
  if (entity.type === "track") {
    // Already an instance? `prepareStream` exists on classes, not on plain data.
    const asTrack = entity as Partial<Track>;
    if (typeof asTrack.prepareStream === "function") return asTrack as Track;
    return buildTrack(entity as TrackData);
  }
  return null;
}

/**
 * Register (or replace) a single entity. Provider re-emits are common —
 * later copies win so merged-source / higher-score data takes precedence.
 *
 * Track data side-effects: also mirrored into the persistent `trackCache`
 * so references from likes / playlists / queue resolve after an app restart.
 */
export function registerEntity(entity: Track | TrackData | AlbumData | null | undefined): void {
  if (!entity) return;
  const norm = normalize(entity);
  if (!norm?.id) return;
  _byId.value.set(norm.id, norm);
  if (norm.type === "track") putTrack(norm);
  bump();
}

/** Register a batch — single reactivity bump. */
export function registerEntities(entities: Array<Track | TrackData | AlbumData>): void {
  if (!entities?.length) return;
  const tracksForCache: Track[] = [];
  for (const e of entities) {
    const norm = normalize(e);
    if (!norm?.id) continue;
    _byId.value.set(norm.id, norm);
    if (norm.type === "track") tracksForCache.push(norm);
  }
  for (const t of tracksForCache) putTrack(t);
  bump();
}

export function getEntity(id: string): Entity | null {
  return _byId.value.get(id) ?? null;
}

export function getTrack(id: string): Track | null {
  const e = _byId.value.get(id);
  return e && e.type === "track" ? (e as Track) : null;
}

export function getAlbum(id: string): AlbumData | null {
  const e = _byId.value.get(id);
  return e && e.type === "album" ? (e as AlbumData) : null;
}

/** Children of an Album, in declared order; silently skips missing ids. */
export function getTracksOfAlbum(album: AlbumData | null | undefined): Track[] {
  if (!album?.trackIds) return [];
  const out: Track[] = [];
  for (const id of album.trackIds) {
    const t = getTrack(id);
    if (t) out.push(t);
  }
  return out;
}

/** Expensive — copy of every value. Use sparingly. */
export function allEntities(): Entity[] {
  return Array.from(_byId.value.values());
}

export function clearEntities(): void {
  if (_byId.value.size === 0) return;
  _byId.value.clear();
  bump();
}
