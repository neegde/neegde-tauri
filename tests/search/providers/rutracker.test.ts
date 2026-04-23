import { describe, it, expect, beforeEach, vi } from "vitest";
import "../../_setup.js";

const { searchMusicMock, getDetailsMock } = vi.hoisted(() => ({
  searchMusicMock: vi.fn(),
  getDetailsMock: vi.fn(),
}));
vi.mock("../../../src/rutracker/search.js", () => ({
  searchMusic: searchMusicMock,
  getTorrentDetails: getDetailsMock,
}));

import { rutrackerProvider } from "../../../src/search/providers/rutracker.js";

beforeEach(() => {
  searchMusicMock.mockReset();
  getDetailsMock.mockReset();
});

function makeCtx() {
  return { signal: new AbortController().signal, log: vi.fn(), requestId: 1 };
}

async function consume<T>(iter: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("rutrackerProvider", () => {
  it("early return when aborted before start", async () => {
    const ac = new AbortController();
    ac.abort();
    const iter = rutrackerProvider.search("x", { signal: ac.signal, log: vi.fn(), requestId: 0 });
    expect(await consume(iter)).toEqual([]);
    expect(searchMusicMock).not.toHaveBeenCalled();
  });

  it("empty topic list → single empty snapshot", async () => {
    searchMusicMock.mockResolvedValue([]);
    const snaps = await consume(rutrackerProvider.search("x", makeCtx()));
    expect(snaps).toEqual([[]]);
  });

  it("emits Album + Track entities for a topic with audio files", async () => {
    searchMusicMock.mockResolvedValue([{ id: "100", name: "Artist - Album", seeders: 5, leechers: 0 }]);
    getDetailsMock.mockResolvedValue({
      artist: "Artist",
      magnet: "magnet:?xt=urn:btih:A",
      files: [
        { path: ["Album", "01.mp3"], size: 1000 },
        { path: ["Album", "02.mp3"], size: 1100 },
        { path: ["Album", "cover.jpg"], size: 500 },
      ],
      cover_data_url: null,
    });
    const snaps = await consume(rutrackerProvider.search("x", makeCtx()));
    const flat = snaps[snaps.length - 1] as Array<{ id: string; type?: string; albumId?: string; trackIds?: string[]; title?: string; sources?: Array<{ kind: string }> }>;
    const album = flat.find((e) => e.type === "album");
    const tracks = flat.filter((e) => e.type === "track");
    expect(album?.title).toBe("Album");
    expect(album?.sources?.[0]?.kind).toBe("rutracker");
    expect(album?.trackIds).toHaveLength(2);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.albumId).toBe(album?.id);
  });

  it("topic error is logged and topic dropped", async () => {
    searchMusicMock.mockResolvedValue([
      { id: "ok", name: "A - B", seeders: 1 },
      { id: "bad", name: "C - D", seeders: 1 },
    ]);
    getDetailsMock.mockImplementation(async (id: string) => {
      if (id === "bad") throw new Error("broken");
      return {
        artist: "A",
        magnet: "m",
        files: [{ path: ["B", "01.mp3"], size: 1 }],
        cover_data_url: null,
      };
    });
    const ctx = makeCtx();
    const snaps = await consume(rutrackerProvider.search("x", ctx));
    const flat = snaps[snaps.length - 1] as Array<{ id: string; type?: string; albumId?: string; trackIds?: string[]; title?: string; sources?: Array<{ kind: string }> }>;
    expect(flat.some((e) => e.id?.includes("ok"))).toBe(true);
    expect(ctx.log).toHaveBeenCalledWith("rutracker", expect.stringMatching(/bad failed/));
  });

  it("throws when all topics fail", async () => {
    searchMusicMock.mockResolvedValue([
      { id: "a", name: "x" },
      { id: "b", name: "y" },
    ]);
    getDetailsMock.mockRejectedValue(new Error("down"));
    await expect(consume(rutrackerProvider.search("x", makeCtx())))
      .rejects.toThrow(/all 2 topics failed/);
  });

  it("skips topics with no audio", async () => {
    searchMusicMock.mockResolvedValue([{ id: "1", name: "Video" }]);
    getDetailsMock.mockResolvedValue({
      artist: null,
      magnet: "m",
      files: [{ path: ["movie.mkv"], size: 1 }],
      cover_data_url: null,
    });
    const snaps = await consume(rutrackerProvider.search("x", makeCtx()));
    const flat = snaps[snaps.length - 1] as Array<{ id: string; type?: string; albumId?: string; trackIds?: string[]; title?: string; sources?: Array<{ kind: string }> }>;
    expect(flat).toHaveLength(0);
  });
});
