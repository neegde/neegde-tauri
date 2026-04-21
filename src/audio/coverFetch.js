/**
 * iTunes Search API — album cover art for SoulSeek tracks.
 * Groups by album (one request per unique artist+album), 1.1s throttle.
 * No registration required.
 */

const cache = new Map();

let lastSent = 0;
const pending = [];
let draining = false;

function enqueue(artist, album) {
  return new Promise((resolve) => {
    pending.push({ artist, album, resolve });
    if (!draining) drain();
  });
}

async function drain() {
  draining = true;
  while (pending.length) {
    const gap = lastSent + 1100 - Date.now();
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    const { artist, album, resolve } = pending.shift();
    lastSent = Date.now();
    try {
      const q = encodeURIComponent(`${artist} ${album}`);
      const r = await fetch(
        `https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=5`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (!r.ok) { resolve(null); continue; }
      const data = await r.json();
      // Pick the hit whose collection name best matches the album we searched for
      const hits = data.results ?? [];
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

/**
 * Fetch cover + Apple Music album link for an artist + album name.
 * Call once per folder (album), not per track.
 *
 * @param {string} artist
 * @param {string} album  — album/folder name used as search hint
 * @returns {Promise<{ artist, album, coverUrl, albumUrl } | null>}
 */
export async function fetchAlbumCover(artist, album) {
  if (!artist || !album || artist.length < 2 || album.length < 2) return null;
  const key = `${artist.toLowerCase()}\0${album.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  const result = await enqueue(artist, album);
  cache.set(key, result);
  return result;
}
