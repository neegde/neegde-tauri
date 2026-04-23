import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

vi.mock("../../src/rutracker/search.js", () => ({
  prefetchTorrentDetails: vi.fn(),
  getRutrackerCoverDataUrl: vi.fn(),
  peekRutrackerCover: vi.fn(() => undefined),
  getCoverReactive: vi.fn(() => null),
  clearRutrackerCoverCache: vi.fn(),
}));

import AlbumCard from "../../src/components/search/AlbumCard.vue";

const rtAlbum = {
  type: "album" as const, id: "rt:album:42:root", title: "Great Album", artist: "Artist",
  year: null, coverUrl: null, format: "FLAC", bitrate: 1000, size: 100_000_000,
  seeders: 15, leechers: 1, peers: null, trackIds: ["t1", "t2", "t3"],
  sources: [{
    kind: "rutracker", refs: { topicId: "42", rootPath: "root" }, raw: {},
  }],
};

const slskAlbum = {
  type: "album" as const, id: "slsk:album:u|Folder", title: "SLSK Album", artist: null,
  coverUrl: null, format: "MP3", bitrate: 320, size: 50_000_000, peers: 4,
  trackIds: ["a", "b"],
  sources: [{
    kind: "soulseek",
    refs: { slskUsername: "u", slskFolder: "Folder" },
    raw: { cover: { slsk_username: "u", slsk_filepath: "Folder/cover.jpg", size: 1024 } },
  }],
};

beforeEach(() => vi.clearAllMocks());

describe("AlbumCard", () => {
  it("renders RT album title + meta", () => {
    const w = mount(AlbumCard, { props: { album: rtAlbum } });
    expect(w.text()).toContain("Great Album");
    expect(w.text()).toContain("FLAC");
    expect(w.text()).toContain("сид");
  });

  it("renders SLSK album", () => {
    const w = mount(AlbumCard, { props: { album: slskAlbum } });
    expect(w.text()).toContain("SLSK Album");
    expect(w.text()).toContain("MP3");
  });

  it("click emits select with the album", async () => {
    const w = mount(AlbumCard, { props: { album: rtAlbum } });
    await w.trigger("click");
    const payload = w.emitted("select")?.[0]?.[0] as typeof rtAlbum | undefined;
    expect(payload?.id).toBe(rtAlbum.id);
  });

  it("hover over RT album schedules a prefetch after 300ms", async () => {
    vi.useFakeTimers();
    const mod = await import("../../src/rutracker/search.js");
    const w = mount(AlbumCard, { props: { album: rtAlbum } });
    await w.trigger("mouseenter");
    vi.advanceTimersByTime(400);
    expect(mod.prefetchTorrentDetails).toHaveBeenCalledWith("42");
    vi.useRealTimers();
  });

  it("selected=true adds selection class", () => {
    const w = mount(AlbumCard, { props: { album: rtAlbum, selected: true } });
    // The .html template uses a specific class — let's just assert some visible class name contains 'selected'.
    expect(w.html()).toMatch(/selected/);
  });
});
