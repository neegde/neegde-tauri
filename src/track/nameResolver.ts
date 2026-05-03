/**
 * Deterministic track-name resolver.
 *
 * Given the minimal set of fields any Track has at construction time,
 * returns `{ artist, title, album, confidence, source }` — best-effort
 * display names assembled without external API calls. Network-based
 * canonicalisation (Deezer / iTunes / MusicBrainz) layers on top and
 * can override these values.
 *
 * Called once per track in `buildTrack()` and the result stamped into
 * `TrackData`, so UI consumers just read `track.title` / `track.artist`
 * directly — no per-render resolver call.
 *
 * Signal cascade (highest-confidence first):
 *   RT:
 *     1. `artist` — explicit "Исполнитель:" label from topic post.
 *        Title comes from basename; album from "Альбом:" label or folder.
 *     2. Folder name (`albumTitle`, stamped by `detectAlbums` from the
 *        .torrent file) parsed as "Artist - Album (Year) [flags]".
 *     3. Pure fallback: cleaned basename as title, everything else empty.
 *   SLSK:
 *     1. Folder hierarchy → artist, then cross-check against basename X-Y
 *        split — resolves the "Контракт - Пошлая Молли" vs "Пошлая Молли
 *        - Контракт" ambiguity by picking the side that matches the folder.
 *     2. Folder artist alone (basename is just a title).
 *     3. Basename "X - Y" with no cross-check — guesses X=artist (low conf).
 *     4. Bare basename.
 */

import {
  parseArtistTitleFromTrackFilename,
  trackDisplayBasename,
  stripMetaTags,
} from "../lib/utils.js";
import type { SoulseekTrackSource, TrackSource, ProviderKind } from "./types.js";

export type NameConfidence = "high" | "medium" | "low";

export type NameSource =
  | "rt-label"
  | "rt-folder"
  | "slsk-folder+cross"
  | "slsk-folder"
  | "slsk-basename"
  | "fallback";

export interface ResolvedNames {
  artist: string;
  title: string;
  album: string;
  confidence: NameConfidence;
  source: NameSource;
}

/**
 * Minimal structural input — satisfied by both `TrackData` (pre-construction,
 * inside `buildTrack`) and `Track` instances (via class getters). Keep this
 * narrow; adding a field here ripples through both call sites.
 */
export interface TrackNameInput {
  fileName: string;
  artist: string | null;
  albumTitle?: string | null;
  sources: readonly TrackSource[];
}

/**
 * Memoization cache. The resolver is deterministic in its public input shape
 * and is hot during search: it runs once per row in `groupSlskRowsToEntities`
 * (via `trackDedupKey`), once more in `buildTrack` (via `resolveNames`), and a
 * third time in `applyFilenameMetadata` for the same rows. With ~500 rows
 * per popular SoulSeek search and many incremental batches, the unmemoized
 * cost compounds into tens of thousands of regex-heavy passes per query and
 * stalls the UI thread.
 *
 * Keyed by the fields the resolver actually reads. Bounded with FIFO eviction
 * so a long session doesn't grow the map indefinitely.
 */
const _cache = new Map<string, ResolvedNames>();
const _CACHE_LIMIT = 5000;
const _CACHE_EVICT = 1024;

/**
 * Build the memoization key for a resolver input. Captures every field the
 * resolver branches on — kind, filename, label artist, folder album, and
 * (SoulSeek only) the full filepath used for parent-folder walks.
 */
function _cacheKey(input: TrackNameInput): string {
  const src = input.sources?.[0];
  const kind = src?.kind ?? "?";
  const slskFp =
    kind === "soulseek"
      ? (src as SoulseekTrackSource | undefined)?.refs?.slskFilepath ?? ""
      : "";
  return `${kind}\t${input.fileName}\t${input.artist ?? ""}\t${input.albumTitle ?? ""}\t${slskFp}`;
}

/**
 * Resolve display names from a track's structural input. Memoized per input
 * fingerprint — see `_cache` above for rationale.
 *
 * Args:
 *   input: Minimal track shape (fileName + sources). Provider-stamped
 *     `artist` / `albumTitle` are respected and feed the RT branch.
 *
 * Returns:
 *   ResolvedNames with `{artist, title, album, confidence, source}`. The
 *   returned object is shared across callers via the cache; treat it as
 *   read-only.
 */
