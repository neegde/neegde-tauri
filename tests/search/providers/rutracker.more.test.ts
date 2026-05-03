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

function withFile(ext: string) {
  searchMusicMock.mockResolvedValue([{ id: "1", name: "A", seeders: 1 }]);
  getDetailsMock.mockResolvedValue({
    artist: "A",
    files: [{ path: ["A", `01.${ext}`], size: 100 }],
    cover_data_url: null,
  });
}

async function formatFor(ext: string): Promise<string | null> {
  withFile(ext);
  const snaps = await consume(rutrackerProvider.search("x", makeCtx()));
  const flat = snaps[snaps.length - 1] as Array<{ type?: string; format?: string | null }>;
  const track = flat.find((e) => e.type === "track");
  return track?.format ?? null;
}

describe("rutrackerProvider — format detection", () => {
  it.each([
    ["flac", "FLAC"],
    ["mp3", "MP3"],
    ["ape", "APE"],
    ["wav", "WAV"],
    ["ogg", "OGG"],
    ["m4a", "ALAC"],
    ["aac", "AAC"],
    ["opus", "OPUS"],
  ])("maps .%s → %s", async (ext, expected) => {
    expect(await formatFor(ext)).toBe(expected);
  });

  it(".wv (audio) is unmapped → format null", async () => {
    expect(await formatFor("wv")).toBe(null);
  });
});

describe("rutrackerProvider — album-level aggregate format", () => {
  it("album format follows the first track with a format set", async () => {
    searchMusicMock.mockResolvedValue([{ id: "1", name: "A", seeders: 1 }]);
    getDetailsMock.mockResolvedValue({
      artist: "A",
      files: [
        { path: ["A", "01.flac"], size: 100 },
        { path: ["A", "02.flac"], size: 100 },
      ],
      cover_data_url: null,
    });
    const snaps = await consume(rutrackerProvider.search("x", makeCtx()));
    const flat = snaps[snaps.length - 1] as Array<{ type?: string; format?: string | null }>;
    const album = flat.find((e) => e.type === "album");
    expect(album?.format).toBe("FLAC");
  });
});

describe("rutrackerProvider — abort after search", () => {
  it("stops before enriching when aborted between searchMusic and enrichTopic", async () => {
    const ac = new AbortController();
    // Abort while searchMusic is running so the post-search signal check returns early.
    searchMusicMock.mockImplementation(async () => {
      ac.abort();
      return [{ id: "a", name: "X", seeders: 1 }];
    });
    getDetailsMock.mockResolvedValue({
      artist: "A",
      files: [{ path: ["X", "01.mp3"], size: 10 }],
      cover_data_url: null,
    });
    const iter = rutrackerProvider.search("x", { signal: ac.signal, log: vi.fn(), requestId: 2 });
    const snaps = await consume(iter);
    // Either early return with no snapshots, or snapshots with no entities —
    // both are valid "abort respected" shapes.
    const lastFlat = snaps.flat();
    expect(lastFlat).toHaveLength(0);
  });
});
