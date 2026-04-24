/**
 * Global entity registry — one source of truth for every Track / Album
 * the user has ever touched (search feed, likes, playlists, queue).
 *
 * Both Track and Album are class-backed; providers emit plain data and the
 * registry hydrates on `registerEntity(...)`. Queue, likes, playlists store
 * ids and resolve here.
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
import type { Album } from "../album/Album.js";
import type { AlbumData } from "../album/types.js";
import { buildAlbum } from "../album/factory.js";
import { putTrack } from "../persistence/trackCache.js";

// Re-export AlbumData so existing consumers don't have to chase a new path.
export type { AlbumData } from "../album/types.js";

export type Entity = Track | Album;

const _byId = shallowRef<Map<string, Entity>>(new Map());
export const entitiesVersion = shallowRef(0);

function bump(): void {
  triggerRef(_byId);
  entitiesVersion.value += 1;
}

/** Exposed for external mutations to Track/Album internals (e.g. Deezer
 *  stamping canonical names on an already-registered track). */
export function bumpEntitiesVersion(): void {
  bump();
}

/** Coerce raw data to a class instance when needed. */
function normalize(entity: Track | TrackData | Album | AlbumData): Entity | null {
  if (!entity) return null;
  if (entity.type === "album") {
    // Already an instance? `coverUrl` is a method on classes, a string/null on data.
    const asAlbum = entity as Partial<Album>;
    if (typeof asAlbum.coverUrl === "function") return asAlbum as Album;
    return buildAlbum(entity as AlbumData);
  }
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
export function registerEntity(entity: Track | TrackData | Album | AlbumData | null | undefined): void {
  if (!entity) return;
  const norm = normalize(entity);
  if (!norm?.id) return;
  _byId.value.set(norm.id, norm);
  if (norm.type === "track") putTrack(norm);
  bump();
}

/**
 * Register a batch — single reactivity bump. Returns the normalized entities
 * in input order (class instances), so callers that need them don't have to
 * re-lookup by id.
 */
export function registerEntities(entities: Array<Track | TrackData | Album | AlbumData>): Entity[] {
  if (!entities?.length) return [];
  const out: Entity[] = [];
  const tracksForCache: Track[] = [];
  for (const e of entities) {
    const norm = normalize(e);
    if (!norm?.id) continue;
    _byId.value.set(norm.id, norm);
    if (norm.type === "track") tracksForCache.push(norm);
    out.push(norm);
  }
  for (const t of tracksForCache) putTrack(t);
  bump();
  return out;
}

export function getEntity(id: string): Entity | null {
  return _byId.value.get(id) ?? null;
}

export function getTrack(id: string): Track | null {
  const e = _byId.value.get(id);
  return e && e.type === "track" ? (e as Track) : null;
}

export function getAlbum(id: string): Album | null {
  const e = _byId.value.get(id);
  return e && e.type === "album" ? (e as Album) : null;
}

/** Children of an Album, in declared order; silently skips missing ids. */
export function getTracksOfAlbum(album: Album | AlbumData | null | undefined): Track[] {
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
