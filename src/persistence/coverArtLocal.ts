/**
 * localStorage-backed LRU for cover-related blobs (RuTracker data URLs,
 * Deezer album HTTPS URLs, Deezer track canonical JSON). Survives app restarts.
 *
 * RuTracker entries are large — keep a small cap. Deezer URLs are tiny —
 * allow a larger cap.
 */

const SEP = "\u0001";

const RT_MANIFEST = "neegde.rtCover.manifest.v1";
const RT_PREFIX = "neegde.rtCover.v1.";
const RT_MAX = 36;

const DZ_ALBUM_MANIFEST = "neegde.dzAlbumArt.manifest.v1";
const DZ_ALBUM_PREFIX = "neegde.dzAlbumArt.v1.";
const DZ_ALBUM_MAX = 800;

const DZ_CANON_MANIFEST = "neegde.dzTrackCanon.manifest.v1";
const DZ_CANON_PREFIX = "neegde.dzTrackCanon.v1.";
const DZ_CANON_MAX = 600;

/** True while hydrating RuTracker positives from disk — skips re-persist. */
let skipRutrackerPersist = false;

function fnv1aSlotId(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(36);
}

function readManifest(manifestKey: string): string[] {
  try {
    const raw = localStorage.getItem(manifestKey);
    if (!raw) return [];
    const p = JSON.parse(raw) as unknown;
    if (!Array.isArray(p)) return [];
    return p.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function writeManifest(manifestKey: string, order: string[]): void {
  try {
    localStorage.setItem(manifestKey, JSON.stringify(order));
  } catch {
    /* quota / disabled */
  }
}

function touchLru(
  manifestKey: string,
  prefix: string,
  slotId: string,
  composite: string,
  max: number,
): void {
  try {
    localStorage.setItem(prefix + slotId, composite);
    let order = readManifest(manifestKey).filter((x) => x !== slotId);
    order.unshift(slotId);
    while (order.length > max) {
      const drop = order.pop();
      if (drop) localStorage.removeItem(prefix + drop);
    }
    writeManifest(manifestKey, order);
  } catch {
    /* quota */
  }
}

function loadLruComposite(
  manifestKey: string,
  prefix: string,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const order = readManifest(manifestKey);
  for (const slotId of order) {
    try {
      const raw = localStorage.getItem(prefix + slotId);
      if (!raw) continue;
      const i = raw.indexOf(SEP);
      if (i <= 0) continue;
      const logicalKey = raw.slice(0, i);
      const payload = raw.slice(i + SEP.length);
      out.push([logicalKey, payload]);
    } catch {
      /* skip slot */
    }
  }
  return out;
}

function removeManifestAndPrefix(manifestKey: string, prefix: string): void {
  const order = readManifest(manifestKey);
  for (const id of order) {
    try {
      localStorage.removeItem(prefix + id);
    } catch {
      /* ignore */
    }
  }
  try {
    localStorage.removeItem(manifestKey);
  } catch {
    /* ignore */
  }
}

/** Persist a RuTracker topic cover (data URL) after a successful fetch. */
export function persistRutrackerCoverPositive(logicalKey: string, dataUrl: string): void {
  if (skipRutrackerPersist) return;
  if (!logicalKey || !dataUrl) return;
  const id = fnv1aSlotId(logicalKey);
  touchLru(RT_MANIFEST, RT_PREFIX, id, logicalKey + SEP + dataUrl, RT_MAX);
}

/** Load persisted RuTracker covers; caller seeds the in-memory cache. */
export function loadPersistedRutrackerCovers(): Array<[string, string]> {
  return loadLruComposite(RT_MANIFEST, RT_PREFIX);
}

export function clearPersistedRutrackerCovers(): void {
  removeManifestAndPrefix(RT_MANIFEST, RT_PREFIX);
}

export function hydrateRutrackerCoversFromDisk(seed: (logicalKey: string, dataUrl: string) => void): void {
  skipRutrackerPersist = true;
  for (const [k, u] of loadPersistedRutrackerCovers()) {
    seed(k, u);
  }
  skipRutrackerPersist = false;
}

/** Persist Deezer album-art HTTPS URL (or skip nulls). */
export function persistDeezerAlbumArt(logicalKey: string, url: string | null): void {
  if (!logicalKey || url == null || url.length < 8) return;
  const id = fnv1aSlotId(logicalKey);
  touchLru(DZ_ALBUM_MANIFEST, DZ_ALBUM_PREFIX, id, logicalKey + SEP + url, DZ_ALBUM_MAX);
}

export function loadPersistedDeezerAlbumArt(): Array<[string, string]> {
  return loadLruComposite(DZ_ALBUM_MANIFEST, DZ_ALBUM_PREFIX);
}

export function clearPersistedDeezerAlbumArt(): void {
  removeManifestAndPrefix(DZ_ALBUM_MANIFEST, DZ_ALBUM_PREFIX);
}

export interface DeezerCanonicalPersisted {
  artist: string;
  title: string;
  album: string;
  coverUrl: string | null;
}

/** Persist a Deezer track canonical row (JSON). Null results are stored so cold starts skip dead queries. */
export function persistDeezerTrackCanonical(logicalKey: string, row: DeezerCanonicalPersisted | null): void {
  if (!logicalKey) return;
  const id = fnv1aSlotId(logicalKey);
  const payload = row ? JSON.stringify(row) : "";
  touchLru(DZ_CANON_MANIFEST, DZ_CANON_PREFIX, id, logicalKey + SEP + payload, DZ_CANON_MAX);
}

export function loadPersistedDeezerTrackCanonicals(): Array<[string, DeezerCanonicalPersisted | null]> {
  const out: Array<[string, DeezerCanonicalPersisted | null]> = [];
  for (const [logicalKey, payload] of loadLruComposite(DZ_CANON_MANIFEST, DZ_CANON_PREFIX)) {
    if (!payload) {
      out.push([logicalKey, null]);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      continue;
    }
    if (parsed == null || typeof parsed !== "object") continue;
    const o = parsed as Record<string, unknown>;
    const artist = typeof o.artist === "string" ? o.artist : "";
    const title = typeof o.title === "string" ? o.title : "";
    const album = typeof o.album === "string" ? o.album : "";
    const coverUrl = o.coverUrl == null ? null : typeof o.coverUrl === "string" ? o.coverUrl : null;
    out.push([logicalKey, { artist, title, album, coverUrl }]);
  }
  return out;
}

export function clearPersistedDeezerTrackCanonical(): void {
  removeManifestAndPrefix(DZ_CANON_MANIFEST, DZ_CANON_PREFIX);
}

/**
 * Returns true when the LRU slot for logicalKey holds a non-empty payload.
 *
 * @param manifestKey - The manifest localStorage key for this LRU.
 * @param prefix - The per-slot key prefix.
 * @param logicalKey - The logical key to probe (must match exactly).
 */
function probeStorageLruHit(manifestKey: string, prefix: string, logicalKey: string): boolean {
  const slotId = fnv1aSlotId(logicalKey);
  const raw = localStorage.getItem(prefix + slotId);
  if (!raw) return false;
  const i = raw.indexOf(SEP);
  if (i <= 0) return false;
  if (raw.slice(0, i) !== logicalKey) return false;
  return raw.slice(i + SEP.length).length > 0;
}

/** True when a RuTracker cover data URL is stored for the given logical key. */
export function probeRutrackerCoverLru(logicalKey: string): boolean {
  return probeStorageLruHit(RT_MANIFEST, RT_PREFIX, logicalKey);
}

/** True when a Deezer track canonical entry is stored for the given logical key. */
export function probeDeezerCanonicalLru(logicalKey: string): boolean {
  return probeStorageLruHit(DZ_CANON_MANIFEST, DZ_CANON_PREFIX, logicalKey);
}

/** True when a Deezer album art URL is stored for the given logical key. */
export function probeDeezerAlbumArtLru(logicalKey: string): boolean {
  return probeStorageLruHit(DZ_ALBUM_MANIFEST, DZ_ALBUM_PREFIX, logicalKey);
}
