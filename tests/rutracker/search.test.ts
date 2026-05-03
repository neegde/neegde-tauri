import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockInvoke } from "../_setup.js";

beforeEach(() => {
  mockInvoke.mockReset();
  vi.resetModules();
});

async function loadFresh() {
  return import("../../src/rutracker/search.js");
}

describe("searchMusic", () => {
  it("invokes rutracker_search with mirror + query", async () => {
    mockInvoke.mockResolvedValueOnce([{ id: "1", name: "A" }]);
    const { searchMusic } = await loadFresh();
    const r = await searchMusic("query");
    expect(r).toEqual([{ id: "1", name: "A" }]);
    expect(mockInvoke).toHaveBeenCalledWith("rutracker_search", {
      mirror: "https://rutracker.test",
      query: "query",
    });
  });
});

describe("filterRutrackerRowsWithPlayableAudio", () => {
  it("empty input → []", async () => {
    const { filterRutrackerRowsWithPlayableAudio } = await loadFresh();
    expect(await filterRutrackerRowsWithPlayableAudio([])).toEqual([]);
    expect(await filterRutrackerRowsWithPlayableAudio(null as unknown as never)).toEqual([]);
  });

  it("keeps rows where check returns truthy; keeps row on check error", async () => {
    // 3 rows. Row 0: true. Row 1: false. Row 2: throws → kept.
    mockInvoke
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("net"));
    const { filterRutrackerRowsWithPlayableAudio } = await loadFresh();
    const kept = await filterRutrackerRowsWithPlayableAudio([
      { id: "a" }, { id: "b" }, { id: "c" },
    ] as unknown as never[]);
    expect(kept.map((r: { id: string }) => r.id)).toEqual(["a", "c"]);
  });
});

describe("getTorrentDetails + prefetch", () => {
  it("invokes rutracker_get_torrent_details and caches", async () => {
    mockInvoke.mockResolvedValue({
      id: "1", cover_data_url: "data:X", magnet: "m", files: [],
    });
    const { getTorrentDetails } = await loadFresh();
    const r1 = await getTorrentDetails("1");
    expect(r1.magnet).toBe("m");
    const r2 = await getTorrentDetails("1");
    // Second call: cache hit, same object.
    expect(r2).toBe(r1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent requests to the same topic", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    mockInvoke.mockReturnValueOnce(new Promise<unknown>((r) => { resolveFirst = r; }));
    const { getTorrentDetails } = await loadFresh();
    const p1 = getTorrentDetails("42");
    const p2 = getTorrentDetails("42");
    // Same in-flight promise.
    expect(p1).toBe(p2);
    resolveFirst({ id: "42", cover_data_url: null, magnet: "m", files: [] });
    await p1;
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("error clears cache entry so retry re-invokes", async () => {
    mockInvoke
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValueOnce({ id: "7", cover_data_url: null, magnet: "m", files: [] });
    const { getTorrentDetails } = await loadFresh();
    await expect(getTorrentDetails("7")).rejects.toThrow(/500/);
    const r = await getTorrentDetails("7");
    expect(r.magnet).toBe("m");
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("prefetchTorrentDetails no-ops on empty id and on cache hit", async () => {
    mockInvoke.mockResolvedValueOnce({
      id: "1", cover_data_url: null, magnet: "m", files: [],
    });
    const { prefetchTorrentDetails, getTorrentDetails } = await loadFresh();
    prefetchTorrentDetails(""); // no-op
    expect(mockInvoke).not.toHaveBeenCalled();
    prefetchTorrentDetails("1");
    await getTorrentDetails("1"); // uses cached/pending result
    prefetchTorrentDetails("1"); // no-op — already cached
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});
