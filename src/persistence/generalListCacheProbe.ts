/**
 * Pure cache-probing helpers for GeneralList entries.
 *
 * Deliberately does NOT import from stores/entities or track/deezerCanonical
 * to avoid a circular module dependency. Deezer key normalization is inlined
 * from the same algorithm used in deezerCanonical.ts.
 */

import type { TrackData, RutrackerRefs, SoulseekRefs, SoulseekTrackRaw } from "../track/types.js";
import type { GeneralListCacheKeys, GeneralListCache, CacheEntry } from "./generalList.js";
import { trackCache } from "./trackCache.js";
import { getMirror } from "../rutracker/config.js";
import { peekSlskCover, slskCoverKey } from "../soulseek/coverCache.js";
import {
  probeRutrackerCoverLru,
  probeDeezerCanonicalLru,
  probeDeezerAlbumArtLru,
} from "./coverArtLocal.js";

const TORRENT_B64_PREFIX = "torrent_file_b64_v1_";

function normalizeDeezer(s: string): string {
  return s.trim().toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");
}

function deezerCanonKey(artist: string, title: string): string {
  return `${normalizeDeezer(artist)}|${normalizeDeezer(title)}`;
}

function deezerAlbumKey(artist: string, album: string): string {
  return `deezer-album-art|${normalizeDeezer(artist || "_")}|${normalizeDeezer(album)}`;
}

/**
 * Builds the set of logical cache keys for all caches that may hold data
 * for the given track. Keys are stable identifiers — not hashed slot IDs.
 *
 * @param data - TrackData to derive keys from.
 * @returns Logical cache key record for every relevant layer.
 */
export function buildCacheKeys(data: TrackData): GeneralListCacheKeys {
  const kind = data.sources[0].kind;
  const artist = data.artist ?? "";
  const albumTitle = data.albumTitle ?? "";

  const deezerCanonical = artist || data.title
    ? deezerCanonKey(artist, data.title)
    : undefined;
  const deezerAlbumArt = albumTitle
    ? deezerAlbumKey(artist, albumTitle)
    : undefined;

  if (kind === "rutracker" || kind === "magnet") {
    const refs = data.sources[0].refs as RutrackerRefs;
    const topicId = refs.topicId ?? null;
    return {
      trackCacheId: data.id,
      rutrackerTopicCover: topicId ? `${getMirror()}\n${topicId}` : undefined,
      deezerCanonical,
      deezerAlbumArt,
      torrentFileB64: topicId ?? undefined,
      streamIdentity: {
        magnet: refs.magnet || undefined,
        fileIdx: refs.fileIdx,
      },
    };
  }

  const refs = data.sources[0].refs as SoulseekRefs;
  const raw = data.sources[0].raw as SoulseekTrackRaw | undefined;
  const cover = raw?.cover ?? null;
  return {
    trackCacheId: data.id,
    deezerCanonical,
    deezerAlbumArt,
    soulseekCover:
      cover?.slsk_username && cover?.slsk_filepath
        ? slskCoverKey(cover.slsk_username, cover.slsk_filepath)
        : undefined,
    streamIdentity: {
      slskUsername: refs.slskUsername || undefined,
      slskFilepath: refs.slskFilepath || undefined,
    },
  };
}

function missEntry(layer: string, storage: CacheEntry["storage"]): CacheEntry {
  return { state: "miss", layer, storage };
}

function inlinedCoverKind(url: string): "data_url" | "https" | "other" {
  if (url.startsWith("data:")) return "data_url";
  if (url.startsWith("https://") || url.startsWith("http://")) return "https";
  return "other";
}

/**
 * Snapshots the state of every relevant cache layer for the given track.
 *
 * @param data - TrackData to probe.
 * @param keys - Pre-built cache keys from {@link buildCacheKeys}.
 * @returns GeneralListCache snapshot with capturedAt = Date.now().
 */