export function resolveTrackNames(input: TrackNameInput): ResolvedNames {
  const key = _cacheKey(input);
  const cached = _cache.get(key);
  if (cached) return cached;

  const filename = input.fileName ?? "";
  const baseNoPrefix = trackDisplayBasename(filename);
  const basenameSplit = parseArtistTitleFromTrackFilename(filename);
  const kind: ProviderKind | undefined = input.sources[0]?.kind;

  const base = kind === "rutracker" || kind === "magnet"
    ? resolveRT(input, basenameSplit, baseNoPrefix)
    : resolveSlsk(input, basenameSplit, baseNoPrefix);

  const result = cleanTitleSubstrings(base);

  if (_cache.size >= _CACHE_LIMIT) {
    let i = 0;
    for (const k of _cache.keys()) {
      _cache.delete(k);
      if (++i >= _CACHE_EVICT) break;
    }
  }
  _cache.set(key, result);
  return result;
}

/** Test-only escape hatch — drops the memoization cache. */
export function _clearTrackNameResolverCache(): void {
  _cache.clear();
}

/** Post-process the resolved title: drop an artist-name occurrence baked into
 *  the filename (e.g. "Пошлая Молли   THRILL PILL" → "Пошлая Молли" when
 *  artist is "THRILL PILL"), then the same pass with album name. Both passes
 *  are case-insensitive and preserve the title only when the stripped
 *  remainder is still non-empty, so we never nuke the title entirely. */
function cleanTitleSubstrings(r: ResolvedNames): ResolvedNames {
  let title = r.title;
  if (r.artist) {
    const stripped = tryStrip(title, r.artist);
    if (stripped) title = stripped;
  }
  if (r.album) {
    const stripped = tryStrip(title, r.album);
    if (stripped) title = stripped;
  }
  return title === r.title ? r : { ...r, title };
}

/** Remove every case-insensitive occurrence of `needle` from `haystack` and
 *  tidy up the leftover separators / whitespace. Returns the cleaned string
 *  or `null` when the result is empty (caller should keep original). */
function tryStrip(haystack: string, needle: string): string | null {
  const n = needle.trim();
  if (!n || !haystack) return null;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "gi");
  const without = haystack.replace(re, "");
  // Collapse left-over separator clutter: leading/trailing " - ", ", ", "  ".
  const tidied = without
    .replace(/[\s\-–—,]+$/u, "")
    .replace(/^[\s\-–—,]+/u, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return tidied && tidied !== haystack.trim() ? tidied : null;
}

// ── RuTracker ────────────────────────────────────────────────────────────────

function resolveRT(
  input: TrackNameInput,
  bSplit: { artist: string; title: string },
  baseNoPrefix: string,
): ResolvedNames {
  const labelArtist = (input.artist ?? "").trim();
  const folderName = (input.albumTitle ?? "").trim(); // folder from detectAlbums

  if (labelArtist) {
    return {
      artist: labelArtist,
      title: bSplit.title || baseNoPrefix,
      album: folderName,
      confidence: "high",
      source: "rt-label",
    };
  }

  const parsed = parseArtistAlbumFromFolder(folderName);
  if (parsed) {
    return {
      artist: parsed.artist,
      title: bSplit.title || baseNoPrefix,
      album: parsed.album,
      confidence: "medium",
      source: "rt-folder",
    };
  }

  return {
    artist: "",
    title: baseNoPrefix,
    album: folderName,
    confidence: "low",
    source: "fallback",
  };
}

/** "Artist - Album (2017) [FLAC]" → { artist: "Artist", album: "Album" }. */
function parseArtistAlbumFromFolder(folder: string): { artist: string; title?: never; album: string } | null {
  if (!folder) return null;
  const cleaned = stripMetaTags(folder).trim();
  if (!cleaned) return null;
  // Strip a leading "YYYY - " (RT "2005 - Artist - Album" shape).
  const noYear = cleaned.replace(/^(19\d{2}|20\d{2})\s*[-–—.]\s+/, "");
  const m = noYear.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (!m) return null;
  const artist = m[1]!.trim();
  const album = stripTrailingParenTags(m[2]!).trim();
  if (!artist || !album) return null;
  return { artist, album };
}

/**
 * Drop trailing "(Year)" / "[FLAC]" / "(lossless)" / "(2 CD)" annotations —
 * anything wrapped in () or [] at the very end, iteratively. Stops once a
 * pass finds nothing to strip, or after 4 passes (guards against pathological
 * deeply-nested cases; normal release folders have 1-2 tag groups).
 */
