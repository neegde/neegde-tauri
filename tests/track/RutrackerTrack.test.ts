import { describe, it, expect, vi, beforeEach } from "vitest";
import "../_setup.js";

vi.mock("../../src/rutracker/coverCache.js", () => ({
  getCoverReactive: vi.fn(() => null),
  getRutrackerCoverDataUrl: vi.fn(() => Promise.resolve(null)),
  peekRutrackerCover: vi.fn(() => undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { buildTrack } from "../../src/track/factory.js";
import { MagnetTrack, RutrackerTrack } from "../../src/track/RutrackerTrack.js";
import {
  getCoverReactive,
  getRutrackerCoverDataUrl,
  peekRutrackerCover,
} from "../../src/rutracker/coverCache.js";
import type { TrackData } from "../../src/track/types.js";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const reactiveMock = getCoverReactive as unknown as ReturnType<typeof vi.fn>;
const peekMock = peekRutrackerCover as unknown as ReturnType<typeof vi.fn>;
const fetchMock = getRutrackerCoverDataUrl as unknown as ReturnType<typeof vi.fn>;

function rt(overrides: Partial<TrackData> = {}): TrackData {
  return {
    type: "track",
    id: "rt:track:12345:3",
    title: "03. Track.mp3",
    artist: "Artist",
    albumTitle: "Album",
    albumId: null,
    fileName: "03. Track.mp3",
    format: "MP3",
    bitrate: 320,
    duration: 200,
    size: 5_000_000,
    sources: [{
      kind: "rutracker",
      refs: {
        topicId: "12345",
        magnet: "magnet:?xt=urn:btih:ABC",
        fileIdx: 3,
        coverFileIdx: 7,
        albumDirPath: "Artist - Album",
      },
    }],
    ...overrides,
  };
}

function magnet(overrides: Partial<TrackData> = {}): TrackData {
  return {
    type: "track",
    id: "magnet:track:DEF:0",
    title: "unknown.mp3",
    artist: null,
    albumTitle: null,
    albumId: null,
    fileName: "unknown.mp3",
    format: null,
    bitrate: null,
    duration: null,
    size: null,
    sources: [{
      kind: "magnet",
      refs: {
        magnet: "magnet:?xt=urn:btih:DEF",
        fileIdx: 0,
        coverFileIdx: null,
        albumDirPath: null,
      },
    }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── prepareStream ───────────────────────────────────────────────────────────

describe("RutrackerTrack.prepareStream", () => {
  it("invokes torrent_prepare_stream with magnet + fileIdx", async () => {
    // prepareStream fans out a best-effort torrentFileB64ForTrack invoke
    // first (to avoid metadata resolution via DHT); mock it to null so the
    // main prepare invoke is the next call.
    invokeMock.mockResolvedValueOnce(null); // torrent_file_b64_for_track
    invokeMock.mockResolvedValueOnce({ url: "http://127.0.0.1/stream/XYZ" });
    const t = buildTrack(rt()) as RutrackerTrack;
    const url = await t.prepareStream();
    expect(url).toBe("http://127.0.0.1/stream/XYZ");
    // Magnet is enriched with open trackers before being passed to Rust.
    expect(invokeMock).toHaveBeenCalledWith("torrent_prepare_stream", expect.objectContaining({
      fileIdx: 3,
      torrentFileB64: null,
    }));
    const call = invokeMock.mock.calls.find((c) => c[0] === "torrent_prepare_stream");
    expect(call?.[1]?.magnet).toContain("magnet:?xt=urn:btih:ABC");
  });

  it("returns empty when no magnet", async () => {
    const d = rt();
    d.sources[0].refs = {
      topicId: "12345", magnet: "", fileIdx: 3, coverFileIdx: null, albumDirPath: null,
    };
    expect(await buildTrack(d).prepareStream()).toBe("");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns empty URL when invoke returns null", async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await buildTrack(rt()).prepareStream()).toBe("");
  });
});

// ── cover ──────────────────────────────────────────────────────────────────

describe("RutrackerTrack.coverUrl + startCoverFetch", () => {
  it("returns inline coverUrl when present on track data", () => {
    const d = rt({ coverUrl: "data:inline,ABC" });
    expect(buildTrack(d).coverUrl()).toBe("data:inline,ABC");
  });

  it("reads from reactive cache by topicId", () => {
    reactiveMock.mockReturnValueOnce("data:topic,YYY");
    expect(buildTrack(rt()).coverUrl()).toBe("data:topic,YYY");
    expect(reactiveMock).toHaveBeenCalledWith("12345");
  });

  it("returns null without topicId and without inline url", () => {
    const d = rt();
    d.sources[0].refs = { ...d.sources[0].refs, topicId: null };
    expect(buildTrack(d).coverUrl()).toBe(null);
  });

  it("startCoverFetch fires on miss", () => {
    peekMock.mockReturnValueOnce(undefined);
    buildTrack(rt()).startCoverFetch();
    expect(fetchMock).toHaveBeenCalledWith("12345");
  });

  it("startCoverFetch skips on cache hit", () => {
    peekMock.mockReturnValueOnce("data:cached,Z");
    buildTrack(rt()).startCoverFetch();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("startCoverFetch noop without topicId", () => {
    const d = rt();
    d.sources[0].refs = { ...d.sources[0].refs, topicId: null };
    buildTrack(d).startCoverFetch();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── navigationTarget ───────────────────────────────────────────────────────

describe("RutrackerTrack.navigationTarget", () => {
  it("RT uses source=rutracker", () => {
    const target = buildTrack(rt()).navigationTarget();
    expect(target?.source).toBe("rutracker");
    expect(target?.torrentId).toBe("12345");
    expect(target?.magnet).toBe("magnet:?xt=urn:btih:ABC");
    expect(target?.fileIdx).toBe(3);
    expect(target?.albumDirPath).toBe("Artist - Album");
  });

  it("Magnet uses source=magnet", () => {
    const target = buildTrack(magnet()).navigationTarget();
    expect(target?.source).toBe("magnet");
    expect(target?.torrentId).toBe("magnet:track:DEF:0");
    expect(target?.magnet).toBe("magnet:?xt=urn:btih:DEF");
  });
});

// ── hasPlaybackIdentity ────────────────────────────────────────────────────

describe("RutrackerTrack.hasPlaybackIdentity", () => {
  it("true when magnet present", () => {
    expect(buildTrack(rt()).hasPlaybackIdentity()).toBe(true);
  });

  it("false when magnet empty", () => {
    const d = rt();
    d.sources[0].refs = { ...d.sources[0].refs, magnet: "" };
    expect(buildTrack(d).hasPlaybackIdentity()).toBe(false);
  });
});

// ── MagnetTrack extends RutrackerTrack (shares flow) ───────────────────────

describe("MagnetTrack", () => {
  it("is a subclass of RutrackerTrack", () => {
    expect(buildTrack(magnet())).toBeInstanceOf(RutrackerTrack);
    expect(buildTrack(magnet())).toBeInstanceOf(MagnetTrack);
  });

  it("prepareStream uses torrent_prepare_stream (same Rust command as RT)", async () => {
    invokeMock.mockResolvedValueOnce(null); // torrent_file_b64_for_track
    invokeMock.mockResolvedValueOnce({ url: "http://127.0.0.1/stream/MAG" });
    const t = buildTrack(magnet());
    await t.prepareStream();
    const call = invokeMock.mock.calls.find((c) => c[0] === "torrent_prepare_stream");
    expect(call?.[1]?.fileIdx).toBe(0);
    expect(call?.[1]?.magnet).toContain("magnet:?xt=urn:btih:DEF");
  });

  it("navigationTarget labels source=magnet", () => {
    const target = buildTrack(magnet()).navigationTarget();
    expect(target?.source).toBe("magnet");
  });
});