export function probeCache(data: TrackData, keys: GeneralListCacheKeys): GeneralListCache {
  const now = Date.now();
  const kind = data.sources[0].kind;

  // ── trackCache ────────────────────────────────────────────────────────────
  const tc = trackCache.get(data.id);
  const trackCacheEntry: CacheEntry = tc
    ? {
        state: "hit",
        layer: "track_cache",
        storage: "localStorage",
        storageKey: "neegde.trackCache.v1",
        payloadHint: tc.coverUrl ? `coverUrl=${tc.coverUrl.slice(0, 80)}` : undefined,
      }
    : missEntry("track_cache", "localStorage");

  // ── inlined cover on TrackData ────────────────────────────────────────────
  const rawCoverUrl = data.coverUrl ?? null;
  const inlinedOnTrack = rawCoverUrl
    ? { present: true as const, kind: inlinedCoverKind(rawCoverUrl) }
    : undefined;

  const result: GeneralListCache = { capturedAt: now, trackCache: trackCacheEntry };

  // ── Deezer enrichment (shared by all kinds) ───────────────────────────────
  const enrichment: GeneralListCache["enrichment"] = {};

  if (keys.deezerCanonical) {
    const hit = probeDeezerCanonicalLru(keys.deezerCanonical);
    enrichment.deezerCanonical = hit
      ? {
          state: "hit",
          layer: "dz_track_canon_local",
          storage: "localStorage",
          storageKey: "neegde.dzTrackCanon.v1.*",
        }
      : missEntry("dz_track_canon_local", "localStorage");
  }

  if (keys.deezerAlbumArt) {
    const hit = probeDeezerAlbumArtLru(keys.deezerAlbumArt);
    enrichment.deezerAlbumArt = hit
      ? {
          state: "hit",
          layer: "dz_album_art_local",
          storage: "localStorage",
          storageKey: "neegde.dzAlbumArt.v1.*",
        }
      : missEntry("dz_album_art_local", "localStorage");
  }

  if (enrichment.deezerCanonical || enrichment.deezerAlbumArt) {
    result.enrichment = enrichment;
  }

  // ── Per-kind cache layers ─────────────────────────────────────────────────
  if (kind === "rutracker" || kind === "magnet") {
    const refs = data.sources[0].refs as RutrackerRefs;
    const topicId = refs.topicId ?? null;

    let rutrackerTopic: CacheEntry | undefined;
    if (topicId && keys.rutrackerTopicCover) {
      const hit = probeRutrackerCoverLru(keys.rutrackerTopicCover);
      if (hit) {
        const raw = localStorage.getItem(`neegde.rtCover.v1.`);
        void raw; // key is hashed; we can't read back easily — just report state
        rutrackerTopic = {
          state: "hit",
          layer: "rt_cover_local",
          storage: "localStorage",
          storageKey: "neegde.rtCover.v1.*",
        };
      } else {
        rutrackerTopic = missEntry("rt_cover_local", "localStorage");
      }
    }

    result.covers = { rutrackerTopic, inlinedOnTrack };

    if (topicId) {
      const b64raw = localStorage.getItem(`${TORRENT_B64_PREFIX}${topicId}`);
      result.torrent = {
        fileListB64: b64raw
          ? {
              state: "hit",
              layer: "torrent_file_b64",
              storage: "localStorage",
              storageKey: `${TORRENT_B64_PREFIX}${topicId}`,
              bytesApprox: b64raw.length,
            }
          : missEntry("torrent_file_b64", "localStorage"),
      };
    }

    result.streaming = {
      backendDiskCache: "partial",
      note: "bytes on disk depend on playback; refresh via vozduxan_stream_stats if needed",
    };
  } else {
    // soulseek
    const raw = data.sources[0].raw as SoulseekTrackRaw | undefined;
    const cover = raw?.cover ?? null;
    let soulseekFile: CacheEntry | undefined;

    if (cover?.slsk_username && cover?.slsk_filepath) {
      const peek = peekSlskCover(cover.slsk_username, cover.slsk_filepath);
      if (typeof peek === "string") {
        soulseekFile = {
          state: "hit",
          layer: "slsk_cover_rust_disk",
          storage: "rust_disk",
          payloadHint: `${peek.slice(0, 40)}…(truncated)`,
        };
      } else {
        soulseekFile = missEntry("slsk_cover_rust_disk", "rust_disk");
      }
    }

    result.covers = { soulseekFile, inlinedOnTrack };
    result.streaming = {
      backendDiskCache: "unknown",
      note: "SLSK stream is peer P2P; vozduxan disk cache N/A",
    };
  }

  return result;
}
