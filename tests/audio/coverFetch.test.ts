import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../_setup.js";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  // Bypass the 1.1s throttle: make setTimeout invoke immediately.
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
    ((cb: () => void) => { cb(); return 0 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
  vi.resetModules();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

function mockFetchOnce(response: unknown, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => response,
  }) as unknown as typeof fetch;
}

async function freshModule() {
  return (await import("../../src/audio/coverFetch.js")).fetchAlbumCover;
}

describe("fetchAlbumCover", () => {
  it("rejects too-short inputs without network", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const fetchAlbumCover = await freshModule();
    expect(await fetchAlbumCover("", "A")).toBeNull();
    expect(await fetchAlbumCover("A", "")).toBeNull();
    expect(await fetchAlbumCover("x", "yy")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("picks best album match from results", async () => {
    mockFetchOnce({
      results: [
        { artistName: "Wrong", collectionName: "Other", artworkUrl100: "http://img/100x100bb.jpg" },
        { artistName: "Right", collectionName: "The Album X", artworkUrl100: "http://img/100x100bb.jpg", collectionViewUrl: "http://u" },
      ],
    });
    const fetchAlbumCover = await freshModule();
    const r = await fetchAlbumCover("Art", "The Album X");
    expect(r?.artist).toBe("Right");
    expect(r?.coverUrl).toBe("http://img/600x600bb.jpg");
    expect(r?.albumUrl).toBe("http://u");
  });

  it("falls back to first hit when none matches", async () => {
    mockFetchOnce({
      results: [{ artistName: "A", collectionName: "X", artworkUrl100: "http://x.jpg" }],
    });
    const fetchAlbumCover = await freshModule();
    const r = await fetchAlbumCover("Artist Two", "Album Two");
    expect(r?.artist).toBe("A");
  });

  it("empty results → null", async () => {
    mockFetchOnce({ results: [] });
    const fetchAlbumCover = await freshModule();
    expect(await fetchAlbumCover("Artist Three", "Album Three")).toBeNull();
  });

  it("non-OK response → null", async () => {
    mockFetchOnce(null, false);
    const fetchAlbumCover = await freshModule();
    expect(await fetchAlbumCover("Artist Four", "Album Four")).toBeNull();
  });

  it("network error → null", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    const fetchAlbumCover = await freshModule();
    expect(await fetchAlbumCover("Artist Five", "Album Five")).toBeNull();
  });

  it("caches repeated lookups", async () => {
    mockFetchOnce({ results: [{ artistName: "Cached", collectionName: "Alb" }] });
    const fetchAlbumCover = await freshModule();
    await fetchAlbumCover("Artist Six", "Album Six");
    await fetchAlbumCover("Artist Six", "Album Six");
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});
