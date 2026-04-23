/**
 * Abstract Track — base of the per-source class hierarchy.
 *
 * Subclasses: `RutrackerTrack`, `SoulseekTrack`, `MagnetTrack`.
 *
 * The class wraps the raw `TrackData` that providers / persistence emit and
 * exposes a stable API: playback, cover, row adapters, navigation targets.
 * Vue `reactive()` over a class instance works fine — reads track fields
 * like `.title` through the proxy and tracks them as reactive deps.
 *
 * Never instantiate a `Track` directly; call `Track.from(data)` which
 * dispatches to the correct subclass by `data.sources[0].kind`.
 */

import type {
  TrackData,
  TrackSource,
  ProviderKind,
  NavigationTarget,
} from "./types.js";

export abstract class Track {
  readonly type = "track" as const;

  constructor(protected readonly data: TrackData) {}

  // ── Identity ──────────────────────────────────────────────────────────────

  get id(): string            { return this.data.id; }
  get title(): string         { return this.data.title; }
  get artist(): string | null { return this.data.artist; }
  get albumId(): string | null { return this.data.albumId; }
  get albumTitle(): string | null { return this.data.albumTitle ?? null; }
  get fileName(): string      { return this.data.fileName; }
  get size(): number | null   { return this.data.size; }
  get bitrate(): number | null { return this.data.bitrate; }
  get duration(): number | null { return this.data.duration; }
  get format(): string | null { return this.data.format; }

  /** Source kind — the discriminator that drove subclass selection. */
  get kind(): ProviderKind { return this.data.sources[0].kind; }
  /** Primary source record — subclass-specific refs live here. */
  protected get source(): TrackSource { return this.data.sources[0]; }
  /**
   * Public sources array. Only exposed because some legacy consumers still
   * peek into `sources[0].raw` (SlskTrackRow peers count, debug logs).
   * Prefer dedicated accessors (`coverUrl()`, etc.) in new code.
   */
  get sources(): readonly TrackSource[] { return this.data.sources; }

  // ── Behavior (subclass-specific) ──────────────────────────────────────────

  /**
   * Resolve a playable URL for this track. The return value is a live URL
   * served by the backend; caller is responsible for `releaseStream()` once
   * the audio element moves on, so the backend can recycle its token.
   */
  abstract prepareStream(): Promise<string>;

  /** Whether {@link prepareStream} can be meaningfully invoked right now. */
  abstract hasPlaybackIdentity(): boolean;

  /** Prompt the user for a destination and write this track to disk. */
  abstract exportToDisk(onProgress?: (p: unknown) => void): Promise<void>;

  /**
   * Payload for the "open source of this track" action — consumers decide
   * what to do with it (navigate to torrent detail, open peer browse, …).
   */
  abstract navigationTarget(): NavigationTarget | null;

  /**
   * Current cover URL if cached (positive), else `null`. Reads reactive
   * sources so invoking inside a Vue `computed` auto-tracks cache updates.
   */
  abstract coverUrl(): string | null;

  /** Kick a lazy cover fetch. Noop when already cached / in flight. */
  abstract startCoverFetch(): void;

  // ── Serialization ─────────────────────────────────────────────────────────

  /**
   * Plain-object snapshot — the *only* serialization path. Persistence layer
   * stores this; `buildTrack()` re-hydrates on read. There are no separate
   * "row" shapes for likes / playlists / queue; everything references a
   * Track by `id` and resolves via the entities registry / trackCache.
   */
  toJSON(): TrackData { return this.data; }
}