function stripTrailingParenTags(s: string): string {
  let out = s.trim();
  for (let i = 0; i < 4; i++) {
    const m = out.match(/^(.+?)\s*[(\[][^()\[\]]*[)\]]\s*$/);
    if (!m) break;
    out = m[1]!.trim();
  }
  return out;
}

// ── SoulSeek ─────────────────────────────────────────────────────────────────

function resolveSlsk(
  input: TrackNameInput,
  bSplit: { artist: string; title: string },
  baseNoPrefix: string,
): ResolvedNames {
  const slskSrc = input.sources?.[0] as SoulseekTrackSource | undefined;
  const fp = slskSrc?.refs?.slskFilepath ?? "";
  const folderArtist = extractFolderArtist(fp);
  const rawAlbum = (input.albumTitle ?? "").trim() || extractFolderAlbum(fp);
  const folderAlbum = cleanAlbumLabel(rawAlbum, folderArtist);

  // Some parsers leave a numeric leftover like "01" or "07" as the artist side
  // when the basename was e.g. "01-07 - Title.flac" (the first track-prefix
  // was stripped but the disc/track pair bled through). Treat as no split.
  const splitArtist = looksLikeTrackNumber(bSplit.artist) ? "" : bSplit.artist;
  const splitTitle = bSplit.title;

  // 1. Cross-check: both basename split AND folder-artist available.
  //    Picks the basename side that matches the folder artist as THE artist;
  //    the other side becomes title. Resolves "Artist - Title" vs
  //    "Title - Artist" ambiguity conclusively.
  if (folderArtist && splitArtist && splitTitle) {
    const xMatch = artistMatchesFolder(splitArtist, folderArtist);
    const yMatch = artistMatchesFolder(splitTitle, folderArtist);
    if (xMatch && !yMatch) {
      return {
        artist: folderArtist,
        title: splitTitle,
        album: folderAlbum,
        confidence: "high",
        source: "slsk-folder+cross",
      };
    }
    if (yMatch && !xMatch) {
      return {
        artist: folderArtist,
        title: splitArtist,
        album: folderAlbum,
        confidence: "high",
        source: "slsk-folder+cross",
      };
    }
    // Both match or neither — fall through to no-cross-check branches.
  }

  // 2. Folder alone gives artist, basename is just a title (no " - ").
  if (folderArtist && !(splitArtist && splitTitle)) {
    return {
      artist: folderArtist,
      title: splitTitle || baseNoPrefix,
      album: folderAlbum,
      confidence: "medium",
      source: "slsk-folder",
    };
  }

  // 3. Basename split without folder cross-check — assume X=artist.
  if (splitArtist && splitTitle) {
    return {
      artist: splitArtist,
      title: splitTitle,
      album: folderAlbum,
      confidence: "low",
      source: "slsk-basename",
    };
  }

  // 4. Fallback: cleaned basename as title only.
  return {
    artist: folderArtist,
    title: splitTitle || baseNoPrefix,
    album: folderAlbum,
    confidence: "low",
    source: "fallback",
  };
}

/** "01", "07", "01-01", "1.02", " 12 ". Anything that's only digits +
 *  typical track-prefix separators. Used to discard basename-parser
 *  leftovers that are clearly track numbers, not artists. */
function looksLikeTrackNumber(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return /^[\d][\d.\-_\s]*$/.test(t);
}

/** Does the basename-side string refer to the same artist as the folder?
 *  Exact match always counts. Containment only counts when the shorter
 *  side is a substantial fraction of the longer — "Молли" inside "Пошлая
 *  Молли" is rejected, but "Пошлая Молли feat. X" matching "Пошлая Молли"
 *  is accepted. */
function artistMatchesFolder(basenameSide: string, folderArtist: string): boolean {
  const a = normalize(basenameSide);
  const b = normalize(folderArtist);
  if (!a || !b) return false;
  if (a === b) return true;
  // Basename side is an extended form of folder artist (e.g. "Artist feat. X").
  if (a.length > b.length && a.includes(b)) return true;
  // Folder artist contains basename side — only accept when substantial.
  if (b.length > a.length && b.includes(a)) {
    return a.length >= Math.ceil(b.length * 0.7);
  }
  return false;
}

/**
 * Generic folder-name patterns that almost never match an artist — SLSK
 * uploaders love burying music under these. Matched case-insensitively as
 * a whole segment.
 */
