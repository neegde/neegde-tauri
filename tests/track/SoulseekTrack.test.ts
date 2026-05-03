import { describe, it, expect, vi, beforeEach } from "vitest";
import "../_setup.js";

// Cache mocks — override the test setup so each test can assert calls.
vi.mock("../../src/soulseek/coverCache.js", () => ({
  getSlskCoverReactive: vi.fn(() => null),
  getSlskCoverDataUrl: vi.fn(() => Promise.resolve(null)),
  peekSlskCover: vi.fn(() => undefined),
}));
vi.mock("../../src/stores/entities.js", () => ({
  getAlbum: vi.fn(() => null),
  entitiesVersion: { value: 0 },
}));

import { invoke } from "@tauri-apps/api/core";
import { buildTrack } from "../../src/track/factory.js";
import { SoulseekTrack } from "../../src/track/SoulseekTrack.js";
import {
  getSlskCoverReactive,
  getSlskCoverDataUrl,
  peekSlskCover,
} from "../../src/soulseek/coverCache.js";
import { getAlbum } from "../../src/stores/entities.js";
import type { TrackData } from "../../src/track/types.js";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const peekMock = peekSlskCover as unknown as ReturnType<typeof vi.fn>;
const fetchMock = getSlskCoverDataUrl as unknown as ReturnType<typeof vi.fn>;
const reactiveMock = getSlskCoverReactive as unknown as ReturnType<typeof vi.fn>;
const getAlbumMock = getAlbum as unknown as ReturnType<typeof vi.fn>;

function slsk(overrides: Partial<TrackData> = {}): TrackData {
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

beforeEach(() => {
  vi.clearAllMocks();
});

// ── prepareStream ───────────────────────────────────────────────────────────

describe("SoulseekTrack.prepareStream", () => {
  it("invokes soulseek_prepare_stream with correct args", async () => {
    invokeMock.mockResolvedValueOnce({ url: "http://127.0.0.1/slsk/1" });
    const t = buildTrack(slsk());
    const url = await t.prepareStream();
    expect(url).toBe("http://127.0.0.1/slsk/1");
    expect(invokeMock).toHaveBeenCalledWith("soulseek_prepare_stream", {
      username: "alice",
      filepath: "music/song.mp3",
      filesize: 7_000_000,
    });
  });

  it("returns empty when no playback identity", async () => {
    const data = slsk();
    data.sources[0].refs = { slskUsername: "", slskFilepath: "" };
    expect(await buildTrack(data).prepareStream()).toBe("");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns empty URL when invoke returns null", async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await buildTrack(slsk()).prepareStream()).toBe("");
  });
});

// ── hasPlaybackIdentity ─────────────────────────────────────────────────────

describe("SoulseekTrack.hasPlaybackIdentity", () => {
  it("true with user + filepath", () => {
    expect(buildTrack(slsk()).hasPlaybackIdentity()).toBe(true);
  });

  it("false when user empty", () => {
    const d = slsk();
    d.sources[0].refs = { slskUsername: "", slskFilepath: "music/song.mp3" };
    expect(buildTrack(d).hasPlaybackIdentity()).toBe(false);
  });

  it("false when filepath empty", () => {
    const d = slsk();
    d.sources[0].refs = { slskUsername: "alice", slskFilepath: "" };
    expect(buildTrack(d).hasPlaybackIdentity()).toBe(false);
  });
});

// ── cover ──────────────────────────────────────────────────────────────────

describe("SoulseekTrack.coverUrl + startCoverFetch", () => {
  it("reads from reactive cache by (user, filepath)", () => {
    reactiveMock.mockReturnValueOnce("data:image/jpg;base64,AAA");
    const t = buildTrack(slsk()) as SoulseekTrack;
    expect(t.coverUrl()).toBe("data:image/jpg;base64,AAA");
    expect(reactiveMock).toHaveBeenCalledWith("alice", "music/cover.jpg");
  });

  it("null when no cover ref and no parent album", () => {
    const d = slsk();
    (d.sources[0] as { raw: { cover: null } }).raw = { cover: null };
    expect(buildTrack(d).coverUrl()).toBe(null);
  });

  it("falls back to parent album's cover when track has no own cover", () => {
    const d = slsk();
    d.albumId = "alb:1";
    (d.sources[0] as { raw: { cover: null } }).raw = { cover: null };
    getAlbumMock.mockReturnValueOnce({
      sources: [{ raw: { cover: { slsk_username: "bob", slsk_filepath: "album/cover.jpg", size: 50_000 } } }],
    });
    reactiveMock.mockReturnValueOnce("data:fromalbum");
    expect(buildTrack(d).coverUrl()).toBe("data:fromalbum");
    expect(reactiveMock).toHaveBeenCalledWith("bob", "album/cover.jpg");
  });

  it("startCoverFetch fires the cache on miss", () => {
    peekMock.mockReturnValueOnce(undefined);
    buildTrack(slsk()).startCoverFetch();
    expect(fetchMock).toHaveBeenCalledWith("alice", "music/cover.jpg", 120_000);
  });

  it("startCoverFetch skips on positive hit", () => {
    peekMock.mockReturnValueOnce("data:hit");
    buildTrack(slsk()).startCoverFetch();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("startCoverFetch skips on negative-TTL hit (null)", () => {
    peekMock.mockReturnValueOnce(null);
    buildTrack(slsk()).startCoverFetch();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("startCoverFetch guesses folder cover when track has no cover source", () => {
    const d = slsk();
    (d.sources[0] as { raw: { cover: null } }).raw = { cover: null };
    buildTrack(d).startCoverFetch();
    expect(fetchMock).toHaveBeenCalledWith("alice", "music/folder.jpg", 0);
  });
});

// ── navigationTarget ───────────────────────────────────────────────────────

describe("SoulseekTrack.navigationTarget", () => {
  it("builds payload with slsk refs", () => {
    const t = buildTrack(slsk());
    const target = t.navigationTarget();
    expect(target).toEqual({
      source: "soulseek",
      slskUsername: "alice",
      slskFilepath: "music/song.mp3",
    });
  });

  it("returns null when username missing", () => {
    const d = slsk();
    d.sources[0].refs = { slskUsername: "", slskFilepath: "p" };
    expect(buildTrack(d).navigationTarget()).toBe(null);
  });
});
