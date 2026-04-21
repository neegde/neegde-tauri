/**
 * Non-blocking track metadata enrichment via MusicBrainz API.
 * Replaces iTunes Search API — works from Russia, no registration required.
 * Rate-limited to 1 req/sec per MusicBrainz ToS.
 */

const MB  = "https://musicbrainz.org/ws/2";
const CAA = "https://coverartarchive.org";

const cache = new Map();

// ── Rate limiter: ≤1 req/sec ─────────────────────────────────────────────────

let lastSent = 0;
const pending = [];
let draining = false;

function enqueue(url) {
  return new Promise((resolve, reject) => {
    pending.push({ url, resolve, reject });
    if (!draining) drain();
  });
}

async function drain() {
  draining = true;
  while (pending.length) {
    const gap = lastSent + 1050 - Date.now();
    if (gap > 0) await sleep(gap);
    const task = pending.shift();
    lastSent = Date.now();
    try {
      const r = await fetch(task.url, {
        signal: AbortSignal.timeout(9000),
        headers: { Accept: "application/json" },
      });
      task.resolve(r);
    } catch (e) {
      task.reject(e);
    }
  }
  draining = false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function mbGet(url) {
  try {
    const r = await enqueue(url);
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

/** Escape Lucene special chars and wrap in quotes for MusicBrainz search. */
function enc(s) {
  return encodeURIComponent(`"${s.replace(/["\\]/g, "\\$&")}"`);
}

/**
 * coverartarchive.org 307-redirects to the actual image;
 * browsers follow it automatically in <img> src.
 */
function caaFront(mbid) {
  return `${CAA}/release/${mbid}/front-250`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up artist + title on MusicBrainz and call onResult with cleaner metadata.
 * Silent on network errors / no match.
 *
 * @param {string} artist
 * @param {string} title
 * @param {(r: { artist: string, album: string, title: string, coverUrl: string|null }) => void} onResult
 */
export async function enrichTrackMeta(artist, title, onResult) {
  if (!artist || !title || artist.length < 2 || title.length < 2) return;

  const key = `track\0${artist.toLowerCase()}\0${title.toLowerCase()}`;
  if (cache.has(key)) {
    const cached = cache.get(key);
    if (cached) onResult(cached);
    return;
  }

  const url = `${MB}/recording/?query=artist:${enc(artist)}+AND+recording:${enc(title)}&fmt=json&limit=3`;
  const data = await mbGet(url);
  const hit = data?.recordings?.[0];
  if (!hit) { cache.set(key, null); return; }

  const mbid = hit.releases?.[0]?.id ?? null;
  const result = {
    artist:   hit["artist-credit"]?.[0]?.artist?.name ?? artist,
    album:    hit.releases?.[0]?.title ?? "",
    title:    hit.title ?? title,
    coverUrl: mbid ? caaFront(mbid) : null,
  };
  cache.set(key, result);
  onResult(result);
}

/**
 * Two-step MusicBrainz lookup for a full album tracklist.
 * Step 1: search release by artist + name → get MBID.
 * Step 2: lookup release with recordings.
 *
 * @param {string} artist
 * @param {string} albumName
 * @returns {Promise<{ artist: string, album: string, coverUrl: string|null, tracksByNumber: Map<number,string> }|null>}
 */
export async function enrichAlbumTracklist(artist, albumName) {
  if (!artist || !albumName || artist.length < 2 || albumName.length < 2) return null;

  const key = `album\0${artist.toLowerCase()}\0${albumName.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);

  // Step 1: find the release
  const url1 = `${MB}/release/?query=artist:${enc(artist)}+AND+release:${enc(albumName)}&fmt=json&limit=1`;
  const d1 = await mbGet(url1);
  const rel = d1?.releases?.[0];
  if (!rel?.id) { cache.set(key, null); return null; }

  // Step 2: get recordings for this release
  const url2 = `${MB}/release/${rel.id}?inc=recordings&fmt=json`;
  const d2 = await mbGet(url2);
  if (!d2) { cache.set(key, null); return null; }

  const tracksByNumber = new Map();
  for (const medium of d2.media ?? []) {
    for (const t of medium.tracks ?? []) {
      const num = t.position ?? Number(t.number);
      if (num != null && t.recording?.title) {
        tracksByNumber.set(num, t.recording.title);
      }
    }
  }

  const result = {
    artist:        d2["artist-credit"]?.[0]?.artist?.name
                ?? rel["artist-credit"]?.[0]?.artist?.name
                ?? artist,
    album:         d2.title ?? albumName,
    coverUrl:      caaFront(rel.id),
    tracksByNumber,
  };
  cache.set(key, result);
  return result;
}
