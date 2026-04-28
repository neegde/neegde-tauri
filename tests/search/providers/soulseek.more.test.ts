import { describe, it, expect, beforeEach, vi } from "vitest";
import "../../_setup.js";

const { soulseekSearchMock, listenMock, listenUnsubscribe } = vi.hoisted(() => ({
  soulseekSearchMock: vi.fn(),
  listenMock: vi.fn(),
  listenUnsubscribe: vi.fn(),
}));

vi.mock("../../../src/soulseek/api.js", () => ({
  soulseekSearch: soulseekSearchMock,
}));

let captured: ((ev: { payload: unknown }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, cb: (ev: { payload: unknown }) => void) => {
    captured = cb;
    listenMock(_name, cb);
    return Promise.resolve(listenUnsubscribe);
  },
  emit: vi.fn(),
}));

import { soulseekProvider } from "../../../src/search/providers/soulseek.js";

function makeCtx(requestId = 1) {
  return { signal: new AbortController().signal, log: vi.fn(), requestId };
}

async function drive(iter: AsyncGenerator<unknown>) {
  const out: unknown[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

beforeEach(() => {
  soulseekSearchMock.mockReset();
  listenMock.mockReset();
  listenUnsubscribe.mockReset();
  captured = null;
});

describe("soulseekProvider — format inference", () => {
  async function format(filename: string): Promise<string | null> {
    soulseekSearchMock.mockResolvedValue([
      {
        slsk_username: "u",
        slsk_filepath: `Album/01 ${filename}`,
        size: 1,
        bitrate: 0,
        slsk_is_image: false,
      },
    ]);
    const snaps = await drive(soulseekProvider.search("q", makeCtx()));
    const last = snaps[snaps.length - 1] as Array<{ type: string; format?: string | null }>;
    const track = last.find((e) => e.type === "track");
    return track?.format ?? null;
  }

  it.each([
    ["song.flac", "FLAC"],
    ["song.mp3", "MP3"],
    ["song.ogg", "OGG"],
    ["song.oga", "OGG"],
    ["song.wav", "WAV"],
    ["song.ape", "APE"],
    ["song.m4a", "ALAC"],
    ["song.alac", "ALAC"],
    ["song.aac", "AAC"],
    ["song.opus", "OPUS"],
    ["song.dsd", "DSD"],
    ["song.dsf", "DSD"],
    ["song.dff", "DSD"],
  ])("%s → %s", async (name, expected) => {
    expect(await format(name)).toBe(expected);
  });

  it("unknown extension → null", async () => {
    expect(await format("song.xyz")).toBe("xyz" === "xyz" ? null : null);
  });

  it("filename without extension → null", async () => {
    expect(await format("song")).toBe(null);
  });
});

describe("soulseekProvider — cover selection", () => {
  it("prefers front.jpg over album.jpg when both exist", async () => {
    soulseekSearchMock.mockResolvedValue([
      { slsk_username: "u", slsk_filepath: "A/01.mp3", size: 1, bitrate: 0, slsk_is_image: false },
      { slsk_username: "u", slsk_filepath: "A/02.mp3", size: 1, bitrate: 0, slsk_is_image: false },
      { slsk_username: "u", slsk_filepath: "A/album.jpg", size: 1000, slsk_is_image: true },
      { slsk_username: "u", slsk_filepath: "A/front.jpg", size: 100,  slsk_is_image: true },
    ]);
    const snaps = await drive(soulseekProvider.search("q", makeCtx()));
    const last = snaps[snaps.length - 1] as Array<{ type: string; sources: Array<{ raw?: { cover?: { slsk_filepath?: string } } }> }>;
    const track = last.find((e) => e.type === "track");
    expect(track?.sources[0]?.raw?.cover?.slsk_filepath).toMatch(/front\.jpg$/);
  });

  it("picks biggest image when priority ties (unknown filenames)", async () => {
    soulseekSearchMock.mockResolvedValue([
      { slsk_username: "u", slsk_filepath: "A/01.mp3", size: 1, bitrate: 0, slsk_is_image: false },
      { slsk_username: "u", slsk_filepath: "A/02.mp3", size: 1, bitrate: 0, slsk_is_image: false },
      { slsk_username: "u", slsk_filepath: "A/img1.jpg", size: 50,  slsk_is_image: true },
      { slsk_username: "u", slsk_filepath: "A/img2.jpg", size: 500, slsk_is_image: true },
    ]);
    const snaps = await drive(soulseekProvider.search("q", makeCtx()));
    const last = snaps[snaps.length - 1] as Array<{ type: string; sources: Array<{ raw?: { cover?: { slsk_filepath?: string } } }> }>;
    const track = last.find((e) => e.type === "track");
    expect(track?.sources[0]?.raw?.cover?.slsk_filepath).toMatch(/img2\.jpg$/);
  });

  it("folder with no images produces null cover on tracks", async () => {
    soulseekSearchMock.mockResolvedValue([
      { slsk_username: "u", slsk_filepath: "A/01.mp3", size: 1, bitrate: 0, slsk_is_image: false },
      { slsk_username: "u", slsk_filepath: "A/02.mp3", size: 1, bitrate: 0, slsk_is_image: false },
    ]);
    const snaps = await drive(soulseekProvider.search("q", makeCtx()));
    const last = snaps[snaps.length - 1] as Array<{ type: string; sources: Array<{ raw?: { cover?: unknown } }> }>;
    const track = last.find((e) => e.type === "track");
    expect(track?.sources[0]?.raw?.cover).toBeNull();
  });
});

describe("soulseekProvider — title normalization + dedup", () => {
  it("strips leading year+date prefixes when deduping across peers", async () => {
    soulseekSearchMock.mockResolvedValue([
      { slsk_username: "u1", slsk_filepath: "[2020.01.15] Song.mp3", size: 1, bitrate: 128, slsk_is_image: false },
      { slsk_username: "u2", slsk_filepath: "2020.01.15 Song.mp3",  size: 1, bitrate: 256, slsk_is_image: false },
      { slsk_username: "u3", slsk_filepath: "Song.mp3",             size: 1, bitrate: 320, slsk_is_image: false },
    ]);
    const snaps = await drive(soulseekProvider.search("q", makeCtx()));
    const last = snaps[snaps.length - 1] as Array<{ type: string; sources: Array<{ raw?: { peers?: number } }>; bitrate?: number }>;
    const tracks = last.filter((e) => e.type === "track");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.sources[0]?.raw?.peers).toBe(3);
  });

  it("strips track-number prefix ('01 Song' == 'Song')", async () => {
    soulseekSearchMock.mockResolvedValue([
      { slsk_username: "u1", slsk_filepath: "01 Song.mp3", size: 1, bitrate: 128, slsk_is_image: false },
      { slsk_username: "u2", slsk_filepath: "Song.mp3",    size: 1, bitrate: 320, slsk_is_image: false },
    ]);
    const snaps = await drive(soulseekProvider.search("q", makeCtx()));
    const last = snaps[snaps.length - 1] as Array<{ type: string; sources: Array<{ raw?: { peers?: number } }> }>;
    const tracks = last.filter((e) => e.type === "track");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.sources[0]?.raw?.peers).toBe(2);
  });

  it("drops rows whose filepath has no basename", async () => {
    soulseekSearchMock.mockResolvedValue([
      { slsk_username: "u", slsk_filepath: "",         size: 1, bitrate: 0, slsk_is_image: false },
      { slsk_username: "u", slsk_filepath: "valid.mp3", size: 1, bitrate: 320, slsk_is_image: false },
    ]);
    const snaps = await drive(soulseekProvider.search("q", makeCtx()));
    const last = snaps[snaps.length - 1] as Array<{ type: string; fileName?: string }>;
    const tracks = last.filter((e) => e.type === "track");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.fileName).toBe("valid.mp3");
  });
});

