import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";

vi.mock("../../src/rutracker/coverCache.js", () => ({
  getCoverReactive: vi.fn(() => null),
  peekRutrackerCover: vi.fn(() => undefined),
  getRutrackerCoverDataUrl: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../../src/soulseek/coverCache.js", () => ({
  getSlskCoverReactive: vi.fn(() => null),
  peekSlskCover: vi.fn(() => undefined),
  getSlskCoverDataUrl: vi.fn(() => Promise.resolve(null)),
}));

import {
  getCoverReactive,
  peekRutrackerCover,
  getRutrackerCoverDataUrl,
} from "../../src/rutracker/coverCache.js";
import {
  getSlskCoverReactive,
  peekSlskCover,
  getSlskCoverDataUrl,
} from "../../src/soulseek/coverCache.js";
import { buildAlbum, ensureAlbum } from "../../src/album/factory.js";
import { RutrackerAlbum } from "../../src/album/RutrackerAlbum.js";
import { SoulseekAlbum } from "../../src/album/SoulseekAlbum.js";
import type { AlbumData } from "../../src/album/types.js";

const rtCoverReactiveMock = getCoverReactive as unknown as ReturnType<typeof vi.fn>;
const rtPeekMock = peekRutrackerCover as unknown as ReturnType<typeof vi.fn>;
const rtFetchMock = getRutrackerCoverDataUrl as unknown as ReturnType<typeof vi.fn>;
const slskReactiveMock = getSlskCoverReactive as unknown as ReturnType<typeof vi.fn>;
const slskPeekMock = peekSlskCover as unknown as ReturnType<typeof vi.fn>;
const slskFetchMock = getSlskCoverDataUrl as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

function rtData(overrides: Partial<AlbumData> = {}): AlbumData {
  return {
    type: "album", id: "rt:1", title: "RT Album", artist: "A",
    trackIds: ["t1"],
    sources: [{ kind: "rutracker", refs: { topicId: "42" } }],
    ...overrides,
  };
}

function slskData(overrides: Partial<AlbumData> = {}): AlbumData {
  return {
    type: "album", id: "slsk:1", title: "SLSK Album", artist: null,
    trackIds: ["t2"],
    sources: [{
      kind: "soulseek",
      refs: { slskUsername: "u", slskFolder: "Folder" },
      raw: { cover: { slsk_username: "u", slsk_filepath: "Folder/cover.jpg", size: 2048 } },
    }],
    ...overrides,
  };
}

describe("buildAlbum factory", () => {
  it("returns RutrackerAlbum for rutracker source", () => {
    expect(buildAlbum(rtData())).toBeInstanceOf(RutrackerAlbum);
  });

  it("returns SoulseekAlbum for soulseek source", () => {
    expect(buildAlbum(slskData())).toBeInstanceOf(SoulseekAlbum);
  });

  it("throws on unknown source kind", () => {
    const bad = {
      type: "album", id: "x", title: "x", artist: null, trackIds: [],
      sources: [{ kind: "youtube", refs: {} }],
    } as unknown as AlbumData;
    expect(() => buildAlbum(bad)).toThrow(/unsupported source kind/);
  });
});

describe("ensureAlbum", () => {
  it("passes an existing Album instance through", () => {
    const a = buildAlbum(rtData());
    expect(ensureAlbum(a)).toBe(a);
  });

  it("wraps raw AlbumData into an Album instance", () => {
    const a = ensureAlbum(rtData());
    expect(a).toBeInstanceOf(RutrackerAlbum);
  });
});

describe("Album — identity getters", () => {
  it("RutrackerAlbum exposes id/title/artist/trackIds/kind", () => {
    const a = buildAlbum(rtData({ seeders: 10, leechers: 1, size: 1000, year: 1991 }));
    expect(a.id).toBe("rt:1");
    expect(a.title).toBe("RT Album");
    expect(a.artist).toBe("A");
    expect(a.trackIds).toEqual(["t1"]);
    expect(a.kind).toBe("rutracker");
    expect(a.seeders).toBe(10);
    expect(a.leechers).toBe(1);
    expect(a.size).toBe(1000);
    expect(a.year).toBe(1991);
  });

  it("SoulseekAlbum peers / sources accessors", () => {
    const a = buildAlbum(slskData({ peers: 5 }));
    expect(a.kind).toBe("soulseek");
    expect(a.peers).toBe(5);
    expect(a.sources.length).toBe(1);
  });

  it("type is always 'album'", () => {
    expect(buildAlbum(rtData()).type).toBe("album");
    expect(buildAlbum(slskData()).type).toBe("album");
  });

  it("toJSON returns the underlying data", () => {
    const data = rtData();
    expect(buildAlbum(data).toJSON()).toBe(data);
  });
});

