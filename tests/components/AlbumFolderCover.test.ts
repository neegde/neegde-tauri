import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

const { peekTorrentImageMock, getTorrentImageDataUrlMock, torrentFileB64Mock } = vi.hoisted(() => ({
  peekTorrentImageMock: vi.fn(() => null),
  getTorrentImageDataUrlMock: vi.fn(() => Promise.resolve("data:img")),
  torrentFileB64Mock: vi.fn(() => Promise.resolve("B64")),
}));
vi.mock("../../src/torrent/torrentImageCache.js", () => ({
  peekTorrentImage: peekTorrentImageMock,
  getTorrentImageDataUrl: getTorrentImageDataUrlMock,
}));
vi.mock("../../src/torrent/api.js", () => ({
  torrentFileB64ForTrack: torrentFileB64Mock,
}));

// Capture IO for controlled intersection firing.
type IOCb = (entries: Array<{ isIntersecting: boolean; target: Element }>) => void;
let lastIO: { cb: IOCb; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } | null = null;
class CaptureIO {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => [] as IntersectionObserverEntry[]);
  root = null; rootMargin = ""; scrollMargin = ""; thresholds: number[] = [];
  constructor(cb: IOCb) {
    lastIO = { cb, observe: this.observe, disconnect: this.disconnect };
  }
}

import AlbumFolderCover from "../../src/components/torrent/AlbumFolderCover.vue";

beforeEach(() => {
  vi.clearAllMocks();
  lastIO = null;
  (globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver })
    .IntersectionObserver = CaptureIO as unknown as typeof IntersectionObserver;
});

describe("AlbumFolderCover", () => {
  it("renders initial letter when no cover / no image source", () => {
    const w = mount(AlbumFolderCover, { props: { label: "Alpha", coverFile: null } });
    expect(w.find(".album-folder-cover-letter").text()).toBe("A");
  });

  it("gradient hue + style apply deterministically from label", () => {
    const w = mount(AlbumFolderCover, { props: { label: "test" } });
    const ph = w.find(".album-folder-cover-placeholder").element as HTMLElement;
    expect(ph.style.background).toContain("linear-gradient");
  });

  it("initial picks first non-whitespace char from label; falls back to ? if nothing", () => {
    const w1 = mount(AlbumFolderCover, { props: { label: "  foo" } });
    expect(w1.find(".album-folder-cover-letter").text()).toBe("F");
    const w2 = mount(AlbumFolderCover, { props: { label: "" } });
    expect(w2.find(".album-folder-cover-letter").text()).toBe("?");
  });

  it("shows image when 'cover' prop is set and no torrent file is needed", async () => {
    const w = mount(AlbumFolderCover, {
      props: { cover: "data:image/jpg;base64,XYZ", label: "A" },
    });
    await nextTick();
    const img = w.find<HTMLImageElement>(".album-folder-cover-img");
    expect(img.exists()).toBe(true);
    expect(img.element.src).toContain("data:image");
  });

  it("schedules torrent fetch when coverFile + magnet present — fires on IO intersect", async () => {
    const w = mount(AlbumFolderCover, {
      props: {
        magnet: "magnet:?xt=urn:btih:A",
        coverFile: { path: "cover.jpg", size: 5000, origIdx: 3 },
        torrentId: "42",
        source: "rutracker",
      },
    });
    await nextTick(); await nextTick();
    expect(lastIO).not.toBeNull();
    // Fire intersection.
    lastIO!.cb([{ isIntersecting: true, target: document.body }]);
    await Promise.resolve(); await Promise.resolve();
    expect(torrentFileB64Mock).toHaveBeenCalledWith({ source: "rutracker", torrentId: "42" });
    expect(getTorrentImageDataUrlMock).toHaveBeenCalledWith("magnet:?xt=urn:btih:A", 3, "B64");
  });

  it("does not fire fetch when entry not intersecting", async () => {
    const w = mount(AlbumFolderCover, {
      props: {
        magnet: "magnet:?xt=urn:btih:A",
        coverFile: { path: "cover.jpg", size: 5000, origIdx: 3 },
      },
    });
    await nextTick(); await nextTick();
    lastIO?.cb([{ isIntersecting: false, target: document.body }]);
    expect(torrentFileB64Mock).not.toHaveBeenCalled();
  });

  it("no IO when coverFile is too large (exceeds MAX_TORRENT_COVER_BYTES)", async () => {
    const big = { path: "cover.jpg", size: 10 * 1024 * 1024, origIdx: 0 };
    mount(AlbumFolderCover, {
      props: { magnet: "magnet:A", coverFile: big },
    });
    await nextTick(); await nextTick();
    expect(lastIO).toBe(null);
  });

  it("no IO when coverFile is not an image", async () => {
    mount(AlbumFolderCover, {
      props: { magnet: "magnet:A", coverFile: { path: "notes.txt", size: 100, origIdx: 0 } },
    });
    await nextTick(); await nextTick();
    expect(lastIO).toBe(null);
  });

  it("cached torrent cover is read from peekTorrentImage via displaySrc", async () => {
    peekTorrentImageMock.mockReturnValueOnce("data:cached");
    const w = mount(AlbumFolderCover, {
      props: {
        magnet: "magnet:A",
        coverFile: { path: "cover.jpg", size: 2000, origIdx: 1 },
      },
    });
    await nextTick();
    const img = w.find<HTMLImageElement>(".album-folder-cover-img");
    expect(img.exists()).toBe(true);
    expect(img.element.src).toContain("data:cached");
  });

  it("canEnlarge → clicking root opens the lightbox", async () => {
    const w = mount(AlbumFolderCover, {
      props: { cover: "data:x", label: "A" },
      attachTo: document.body,
    });
    await nextTick();
    // Simulate img load so showImg → visible.
    const img = w.find<HTMLImageElement>(".album-folder-cover-img");
    await img.trigger("load");
    await w.find(".album-folder-cover-root").trigger("click");
    // Lightbox open state — teleported to body; overlay appears after update:open toggles.
    await nextTick();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("disconnects observer on unmount", async () => {
    const w = mount(AlbumFolderCover, {
      props: {
        magnet: "magnet:A",
        coverFile: { path: "cover.jpg", size: 2000, origIdx: 1 },
      },
    });
    await nextTick(); await nextTick();
    const captured = lastIO!;
    w.unmount();
    expect(captured.disconnect).toHaveBeenCalled();
  });

  it("failed image load surfaces the placeholder letter again", async () => {
    const w = mount(AlbumFolderCover, {
      props: { cover: "data:bad", label: "X" },
    });
    await nextTick();
    await w.find(".album-folder-cover-img").trigger("error");
    await nextTick();
    expect(w.find(".album-folder-cover-letter").exists()).toBe(true);
  });

  it("loadCover swallows torrentFileB64 rejections", async () => {
    torrentFileB64Mock.mockRejectedValueOnce(new Error("no torrent"));
    mount(AlbumFolderCover, {
      props: {
        magnet: "magnet:A",
        coverFile: { path: "cover.jpg", size: 2000, origIdx: 1 },
      },
    });
    await nextTick(); await nextTick();
    lastIO!.cb([{ isIntersecting: true, target: document.body }]);
    // Wait through rejection chain; no throw.
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(torrentFileB64Mock).toHaveBeenCalled();
  });
});