const GENERIC_FOLDER_RE = /^(music(_\w+)?|audio|media|sounds?|mp3s?|flacs?|tracks?|tunes?|share(d)?|shares|downloads?|archive|collection|discography|albums?|альбомы?|дискография|сборники?|разные\s*исполнители|va|v\.a\.|torrents?|home|users?|root|soulseek|sseek|sorted|unsorted|other|другое|misc|tmp|temp|new|random|lossless|acoustic|iomega|private|public|d[2-9]|ramona|collection\d*|playlist\w*|альбомы,?\s*ep|pop|rock|jazz|classical|metal|hip\s*hop|rap|hyperpop|indie|dance|electronic|electro|folk|country|blues|punk|reggae|techno|house|rnb|r\s*&\s*b|soul|ambient|trap|dnb|drum\s*&\s*bass|edm|phonk|shoegaze|dubstep|hardcore|alternative|experimental)$/i;

/** A folder segment that looks like an album, not an artist. Matches:
 *    "2017 - Album"      (year-prefix, "YYYY - Name")
 *    "Album (2017)"      (parenthesized year suffix, common on release folders)
 *    "Album [2017]"      (bracketed year suffix)
 *    "Artist - Album"    (when we already have a stronger artist hint upstream
 *                         this is ambiguous; the in-segment dash is handled by
 *                         the "Artist - Album" split inside extractFolderArtist).
 */
function segmentLooksLikeAlbum(seg: string): boolean {
  const s = seg.trim();
  if (/^(19\d{2}|20\d{2})(\s*[-–—.]|\s|$)/.test(s)) return true;
  if (/[(\[](19\d{2}|20\d{2})[)\]]/.test(s)) return true;
  return false;
}

/** Walk parent folders of a SLSK filepath, pick the first "artist-looking" segment.
 *
 * Traversal is deepest-parent first (the folder closest to the file is more
 * likely to carry the artist than roots like "Music"). For each segment we
 * look for a clean artist name; when the segment is an "Artist - Album"
 * compound (typical SLSK release folder), we pull just the artist half.
 */
/**
 * Two-pass walker. The hierarchy we're usually dealing with is one of:
 *   A. `Music/Artist - Album (YYYY)/NN - Title.ext`   (compact)
 *   B. `Music/Artist/Album/NN - Title.ext`             (standard library)
 *   C. `Music/Compilation (YYYY)/NN - Artist - T.mp3` (va / mixtape)
 *
 * Pass 1 — "Artist - Album" split on any parent, deepest first. This nails
 *   shape (A) cleanly.
 * Pass 2 — top-down scan for a "clean" artist folder. Naturally prefers the
 *   grandparent-level folder over the deepest-parent album folder in shape
 *   (B) where the deepest parent has no usable split or year marker (e.g.
 *   `Music/LIDA/Жабы атаковали планету земля/…`).
 */
function extractFolderArtist(filepath: string): string {
  const segs = splitFolderPath(filepath);
  if (segs.length < 2) return "";
  const parents = segs.slice(0, -1);

  // Pass 1: deepest-first "Artist - Album" split.
  for (let i = parents.length - 1; i >= 0; i--) {
    const raw = (parents[i] ?? "").trim();
    if (!raw || isGenericLike(raw)) continue;
    const seg = stripTrailingReleaseType(stripLeadingYear(raw));
    const m = seg.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) {
      const candidate = stripTrailingParenTags(m[1]!.trim());
      // "VA - Compilation" / "09 - чума" / "Downloads - Junk" — reject numeric
      // or bucket candidates so the less aggressive Pass 2 gets a chance.
      if (!isGenericLike(candidate)) return candidate;
    }
  }

  // Pass 2: top-down "clean artist folder" scan.
  for (const rawIn of parents) {
    const raw = rawIn.trim();
    if (!raw || isGenericLike(raw)) continue;
    // Release folder with a year marker — definitely an album, skip.
    if (segmentLooksLikeAlbum(raw)) continue;
    const seg = stripLeadingYear(raw);
    // Bare year ("1998") or remaining album marker after year strip.
    if (/^(19\d{2}|20\d{2})$/.test(seg)) continue;
    const cleaned = stripTrailingParenTags(seg).trim();
    if (!cleaned || isGenericLike(cleaned)) continue;
    return cleaned;
  }
  return "";
}

/** Substring-level bucket words that almost always identify a personal
 *  collection container rather than an artist — `VCs torrents`, `my shared`,
 *  `Downloaded music`, `Home Library`, `Plex music`, `old_yandex` etc. Most
 *  are matched as whole words; service names (plex/yandex/…) use a looser
 *  `_`-aware boundary because paths like `old_yandex` don't have a real
 *  word-boundary at the underscore. */