describe("RutrackerAlbum.coverUrl + startCoverFetch", () => {
  it("prefers statically-stamped coverUrl over topic cache", () => {
    const a = buildAlbum(rtData({ coverUrl: "data:stamped" }));
    expect(a.coverUrl()).toBe("data:stamped");
    expect(rtCoverReactiveMock).not.toHaveBeenCalled();
  });

  it("reads reactive cache when no static cover", () => {
    rtCoverReactiveMock.mockReturnValueOnce("data:reactive");
    const a = buildAlbum(rtData());
    expect(a.coverUrl()).toBe("data:reactive");
    expect(rtCoverReactiveMock).toHaveBeenCalledWith("42");
  });

  it("returns null without topicId", () => {
    const a = buildAlbum(rtData({
      sources: [{ kind: "rutracker", refs: { topicId: "" } }],
    }));
    expect(a.coverUrl()).toBe(null);
  });

  it("startCoverFetch fires the fetch on cache miss", () => {
    rtPeekMock.mockReturnValueOnce(undefined);
    buildAlbum(rtData()).startCoverFetch();
    expect(rtFetchMock).toHaveBeenCalledWith("42");
  });

  it("startCoverFetch skips when static coverUrl is set", () => {
    buildAlbum(rtData({ coverUrl: "data:stamped" })).startCoverFetch();
    expect(rtFetchMock).not.toHaveBeenCalled();
  });

  it("startCoverFetch skips on cache hit", () => {
    rtPeekMock.mockReturnValueOnce("data:hit");
    buildAlbum(rtData()).startCoverFetch();
    expect(rtFetchMock).not.toHaveBeenCalled();
  });

  it("startCoverFetch noops without topicId", () => {
    buildAlbum(rtData({
      sources: [{ kind: "rutracker", refs: { topicId: "" } }],
    })).startCoverFetch();
    expect(rtFetchMock).not.toHaveBeenCalled();
  });
});

describe("SoulseekAlbum.coverUrl + startCoverFetch", () => {
  it("prefers statically-stamped coverUrl over the peer cache", () => {
    const a = buildAlbum(slskData({ coverUrl: "data:stamped" }));
    expect(a.coverUrl()).toBe("data:stamped");
    expect(slskReactiveMock).not.toHaveBeenCalled();
  });

  it("reads reactive cache by user+filepath", () => {
    slskReactiveMock.mockReturnValueOnce("data:slsk");
    const a = buildAlbum(slskData());
    expect(a.coverUrl()).toBe("data:slsk");
    expect(slskReactiveMock).toHaveBeenCalledWith("u", "Folder/cover.jpg");
  });

  it("returns null without slsk refs in raw.cover", () => {
    const a = buildAlbum(slskData({
      sources: [{
        kind: "soulseek",
        refs: { slskUsername: "u", slskFolder: "F" },
        raw: { cover: null },
      }],
    }));
    expect(a.coverUrl()).toBe(null);
  });

  it("startCoverFetch fires on cache miss with size", () => {
    slskPeekMock.mockReturnValueOnce(undefined);
    buildAlbum(slskData()).startCoverFetch();
    expect(slskFetchMock).toHaveBeenCalledWith("u", "Folder/cover.jpg", 2048);
  });

  it("startCoverFetch uses 0 size when not provided", () => {
    slskPeekMock.mockReturnValueOnce(undefined);
    buildAlbum(slskData({
      sources: [{
        kind: "soulseek",
        refs: { slskUsername: "u", slskFolder: "F" },
        raw: { cover: { slsk_username: "x", slsk_filepath: "F/cover.jpg" } },
      }],
    })).startCoverFetch();
    expect(slskFetchMock).toHaveBeenCalledWith("x", "F/cover.jpg", 0);
  });

  it("startCoverFetch skips when static coverUrl is set", () => {
    buildAlbum(slskData({ coverUrl: "data:stamped" })).startCoverFetch();
    expect(slskFetchMock).not.toHaveBeenCalled();
  });

  it("startCoverFetch skips on cache hit", () => {
    slskPeekMock.mockReturnValueOnce("data:hit");
    buildAlbum(slskData()).startCoverFetch();
    expect(slskFetchMock).not.toHaveBeenCalled();
  });

  it("startCoverFetch noops without cover ref", () => {
    buildAlbum(slskData({
      sources: [{
        kind: "soulseek",
        refs: { slskUsername: "u", slskFolder: "F" },
        raw: { cover: null },
      }],
    })).startCoverFetch();
    expect(slskFetchMock).not.toHaveBeenCalled();
  });
});
