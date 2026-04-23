import { OPEN_TRACKERS } from "./openTrackers.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
const COVER_NAMES = ["cover", "folder", "front", "albumart", "album", "artwork", "thumb"];

/** Max size for torrent image fetch / cover preview (aligned with Tauri-side limit). */
export const MAX_TORRENT_COVER_BYTES = 3 * 1024 * 1024;

export interface FileRow {
  path: string;
  size?: number;
  origIdx?: number;
  [extra: string]: unknown;
}

export interface Album<F extends FileRow = FileRow> {
  dirPath: string;
  name: string;
  audioFiles: F[];
  coverFile: F | null;
}

export function isImage(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

function coverScore(filename: string): number {
  const name = filename.replace(/\.[^.]+$/, "").toLowerCase();
  for (let i = 0; i < COVER_NAMES.length; i++) {
    if (name === COVER_NAMES[i] || name.startsWith(COVER_NAMES[i]!)) return i;
  }
  return COVER_NAMES.length;
}

/** Returns array of { dirPath, name, audioFiles, coverFile }. */
export function detectAlbums<F extends FileRow>(files: F[] | null | undefined): Album<F>[] {
  if (!files?.length) return [];

  // Build dir → best cover image map
  const dirImages = new Map<string, F>();
  for (const f of files) {
    if (!isImage(f.path)) continue;
    const parts = f.path.replace(/\\/g, "/").split("/");
    const dirPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    const fname = parts[parts.length - 1]!;
    const existing = dirImages.get(dirPath);
    if (!existing || coverScore(fname) < coverScore(existing.path.split("/").pop()!)) {
      dirImages.set(dirPath, f);
    }
  }

  // Group audio files by immediate parent dir
  const dirs = new Map<string, Album<F>>();
  for (const f of files) {
    if (!isAudio(f.path)) continue;
    const parts = f.path.replace(/\\/g, "/").split("/");
    const dirPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    const dirName = parts.length > 1 ? (parts[parts.length - 2] ?? "") : "";
    if (!dirs.has(dirPath)) {
      dirs.set(dirPath, { dirPath, name: dirName, audioFiles: [], coverFile: null });
    }
    dirs.get(dirPath)!.audioFiles.push(f);
  }

  // Assign covers: walk up directory tree for each album
  for (const [, album] of dirs) {
    for (let s = album.dirPath; ; ) {
      const img = dirImages.get(s);
      if (img) { album.coverFile = img; break; }
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
export function orderedAudioFiles<F extends FileRow>(files: F[] | null | undefined): F[] {
  if (!files?.length) return [];
  return detectAlbums(files).flatMap((a) => a.audioFiles);
}

const TRACKERS = OPEN_TRACKERS;

export function makeMagnet(hash: string, name: string): string {
  const tr = TRACKERS.map((t) => `tr=${encodeURIComponent(t)}`).join("&");
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}&${tr}`;
}

/**
 * Appends public tracker announce URLs to a magnet so clients can find peers
 * when the source only listed a single announce URL (e.g. Rutracker).
 */
export function enrichMagnetWithOpenTrackers(magnet: unknown): string {
  if (!magnet || typeof magnet !== "string" || !magnet.includes("btih:")) {
    return String(magnet ?? "");
  }
  let out = magnet.trim();
  for (const tr of TRACKERS) {
    const enc = encodeURIComponent(tr);
    if (out.includes(`tr=${enc}`) || out.includes(tr)) continue;
    out += `&tr=${enc}`;
  }
  return out;
}

/** Число и единица размера файла (для двухстрочной колонки без переноса). */
export function fmtSizeParts(bytes: unknown): { value: string; unit: string } {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) n = 0;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  const text = u === 0 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1);
  return { value: text, unit: units[u]! };
}

export function fmtSize(bytes: unknown): string {
  const { value, unit } = fmtSizeParts(bytes);
  return `${value} ${unit}`;
}

/** Sum of `file.size` for loaded torrent file rows. */
export function sumFileSizes(files: Array<{ size?: unknown }> | null | undefined): number {
  if (!files?.length) return 0;
  let s = 0;
  for (const f of files) {
    const n = Number(f.size);
    if (Number.isFinite(n)) s += n;
  }
  return s;
}

export function fmtDate(val: unknown): string {
  if (val == null || val === 0 || val === "0" || val === "—") return "—";
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

const AUDIO_FORMAT_LABELS: Readonly<Record<string, string>> = Object.freeze({
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

export function isAudio(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return AUDIO_EXTS.has(ext);
}

const FORMAT_NAME_RE = /\b(flac|mp3|ape|wav|m4a|ogg|wv|aac|opus)\b/i;

const NON_PLAYABLE_RE =
  /\b(xvid|divx|x264|x265|h\.?264|h\.?265|hevc|avc|720p|1080p|2160p|480p|4k|dvdrip|bdrip|hdrip|webrip|web-?dl|hdtv|sacd|sacd-r|dsd|dsf|dff)\b/i;

// Case-insensitive, unicode-aware: ASCII `\b` doesn't fire between two Cyrillic
// characters, so "Клипы" would slip through. Use explicit char classes instead.
const VIDEO_CATEGORY_RE = /(?:^|[^\p{L}])(?:видео|клип|video|clip)/iu;

/**
 * Returns false when a torrent is unlikely to contain playable audio files.
 * Checks video codec/resolution keywords in the name and video-section
 * keywords in the category (e.g. "Музыкальное видео", "Клипы").
 */
export function isLikelyPlayable(name: unknown, category: unknown): boolean {
  if (NON_PLAYABLE_RE.test(String(name ?? ""))) return false;
  if (VIDEO_CATEGORY_RE.test(String(category ?? ""))) return false;
  return true;
}

/** Dominant audio format (FLAC / MP3 / …) from a torrent display name, or null. */
export function dominantFormatFromName(name: unknown): string | null {
  if (!name) return null;
  const m = String(name).match(FORMAT_NAME_RE);
  return m ? m[1]!.toUpperCase() : null;
}

/** Normalized human-readable audio format from a file path. "AUDIO" if unknown. */
export function audioFormatLabel(path: unknown): string {
  const value = String(path ?? "").trim();
  if (!value) return "AUDIO";
  const dot = value.lastIndexOf(".");
  if (dot < 0 || dot === value.length - 1) return "AUDIO";
  const ext = value.slice(dot + 1).toLowerCase();
  if (AUDIO_FORMAT_LABELS[ext]) return AUDIO_FORMAT_LABELS[ext]!;
  if (!/^[a-z0-9]{1,6}$/.test(ext)) return "AUDIO";
  return ext.toUpperCase();
}

export function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

const META_TAG_WORDS_RE =
  /\b(flac|mp3|ape|wav|wv|aac|ogg|opus|m4a|wma|ac3|dts|lossless|lossy|320|256|192|128|v0|v2|cbr|vbr|kbps|web|cd|vinyl|dvd|hdtv|sacd|blu-?ray|remaster(?:ed)?|deluxe|expanded|bonus|edition|rip|scan|of|tr\d+)\b/i;

/** Strip common audio release tags from a name. */
export function stripMetaTags(str: string | null | undefined): string {
  if (!str) return str ?? "";
  return str
    .replace(/^(\[[\w\d]{1,10}\]\s*)+/, "")
    .replace(/^(19|20)\d{2}\s+/, "")
    .replace(/^\[\d{4}\]\s*/, "")
    .replace(/^([\[(][^\[\]()]*[\])]\s*)+/, "")
    .replace(/\s*[\[(]([^\[\]()]{1,40})[\])]/g, (match, inner) => {
      const s = String(inner).trim();
      if (/^\d{4}$/.test(s)) return "";
      if (META_TAG_WORDS_RE.test(s)) return "";
      return match;
    })
    .trim();
}

/** Leading track index in basename ("01. Title.flac" → { order: 1, title: "Title.flac" }), or null. */
export function parseAudioTrackPrefix(basenameStr: string): { order: number; title: string } | null {
  const m = basenameStr.match(/^(\d{1,3})\s*[.\-–—]\s*(.+)$/);
  if (m) {
    const title = m[2]!.trim();
    if (title) return { order: parseInt(m[1]!, 10), title };
  }
  const m2 = basenameStr.match(/^(\d{1,3})\s+([A-Za-zА-Яа-яЁёÀ-ɏ].+)$/);
  if (m2) {
    const title = m2[2]!.trim();
    if (title) return { order: parseInt(m2[1]!, 10), title };
  }
  return null;
}

function stripFilenameExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 1) return name;
  return name.slice(0, dot);
}

const VARIOUS_ARTISTS_RE = /^(va|v\.a\.?|various(\s+artists?)?|разные(\s+исполнители)?)$/i;

const DISC_MARKER_RE = /^(cd|disc|disk|part|диск)\s*\d+$/i;

/** True if `name` is a disc/part marker like "CD1", "Disc 2", "Диск 1". */
export function isDiscMarker(name: string | null | undefined): boolean {
  return DISC_MARKER_RE.test((name ?? "").trim());
}

/** True if the whole token is a 4-digit release year (not an artist name). */
export function isYearLike(s: unknown): boolean {
  return /^\d{4}$/.test(String(s ?? "").trim());
}

/**
 * Removes leading "YYYY - …" segments. RuTracker often uses "2005 - Artist - Album";
 * otherwise the first token before " - " is parsed as the artist and becomes a year.
 */
function stripLeadingYearDashPrefixes(str: unknown): string {
  let s = String(str ?? "").trim();
  let guard = 0;
  while (guard++ < 8 && s.length) {
    const m = s.match(/^(19\d{2}|20\d{2})\s*[-–—]\s+(.+)$/);
    if (!m) break;
    s = m[2]!.trim();
  }
  return s;
}

/**
 * Album title from "Artist - Album [tags]". Strips tags, then takes the part
 * after the first " - " separator.
 */
export function extractAlbumFromTorrentName(torrentName: string | null | undefined): string {
  if (!torrentName) return "";
  let cleaned = stripMetaTags(torrentName.trim());
  cleaned = stripLeadingYearDashPrefixes(cleaned);
  if (!cleaned) return "";
  const m = cleaned.match(/^.+?\s+[-–—]\s+(.+)$/);
  return m ? m[1]!.trim() : cleaned;
}

/** Artist from "Artist - Album"; strips leading "YYYY - " first. */
export function extractArtist(torrentName: string | null | undefined): string {
  if (!torrentName) return "";
  // Strip the year prefix BEFORE stripMetaTags: the latter eats the bare year
  // ("2005 ") separately, which used to leave a stray leading "- " behind.
  let name = stripLeadingYearDashPrefixes(torrentName);
  name = stripMetaTags(name);
  name = name.replace(/^([\[(][^\[\]()]*[\])]\s*)+/, "").trim();
  name = stripLeadingYearDashPrefixes(name);
  const m = name.match(/^(.+?)\s+[-–—]\s+/);
  const artist = m ? m[1]!.trim() : name;
  return VARIOUS_ARTISTS_RE.test(artist) ? "" : artist;
}

/**
 * Priority: explicit > torrent name > magnet dn= > dirPath segments.
 */
export function extractTrackArtist(
  torrentName: string | null | undefined,
  albumDirPath: string | null | undefined,
  explicitArtist: string | null | undefined,
  magnet: string | null | undefined,
): string {
  if (explicitArtist) {
    const raw = String(explicitArtist).trim();
    if (raw && !isYearLike(raw)) {
      const cleaned = extractArtist(raw);
      const candidate = (cleaned || raw).trim();
      if (candidate && !isYearLike(candidate)) return candidate;
    }
  }

  const fromTorrent = extractArtist(torrentName);
  if (fromTorrent && !isYearLike(fromTorrent)) return fromTorrent;

  if (magnet) {
    const m = magnet.match(/[?&]dn=([^&]+)/);
    if (m) {
      try {
        const dn = decodeURIComponent(m[1]!);
        const fromDn = extractArtist(dn);
        if (fromDn && !isYearLike(fromDn)) return fromDn;
      } catch { /* malformed encoding — skip */ }
    }
  }

  if (albumDirPath) {
    for (const seg of albumDirPath.split("/").filter(Boolean)) {
      if (isYearLike(seg)) continue;
      const fromSeg = extractArtist(seg);
      if (fromSeg && !isYearLike(fromSeg)) return fromSeg;
    }
  }

  const tail =
    stripMetaTags(fromTorrent) || stripMetaTags(torrentName || "") || "";
  if (tail && !isYearLike(tail.trim())) return tail;
  return "";
}

/** Basename for UI: no leading "01. " / "02 - ", no file extension. */
export function trackDisplayBasename(path: string): string {
  const base = basename(path);
  const p = parseAudioTrackPrefix(base);
  const withoutPrefix = p ? p.title : base;
  return stripFilenameExtension(withoutPrefix);
}

/** Parses "Artist - Title" from a track file path for two-line UI. */
export function parseArtistTitleFromTrackFilename(path: unknown): { artist: string; title: string } {
  const base = basename(String(path ?? "").replace(/\\/g, "/"));
  const p = parseAudioTrackPrefix(base);
  const rest = p ? p.title : base;
  const noExt = stripFilenameExtension(rest);
  const cleaned = stripMetaTags(noExt).trim();
  if (!cleaned) return { artist: "", title: "" };
  const m = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) {
    const a = m[1]!.trim();
    const t = m[2]!.trim();
    if (a && t) {
      // VA is noise — drop the leading "VA - " and treat the rest as the title.
      if (VARIOUS_ARTISTS_RE.test(a)) return { artist: "", title: t };
      return { artist: a, title: t };
    }
  }
  return { artist: "", title: cleaned };
}

function sortAudioFilesByTrackPrefix<F extends FileRow>(audioFiles: F[]): F[] {
  if (audioFiles.length <= 1) return audioFiles;
  const parsed = audioFiles.map((f, i) => ({
    f,
    i,
    p: parseAudioTrackPrefix(basename(f.path)),
  }));
  if (!parsed.every((x) => x.p !== null)) return audioFiles;
  parsed.sort((a, b) => {
    if (a.p!.order !== b.p!.order) return a.p!.order - b.p!.order;
    return a.i - b.i;
  });
  return parsed.map((x) => x.f);
}

interface FileTreeNode {
  __files: Array<{ name: string; size?: number; origIdx?: number }>;
  [dir: string]: FileTreeNode | Array<{ name: string; size?: number; origIdx?: number }>;
}

export function buildTree(files: FileRow[]): FileTreeNode {
  const root: FileTreeNode = { __files: [] };
  for (const f of files) {
    const parts = f.path.replace(/\\/g, "/").split("/");
    let node: FileTreeNode = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]!;
      if (!node[p]) node[p] = { __files: [] };
      node = node[p] as FileTreeNode;
    }
    node.__files.push({ name: parts.at(-1)!, size: f.size, origIdx: f.origIdx });
  }
  return root;
}
