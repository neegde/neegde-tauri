const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
const COVER_NAMES = ["cover", "folder", "front", "albumart", "album", "artwork", "thumb"];

/** Max size for torrent image fetch / cover preview (aligned with Tauri-side limit). */
export const MAX_TORRENT_COVER_BYTES = 3 * 1024 * 1024;

export function isImage(path) {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

function coverScore(filename) {
  const name = filename.replace(/\.[^.]+$/, "").toLowerCase();
  for (let i = 0; i < COVER_NAMES.length; i++) {
    if (name === COVER_NAMES[i] || name.startsWith(COVER_NAMES[i])) return i;
  }
  return COVER_NAMES.length;
}

// Returns array of { dirPath, name, audioFiles, coverFile }
export function detectAlbums(files) {
  // Build dir → best cover image map
  const dirImages = new Map();
  for (const f of files) {
    if (!isImage(f.path)) continue;
    const parts = f.path.replace(/\\/g, "/").split("/");
    const dirPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    const fname = parts[parts.length - 1];
    const existing = dirImages.get(dirPath);
    if (!existing || coverScore(fname) < coverScore(existing.path.split("/").pop())) {
      dirImages.set(dirPath, f);
    }
  }

  // Group audio files by immediate parent dir
  const dirs = new Map();
  for (const f of files) {
    if (!isAudio(f.path)) continue;
    const parts = f.path.replace(/\\/g, "/").split("/");
    const dirPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    const dirName = parts.length > 1 ? parts[parts.length - 2] : "";
    if (!dirs.has(dirPath)) dirs.set(dirPath, { dirPath, name: dirName, audioFiles: [], coverFile: null });
    dirs.get(dirPath).audioFiles.push(f);
  }

  // Assign covers: walk up directory tree for each album
  for (const [, album] of dirs) {
    for (let s = album.dirPath; ; ) {
      if (dirImages.has(s)) { album.coverFile = dirImages.get(s); break; }
      if (s === "") break;
      const slash = s.lastIndexOf("/");
      s = slash >= 0 ? s.slice(0, slash) : "";
    }
  }

  const albums = [...dirs.values()];
  albums.sort((a, b) => a.dirPath.localeCompare(b.dirPath));
  for (const a of albums) {
    a.audioFiles = sortAudioFilesByTrackPrefix(a.audioFiles);
  }
  return albums;
}

/** Все аудиофайлы в порядке альбомов (как в UI), а не в сыром порядке торрента. */
export function orderedAudioFiles(files) {
  if (!files?.length) return [];
  return detectAlbums(files).flatMap((a) => a.audioFiles);
}

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
];

