import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";
import { buildCacheKeys, probeCache } from "../../src/persistence/generalListCacheProbe.js";
import { clearTrackCache, putTrack } from "../../src/persistence/trackCache.js";
import type { TrackData } from "../../src/track/types.js";

function rtTrack(topicId: string, fileIdx = 0): TrackData {
  return {
    type: "track",
    id: `rt:track:${topicId}:${fileIdx}`,
    title: "Paranoid Android",
    artist: "Radiohead",
    albumTitle: "OK Computer",
    albumId: `rt:album:${topicId}`,
    fileName: "02 Paranoid Android.flac",
    format: "flac",
    bitrate: 900,
    duration: 383,
    size: null,
    coverUrl: null,
    sources: [{
      kind: "rutracker",
      refs: { topicId, magnet: "magnet:?xt=urn:btih:DEADBEEF", fileIdx, coverFileIdx: null, albumDirPath: null },
    }],
  };
}

function slskTrack(username = "dj_nebula", filepath = "/music/Florence/Ship to Wreck.flac"): TrackData {
  return {
    type: "track",
    id: `slsk:track:${username}|${filepath}`,
    title: "Ship to Wreck",
    artist: "Florence + the Machine",
    albumTitle: "How Big, How Blue, How Beautiful",
    albumId: null,
    fileName: "01 Ship to Wreck.flac",
    format: "flac",
    bitrate: null,
    duration: null,
    size: 40_000_000,
    coverUrl: "https://example.com/cover.jpg",
    sources: [{
      kind: "soulseek",
      refs: { slskUsername: username, slskFilepath: filepath },
      raw: {
        cover: { slsk_username: username, slsk_filepath: "/music/Florence/cover.jpg", size: 50000 },
        peers: 2,
      },
    }],
  };
}

beforeEach(() => {
  fakeLocalStorage.clear();
  clearTrackCache();
});

describe("buildCacheKeys — rutracker", () => {
  it("sets trackCacheId to track.id", () => {
    const keys = buildCacheKeys(rtTrack("123456"));
    expect(keys.trackCacheId).toBe("rt:track:123456:0");
  });

  it("includes rutrackerTopicCover with topicId", () => {
    const keys = buildCacheKeys(rtTrack("123456"));
    expect(keys.rutrackerTopicCover).toMatch(/123456/);
  });

  it("omits rutrackerTopicCover when topicId is null", () => {
    const data = rtTrack("123456");
    (data.sources[0].refs as { topicId: string | null }).topicId = null;
    const keys = buildCacheKeys(data);
    expect(keys.rutrackerTopicCover).toBeUndefined();
  });

  it("sets torrentFileB64 to topicId string", () => {
    const keys = buildCacheKeys(rtTrack("123456"));
    expect(keys.torrentFileB64).toBe("123456");
  });

  it("builds deezerCanonical key from artist and title", () => {
    const keys = buildCacheKeys(rtTrack("123456"));
    // normalize: "Radiohead" → "radiohead", "Paranoid Android" → "paranoidandroid"
    expect(keys.deezerCanonical).toBe("radiohead|paranoidandroid");
  });

  it("builds deezerAlbumArt key when albumTitle present", () => {
    const keys = buildCacheKeys(rtTrack("123456"));
    expect(keys.deezerAlbumArt).toContain("okcomputer");
  });

  it("omits deezerAlbumArt when albumTitle absent", () => {
    const data = rtTrack("123456");
    data.albumTitle = null;
    const keys = buildCacheKeys(data);
    expect(keys.deezerAlbumArt).toBeUndefined();
  });

  it("includes streamIdentity magnet and fileIdx", () => {
    const keys = buildCacheKeys(rtTrack("123456", 3));
    expect(keys.streamIdentity?.magnet).toContain("DEADBEEF");
    expect(keys.streamIdentity?.fileIdx).toBe(3);
  });

  it("has no soulseekCover field", () => {
    const keys = buildCacheKeys(rtTrack("123456"));
    expect(keys.soulseekCover).toBeUndefined();
  });
});

