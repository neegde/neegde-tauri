/**
 * iTunes Search API — album cover art for SoulSeek tracks.
 * Groups by album (one request per unique artist+album), 1.1s throttle.
 */

import { RateLimitedFetchQueue } from "../lib/RateLimitedFetchQueue.js";

export interface AlbumCoverResult {
  artist: string;
  album: string;
  coverUrl: string | null;
  albumUrl: string | null;
}

const cache = new Map<string, AlbumCoverResult | null>();

interface ITunesHit {
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
  collectionViewUrl?: string;
  [k: string]: unknown;
}

const queue = new RateLimitedFetchQueue<{ artist: string; album: string }, AlbumCoverResult | null>({
  intervalMs: 1100,
  executor: async ({ artist, album }) => {
    const q = encodeURIComponent(`${artist} ${album}`);
    const r = await fetch(
      `https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=5`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return null;
    const data = await r.json();
    const hits: ITunesHit[] = data.results ?? [];
    const hit = hits.find((h) => {
      const col = (h.collectionName ?? "").toLowerCase();
      return col.includes(album.toLowerCase().slice(0, 6));
    }) ?? hits[0];
    if (!hit) return null;
    return {
      artist:   hit.artistName ?? artist,
      album:    hit.collectionName ?? album,
      coverUrl: hit.artworkUrl100?.replace(/\d+x\d+bb/, "600x600bb") ?? null,
      albumUrl: hit.collectionViewUrl ?? null,
    };
  },
});

export async function fetchAlbumCover(artist: string, album: string): Promise<AlbumCoverResult | null> {
  if (!artist || !album || artist.length < 2 || album.length < 2) return null;
  const key = `${artist.toLowerCase()}\0${album.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let result: AlbumCoverResult | null;
  try {
    result = await queue.enqueue({ artist, album });
  } catch {
    result = null;
  }
  cache.set(key, result);
  return result;
}
