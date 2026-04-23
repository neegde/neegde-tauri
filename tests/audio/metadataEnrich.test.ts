import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../_setup.js";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
    ((cb: () => void) => { cb(); return 0 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
  vi.resetModules();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

function mockFetchOnce(json: unknown, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok, json: async () => json }) as unknown as typeof fetch;
}

async function loadFresh() {
  return import("../../src/audio/metadataEnrich.js");
}

describe("enrichTrackMeta", () => {
  it("rejects too-short inputs", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const { enrichTrackMeta } = await loadFresh();
    const onResult = vi.fn();
    await enrichTrackMeta("", "x", onResult);
    await enrichTrackMeta("x", "", onResult);
    await enrichTrackMeta("a", "b", onResult); // len 1 each
    expect(onResult).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("skips year-like artist", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const { enrichTrackMeta } = await loadFresh();
    const onResult = vi.fn();
    await enrichTrackMeta("2020", "Song", onResult);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("calls onResult with cleaner metadata on hit", async () => {
    mockFetchOnce({
      recordings: [{
        title: "Clean Title",
        "artist-credit": [{ artist: { name: "Real Artist" } }],
        releases: [{ id: "abcd-1234", title: "Great Album" }],
      }],
    });
    const { enrichTrackMeta } = await loadFresh();
    const onResult = vi.fn();
    await enrichTrackMeta("Some Artist", "Some Title", onResult);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      artist: "Real Artist",
      album: "Great Album",
      title: "Clean Title",
      coverUrl: expect.stringContaining("coverartarchive.org/release/abcd-1234"),
    }));
  });

  it("no match → silent", async () => {
    mockFetchOnce({ recordings: [] });
    const { enrichTrackMeta } = await loadFresh();
    const onResult = vi.fn();
    await enrichTrackMeta("Foo", "Bar", onResult);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("network error → silent", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    const { enrichTrackMeta } = await loadFresh();
    const onResult = vi.fn();
    await enrichTrackMeta("Foo Two", "Bar Two", onResult);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("non-OK → silent", async () => {
    mockFetchOnce({}, false);
    const { enrichTrackMeta } = await loadFresh();
    const onResult = vi.fn();
    await enrichTrackMeta("Foo Three", "Bar Three", onResult);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("cached result re-delivers through onResult without refetch", async () => {
    mockFetchOnce({
      recordings: [{ title: "T", "artist-credit": [{ artist: { name: "A" } }], releases: [{ id: "x", title: "Alb" }] }],
    });
    const { enrichTrackMeta } = await loadFresh();
    const onResult = vi.fn();
    await enrichTrackMeta("Artist X", "Title X", onResult);
    await enrichTrackMeta("Artist X", "Title X", onResult);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("cached null → no second onResult, no refetch", async () => {
    mockFetchOnce({ recordings: [] });
    const { enrichTrackMeta } = await loadFresh();
    const onResult = vi.fn();
    await enrichTrackMeta("Artist Y", "Title Y", onResult);
    await enrichTrackMeta("Artist Y", "Title Y", onResult);
    expect(onResult).not.toHaveBeenCalled();
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});

describe("enrichAlbumTracklist", () => {
  it("rejects too-short / year-like inputs", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const { enrichAlbumTracklist } = await loadFresh();
    expect(await enrichAlbumTracklist("", "x")).toBeNull();
    expect(await enrichAlbumTracklist("A", "B")).toBeNull(); // len 1
    expect(await enrichAlbumTracklist("2020", "Album")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns tracksByNumber on two-step success", async () => {
    // Sequence: first fetch returns release id, second returns tracklist.
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ releases: [{ id: "rel-1", title: "Album" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        title: "Album",
        media: [{ tracks: [
          { position: 1, recording: { title: "One" } },
          { position: 2, recording: { title: "Two" } },
          { number: "3", recording: { title: "Three" } },
        ] }],
      }) }) as unknown as typeof fetch;
    const { enrichAlbumTracklist } = await loadFresh();
    const r = await enrichAlbumTracklist("Artist", "Album");
    expect(r?.album).toBe("Album");
    expect(r?.tracksByNumber.get(1)).toBe("One");
    expect(r?.tracksByNumber.get(2)).toBe("Two");
    expect(r?.tracksByNumber.get(3)).toBe("Three");
    expect(r?.coverUrl).toContain("rel-1");
  });

  it("no release → null", async () => {
    mockFetchOnce({ releases: [] });
    const { enrichAlbumTracklist } = await loadFresh();
    expect(await enrichAlbumTracklist("Art X", "Alb X")).toBeNull();
  });

  it("step2 non-OK → null", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ releases: [{ id: "rel-2" }] }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;
    const { enrichAlbumTracklist } = await loadFresh();
    expect(await enrichAlbumTracklist("Art Y", "Alb Y")).toBeNull();
  });

  it("caches null results", async () => {
    mockFetchOnce({ releases: [] });
    const { enrichAlbumTracklist } = await loadFresh();
    await enrichAlbumTracklist("Art Z", "Alb Z");
    await enrichAlbumTracklist("Art Z", "Alb Z");
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});
