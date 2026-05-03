import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

const { getSlskCoverDataUrlMock, peekSlskCoverMock } = vi.hoisted(() => ({
  getSlskCoverDataUrlMock: vi.fn(() => Promise.resolve("data:ok")),
  peekSlskCoverMock: vi.fn(() => undefined),
}));
vi.mock("../../src/soulseek/coverCache.js", () => ({
  getSlskCoverDataUrl: getSlskCoverDataUrlMock,
  peekSlskCover: peekSlskCoverMock,
  getSlskCoverReactive: vi.fn(() => null),
}));

const { prefetchTorrentDetailsMock } = vi.hoisted(() => ({
  prefetchTorrentDetailsMock: vi.fn(),
}));
vi.mock("../../src/rutracker/search.js", () => ({
  prefetchTorrentDetails: prefetchTorrentDetailsMock,
  getRutrackerCoverDataUrl: vi.fn(() => Promise.resolve(null)),
  peekRutrackerCover: vi.fn(() => undefined),
  getCoverReactive: vi.fn(() => null),
}));

import AlbumCard from "../../src/components/search/AlbumCard.vue";

function rutrackerAlbum(overrides: Record<string, unknown> = {}) {
  return {
    type: "album", id: "alb-rt", title: "Album", artist: "Artist",
    seeders: 10, trackIds: ["t1", "t2"], format: "FLAC", bitrate: 1000,
    sources: [{ kind: "rutracker", refs: { topicId: "100" } }],
    ...overrides,
  };
}

function soulseekAlbum(overrides: Record<string, unknown> = {}) {
  return {
    type: "album", id: "alb-sl", title: "Album", artist: null,
    peers: 3, trackIds: ["t1", "t2", "t3"],
    sources: [{
      kind: "soulseek",
      raw: { cover: { slsk_username: "u", slsk_filepath: "cover.jpg", size: 200 } },
    }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AlbumCard — label + meta branches", () => {
  it("format label shows just fmt when no bitrate", () => {
    const w = mount(AlbumCard, { props: { album: rutrackerAlbum({ bitrate: null }) } });
    expect(w.find(".album-format-badge").text()).toBe("FLAC");
  });

  it("no format badge when both fmt and bitrate missing", () => {
    const w = mount(AlbumCard, { props: { album: rutrackerAlbum({ format: null, bitrate: null }) } });
    expect(w.find(".album-format-badge").exists()).toBe(false);
  });

  it.each([
    [1, "1 сид"],
    [2, "2 сида"],
    [4, "4 сида"],
    [5, "5 сидов"],
    [0, "0 сида"],
  ])("RT seeders %i → %s", (n, expected) => {
    const w = mount(AlbumCard, { props: { album: rutrackerAlbum({ seeders: n }) } });
    expect(w.find(".album-seeds").text()).toBe(expected);
  });

  it("RT 0 seeders gets seeds-dead; >0 seeds-ok", () => {
    const dead = mount(AlbumCard, { props: { album: rutrackerAlbum({ seeders: 0 }) } });
    expect(dead.find(".album-seeds").classes()).toContain("seeds-dead");
    const ok = mount(AlbumCard, { props: { album: rutrackerAlbum({ seeders: 5 }) } });
    expect(ok.find(".album-seeds").classes()).toContain("seeds-ok");
  });

  it.each([
    [2, "2 трека"],
    [4, "4 трека"],
    [5, "5 треков"],
  ])("SLSK trackCount %i → %s", (n, expected) => {
    const w = mount(AlbumCard, {
      props: { album: soulseekAlbum({ trackIds: Array.from({ length: n }, (_, i) => `t${i}`) }) },
    });
    expect(w.find(".slsk-track-count").text()).toBe(expected);
  });

  it("SLSK with 1 track + peers>1 shows 'Nx'", () => {
    const w = mount(AlbumCard, {
      props: { album: soulseekAlbum({ trackIds: ["t1"], peers: 4 }) },
    });
    expect(w.find(".slsk-track-count").text()).toBe("4×");
  });

  it("SLSK with 1 track + 1 peer shows 'SoulSeek'", () => {
    const w = mount(AlbumCard, {
      props: { album: soulseekAlbum({ trackIds: ["t1"], peers: 1 }) },
    });
    expect(w.find(".slsk-track-count").text()).toBe("SoulSeek");
  });
});

describe("AlbumCard — hover prefetch", () => {
  it("mouseleave before 300ms cancels RT prefetch", async () => {
    const w = mount(AlbumCard, { props: { album: rutrackerAlbum() } });
    await w.find(".album-card").trigger("mouseenter");
    await w.find(".album-card").trigger("mouseleave");
    vi.advanceTimersByTime(500);
    expect(prefetchTorrentDetailsMock).not.toHaveBeenCalled();
  });

  it("SLSK hover eagerly fetches the cover on cache miss", async () => {
    const w = mount(AlbumCard, { props: { album: soulseekAlbum() } });
    await w.find(".album-card").trigger("mouseenter");
    expect(peekSlskCoverMock).toHaveBeenCalledWith("u", "cover.jpg");
    expect(getSlskCoverDataUrlMock).toHaveBeenCalledWith("u", "cover.jpg", 200);
  });

  it("SLSK hover skips fetch when cache has a hit", async () => {
    peekSlskCoverMock.mockReturnValueOnce("data:cached");
    const w = mount(AlbumCard, { props: { album: soulseekAlbum() } });
    await w.find(".album-card").trigger("mouseenter");
    expect(getSlskCoverDataUrlMock).not.toHaveBeenCalled();
  });

  it("SLSK hover skips fetch when cover ref missing", async () => {
    const album = soulseekAlbum({
      sources: [{ kind: "soulseek", raw: { cover: null } }],
    });
    const w = mount(AlbumCard, { props: { album } });
    await w.find(".album-card").trigger("mouseenter");
    expect(getSlskCoverDataUrlMock).not.toHaveBeenCalled();
  });

  it("unmount cancels pending RT hover timer", async () => {
    const w = mount(AlbumCard, { props: { album: rutrackerAlbum() } });
    await w.find(".album-card").trigger("mouseenter");
    w.unmount();
    vi.advanceTimersByTime(500);
    expect(prefetchTorrentDetailsMock).not.toHaveBeenCalled();
  });

  it("RT hover without topicId does not schedule a timer", async () => {
    const album = rutrackerAlbum({
      sources: [{ kind: "rutracker", refs: {} }],
    });
    const w = mount(AlbumCard, { props: { album } });
    await w.find(".album-card").trigger("mouseenter");
    vi.advanceTimersByTime(500);
    expect(prefetchTorrentDetailsMock).not.toHaveBeenCalled();
  });
});

describe("AlbumCard — click plumbing", () => {
  it("play button click emits select without double-firing", async () => {
    const w = mount(AlbumCard, { props: { album: rutrackerAlbum() } });
    await w.find(".album-art-play").trigger("click");
    // .stop on the play button prevents bubbling → exactly one select emission.
    expect(w.emitted("select")?.length).toBe(1);
  });
});