describe("buildCacheKeys — soulseek", () => {
  it("sets trackCacheId to track.id", () => {
    const keys = buildCacheKeys(slskTrack());
    expect(keys.trackCacheId).toBe("slsk:track:dj_nebula|/music/Florence/Ship to Wreck.flac");
  });

  it("has no rutrackerTopicCover or torrentFileB64", () => {
    const keys = buildCacheKeys(slskTrack());
    expect(keys.rutrackerTopicCover).toBeUndefined();
    expect(keys.torrentFileB64).toBeUndefined();
  });

  it("builds soulseekCover key from raw.cover", () => {
    const keys = buildCacheKeys(slskTrack());
    expect(keys.soulseekCover).toMatch(/dj_nebula/);
    expect(keys.soulseekCover).toContain("cover.jpg");
  });

  it("omits soulseekCover when no raw.cover", () => {
    const data = slskTrack();
    (data.sources[0].raw as { cover: null }).cover = null;
    const keys = buildCacheKeys(data);
    expect(keys.soulseekCover).toBeUndefined();
  });

  it("sets streamIdentity slskUsername + slskFilepath", () => {
    const keys = buildCacheKeys(slskTrack());
    expect(keys.streamIdentity?.slskUsername).toBe("dj_nebula");
    expect(keys.streamIdentity?.slskFilepath).toContain("Ship to Wreck");
  });
});

describe("probeCache — trackCache", () => {
  it("reports miss when track not in cache", () => {
    const data = rtTrack("111");
    const keys = buildCacheKeys(data);
    const c = probeCache(data, keys);
    expect(c.trackCache.state).toBe("miss");
  });

  it("reports hit when track is in trackCache", () => {
    const data = rtTrack("111");
    putTrack(data);
    const keys = buildCacheKeys(data);
    const c = probeCache(data, keys);
    expect(c.trackCache.state).toBe("hit");
    expect(c.trackCache.layer).toBe("track_cache");
  });

  it("includes payloadHint when coverUrl present in trackCache", () => {
    const data = { ...rtTrack("111"), coverUrl: "https://example.com/img.jpg" };
    putTrack(data);
    const keys = buildCacheKeys(data);
    const c = probeCache(data, keys);
    expect(c.trackCache.payloadHint).toContain("coverUrl=");
  });
});

describe("probeCache — rutracker streaming + torrent", () => {
  it("includes streaming with backendDiskCache=partial", () => {
    const data = rtTrack("222");
    const c = probeCache(data, buildCacheKeys(data));
    expect(c.streaming?.backendDiskCache).toBe("partial");
  });

  it("reports torrent B64 miss when not in localStorage", () => {
    const data = rtTrack("333");
    const c = probeCache(data, buildCacheKeys(data));
    expect(c.torrent?.fileListB64?.state).toBe("miss");
  });

  it("reports torrent B64 hit when key is present", () => {
    fakeLocalStorage.set("torrent_file_b64_v1_333", "ABCDEF==");
    const data = rtTrack("333");
    const c = probeCache(data, buildCacheKeys(data));
    expect(c.torrent?.fileListB64?.state).toBe("hit");
    expect(c.torrent?.fileListB64?.bytesApprox).toBe(8);
  });
});

describe("probeCache — inlinedOnTrack", () => {
  it("inlinedOnTrack is undefined when no coverUrl", () => {
    const data = rtTrack("444");
    const c = probeCache(data, buildCacheKeys(data));
    expect(c.covers?.inlinedOnTrack).toBeUndefined();
  });

  it("detects https coverUrl", () => {
    const data = { ...rtTrack("444"), coverUrl: "https://cdn.example.com/img.jpg" };
    const c = probeCache(data, buildCacheKeys(data));
    expect(c.covers?.inlinedOnTrack?.kind).toBe("https");
  });

  it("detects data_url coverUrl", () => {
    const data = { ...rtTrack("444"), coverUrl: "data:image/jpeg;base64,AAAA" };
    const c = probeCache(data, buildCacheKeys(data));
    expect(c.covers?.inlinedOnTrack?.kind).toBe("data_url");
  });
});

describe("probeCache — soulseek streaming", () => {
  it("includes streaming note for SLSK tracks", () => {
    const data = slskTrack();
    const c = probeCache(data, buildCacheKeys(data));
    expect(c.streaming?.backendDiskCache).toBe("unknown");
    expect(c.streaming?.note).toContain("SLSK");
  });
});

describe("probeCache — capturedAt", () => {
  it("capturedAt is recent", () => {
    const before = Date.now();
    const c = probeCache(rtTrack("555"), buildCacheKeys(rtTrack("555")));
    expect(c.capturedAt).toBeGreaterThanOrEqual(before);
  });
});
