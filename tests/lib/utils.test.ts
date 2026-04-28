import { describe, it, expect } from "vitest";
import "../_setup.js";

import {
  isImage,
  isAudio,
  detectAlbums,
  orderedAudioFiles,
  makeMagnet,
  enrichMagnetWithOpenTrackers,
  fmtSize,
  fmtSizeParts,
  sumFileSizes,
  fmtDate,
  isLikelyPlayable,
  dominantFormatFromName,
  audioFormatLabel,
  basename,
  stripMetaTags,
  parseAudioTrackPrefix,
  isDiscMarker,
  isYearLike,
  extractAlbumFromTorrentName,
  extractArtist,
  extractTrackArtist,
  trackDisplayBasename,
  parseArtistTitleFromTrackFilename,
  buildTree,
  MAX_TORRENT_COVER_BYTES,
  AUDIO_EXTS,
} from "../../src/lib/utils.js";

describe("isImage / isAudio", () => {
  it("recognises image extensions", () => {
    expect(isImage("cover.jpg")).toBe(true);
    expect(isImage("cover.JPEG")).toBe(true);
    expect(isImage("cover.png")).toBe(true);
    expect(isImage("cover.webp")).toBe(true);
    expect(isImage("cover.bmp")).toBe(true);
    expect(isImage("cover.svg")).toBe(false);
    expect(isImage("song.mp3")).toBe(false);
  });
  it("recognises audio extensions", () => {
    for (const ext of AUDIO_EXTS) {
      expect(isAudio(`track${ext}`)).toBe(true);
    }
    expect(isAudio("note.txt")).toBe(false);
    expect(isAudio("cover.jpg")).toBe(false);
  });
});

describe("detectAlbums", () => {
  it("empty / null input", () => {
    expect(detectAlbums([])).toEqual([]);
    expect(detectAlbums(null)).toEqual([]);
    expect(detectAlbums(undefined)).toEqual([]);
  });

  it("groups files by parent folder and attaches covers", () => {
    const files = [
      { path: "Album A/01 Track.mp3", size: 100 },
      { path: "Album A/02 Track.mp3", size: 110 },
      { path: "Album A/cover.jpg", size: 50 },
      { path: "Album B/01 Song.flac", size: 200 },
      { path: "Album B/folder.jpeg", size: 40 },
    ];
    const out = detectAlbums(files);
    expect(out).toHaveLength(2);
    expect(out[0]?.dirPath).toBe("Album A");
    expect(out[0]?.audioFiles).toHaveLength(2);
    expect(out[0]?.coverFile?.path).toBe("Album A/cover.jpg");
    expect(out[1]?.coverFile?.path).toBe("Album B/folder.jpeg");
  });

  it("prefers 'cover' over 'folder' when both present", () => {
    const files = [
      { path: "X/a.mp3" },
      { path: "X/folder.jpg" },
      { path: "X/cover.png" },
    ];
    const [alb] = detectAlbums(files);
    expect(alb?.coverFile?.path).toBe("X/cover.png");
  });

  it("falls back to parent directory cover when local dir has none", () => {
    const files = [
      { path: "CD/CD1/01.flac" },
      { path: "CD/cover.jpg" },
    ];
    const [alb] = detectAlbums(files);
    expect(alb?.coverFile?.path).toBe("CD/cover.jpg");
  });

  it("handles backslash paths (Windows)", () => {
    const files = [{ path: "Album\\01.mp3" }];
    const [alb] = detectAlbums(files);
    expect(alb?.dirPath).toBe("Album");
  });

  it("files at root get empty dirPath", () => {
    const [alb] = detectAlbums([{ path: "song.mp3" }]);
    expect(alb?.dirPath).toBe("");
    expect(alb?.name).toBe("");
  });

  it("sorts audio by track prefix", () => {
    const files = [
      { path: "X/03 C.mp3" },
      { path: "X/01 A.mp3" },
      { path: "X/02 B.mp3" },
    ];
    const [alb] = detectAlbums(files);
    expect(alb?.audioFiles.map((f) => f.path)).toEqual(["X/01 A.mp3", "X/02 B.mp3", "X/03 C.mp3"]);
  });

  it("preserves order when no track prefixes", () => {
    const files = [
      { path: "X/zz.mp3" },
      { path: "X/aa.mp3" },
    ];
    const [alb] = detectAlbums(files);
    expect(alb?.audioFiles.map((f) => f.path)).toEqual(["X/zz.mp3", "X/aa.mp3"]);
  });
});

