import { describe, it, expect, beforeEach } from "vitest";
import { mockInvoke, fakeLocalStorage } from "../_setup.js";

import {
  magnetListFiles,
  streamUrl,
  torrentFileB64ForTrack,
  prefetchNextInQueue,
} from "../../src/torrent/api.js";

beforeEach(() => {
  mockInvoke.mockReset();
  // Clear torrent file b64 persisted cache — keys under neegde.*.
  for (const k of Array.from(fakeLocalStorage.keys())) {
    if (k.startsWith("torrent_file_b64_v1_")) fakeLocalStorage.delete(k);
  }
});

describe("magnetListFiles", () => {
  it("passes through to invoke('torrent_magnet_list_files')", async () => {
    mockInvoke.mockResolvedValueOnce([{ path: ["a", "b.mp3"], size: 100 }]);
    const r = await magnetListFiles("magnet:?xt=urn:btih:X");
    expect(r).toEqual([{ path: ["a", "b.mp3"], size: 100 }]);
    expect(mockInvoke).toHaveBeenCalledWith("torrent_magnet_list_files", {
      magnet: "magnet:?xt=urn:btih:X",
    });
  });
});

describe("streamUrl — soulseek branch", () => {
  it("returns '' when slsk creds missing", async () => {
    const out = await streamUrl("", 0, { source: "soulseek" });
    expect(out).toBe("");
  });
  it("invokes soulseek_prepare_stream and returns URL", async () => {
    mockInvoke.mockResolvedValueOnce({ url: "slsk-url", token: "tok" });
    const out = await streamUrl("ignored", 0, {
      source: "soulseek",
      slskUsername: "u",
      slskFilepath: "f",
      slskFilesize: 123,
    } as never);
    expect(out).toBe("slsk-url");
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_prepare_stream", {
      username: "u", filepath: "f", filesize: 123,
    });
  });
  it("propagates slsk errors", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("peer gone"));
    await expect(streamUrl("", 0, { source: "soulseek", slskUsername: "u", slskFilepath: "f" } as never))
      .rejects.toThrow(/peer gone/);
  });
});

describe("streamUrl — torrent branch", () => {
  it("'' on bad inputs", async () => {
    expect(await streamUrl("", 0)).toBe("");
    expect(await streamUrl("magnet:?xt=urn:btih:X", -1)).toBe("");
    expect(await streamUrl("magnet:?xt=urn:btih:X", null as unknown as number)).toBe("");
  });
  it("invokes torrent_prepare_stream with enriched magnet", async () => {
    mockInvoke.mockResolvedValueOnce({ url: "http://local/stream" });
    const out = await streamUrl("magnet:?xt=urn:btih:deadbeef", 2);
    expect(out).toBe("http://local/stream");
    expect(mockInvoke).toHaveBeenCalledWith("torrent_prepare_stream", {
      magnet: expect.stringContaining("magnet:?xt=urn:btih:deadbeef"),
      fileIdx: 2,
      torrentFileB64: null,
    });
  });
  it("downloads + caches .torrent b64 for rutracker", async () => {
    // First call: b64 download, then prepare stream.
    mockInvoke.mockResolvedValueOnce("BASE64");
    mockInvoke.mockResolvedValueOnce({ url: "http://local/x" });
    const out = await streamUrl("magnet:?xt=urn:btih:X", 0, { source: "rutracker", torrentId: 42 });
    expect(out).toBe("http://local/x");
    expect(mockInvoke.mock.calls[0]).toEqual([
      "rutracker_download_torrent_file_b64",
      { mirror: "https://rutracker.test", topicId: "42" },
    ]);
    // Second streamUrl for same topic → cache hit, no new b64 download.
    mockInvoke.mockResolvedValueOnce({ url: "http://local/y" });
    await streamUrl("magnet:?xt=urn:btih:X", 0, { source: "rutracker", torrentId: 42 });
    // Should be only 3 calls (download + prepare + prepare).
    expect(mockInvoke).toHaveBeenCalledTimes(3);
  });
  it("propagates prepare error", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("boom"));
    await expect(streamUrl("magnet:?xt=urn:btih:X", 0)).rejects.toThrow(/boom/);
  });
});

describe("torrentFileB64ForTrack", () => {
  it("null for missing track", async () => {
    expect(await torrentFileB64ForTrack(null as unknown as never)).toBeNull();
  });
  it("null for non-rutracker track", async () => {
    expect(await torrentFileB64ForTrack({ source: "soulseek", torrentId: "1" } as unknown as never))
      .toBeNull();
  });
  it("null when torrentId missing", async () => {
    expect(await torrentFileB64ForTrack({ source: "rutracker" } as unknown as never)).toBeNull();
  });
  it("invokes download for rutracker track with id", async () => {
    mockInvoke.mockResolvedValueOnce("B64");
    const r = await torrentFileB64ForTrack({ source: "rutracker", torrentId: "7" } as unknown as never);
    expect(r).toBe("B64");
  });
});

describe("prefetchNextInQueue", () => {
  it("null on bad input", async () => {
    expect(await prefetchNextInQueue(null as unknown as never, null as unknown as never)).toBeNull();
    expect(await prefetchNextInQueue({ magnet: "m" } as unknown as never, null as unknown as never)).toBeNull();
  });
  it("invokes torrent_prefetch_next_track with enriched magnets", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "streamReady", url: "http://pre/" });
    const r = await prefetchNextInQueue(
      { magnet: "magnet:?xt=urn:btih:A", fileIdx: 0 } as unknown as never,
      { magnet: "magnet:?xt=urn:btih:B", fileIdx: 3 } as unknown as never,
    );
    expect(r?.url).toBe("http://pre/");
    expect(mockInvoke).toHaveBeenCalledWith("torrent_prefetch_next_track", expect.objectContaining({
      currentFileIdx: 0,
      nextFileIdx: 3,
      warmOnly: false,
    }));
  });
  it("warmOnly=true propagates", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "streamReady", url: "u" });
    await prefetchNextInQueue(
      { magnet: "magnet:?xt=urn:btih:A", fileIdx: 0 } as unknown as never,
      { magnet: "magnet:?xt=urn:btih:B", fileIdx: 1 } as unknown as never,
      { warmOnly: true },
    );
    expect(mockInvoke.mock.calls.at(-1)?.[1]).toMatchObject({ warmOnly: true });
  });
  it("propagates invoke error", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("bad"));
    await expect(prefetchNextInQueue(
      { magnet: "magnet:?xt=urn:btih:A", fileIdx: 0 } as unknown as never,
      { magnet: "magnet:?xt=urn:btih:B", fileIdx: 1 } as unknown as never,
    )).rejects.toThrow(/bad/);
  });
});
