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

// Replace the top-level Tauri event mock with a capture-capable version so
// tests can invoke the event handler directly.
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

function drive(iter: AsyncGenerator<unknown>) {
  // Helper: collect all yielded snapshots.
  return (async () => {
    const out: unknown[] = [];
    for await (const x of iter) out.push(x);
    return out;
  })();
}

beforeEach(() => {
  soulseekSearchMock.mockReset();
  listenMock.mockReset();
  listenUnsubscribe.mockReset();
  captured = null;
});

describe("soulseekProvider — basics", () => {
  it("early-return when aborted before start", async () => {
    const ac = new AbortController();
    ac.abort();
    const iter = soulseekProvider.search("x", { signal: ac.signal, log: vi.fn(), requestId: 0 });
    const snaps = await drive(iter);
    expect(snaps).toEqual([]);
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("final batch only → single snapshot", async () => {
    soulseekSearchMock.mockResolvedValue([
      { slsk_username: "u", slsk_filepath: "music/a.mp3", size: 100, bitrate: 320, slsk_is_image: false },
    ]);
    const ctx = makeCtx();
    const snaps = await drive(soulseekProvider.search("q", ctx));
    expect(snaps.length).toBeGreaterThan(0);
    const last = snaps[snaps.length - 1] as Array<{ type: string; id: string }>;
    expect(last.some((e) => e.type === "track" && e.id.includes("slsk:track:u|music/a.mp3"))).toBe(true);
    expect(listenUnsubscribe).toHaveBeenCalled();
  });

  it("skips batches with wrong requestId", async () => {
    soulseekSearchMock.mockResolvedValue([]);
    const ctx = makeCtx(42);
    const iter = soulseekProvider.search("q", ctx);
    const run = drive(iter);
    // Fire a wrong-requestId batch synchronously.
    captured?.({ payload: {
      requestId: 99,
      rows: [{ slsk_username: "u", slsk_filepath: "x/y.mp3", size: 1, bitrate: 0, slsk_is_image: false }],
    } });
    const snaps = await run;
    // Final batch fires emitSnapshot from soulseekSearch — single empty entity list.
    const last = snaps[snaps.length - 1] as unknown[];
    expect(last).toEqual([]);
  });

  it("error from soulseekSearch surfaces via throw", async () => {
    soulseekSearchMock.mockRejectedValue(new Error("net"));
    await expect(drive(soulseekProvider.search("q", makeCtx())))
      .rejects.toThrow(/net/);
  });
});

describe("soulseekProvider — grouping", () => {
  it("multi-track folder emits a flat track per title (no album entity)", async () => {
    soulseekSearchMock.mockResolvedValue([
      { slsk_username: "u1", slsk_filepath: "Folder/A.mp3", size: 1000, bitrate: 320, slsk_is_image: false },
      { slsk_username: "u1", slsk_filepath: "Folder/B.mp3", size: 1100, bitrate: 320, slsk_is_image: false },
      { slsk_username: "u1", slsk_filepath: "Folder/cover.jpg", slsk_is_image: true },
    ]);
    const snaps = await drive(soulseekProvider.search("q", makeCtx()));
    const last = snaps[snaps.length - 1] as Array<{ type: string; sources: Array<{ raw?: { cover?: unknown } }> }>;
    expect(last.filter((e) => e.type === "album")).toHaveLength(0);
    const tracks = last.filter((e) => e.type === "track");
    expect(tracks.length).toBeGreaterThanOrEqual(2);
    // Cover from the folder should be stamped on each track.
    for (const t of tracks) expect(t.sources[0]?.raw?.cover).toBeDefined();
  });

  it("single-song folder emits a track (no album entity)", async () => {
    soulseekSearchMock.mockResolvedValue([
      { slsk_username: "u", slsk_filepath: "X/OneSong.mp3", size: 1, bitrate: 0, slsk_is_image: false },
    ]);
    const snaps = await drive(soulseekProvider.search("q", makeCtx()));
    const last = snaps[snaps.length - 1] as Array<{ type: string }>;
    const albums = last.filter((e) => e.type === "album");
    expect(albums).toHaveLength(0);
    expect(last.some((e) => e.type === "track")).toBe(true);
  });

  it("cross-peer dedup of singletons counts unique users in raw.peers", async () => {
    soulseekSearchMock.mockResolvedValue([
      { slsk_username: "u1", slsk_filepath: "Song.mp3", size: 10, bitrate: 128, slsk_is_image: false },
      { slsk_username: "u2", slsk_filepath: "song.mp3", size: 10, bitrate: 256, slsk_is_image: false },
      { slsk_username: "u3", slsk_filepath: "Song.mp3", size: 10, bitrate: 320, slsk_is_image: false },
    ]);
    const snaps = await drive(soulseekProvider.search("q", makeCtx()));
    const last = snaps[snaps.length - 1] as Array<{ type: string; sources: Array<{ raw?: { peers?: number } }>; bitrate?: number }>;
    const tracks = last.filter((e) => e.type === "track");
    expect(tracks).toHaveLength(1);
    // Should pick highest bitrate (320) and have peers == 3.
    expect(tracks[0]?.sources[0]?.raw?.peers).toBe(3);
    expect(tracks[0]?.bitrate).toBe(320);
  });

  it("FLAC and MP3 copies of same title stay distinct", async () => {
    soulseekSearchMock.mockResolvedValue([
      { slsk_username: "u", slsk_filepath: "A/01 Song.flac", size: 1, bitrate: 1000, slsk_is_image: false },
      { slsk_username: "u", slsk_filepath: "A/02 Other.flac", size: 1, bitrate: 1000, slsk_is_image: false },
      { slsk_username: "u", slsk_filepath: "A/01 Song.mp3",  size: 1, bitrate: 320,  slsk_is_image: false },
      { slsk_username: "u", slsk_filepath: "A/02 Other.mp3", size: 1, bitrate: 320,  slsk_is_image: false },
    ]);
    const snaps = await drive(soulseekProvider.search("q", makeCtx()));
    const last = snaps[snaps.length - 1] as Array<{ type: string }>;
    // No album entities — SLSK only emits tracks now.
    expect(last.filter((e) => e.type === "album")).toHaveLength(0);
    // byTitle dedup keeps best-bitrate per (title.ext) → 4 tracks (flac + mp3 pairs).
    expect(last.filter((e) => e.type === "track")).toHaveLength(4);
  });
});

describe("soulseekProvider — abort handling", () => {
  it("mid-flight abort cleans up listener", async () => {
    let resolveSearch: (v: unknown[]) => void = () => {};
    soulseekSearchMock.mockReturnValue(new Promise<unknown[]>((r) => { resolveSearch = r; }));
    const ac = new AbortController();
    const iter = soulseekProvider.search("q", { signal: ac.signal, log: vi.fn(), requestId: 1 });
    const p = drive(iter);
    ac.abort();
    resolveSearch([]);
    await p;
    expect(listenUnsubscribe).toHaveBeenCalled();
  });
});
