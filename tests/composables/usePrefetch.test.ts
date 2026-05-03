import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { ref, computed } from "vue";

const { prefetchNextInQueueMock, releaseTorrentStreamUrlMock } = vi.hoisted(() => ({
  prefetchNextInQueueMock: vi.fn(),
  releaseTorrentStreamUrlMock: vi.fn(),
}));
vi.mock("../../src/torrent/api.js", async (orig) => {
  const actual = await orig<typeof import("../../src/torrent/api.js")>();
  return { ...actual, prefetchNextInQueue: prefetchNextInQueueMock };
});
vi.mock("../../src/torrent/torrentSession.js", () => ({
  releaseTorrentStreamUrl: releaseTorrentStreamUrlMock,
}));

import { usePrefetch } from "../../src/composables/usePrefetch.js";

function setup() {
  const track = ref<Record<string, unknown> | null>(null);
  const nextTrack = ref<Record<string, unknown> | null>(null);
  const secondNextTrack = ref<Record<string, unknown> | null>(null);
  const playing = ref(false);
  const streamPhase = ref("idle");
  const isLoading = computed(() => false);
  const duration = ref(0);
  const current = ref(0);
  const api = usePrefetch({
    track: computed(() => track.value),
    nextTrack: computed(() => nextTrack.value),
    secondNextTrack: computed(() => secondNextTrack.value),
    playing, streamPhase, isLoading, duration, current,
  });
  return { api, track, nextTrack, secondNextTrack, playing, streamPhase, duration, current };
}

beforeEach(() => {
  prefetchNextInQueueMock.mockReset();
  releaseTorrentStreamUrlMock.mockReset();
});

describe("usePrefetch — guards", () => {
  it("does not prefetch when there's no current track", async () => {
    const { nextTrack } = setup();
    nextTrack.value = { id: "n1", magnet: "m", fileIdx: 1 };
    await Promise.resolve(); await Promise.resolve();
    expect(prefetchNextInQueueMock).not.toHaveBeenCalled();
  });

  it("does not prefetch when soulseek", async () => {
    const { track, nextTrack, playing, streamPhase, duration, current } = setup();
    track.value = { id: "t", source: "soulseek", magnet: "" };
    nextTrack.value = { id: "n", source: "soulseek", magnet: "" };
    playing.value = true;
    streamPhase.value = "ready";
    duration.value = 300;
    current.value = 60;
    await Promise.resolve(); await Promise.resolve();
    expect(prefetchNextInQueueMock).not.toHaveBeenCalled();
  });

  it("does not prefetch before enough playback elapsed", async () => {
    const { track, nextTrack, playing, streamPhase, duration, current } = setup();
    track.value = { id: "t", magnet: "A", fileIdx: 0, fileName: "t.mp3", torrentId: "1" };
    nextTrack.value = { id: "n", magnet: "B", fileIdx: 1, fileName: "n.mp3", torrentId: "2" };
    playing.value = true;
    streamPhase.value = "ready";
    duration.value = 300;
    current.value = 1; // below both thresholds
    await Promise.resolve();
    expect(prefetchNextInQueueMock).not.toHaveBeenCalled();
  });
});

describe("usePrefetch — happy path", () => {
  it("kicks prefetch once playback elapsed past threshold (cross-torrent)", async () => {
    prefetchNextInQueueMock.mockResolvedValue({ kind: "streamReady", url: "http://pref" });
    const { track, nextTrack, playing, streamPhase, duration, current, api } = setup();
    track.value = { id: "t", magnet: "A", fileIdx: 0, fileName: "t.mp3", torrentId: "1" };
    nextTrack.value = { id: "n", magnet: "B", fileIdx: 1, fileName: "n.mp3", torrentId: "2" };
    playing.value = true;
    streamPhase.value = "ready";
    duration.value = 300;
    current.value = 30; // well past MIN_SEC=4
    await Promise.resolve(); await Promise.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(prefetchNextInQueueMock).toHaveBeenCalled();
    // Let the promise resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(api.prefetchedStream.value.url).toBe("http://pref");
  });

  it("same fingerprint won't re-prefetch", async () => {
    prefetchNextInQueueMock.mockResolvedValue({ kind: "streamReady", url: "http://a" });
    const s = setup();
    s.track.value = { id: "t", magnet: "A", fileIdx: 0, fileName: "t.mp3" };
    s.nextTrack.value = { id: "n", magnet: "B", fileIdx: 1, fileName: "n.mp3" };
    s.playing.value = true; s.streamPhase.value = "ready";
    s.duration.value = 300; s.current.value = 30;
    await Promise.resolve(); await Promise.resolve();
    await Promise.resolve(); await Promise.resolve();
    await Promise.resolve(); await Promise.resolve();
    const firstCalls = prefetchNextInQueueMock.mock.calls.length;
    s.current.value = 40;
    await Promise.resolve(); await Promise.resolve();
    expect(prefetchNextInQueueMock.mock.calls.length).toBe(firstCalls);
  });
});

describe("usePrefetch — reset + release", () => {
  it("resetOnTrackChange clears fingerprints and releases stale URL", () => {
    const { api } = setup();
    api.prefetchedStream.value = { url: "http://old", forKey: "oldKey" };
    api.resetOnTrackChange();
    expect(releaseTorrentStreamUrlMock).toHaveBeenCalledWith("http://old");
    expect(api.prefetchedStream.value.url).toBe("");
  });
  it("releasePrefetchedStream unconditionally clears", () => {
    const { api } = setup();
    api.prefetchedStream.value = { url: "http://x", forKey: "k" };
    api.releasePrefetchedStream();
    expect(releaseTorrentStreamUrlMock).toHaveBeenCalledWith("http://x");
    expect(api.prefetchedStream.value).toEqual({ url: "", forKey: "" });
  });
});
