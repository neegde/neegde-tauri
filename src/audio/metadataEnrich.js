/**
 * Non-blocking track metadata enrichment via iTunes Search API.
 * Fires after playback starts — does NOT delay streaming.
 */

const cache = new Map();

/**
 * Look up artist + title on iTunes and call onResult with cleaner metadata.
 * Silent on network errors / no match.
 *
 * @param {string} artist
 * @param {string} title
 * @param {(result: { artist: string, album: string, title: string, coverUrl: string }) => void} onResult
 */
export async function enrichTrackMeta(artist, title, onResult) {
  if (!artist || !title || artist.length < 2 || title.length < 2) return;

  const key = `track\0${artist.toLowerCase()}\0${title.toLowerCase()}`;
  if (cache.has(key)) {
    const cached = cache.get(key);
    if (cached) onResult(cached);
    return;
  }

  const q = encodeURIComponent(`${artist} ${title}`);
  try {
    const r = await fetch(
      `https://itunes.apple.com/search?term=${q}&media=music&limit=3&entity=song`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return;
    const data = await r.json();
    const hit = data.results?.[0];
    if (!hit) {
      cache.set(key, null);
      return;
    }
    const result = {
      artist: hit.artistName ?? artist,
      album: hit.collectionName ?? "",
      title: hit.trackName ?? title,
      coverUrl: hit.artworkUrl100?.replace(/\d+x\d+bb/, "600x600bb") ?? null,
    };
    cache.set(key, result);
    onResult(result);
  } catch {
    /* timeout / offline — silently ignore */
  }
}

/**
 * Two-step iTunes lookup for a full album tracklist.
 * Step 1: search album by artist + name → get collectionId.
 * Step 2: lookup all songs in that collection.
 *
 * @param {string} artist
 * @param {string} albumName
 * @returns {Promise<{ artist: string, album: string, coverUrl: string|null, tracksByNumber: Map<number,string> }|null>}
 */
export async function enrichAlbumTracklist(artist, albumName) {
  if (!artist || !albumName || artist.length < 2 || albumName.length < 2) return null;

  const key = `album\0${artist.toLowerCase()}\0${albumName.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);

  const q = encodeURIComponent(`${artist} ${albumName}`);
  try {
    // Step 1: find the album
    const r1 = await fetch(
      `https://itunes.apple.com/search?term=${q}&media=music&entity=album&limit=1`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r1.ok) return null;
    const d1 = await r1.json();
    const albumHit = d1.results?.[0];
    if (!albumHit?.collectionId) { cache.set(key, null); return null; }

    // Step 2: get all tracks in that album
    const r2 = await fetch(
      `https://itunes.apple.com/lookup?id=${albumHit.collectionId}&entity=song`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r2.ok) return null;
    const d2 = await r2.json();

    const tracksByNumber = new Map();
    for (const t of d2.results ?? []) {
      if (t.wrapperType === "track" && t.trackNumber != null && t.trackName) {
        tracksByNumber.set(t.trackNumber, t.trackName);
      }
    }

    const result = {
      artist: albumHit.artistName ?? artist,
      album: albumHit.collectionName ?? albumName,
      coverUrl: albumHit.artworkUrl100?.replace(/\d+x\d+bb/, "600x600bb") ?? null,
      tracksByNumber,
    };
    cache.set(key, result);
    return result;
  } catch {
    return null;
  }
}