export function makeMagnet(hash, name) {
  const tr = TRACKERS.map((t) => `tr=${encodeURIComponent(t)}`).join("&");
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}&${tr}`;
}

/**
 * Appends public UDP trackers to a magnet from an indexer page so clients can find peers when
 * the page only listed a single announce URL (e.g. Rutracker HTML magnet).
 *
 * Args:
 *     magnet: Raw magnet string.
 *
 * Returns:
 *     Magnet with extra `&tr=` params, or the input if not a btih magnet.
 */
export function enrichMagnetWithOpenTrackers(magnet) {
  if (!magnet || typeof magnet !== "string" || !magnet.includes("btih:")) {
    return magnet;
  }
  let out = magnet.trim();
  for (const tr of TRACKERS) {
    const enc = encodeURIComponent(tr);
    if (out.includes(`tr=${enc}`) || out.includes(tr)) {
      continue;
    }
    out += `&tr=${enc}`;
  }
  return out;
}

/**
 * Число и единица размера файла (для двухстрочной колонки без переноса).
 *
 * @param {number} bytes
 * @returns {{ value: string, unit: string }}
 */
export function fmtSizeParts(bytes) {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) n = 0;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  const text =
    u === 0 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1);
  return { value: text, unit: units[u] };
}

export function fmtSize(bytes) {
  const { value, unit } = fmtSizeParts(bytes);
  return `${value} ${unit}`;
}

/** Sum of `file.size` for loaded torrent file rows (more reliable than tracker HTML for totals). */
export function sumFileSizes(files) {
  if (!files?.length) return 0;
  let s = 0;
  for (const f of files) {
    const n = Number(f.size);
    if (Number.isFinite(n)) s += n;
  }
  return s;
}

export function fmtDate(val) {
  if (!val || val === 0 || val === "0" || val === "—") return "—";
  // Unix timestamp (number or digit-only string ≥ 9 chars)
  if (typeof val === "number" || /^\d{9,}$/.test(String(val))) {
    try {
      return new Date(Number(val) * 1000).toLocaleDateString("ru-RU", {
        year: "numeric", month: "short", day: "numeric",
      });
    } catch { /* fall through */ }
  }
  return String(val);
}

export const AUDIO_EXTS = new Set([
  ".mp3", ".flac", ".ape", ".wav", ".m4a", ".ogg", ".wv", ".aac", ".opus",
]);

const AUDIO_FORMAT_LABELS = Object.freeze({
  mp3: "MP3",
  flac: "FLAC",
  ape: "APE",
  wav: "WAV",
  m4a: "M4A",
  ogg: "OGG",
  wv: "WV",
  aac: "AAC",
  opus: "OPUS",
});

export function isAudio(path) {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return AUDIO_EXTS.has(ext);
}

/**
 * Extracts normalized human-readable audio format from a file path.
 *
 * Args:
 *     path: Audio file path or file name.
 *
 * Returns:
 *     Uppercase short format label (for example "FLAC"), or "AUDIO" for unknown extension.
 */
export function audioFormatLabel(path) {
  const value = String(path ?? "").trim();
  if (!value) return "AUDIO";
  const dot = value.lastIndexOf(".");
  if (dot < 0 || dot === value.length - 1) return "AUDIO";
  const ext = value.slice(dot + 1).toLowerCase();
  if (AUDIO_FORMAT_LABELS[ext]) return AUDIO_FORMAT_LABELS[ext];
  if (!/^[a-z0-9]{1,6}$/.test(ext)) return "AUDIO";
  return ext.toUpperCase();
}

export function basename(path) {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

// Keywords that mark bracket content as release metadata noise (case-insensitive).
const META_TAG_WORDS_RE =
  /\b(flac|mp3|ape|wav|wv|aac|ogg|opus|m4a|wma|ac3|dts|lossless|lossy|320|256|192|128|v0|v2|cbr|vbr|kbps|web|cd|vinyl|dvd|hdtv|sacd|blu-?ray|remaster(?:ed)?|deluxe|expanded|bonus|edition|rip|scan|of|tr\d+)\b/i;

/**
 * Strip common audio release tags from a name:
 *   [FLAC], [MP3 320], (Deluxe Edition), [TR24][OF], 2023 Artist, [2005], etc.
 * Keeps feat., remix, and other creative annotations intact.
 */
export function stripMetaTags(str) {
  if (!str) return str;
  return str
    // Leading short tag clusters e.g. [TR24][OF], [320] etc. (≤10 chars per tag, no spaces)
    .replace(/^(\[[\w\d]{1,10}\]\s*)+/, "")
    // Leading bare year: "2023 Artist" → "Artist"
    .replace(/^(19|20)\d{2}\s+/, "")
    // Leading year in brackets: [2005] Artist → Artist
    .replace(/^\[\d{4}\]\s*/, "")
    // Leading genre/category bracket: "(Hip-hop / Rap) Artist" → "Artist"
    .replace(/^([\[(][^\[\]()]*[\])]\s*)+/, "")
    // Bracket/paren groups that look like release metadata
    // Decision: strip if the content (≤40 chars) contains a known meta keyword,
    //           or is a 4-digit year alone. Keep groups with feat./remix/live/etc.
    .replace(/\s*[\[(]([^\[\]()]{1,40})[\])]/g, (match, inner) => {
      const s = inner.trim();
      if (/^\d{4}$/.test(s)) return ""; // bare year
      if (META_TAG_WORDS_RE.test(s)) return ""; // known meta word
      return match; // keep (feat., remix, live, …)
    })
    .trim();
}

/**
 * Leading track index in the basename (e.g. "01. Title.flac", "02 - Title.mp3", "01 Title.mp3").
 * Returns { order, title } with `title` = rest of filename (incl. extension), or null.
 */
export function parseAudioTrackPrefix(basenameStr) {
  // With separator: "01. Title" / "02 - Title"
  const m = basenameStr.match(/^(\d{1,3})\s*[.\-–—]\s*(.+)$/);
  if (m) {
    const title = m[2].trim();
    if (title) return { order: parseInt(m[1], 10), title };
  }
  // Space only: "01 Title" — only if followed by a letter (avoid "128 kbps.mp3")
  const m2 = basenameStr.match(/^(\d{1,3})\s+([A-Za-zА-Яа-яЁё\u00C0-\u024F].+)$/);
  if (m2) {
    const title = m2[2].trim();
    if (title) return { order: parseInt(m2[1], 10), title };
  }
  return null;
}

function stripFilenameExtension(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 1) return name;
  return name.slice(0, dot);
}

const VARIOUS_ARTISTS_RE = /^(va|v\.a\.?|various(\s+artists?)?|разные(\s+исполнители)?)$/i;

const DISC_MARKER_RE = /^(cd|disc|disk|part|диск)\s*\d+$/i;

/** True if `name` is a disc/part marker like "CD1", "Disc 2", "Диск 1". */
export function isDiscMarker(name) {
  return DISC_MARKER_RE.test((name ?? "").trim());
}

/**
 * Extracts the album title from a torrent name like "Artist - Album [tags]".
 * Strips meta tags first, then returns the part after the first " - " separator,
 * or the cleaned name if no separator is found.
 */
export function extractAlbumFromTorrentName(torrentName) {
  if (!torrentName) return "";
  const cleaned = stripMetaTags(torrentName.trim());
  if (!cleaned) return "";
  const m = cleaned.match(/^.+?\s+[-–—]\s+(.+)$/);
  return m ? m[1].trim() : cleaned;
}

/**
 * Extracts artist from a torrent name in "Artist - Album" format.
 * Falls back to the full torrent name if no separator is found.
 */
export function extractArtist(torrentName) {
  if (!torrentName) return "";
  // Strip leading year bracket before parsing
  let name = stripMetaTags(torrentName);
  // Strip remaining leading category/genre brackets that stripMetaTags missed
  // (>40 chars, e.g. "(Underground hip-hop, gangsta rap, hyperrealism) Artist - Album")
  name = name.replace(/^([\[(][^\[\]()]*[\])]\s*)+/, "").trim();
  const m = name.match(/^(.+?)\s+[-–—]\s+/);
  const artist = m ? m[1].trim() : name;
  // Reject VA placeholders
  return VARIOUS_ARTISTS_RE.test(artist) ? "" : artist;
}

function isYearLike(s) {
  return /^\d{4}$/.test(s);
}

/**
 * Extracts artist from a track.
 * Priority:
 *   1. `explicitArtist` — from RuTracker post body ("Исполнитель: ...")
 *   2. torrentName — part before the first separator, if not a year
 *   3. magnet dn= — torrent internal name (often "Artist - Album", distinct from topic title)
 *   4. Each segment of albumDirPath (outermost first) — e.g. "Кровосток/2005 - Река крови" → "Кровосток"
 *
 * @param {string} torrentName
 * @param {string|null} albumDirPath  - dirPath from detectAlbums
 * @param {string|null} explicitArtist - artist from torrent details post body
 * @param {string|null} magnet - magnet link (dn= contains torrent internal name)
 */
export function extractTrackArtist(torrentName, albumDirPath, explicitArtist, magnet) {
  // Best source: parsed from RuTracker post body — strip genre prefixes just in case
  if (explicitArtist) {
    const cleaned = extractArtist(explicitArtist);
    return cleaned || explicitArtist;
  }

  const fromTorrent = extractArtist(torrentName);
  if (fromTorrent && !isYearLike(fromTorrent)) return fromTorrent;

  // Magnet dn= is the torrent's internal name — often "Artist - Album [Format]"
  // and may differ from the search result topic title
  if (magnet) {
    const m = magnet.match(/[?&]dn=([^&]+)/);
    if (m) {
      try {
        const dn = decodeURIComponent(m[1]);
        const fromDn = extractArtist(dn);
        if (fromDn && !isYearLike(fromDn)) return fromDn;
      } catch { /* malformed encoding — skip */ }
    }
  }

  // Walk all dirPath segments (outermost to innermost) looking for a non-year artist
  if (albumDirPath) {
    for (const seg of albumDirPath.split("/").filter(Boolean)) {
      if (isYearLike(seg)) continue;
      const fromSeg = extractArtist(seg);
      if (fromSeg && !isYearLike(fromSeg)) return fromSeg;
    }
  }

  return stripMetaTags(fromTorrent) || stripMetaTags(torrentName) || "";
}

/** Basename for UI: no leading "01. " / "02 - ", no file extension. */
export function trackDisplayBasename(path) {
  const base = basename(path);
  const p = parseAudioTrackPrefix(base);
  const withoutPrefix = p ? p.title : base;
  return stripFilenameExtension(withoutPrefix);
}

function sortAudioFilesByTrackPrefix(audioFiles) {
  if (audioFiles.length <= 1) return audioFiles;
  const withIdx = audioFiles.map((f, i) => ({ f, i }));
  const parsed = withIdx.map(({ f, i }) => ({
    f,
    i,
    p: parseAudioTrackPrefix(basename(f.path)),
  }));
  if (!parsed.every((x) => x.p !== null)) return audioFiles;
  parsed.sort((a, b) => {
    if (a.p.order !== b.p.order) return a.p.order - b.p.order;
    return a.i - b.i;
  });
  return parsed.map((x) => x.f);
}

export function buildTree(files) {
  const root = { __files: [] };
  for (const f of files) {
    const parts = f.path.replace(/\\/g, "/").split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!node[p]) node[p] = { __files: [] };
      node = node[p];
    }
    node.__files.push({ name: parts.at(-1), size: f.size, origIdx: f.origIdx });
  }
  return root;
}
