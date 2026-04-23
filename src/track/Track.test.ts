import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrackData } from "./types.js";

// Mock Tauri bridges BEFORE importing the SUT so the tests run in Node.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(null),
}));
vi.mock("../soulseek/coverCache.js", () => ({
  getSlskCoverReactive: vi.fn(() => null),
  getSlskCoverDataUrl: vi.fn(() => Promise.resolve(null)),
  peekSlskCover: vi.fn(() => undefined),
}));
vi.mock("../rutracker/coverCache.js", () => ({
  getCoverReactive: vi.fn(() => null),
  getRutrackerCoverDataUrl: vi.fn(() => Promise.resolve(null)),
  peekRutrackerCover: vi.fn(() => undefined),
}));
vi.mock("../stores/entities.js", () => ({
  getAlbum: vi.fn(() => null),
  entitiesVersion: { value: 0 },
}));

import { invoke } from "@tauri-apps/api/core";
import { buildTrack } from "./factory.js";
import { SoulseekTrack } from "./SoulseekTrack.js";
import { RutrackerTrack, MagnetTrack } from "./RutrackerTrack.js";
import { getSlskCoverDataUrl, peekSlskCover, getSlskCoverReactive } from "../soulseek/coverCache.js";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const peekSlskMock = peekSlskCover as unknown as ReturnType<typeof vi.fn>;
const fetchSlskMock = getSlskCoverDataUrl as unknown as ReturnType<typeof vi.fn>;
const reactSlskMock = getSlskCoverReactive as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

function makeSlskData(overrides: Partial<TrackData> = {}): TrackData {
  return {
    type: "track",
    id: "slsk:track:alice|music/song.mp3",
    title: "song.mp3",
    artist: "Alice",
    albumTitle: "Music",
    albumId: null,
    fileName: "song.mp3",
    format: "MP3",
    bitrate: 320,
    duration: 180,
    size: 7_000_000,
    sources: [{
      kind: "soulseek",
      refs: { slskUsername: "alice", slskFilepath: "music/song.mp3" },
      raw: {
        cover: { slsk_username: "alice", slsk_filepath: "music/cover.jpg", size: 120_000 },
        peers: 5,
      },
    }],
    ...overrides,
  };
}

function makeRtData(overrides: Partial<TrackData> = {}): TrackData {
  return {
    type: "track",
    id: "rt:track:12345:3",
    title: "03. Track.mp3",
    artist: "Artist",
    albumTitle: "Album",
    albumId: null,
    fileName: "03. Track.mp3",
    format: "MP3",
    bitrate: null,
    duration: null,
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

// ── Factory ─────────────────────────────────────────────────────────────────

describe("buildTrack", () => {
  it("returns SoulseekTrack for soulseek source", () => {
    expect(buildTrack(makeSlskData())).toBeInstanceOf(SoulseekTrack);
  });

  it("returns RutrackerTrack for rutracker source", () => {
    expect(buildTrack(makeRtData())).toBeInstanceOf(RutrackerTrack);
  });

  it("returns MagnetTrack for magnet source", () => {
    const data = makeRtData({
      sources: [{
        kind: "magnet",
        refs: {
          magnet: "magnet:?xt=urn:btih:ABC",
          fileIdx: 0,
          coverFileIdx: null,
          albumDirPath: null,
        },
      }],
    });
    expect(buildTrack(data)).toBeInstanceOf(MagnetTrack);
  });

  it("throws on unknown kind", () => {
    const bad = makeSlskData();
    // @ts-expect-error — intentional invalid kind
    bad.sources = [{ kind: "youtube", refs: {} }];
    expect(() => buildTrack(bad)).toThrow(/unsupported source kind/);
  });
});

// ── Identity accessors ──────────────────────────────────────────────────────

describe("Track identity", () => {
  it("exposes typed accessors", () => {
    const t = buildTrack(makeSlskData());
    expect(t.id).toBe("slsk:track:alice|music/song.mp3");
    expect(t.title).toBe("song.mp3");
    expect(t.artist).toBe("Alice");
    expect(t.kind).toBe("soulseek");
    expect(t.bitrate).toBe(320);
  });
});

// ── Soulseek playback ──────────────────────────────────────────────────────

describe("SoulseekTrack playback", () => {
  it("prepareStream invokes soulseek_prepare_stream with correct args", async () => {
    invokeMock.mockResolvedValueOnce({ url: "http://127.0.0.1/slsk/1" });
    const t = buildTrack(makeSlskData());
    const url = await t.prepareStream();
    expect(url).toBe("http://127.0.0.1/slsk/1");
    expect(invokeMock).toHaveBeenCalledWith("soulseek_prepare_stream", {
      username: "alice",
      filepath: "music/song.mp3",
      filesize: 7_000_000,
    });
  });

  it("hasPlaybackIdentity false without slsk fields", () => {
    const data = makeSlskData();
    data.sources[0].refs = { slskUsername: "", slskFilepath: "" };
    expect(buildTrack(data).hasPlaybackIdentity()).toBe(false);
  });

  it("prepareStream returns empty when no playback identity", async () => {
    const data = makeSlskData();
    data.sources[0].refs = { slskUsername: "", slskFilepath: "" };
    expect(await buildTrack(data).prepareStream()).toBe("");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

// ── Soulseek cover ─────────────────────────────────────────────────────────

describe("SoulseekTrack cover", () => {
  it("coverUrl reads from reactive cache by (user, filepath)", () => {
    reactSlskMock.mockReturnValueOnce("data:image/jpg;base64,AAA");
    const t = buildTrack(makeSlskData());
    expect(t.coverUrl()).toBe("data:image/jpg;base64,AAA");
    expect(reactSlskMock).toHaveBeenCalledWith("alice", "music/cover.jpg");
  });

  it("coverUrl returns null when no cover ref", () => {
    const data = makeSlskData();
    (data.sources[0] as { raw: { cover: null } }).raw = { cover: null };
    expect(buildTrack(data).coverUrl()).toBe(null);
  });

  it("startCoverFetch kicks the cache when miss", () => {
    peekSlskMock.mockReturnValueOnce(undefined);
    buildTrack(makeSlskData()).startCoverFetch();
    expect(fetchSlskMock).toHaveBeenCalledWith("alice", "music/cover.jpg", 120_000);
  });

  it("startCoverFetch skips when already cached (positive or negative)", () => {
    peekSlskMock.mockReturnValueOnce("data:image/png;base64,ZZZ");
    buildTrack(makeSlskData()).startCoverFetch();
    expect(fetchSlskMock).not.toHaveBeenCalled();
  });
});

// ── Serialization round-trip ───────────────────────────────────────────────

describe("Track serialization", () => {
  it("toJSON returns plain data passable through localStorage / IPC", () => {
    const data = makeSlskData();
    const t = buildTrack(data);
    const json = JSON.parse(JSON.stringify(t));
    expect(json).toEqual(data);
  });

  it("round-trips through buildTrack", () => {
    const data = makeRtData();
    const t1 = buildTrack(data);
    const t2 = buildTrack(JSON.parse(JSON.stringify(t1)));
    expect(t2).toBeInstanceOf(RutrackerTrack);
    expect(t2.id).toBe(t1.id);
    expect(t2.artist).toBe(t1.artist);
  });
});