const BUCKET_WORD_RE = /(?:\b(?:torrents?|downloads?|downloaded|seeding|library|libraries|collection|collections|shared|sharing|unsorted|plex|spotify|itunes|apple\s*music|dropbox|g(?:oogle)?\s*drive|onedrive|mediafire|mega|soulseek)\b|(?:^|_)(?:yandex|plex|spotify|itunes|dropbox|mega|onedrive)(?:_|$))/i;

/** Combined "skip as artist candidate" test: @@hash camouflage, generic
 *  whole-segment match, a bucket-word substring, or a bare numeric folder
 *  (`03`, `2017` etc — those are user-organizer buckets, never artists). */
function isGenericLike(seg: string): boolean {
  if (/^@@/.test(seg)) return true;
  if (GENERIC_FOLDER_RE.test(seg)) return true;
  if (BUCKET_WORD_RE.test(seg)) return true;
  if (/^\d{1,4}$/.test(seg)) return true;
  return false;
}

/** Strip any leading year annotation from a folder segment. Handles:
 *    "(2009) Anacondaz ..."
 *    "[2009] Anacondaz ..."
 *    "2009 - Anacondaz ..."
 *    "2009. Anacondaz ..."
 */
function stripLeadingYear(seg: string): string {
  return seg
    .replace(/^[(\[](19\d{2}|20\d{2})[)\]]\s*/, "")
    .replace(/^(19\d{2}|20\d{2})\s*[-–—.]\s+/, "")
    .trim();
}

/** Strip a trailing release-type marker (" - EP", " - LP", " - Single",
 *  " - Maxi Single", " - CD1", " - Deluxe") from a folder segment. These
 *  aren't separate albums — the preceding chunk IS the album. Without this
 *  the "Artist - Album" split happily reads "AlbumName - EP" as
 *  "artist=AlbumName, album=EP", which is always wrong. */
function stripTrailingReleaseType(seg: string): string {
  return seg
    .replace(/\s*[-–—]\s*(?:ep|lp|single|maxi(?:\s*single)?|cd\s*\d*|disc\s*\d*|deluxe|remaster(?:ed)?|anniversary|bonus|mix(?:tape)?)\s*$/i, "")
    .trim();
}

/**
 * Normalise a folder-derived album label:
 *   - strip trailing "(YYYY)" / "[FLAC]" / "(lossless)" tags,
 *   - strip leading "Artist - " when the artist is the same one we already
 *     identified (avoids duplication in "Пошлая Молли - PAYCHECK" when
 *     artist is already "Пошлая Молли").
 */
function cleanAlbumLabel(raw: string, artist: string): string {
  let s = raw.trim();
  if (!s) return "";
  // Trailing tags: "... (2020)" + "... [FLAC]" + "... (lossless)"
  s = stripTrailingParenTags(s);
  // Leading "(YYYY) " / "[YYYY] " / "YYYY - " / "YYYY. "
  s = stripLeadingYear(s);
  // Leading "Artist - " (only if it matches the already-picked artist).
  if (artist) {
    const a = normalize(artist);
    const m = s.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m && fuzzyMatch(normalize(m[1]!), a)) {
      s = m[2]!.trim();
      s = stripTrailingParenTags(s);
      s = stripLeadingYear(s);
    }
  }
  // After all stripping, a bare year ("1998") isn't a useful album.
  if (/^(19\d{2}|20\d{2})$/.test(s.trim())) return "";
  return s;
}

/** The immediate-parent folder, stripped of a "YYYY - " / "YYYY." prefix
 *  and a trailing " - EP"/"- LP"/release-type marker. */
function extractFolderAlbum(filepath: string): string {
  const segs = splitFolderPath(filepath);
  if (segs.length < 2) return "";
  const parent = (segs[segs.length - 2] ?? "").trim();
  if (!parent) return "";
  const m = parent.match(/^(?:19\d{2}|20\d{2})\s*[-–—.]\s*(.+)$/);
  const cleaned = (m ? m[1]! : parent).trim();
  return stripTrailingReleaseType(stripTrailingParenTags(cleaned));
}

function splitFolderPath(filepath: string): string[] {
  return String(filepath ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
}

// ── String normalization ─────────────────────────────────────────────────────

/** Lowercase + strip punctuation/spaces. Used for fuzzy comparison only. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .replace(/ё/g, "е");
}

/** Two normalized strings match if one contains the other (and both non-empty). */
function fuzzyMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}
