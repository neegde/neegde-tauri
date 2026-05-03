/**
 * Abstract Album — base of the per-source class hierarchy. Mirrors Track.
 *
 * Subclasses: `RutrackerAlbum`, `SoulseekAlbum`.
 *
 * The class wraps the raw `AlbumData` that providers / persistence emit and
 * exposes a stable API: cover resolution, cover prefetch, identity.
 * Never instantiate directly; use `buildAlbum(data)` which dispatches to
 * the correct subclass by `data.sources[0].kind`.
 */

import type { AlbumData, AlbumSource } from "./types.js";
import type { ProviderKind } from "../track/types.js";

export abstract class Album {
  readonly type = "album" as const;

  constructor(protected readonly data: AlbumData) {}

  // ── Identity ──────────────────────────────────────────────────────────────

  get id(): string              { return this.data.id; }
  get title(): string           { return this.data.title; }
  get artist(): string | null   { return this.data.artist; }
  get trackIds(): string[]      { return this.data.trackIds; }
  get peers(): number | null    { return this.data.peers ?? null; }
  get seeders(): number | null  { return this.data.seeders ?? null; }
  get leechers(): number | null { return this.data.leechers ?? null; }
  get format(): string | null   { return this.data.format ?? null; }
  get bitrate(): number | null  { return this.data.bitrate ?? null; }
  get size(): number | null     { return this.data.size ?? null; }
  get year(): number | null     { return this.data.year ?? null; }

  /** Source kind — the discriminator that drove subclass selection. */
  get kind(): ProviderKind { return this.source.kind; }

  /** Primary source record — subclass-specific refs live here. */
  protected get source(): AlbumSource {
    const s = this.data.sources?.[0];
    if (!s) throw new Error(`Album "${this.data.id}" has no source record`);
    return s;
  }

  /** Public sources — kept for legacy consumers (App.vue still peeks at RT topicId). */
  get sources(): readonly AlbumSource[] { return this.data.sources ?? []; }

  // ── Behavior (subclass-specific) ──────────────────────────────────────────

  /**
   * Current cover URL if cached (positive), else `null`. Reads reactive
   * sources so invoking inside a Vue `computed` auto-tracks cache updates.
   * Static `data.coverUrl` (set by the resolver) takes priority.
   */
  abstract coverUrl(): string | null;

  /** Kick a lazy cover fetch. Noop when already cached / in flight. */
  abstract startCoverFetch(signal?: AbortSignal): void;

  // ── Serialization ─────────────────────────────────────────────────────────

  /** Plain-object snapshot. Same contract as Track.toJSON(). */
  toJSON(): AlbumData { return this.data; }
}
