import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import "../_setup.js";
import { defineComponent, h, ref, nextTick } from "vue";
import { mount } from "@vue/test-utils";

const { getCoverReactiveMock, peekRutrackerMock, getRutrackerDataUrlMock } = vi.hoisted(() => ({
  getCoverReactiveMock: vi.fn(() => null),
  peekRutrackerMock: vi.fn(() => undefined),
  getRutrackerDataUrlMock: vi.fn(() => Promise.resolve(null)),
}));
const { getSlskCoverReactiveMock, peekSlskMock, getSlskDataUrlMock } = vi.hoisted(() => ({
  getSlskCoverReactiveMock: vi.fn(() => null),
  peekSlskMock: vi.fn(() => undefined),
  getSlskDataUrlMock: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../src/rutracker/coverCache.js", () => ({
  getCoverReactive: getCoverReactiveMock,
  peekRutrackerCover: peekRutrackerMock,
  getRutrackerCoverDataUrl: getRutrackerDataUrlMock,
}));
vi.mock("../../src/soulseek/coverCache.js", () => ({
  getSlskCoverReactive: getSlskCoverReactiveMock,
  peekSlskCover: peekSlskMock,
  getSlskCoverDataUrl: getSlskDataUrlMock,
}));

// Capture-capable IO mock so we can fire intersection events from tests.
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

import { useEntityCover } from "../../src/composables/useEntityCover.js";
import { clearEntities, type AlbumData } from "../../src/stores/entities.js";

function mountWith(entityRef: ReturnType<typeof ref>) {
  let api!: ReturnType<typeof useEntityCover>;
  const rootRef = ref<HTMLElement | null>(document.createElement("div"));
  const Wrapper = defineComponent({
    setup() {
      api = useEntityCover(entityRef as never, rootRef);
      return () => h("div", { ref: rootRef });
    },
  });
  const wrapper = mount(Wrapper, { attachTo: document.body });
  return { api, wrapper, rootRef };
}

beforeEach(() => {
  clearEntities();
  vi.clearAllMocks();
  lastIO = null;
  (globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver })
    .IntersectionObserver = CaptureIO as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  // Restore nothing — _setup.ts's default FakeIntersectionObserver is what
  // other tests already expect; next test's beforeEach will reassign.
});