describe("soulseekProvider — event stream", () => {
  it("forwards matching-requestId batch through emitSnapshot", async () => {
    soulseekSearchMock.mockImplementation(
      () => new Promise(() => {}), // never resolves; idle timer will close
    );
    const ac = new AbortController();
    const iter = soulseekProvider.search("q", { signal: ac.signal, log: vi.fn(), requestId: 7 });
    const p = drive(iter);
    await Promise.resolve();
    // Event with matching requestId.
    captured?.({ payload: {
      requestId: 7,
      rows: [{ slsk_username: "u", slsk_filepath: "X/song.mp3", size: 1, bitrate: 0, slsk_is_image: false }],
    } });
    // Now abort to unblock the generator without waiting for idle timer.
    ac.abort();
    const snaps = await p;
    // At least one snapshot containing the row.
    const flat = snaps.flat() as Array<{ type: string }>;
    expect(flat.some((e) => e.type === "track")).toBe(true);
  });

  it("ignores null / payload-less events", async () => {
    soulseekSearchMock.mockResolvedValue([]);
    const ctx = makeCtx(1);
    const iter = soulseekProvider.search("q", ctx);
    const p = drive(iter);
    captured?.({ payload: null });
    const snaps = await p;
    const flat = snaps.flat() as Array<{ type: string }>;
    expect(flat).toHaveLength(0);
  });
});
