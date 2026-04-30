import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

const rtMocks = vi.hoisted(() => ({
  getRutrackerCoverDataUrlMock: vi.fn(() => Promise.resolve("data:rt")),
  peekRutrackerCoverMock: vi.fn(() => undefined),
  getCoverReactiveMock: vi.fn(() => null),
  // Component reads `.value` on this — a plain ref-shaped object is enough.
  rutrackerCoverFetchEpoch: { value: 0 },
}));
vi.mock("../../src/rutracker/search.js", () => ({
  getRutrackerCoverDataUrl: rtMocks.getRutrackerCoverDataUrlMock,
  peekRutrackerCover: rtMocks.peekRutrackerCoverMock,
  getCoverReactive: rtMocks.getCoverReactiveMock,
  rutrackerCoverFetchEpoch: rtMocks.rutrackerCoverFetchEpoch,
}));

const tiMocks = vi.hoisted(() => ({
  getTorrentImageDataUrlMock: vi.fn(() => Promise.resolve("data:tc")),
  peekTorrentImageMock: vi.fn(() => undefined),
}));
vi.mock("../../src/torrent/torrentImageCache.js", () => ({
  getTorrentImageDataUrl: tiMocks.getTorrentImageDataUrlMock,
  peekTorrentImage: tiMocks.peekTorrentImageMock,
}));

const apiMocks = vi.hoisted(() => ({
  torrentFileB64Mock: vi.fn(() => Promise.resolve("B64")),
}));
vi.mock("../../src/torrent/api.js", () => ({
  torrentFileB64ForTrack: apiMocks.torrentFileB64Mock,
}));

// Capture IO.
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

import CoverThumb from "../../src/components/shared/CoverThumb.vue";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default return values — earlier tests may have set persistent values.
  tiMocks.peekTorrentImageMock.mockReturnValue(undefined as unknown as string);
  tiMocks.getTorrentImageDataUrlMock.mockResolvedValue("data:tc");
  rtMocks.peekRutrackerCoverMock.mockReturnValue(undefined as unknown as string);
  rtMocks.getCoverReactiveMock.mockReturnValue(null);
  rtMocks.getRutrackerCoverDataUrlMock.mockResolvedValue("data:rt");
  apiMocks.torrentFileB64Mock.mockResolvedValue("B64");
  lastIO = null;
  (globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver })
    .IntersectionObserver = CaptureIO as unknown as typeof IntersectionObserver;
});

describe("CoverThumb — coverUrl reactive", () => {
  it("prefers overrideCoverUrl when set", () => {
    const w = mount(CoverThumb, {
      props: {
        overrideCoverUrl: "data:override",
        source: "rutracker", torrentId: "1",
      },
    });
    expect(w.html()).toContain("data:override");
  });

  it("reads from peekTorrentImage cache when magnet + coverFileIdx present", () => {
    tiMocks.peekTorrentImageMock.mockReturnValueOnce("data:torrent-hit");
    const w = mount(CoverThumb, {
      props: {
        magnet: "magnet:A",
        coverFileIdx: 2,
        source: "rutracker",
        torrentId: "1",
      },
    });
    expect(w.html()).toContain("data:torrent-hit");
  });

  it("falls back to rutracker getCoverReactive when no torrent image", () => {
    rtMocks.getCoverReactiveMock.mockReturnValueOnce("data:rt-rx");
    const w = mount(CoverThumb, {
      props: {
        source: "rutracker",
        torrentId: "42",
      },
    });
    expect(w.html()).toContain("data:rt-rx");
  });

  it("returns null for non-rutracker source without magnet/idx", () => {
    const w = mount(CoverThumb, {
      props: { source: "other", torrentId: "" },
    });
    // No img — fallback placeholder rendering.
    expect(w.html()).not.toContain("data:");
  });
});

describe("CoverThumb — IO-triggered fetches", () => {
  it("torrent fetch runs on IO intersect when cache miss", async () => {
    const w = mount(CoverThumb, {
      props: {
        magnet: "magnet:A",
        coverFileIdx: 3,
        source: "rutracker",
        torrentId: "42",
      },
    });
    await nextTick();
    expect(lastIO).not.toBe(null);
    lastIO!.cb([{ isIntersecting: true, target: document.body }]);
    await Promise.resolve(); await Promise.resolve();
    expect(apiMocks.torrentFileB64Mock).toHaveBeenCalledWith({ source: "rutracker", torrentId: "42" });
    expect(tiMocks.getTorrentImageDataUrlMock).toHaveBeenCalledWith("magnet:A", 3, "B64");
    w.unmount();
  });

  it("rutracker fetch runs on IO intersect when topic cover cache is missing", async () => {
    mount(CoverThumb, {
      props: {
        source: "rutracker",
        torrentId: "42",
      },
    });
    await nextTick();
    expect(lastIO).not.toBe(null);
    lastIO!.cb([{ isIntersecting: true, target: document.body }]);
    await Promise.resolve();
    expect(rtMocks.getRutrackerCoverDataUrlMock).toHaveBeenCalledWith("42");
  });

  it("no observer when override cover is supplied", async () => {
    mount(CoverThumb, {
      props: { overrideCoverUrl: "data:x", source: "rutracker", torrentId: "1" },
    });
    await nextTick();
    expect(lastIO).toBe(null);
  });

  it("no observer when rutracker cache already has a positive hit", async () => {
    rtMocks.peekRutrackerCoverMock.mockReturnValueOnce("data:hit");
    mount(CoverThumb, {
      props: { source: "rutracker", torrentId: "42" },
    });
    await nextTick();
    expect(lastIO).toBe(null);
  });

  it("no observer when torrent image cache already has a positive hit", async () => {
    // peekTorrentImage is called twice (coverUrl computed + setupCover) — need
    // a persistent hit, not a once-off.
    tiMocks.peekTorrentImageMock.mockReturnValue("data:hit");
    rtMocks.peekRutrackerCoverMock.mockReturnValue("data:rt-hit");
    mount(CoverThumb, {
      props: { magnet: "magnet:A", coverFileIdx: 2, source: "rutracker", torrentId: "1" },
    });
    await nextTick();
    expect(lastIO).toBe(null);
  });

  it("disconnects IO on unmount", async () => {
    const w = mount(CoverThumb, {
      props: { source: "rutracker", torrentId: "42" },
    });
    await nextTick();
    const captured = lastIO!;
    w.unmount();
    expect(captured.disconnect).toHaveBeenCalled();
  });

  it("swallows torrent fetch rejection", async () => {
    apiMocks.torrentFileB64Mock.mockRejectedValueOnce(new Error("no .torrent"));
    mount(CoverThumb, {
      props: { magnet: "magnet:A", coverFileIdx: 3, source: "rutracker", torrentId: "42" },
    });
    await nextTick();
    lastIO!.cb([{ isIntersecting: true, target: document.body }]);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    // No throw.
    expect(apiMocks.torrentFileB64Mock).toHaveBeenCalled();
  });

  it("re-arms observer on prop change (magnet changes)", async () => {
    const w = mount(CoverThumb, {
      props: { magnet: "magnet:A", coverFileIdx: 3, source: "rutracker", torrentId: "42" },
    });
    await nextTick();
    const first = lastIO;
    await w.setProps({ magnet: "magnet:B" });
    await nextTick();
    expect(lastIO).not.toBe(first);
    expect(first?.disconnect).toHaveBeenCalled();
  });
});