describe("useEntityCover — coverage gaps", () => {
  it("returns null for an album source with unknown kind", () => {
    const album: AlbumData = {
      type: "album", id: "a", title: "A", artist: null, trackIds: [],
      sources: [{ kind: "magnet", refs: {} }],
    };
    const { api } = mountWith(ref(album));
    expect(api.coverUrl.value).toBe(null);
  });

  it("null for soulseek album when raw.cover is missing", () => {
    const album: AlbumData = {
      type: "album", id: "a", title: "A", artist: null, trackIds: [],
      sources: [{ kind: "soulseek", raw: {} }],
    };
    const { api } = mountWith(ref(album));
    expect(api.coverUrl.value).toBe(null);
  });

  it("null for rutracker album without a topicId", () => {
    const album: AlbumData = {
      type: "album", id: "a", title: "A", artist: null, trackIds: [],
      sources: [{ kind: "rutracker", refs: {} }],
    };
    const { api } = mountWith(ref(album));
    expect(api.coverUrl.value).toBe(null);
  });

  it("IntersectionObserver callback triggers startAlbumFetch (soulseek path)", async () => {
    const album: AlbumData = {
      type: "album", id: "a", title: "A", artist: null, trackIds: [],
      sources: [{
        kind: "soulseek",
        raw: { cover: { slsk_username: "u", slsk_filepath: "cover.jpg", size: 500 } },
      }],
    };
    // No cached cover: coverOfEntity returns null (getSlskCoverReactive mocked
    // to return null by default) so the observer gets wired up.
    const { api } = mountWith(ref(album));
    await nextTick();
    expect(lastIO?.observe).toHaveBeenCalled();
    lastIO?.cb([{ isIntersecting: true, target: document.body }]);
    expect(peekSlskMock).toHaveBeenCalledWith("u", "cover.jpg");
    expect(getSlskDataUrlMock).toHaveBeenCalledWith("u", "cover.jpg", 500);
    expect(api.coverErr.value).toBe(false);
  });

  it("skips IO fetch when peekSlskCover already has a hit", async () => {
    peekSlskMock.mockReturnValueOnce("cached");
    const album: AlbumData = {
      type: "album", id: "a", title: "A", artist: null, trackIds: [],
      sources: [{
        kind: "soulseek",
        raw: { cover: { slsk_username: "u", slsk_filepath: "cover.jpg" } },
      }],
    };
    mountWith(ref(album));
    await nextTick();
    lastIO?.cb([{ isIntersecting: true, target: document.body }]);
    expect(getSlskDataUrlMock).not.toHaveBeenCalled();
  });

  it("IntersectionObserver callback triggers startAlbumFetch (rutracker path)", async () => {
    const album: AlbumData = {
      type: "album", id: "a", title: "A", artist: null, trackIds: [],
      sources: [{ kind: "rutracker", refs: { topicId: "100" } }],
    };
    mountWith(ref(album));
    await nextTick();
    lastIO?.cb([{ isIntersecting: true, target: document.body }]);
    expect(peekRutrackerMock).toHaveBeenCalledWith("100");
    expect(getRutrackerDataUrlMock).toHaveBeenCalledWith("100");
  });

  it("IntersectionObserver fires noop when entry is not intersecting", async () => {
    const album: AlbumData = {
      type: "album", id: "a", title: "A", artist: null, trackIds: [],
      sources: [{ kind: "rutracker", refs: { topicId: "100" } }],
    };
    mountWith(ref(album));
    await nextTick();
    lastIO?.cb([{ isIntersecting: false, target: document.body }]);
    expect(getRutrackerDataUrlMock).not.toHaveBeenCalled();
  });

  it("observer is disconnected on unmount", async () => {
    const album: AlbumData = {
      type: "album", id: "a", title: "A", artist: null, trackIds: [],
      sources: [{ kind: "rutracker", refs: { topicId: "100" } }],
    };
    const { wrapper } = mountWith(ref(album));
    await nextTick();
    wrapper.unmount();
    expect(lastIO?.disconnect).toHaveBeenCalled();
  });

  it("startAlbumFetch noops when raw.cover has no filepath", async () => {
    const album: AlbumData = {
      type: "album", id: "a", title: "A", artist: null, trackIds: [],
      sources: [{ kind: "soulseek", raw: { cover: { slsk_username: "u" } } }],
    };
    mountWith(ref(album));
    await nextTick();
    lastIO?.cb([{ isIntersecting: true, target: document.body }]);
    expect(getSlskDataUrlMock).not.toHaveBeenCalled();
  });

  it("startAlbumFetch noops for unknown source kind", async () => {
    const album: AlbumData = {
      type: "album", id: "a", title: "A", artist: null, trackIds: [],
      sources: [{ kind: "magnet", refs: {} }],
    };
    mountWith(ref(album));
    await nextTick();
    lastIO?.cb([{ isIntersecting: true, target: document.body }]);
    expect(getRutrackerDataUrlMock).not.toHaveBeenCalled();
    expect(getSlskDataUrlMock).not.toHaveBeenCalled();
  });

  it("arm returns early when entity already has a cached cover URL", () => {
    const album: AlbumData = {
      type: "album", id: "a", title: "A", artist: null, trackIds: [],
      coverUrl: "data:cached",
    };
    mountWith(ref(album));
    // arm sees coverOfEntity returns truthy, so it never creates an observer.
    expect(lastIO).toBe(null);
  });

  it("re-arms when the entity id changes", async () => {
    const entityRef = ref<AlbumData | null>({
      type: "album", id: "a1", title: "A", artist: null, trackIds: [],
      sources: [{ kind: "rutracker", refs: { topicId: "1" } }],
    });
    mountWith(entityRef);
    await nextTick();
    const firstIO = lastIO;
    entityRef.value = {
      type: "album", id: "a2", title: "B", artist: null, trackIds: [],
      sources: [{ kind: "rutracker", refs: { topicId: "2" } }],
    };
    await nextTick();
    expect(firstIO?.disconnect).toHaveBeenCalled();
    // A fresh observer is constructed for the new entity.
    expect(lastIO).not.toBe(firstIO);
  });
});
