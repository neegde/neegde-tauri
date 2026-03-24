const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
const COVER_NAMES = ["cover", "folder", "front", "albumart", "album", "artwork", "thumb"];

/** Max size for torrent image fetch / cover preview (matches backend cap). */
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

export function fmtSize(bytes) {
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
  return `${text} ${units[u]}`;
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

export function isAudio(path) {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return AUDIO_EXTS.has(ext);
}

export function basename(path) {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

/**
 * Leading track index in the basename (e.g. "01. Title.flac", "02 - Title.mp3").
 * Returns { order, title } with `title` = rest of filename (incl. extension), or null.
 */
export function parseAudioTrackPrefix(basenameStr) {
  const m = basenameStr.match(/^(\d{1,3})\s*[.\-–—]\s*(.+)$/);
  if (!m) return null;
  const title = m[2].trim();
  if (!title) return null;
  return { order: parseInt(m[1], 10), title };
}

function stripFilenameExtension(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 1) return name;
  return name.slice(0, dot);
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
