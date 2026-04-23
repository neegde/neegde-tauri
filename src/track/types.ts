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

export interface SourceBase<K extends ProviderKind, R> {
  kind: K;
  refs: R;
  raw?: unknown;
}

export type TrackSource =
  | SourceBase<"rutracker", RutrackerRefs>
  | SourceBase<"soulseek", SoulseekRefs>
  | SourceBase<"magnet", MagnetRefs>;

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

export interface NavigationTarget {
  torrentId: string;
  torrentName: string;
  source: ProviderKind;
  magnet: string;
  fileIdx: number;
  albumDirPath: string | null;
  artist?: string | null;
  seeders?: number | null;
  slskUsername?: string;
  slskFilepath?: string | null;
}
