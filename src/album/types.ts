/**
 * Type contracts for the Album class hierarchy. Mirrors `src/track/types.ts`.
 *
 * Album provenance is the same per-provider discriminator used by Track, but
 * with album-flavoured refs (folder / topic root path) and a raw payload that
 * carries provider-specific metadata (topic row, sub-album descriptor, folder
 * cover candidate).
 */

import type { ProviderKind } from "../track/types.js";

export interface RutrackerAlbumRefs {
  topicId: string;
  rootPath?: string;
}

export interface SoulseekAlbumRefs {
  slskUsername: string;
  slskFolder: string;
}

export interface SlskAlbumCoverRef {
  slsk_username?: string;
  slsk_filepath?: string;
  size?: number;
}

export interface AlbumSourceBase<K extends ProviderKind, R> {
  kind: K;
  refs: R;
  raw?: unknown;
}

export type RutrackerAlbumSource = AlbumSourceBase<"rutracker", RutrackerAlbumRefs> & {
  raw?: {
    topicRow?: { id?: string | number; name?: string; seeders?: number | null; leechers?: number | null };
    details?: { artist?: string | null; magnet?: string; cover_data_url?: string | null };
    albumDir?: unknown;
    /** One forum topic yielded several folder-albums — topic cover is not per-folder. */
    multiAlbumTopic?: boolean;
    /** Artist guess for catalog lookups; falls back to topic dir tree when post-meta is empty. */
    coverArtist?: string | null;
    /** Album title cleaned for catalog lookups (year prefix / EP / CD-disc suffixes stripped). */
    coverAlbumTitle?: string | null;
    [k: string]: unknown;
  };
};

export type SoulseekAlbumSource = AlbumSourceBase<"soulseek", SoulseekAlbumRefs> & {
  raw?: {
    cover?: SlskAlbumCoverRef | null;
    tracks?: unknown[];
    kind?: string;
    [k: string]: unknown;
  };
};

export type AlbumSource = RutrackerAlbumSource | SoulseekAlbumSource;

/**
 * Shape emitted by search providers / album factories. Intermediate — Album
 * subclasses consume this and expose typed accessors.
 */
export interface AlbumData {
  type: "album";
  id: string;
  title: string;
  artist: string | null;
  trackIds: string[];
  peers?: number | null;
  seeders?: number | null;
  leechers?: number | null;
  coverUrl?: string | null;
  format?: string | null;
  bitrate?: number | null;
  size?: number | null;
  year?: number | null;
  sources?: AlbumSource[];
  score?: number;
  mergedFrom?: number;
}