describe("orderedAudioFiles", () => {
  it("flatten albums in dirPath order", () => {
    const files = [
      { path: "B/01.mp3" },
      { path: "A/02.mp3" },
      { path: "A/01.mp3" },
    ];
    expect(orderedAudioFiles(files).map((f) => f.path)).toEqual([
      "A/01.mp3", "A/02.mp3", "B/01.mp3",
    ]);
  });
  it("empty for empty input", () => {
    expect(orderedAudioFiles([])).toEqual([]);
    expect(orderedAudioFiles(null)).toEqual([]);
  });
});

describe("makeMagnet + enrichMagnetWithOpenTrackers", () => {
  it("makeMagnet has xt, dn and trackers", () => {
    const m = makeMagnet("deadbeef", "Artist Album");
    expect(m.startsWith("magnet:?xt=urn:btih:deadbeef")).toBe(true);
    expect(m).toContain("dn=Artist%20Album");
    expect(m).toContain("tr=");
  });
  it("enrich appends missing trackers, idempotent on second run", () => {
    const base = "magnet:?xt=urn:btih:abcdef";
    const once = enrichMagnetWithOpenTrackers(base);
    const twice = enrichMagnetWithOpenTrackers(once);
    expect(once).toBe(twice);
    expect(once.length).toBeGreaterThan(base.length);
  });
  it("enrich is a no-op for non-btih magnets", () => {
    expect(enrichMagnetWithOpenTrackers("not a magnet")).toBe("not a magnet");
    expect(enrichMagnetWithOpenTrackers("")).toBe("");
    expect(enrichMagnetWithOpenTrackers(null)).toBe("");
    expect(enrichMagnetWithOpenTrackers(undefined)).toBe("");
    expect(enrichMagnetWithOpenTrackers(42)).toBe("42");
  });
});

describe("fmtSize / fmtSizeParts", () => {
  it("bytes", () => {
    expect(fmtSizeParts(0)).toEqual({ value: "0", unit: "Б" });
    expect(fmtSizeParts(512)).toEqual({ value: "512", unit: "Б" });
  });
  it("KB", () => {
    expect(fmtSizeParts(1024)).toEqual({ value: "1", unit: "КБ" });
  });
  it("MB rounded to 1 decimal when fractional", () => {
    expect(fmtSizeParts(1_500_000)).toEqual({ value: "1.4", unit: "МБ" });
  });
  it("GB", () => {
    expect(fmtSize(5 * 1024 * 1024 * 1024)).toBe("5 ГБ");
  });
  it("clamps negative / NaN to 0", () => {
    expect(fmtSizeParts(-10)).toEqual({ value: "0", unit: "Б" });
    expect(fmtSizeParts(NaN)).toEqual({ value: "0", unit: "Б" });
    expect(fmtSizeParts(undefined)).toEqual({ value: "0", unit: "Б" });
  });
});

describe("sumFileSizes", () => {
  it("sums finite numbers and ignores non-numbers", () => {
    const s = sumFileSizes([{ size: 10 }, { size: 20 }, { size: "x" }, { size: NaN }, {}]);
    expect(s).toBe(30);
  });
  it("empty returns 0", () => {
    expect(sumFileSizes([])).toBe(0);
    expect(sumFileSizes(null)).toBe(0);
  });
});

describe("fmtDate", () => {
  it("unknown sentinels", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate(undefined)).toBe("—");
    expect(fmtDate(0)).toBe("—");
    expect(fmtDate("0")).toBe("—");
    expect(fmtDate("—")).toBe("—");
  });
  it("unix timestamp number", () => {
    const out = fmtDate(1_700_000_000);
    expect(out).toMatch(/\d{4}/);
  });
  it("long numeric string treated as unix", () => {
    const out = fmtDate("1700000000");
    expect(out).toMatch(/\d{4}/);
  });
  it("passes through non-numeric strings", () => {
    expect(fmtDate("вчера")).toBe("вчера");
  });
});

describe("isLikelyPlayable", () => {
  it("accepts plain audio names", () => {
    expect(isLikelyPlayable("Artist - Album [FLAC]", "Музыка")).toBe(true);
  });
  it("rejects video codecs", () => {
    expect(isLikelyPlayable("Concert 1080p BDRip x264", "Музыка")).toBe(false);
    expect(isLikelyPlayable("Thing HEVC", "")).toBe(false);
  });
  it("rejects video-section category", () => {
    expect(isLikelyPlayable("Artist - X", "Музыкальное видео")).toBe(false);
    expect(isLikelyPlayable("Artist - X", "Клипы")).toBe(false);
  });
  it("rejects DSD / SACD", () => {
    expect(isLikelyPlayable("Album SACD", "")).toBe(false);
  });
  it("null safety", () => {
    expect(isLikelyPlayable(null, null)).toBe(true);
  });
});

