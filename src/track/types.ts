/**
 * Type contracts for the Track class hierarchy.
 *
 * The *data* shape a backend / provider emits, and the *row* shapes the
 * persisted stores still expect. Classes consume `TrackData` and emit rows.
 */

export type ProviderKind = "rutracker" | "soulseek" | "magnet";

export interface RutrackerRefs {
  topicId: string | null;
  magnet: string;
  fileIdx: number;
  coverFileIdx: number | null;
  albumDirPath: string | null;
}

export interface SoulseekRefs {
  slskUsername: string;
  slskFilepath: string;
  slskFolder?: string;
}

export interface MagnetRefs {
  magnet: string;
  fileIdx: number;
  coverFileIdx: number | null;
  albumDirPath: string | null;
}

/** Cover ref shape stamped by the SoulSeek search provider. */
export interface SlskTrackCoverRef {
  slsk_username?: string;
  slsk_filepath?: string;
  size?: number;
}

export interface RutrackerTrackRaw {
  topicRow?: { id?: string | number; name?: string; [k: string]: unknown };
  details?: { magnet?: string; artist?: string | null; [k: string]: unknown };
  file?: unknown;
  [k: string]: unknown;
}

/**
 * Alternative SLSK peer for a singleton track. The provider stores up to
 * ~5 of these alongside the primary ref so {@link SoulseekTrack.prepareStream}
 * can fail over to another seed when the primary is down.
 */
export interface SlskAltPeer {
  slskUsername: string;
  slskFilepath: string;
  size?: number;
}

export interface SoulseekTrackRaw {
  row?: unknown;
  cover?: SlskTrackCoverRef | null;
  peers?: number;
  /** Backup peers (same track, different seed) tried in order on failure. */
  alternativePeers?: SlskAltPeer[];
  [k: string]: unknown;
}

export interface SourceBase<K extends ProviderKind, R, Raw = unknown> {
  kind: K;
  refs: R;
  raw?: Raw;
}

export type RutrackerTrackSource = SourceBase<"rutracker", RutrackerRefs, RutrackerTrackRaw>;
export type SoulseekTrackSource  = SourceBase<"soulseek",  SoulseekRefs,  SoulseekTrackRaw>;
export type MagnetTrackSource    = SourceBase<"magnet",    MagnetRefs,    RutrackerTrackRaw>;

export type TrackSource = RutrackerTrackSource | SoulseekTrackSource | MagnetTrackSource;

/**
 * Shape emitted by search providers / entity factories. Intermediate — Track
 * subclasses consume this and expose typed accessors.
 */
export interface TrackData {
  type: "track";
  id: string;
  title: string;
  artist: string | null;
  albumTitle?: string | null;
  albumId: string | null;
  fileName: string;
  format: string | null;
  bitrate: number | null;
  duration: number | null;
  size: number | null;
  coverUrl?: string | null;
  sources: [TrackSource, ...TrackSource[]];
  score?: number;
  mergedFrom?: number;
}

/**
 * Payload forwarded by a Track's `navigationTarget()` to the "open source"
 * bridge in App.vue. Discriminated by `source`:
 *
 *   - RuTracker / magnet → needs a torrent id + magnet + file index so the
 *     app can navigate to the torrent detail view and scope to the right
 *     album folder.
 *   - SoulSeek → needs a peer login (and optionally a filepath) so the app
 *     can kick off a user-browse search. None of the RT-shaped fields apply.
 */
export interface RutrackerNavigationTarget {
  source: "rutracker" | "magnet";
  torrentId: string;
  torrentName: string;
  magnet: string;
  fileIdx: number;
  albumDirPath: string | null;
  artist?: string | null;
  seeders?: number | string | null;
}

export interface SoulseekNavigationTarget {
  source: "soulseek";
  slskUsername: string;
  slskFilepath: string | null;
}

export type NavigationTarget =
  | RutrackerNavigationTarget
  | SoulseekNavigationTarget;
