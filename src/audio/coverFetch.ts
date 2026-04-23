/**
 * iTunes Search API — album cover art for SoulSeek tracks.
 * Groups by album (one request per unique artist+album), 1.1s throttle.
 */

export interface AlbumCoverResult {
  artist: string;
  album: string;
  coverUrl: string | null;
  albumUrl: string | null;
}

const cache = new Map<string, AlbumCoverResult | null>();

let lastSent = 0;
interface PendingItem { artist: string; album: string; resolve: (v: AlbumCoverResult | null) => void }
const pending: PendingItem[] = [];
let draining = false;

function enqueue(artist: string, album: string): Promise<AlbumCoverResult | null> {
  return new Promise<AlbumCoverResult | null>((resolve) => {
    pending.push({ artist, album, resolve });
    if (!draining) void drain();
  });
}

interface ITunesHit {
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
  collectionViewUrl?: string;
  [k: string]: unknown;
}

async function drain(): Promise<void> {
  draining = true;
  while (pending.length) {
    const gap = lastSent + 1100 - Date.now();
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    const { artist, album, resolve } = pending.shift()!;
    lastSent = Date.now();
    try {
      const q = encodeURIComponent(`${artist} ${album}`);
      const r = await fetch(
        `https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=5`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (!r.ok) { resolve(null); continue; }
      const data = await r.json();
      const hits: ITunesHit[] = data.results ?? [];
      const hit = hits.find((h) => {
        const col = (h.collectionName ?? "").toLowerCase();
        return col.includes(album.toLowerCase().slice(0, 6));
      }) ?? hits[0];
      if (!hit) { resolve(null); continue; }
      resolve({
        artist:   hit.artistName ?? artist,
        album:    hit.collectionName ?? album,
        coverUrl: hit.artworkUrl100?.replace(/\d+x\d+bb/, "600x600bb") ?? null,
        albumUrl: hit.collectionViewUrl ?? null,
      });
    } catch {
      resolve(null);
    }
  }
  draining = false;
}

export async function fetchAlbumCover(artist: string, album: string): Promise<AlbumCoverResult | null> {
  if (!artist || !album || artist.length < 2 || album.length < 2) return null;
  const key = `${artist.toLowerCase()}\0${album.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = await enqueue(artist, album);
  cache.set(key, result);
  return result;
}