describe("dominantFormatFromName", () => {
  it("picks FLAC / MP3 / APE", () => {
    expect(dominantFormatFromName("Artist - Album [FLAC]")).toBe("FLAC");
    expect(dominantFormatFromName("Artist - Album [MP3 320]")).toBe("MP3");
    expect(dominantFormatFromName("Artist (APE)")).toBe("APE");
  });
  it("null when no tag", () => {
    expect(dominantFormatFromName("Artist - Album")).toBeNull();
    expect(dominantFormatFromName(null)).toBeNull();
    expect(dominantFormatFromName("")).toBeNull();
  });
});

describe("audioFormatLabel", () => {
  it("known extensions mapped", () => {
    expect(audioFormatLabel("song.mp3")).toBe("MP3");
    expect(audioFormatLabel("song.FLAC")).toBe("FLAC");
    expect(audioFormatLabel("song.opus")).toBe("OPUS");
  });
  it("uppercase unknown short extension", () => {
    expect(audioFormatLabel("song.dsd")).toBe("DSD");
  });
  it("AUDIO fallback", () => {
    expect(audioFormatLabel("")).toBe("AUDIO");
    expect(audioFormatLabel(null)).toBe("AUDIO");
    expect(audioFormatLabel("song.")).toBe("AUDIO");
    expect(audioFormatLabel("noext")).toBe("AUDIO");
    expect(audioFormatLabel("weird.verylongext12345")).toBe("AUDIO");
    expect(audioFormatLabel("weird.not!")).toBe("AUDIO");
  });
});

describe("basename", () => {
  it("strips path", () => {
    expect(basename("a/b/c.mp3")).toBe("c.mp3");
    expect(basename("a\\b\\c.mp3")).toBe("c.mp3");
    expect(basename("flat.mp3")).toBe("flat.mp3");
  });
});

describe("stripMetaTags", () => {
  it("handles empty", () => {
    expect(stripMetaTags("")).toBe("");
    expect(stripMetaTags(null)).toBe("");
    expect(stripMetaTags(undefined)).toBe("");
  });
  it("strips leading short brackets", () => {
    expect(stripMetaTags("[TR24][OF] Artist - Album")).toBe("Artist - Album");
  });
  it("strips leading year", () => {
    expect(stripMetaTags("2023 Artist - Album")).toBe("Artist - Album");
    expect(stripMetaTags("[2005] Artist - Album")).toBe("Artist - Album");
  });
  it("strips leading category bracket", () => {
    expect(stripMetaTags("(Hip-hop) Artist - Album")).toBe("Artist - Album");
  });
  it("strips inline meta bracket but keeps feat.", () => {
    expect(stripMetaTags("Artist - Album [FLAC 320]")).toBe("Artist - Album");
    expect(stripMetaTags("Song (feat. X)")).toBe("Song (feat. X)");
  });
  it("strips bare year in parens", () => {
    expect(stripMetaTags("Album (2005)")).toBe("Album");
  });
});

describe("parseAudioTrackPrefix", () => {
  it("with dot/dash separator", () => {
    expect(parseAudioTrackPrefix("01. Song.mp3")).toEqual({ order: 1, title: "Song.mp3" });
    expect(parseAudioTrackPrefix("02 - B.flac")).toEqual({ order: 2, title: "B.flac" });
    expect(parseAudioTrackPrefix("03 – C")).toEqual({ order: 3, title: "C" });
  });
  it("space-only separator requires a letter first", () => {
    expect(parseAudioTrackPrefix("01 Song.mp3")).toEqual({ order: 1, title: "Song.mp3" });
    // Space-only + digit start → null (no letter first).
    expect(parseAudioTrackPrefix("01 2nd")).toBeNull();
  });
  it("null on no prefix", () => {
    expect(parseAudioTrackPrefix("Song.mp3")).toBeNull();
  });
  it("null when title missing after prefix", () => {
    expect(parseAudioTrackPrefix("01. ")).toBeNull();
  });
});

describe("isDiscMarker / isYearLike", () => {
  it("disc markers", () => {
    expect(isDiscMarker("CD1")).toBe(true);
    expect(isDiscMarker("Disc 2")).toBe(true);
    expect(isDiscMarker("Диск 3")).toBe(true);
    expect(isDiscMarker("Part 4")).toBe(true);
    expect(isDiscMarker("Album")).toBe(false);
    expect(isDiscMarker("")).toBe(false);
    expect(isDiscMarker(null)).toBe(false);
  });
  it("year detection", () => {
    expect(isYearLike("2020")).toBe(true);
    expect(isYearLike(" 2020 ")).toBe(true);
    expect(isYearLike(2020)).toBe(true);
    expect(isYearLike("Artist")).toBe(false);
    expect(isYearLike("")).toBe(false);
    expect(isYearLike(null)).toBe(false);
  });
});

describe("extractAlbumFromTorrentName", () => {
  it("part after first separator", () => {
    expect(extractAlbumFromTorrentName("Artist - Album [FLAC]")).toBe("Album");
  });
  it("strips leading year", () => {
    expect(extractAlbumFromTorrentName("2005 - Artist - Album")).toBe("Album");
  });
  it("whole string if no separator", () => {
    expect(extractAlbumFromTorrentName("LoneName")).toBe("LoneName");
  });
  it("empty inputs", () => {
    expect(extractAlbumFromTorrentName("")).toBe("");
    expect(extractAlbumFromTorrentName(null)).toBe("");
  });
});

describe("extractArtist", () => {
  it("first segment of Artist - Album", () => {
    expect(extractArtist("Artist - Album")).toBe("Artist");
  });
  it("strips leading year-dash prefix", () => {
    expect(extractArtist("2005 - Artist - Album")).toBe("Artist");
  });
  it("returns empty for Various Artists", () => {
    expect(extractArtist("VA - Comp")).toBe("");
    expect(extractArtist("Various Artists - Comp")).toBe("");
    expect(extractArtist("Разные исполнители - Comp")).toBe("");
  });
  it("handles falsy input", () => {
    expect(extractArtist("")).toBe("");
    expect(extractArtist(null)).toBe("");
  });
});

describe("extractTrackArtist", () => {
  it("prefers explicit artist", () => {
    expect(extractTrackArtist("T", null, "Explicit", null)).toBe("Explicit");
  });
  it("skips year-like explicit", () => {
    expect(extractTrackArtist("Artist - Album", null, "2005", null)).toBe("Artist");
  });
  it("falls back to torrent name", () => {
    expect(extractTrackArtist("Artist - Album", null, null, null)).toBe("Artist");
  });
  it("parses magnet dn= when torrent name useless", () => {
    const m = "magnet:?xt=urn:btih:x&dn=" + encodeURIComponent("Real - Album");
    expect(extractTrackArtist("2024", null, null, m)).toBe("Real");
  });
  it("walks dirPath segments", () => {
    expect(extractTrackArtist("", "Кровосток/2005 - Река крови", null, null)).toBe("Кровосток");
  });
  it("last-resort stripped tail", () => {
    expect(extractTrackArtist("NoSeparator [FLAC]", null, null, null)).toBe("NoSeparator");
  });
  it("returns empty when truly nothing", () => {
    expect(extractTrackArtist("2024", null, null, null)).toBe("");
  });
  it("tolerates malformed magnet dn encoding", () => {
    const m = "magnet:?xt=urn:btih:x&dn=%E0%A4%A"; // bad sequence
    expect(extractTrackArtist("", null, null, m)).toBe("");
  });
});

describe("trackDisplayBasename", () => {
  it("strips prefix and extension", () => {
    expect(trackDisplayBasename("A/01 - Song.mp3")).toBe("Song");
    expect(trackDisplayBasename("song.mp3")).toBe("song");
    expect(trackDisplayBasename("no-ext")).toBe("no-ext");
  });
});

describe("parseArtistTitleFromTrackFilename", () => {
  it("splits Artist - Title", () => {
    expect(parseArtistTitleFromTrackFilename("01 - Artist - Title.mp3"))
      .toEqual({ artist: "Artist", title: "Title" });
  });
  it("no separator → just title", () => {
    expect(parseArtistTitleFromTrackFilename("01 Track.mp3"))
      .toEqual({ artist: "", title: "Track" });
  });
  it("drops VA / Various", () => {
    expect(parseArtistTitleFromTrackFilename("VA - Comp.mp3"))
      .toEqual({ artist: "", title: "Comp" });
  });
  it("empty / null", () => {
    expect(parseArtistTitleFromTrackFilename("")).toEqual({ artist: "", title: "" });
    expect(parseArtistTitleFromTrackFilename(null)).toEqual({ artist: "", title: "" });
  });
  it("win-style path", () => {
    expect(parseArtistTitleFromTrackFilename("A\\B\\01 - X - Y.flac"))
      .toEqual({ artist: "X", title: "Y" });
  });
});

describe("buildTree", () => {
  it("nested structure", () => {
    const tree = buildTree([
      { path: "A/B/x.mp3", size: 10, origIdx: 0 },
      { path: "A/y.mp3", size: 20, origIdx: 1 },
      { path: "z.mp3", size: 30, origIdx: 2 },
    ]);
    expect(tree.__files).toHaveLength(1);
    const a = tree.A as typeof tree;
    expect(a.__files).toHaveLength(1);
    const b = a.B as typeof tree;
    expect(b.__files).toHaveLength(1);
    expect(b.__files[0]).toEqual({ name: "x.mp3", size: 10, origIdx: 0 });
  });
});

describe("constants", () => {
  it("cover byte cap", () => {
    expect(MAX_TORRENT_COVER_BYTES).toBe(3 * 1024 * 1024);
  });
});
