import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { mockInvoke } from "../_setup.js";

import {
  peekTorrentImage,
  getTorrentImageDataUrl,
  clearTorrentImageCache,
} from "../../src/torrent/torrentImageCache.js";

beforeEach(() => {
  mockInvoke.mockReset();
  clearTorrentImageCache();
});

describe("torrentImageCache — peek / getOrFetch", () => {
  it("peek returns undefined for unseen keys", () => {
    expect(peekTorrentImage("magnet:A", 0)).toBe(undefined);
  });

  it("getTorrentImageDataUrl invokes backend once and caches the positive result", async () => {
    mockInvoke.mockResolvedValue("data:image/jpg;base64,AAA");
    const first = await getTorrentImageDataUrl("magnet:A", 3);
    expect(first).toBe("data:image/jpg;base64,AAA");
    const second = await getTorrentImageDataUrl("magnet:A", 3);
    expect(second).toBe("data:image/jpg;base64,AAA");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(peekTorrentImage("magnet:A", 3)).toBe("data:image/jpg;base64,AAA");
  });

  it("passes torrentFileB64 hint through to invoke", async () => {
    mockInvoke.mockResolvedValueOnce("data:tc");
    await getTorrentImageDataUrl("magnet:A", 0, "B64_PAYLOAD");
    expect(mockInvoke).toHaveBeenCalledWith(
      "torrent_fetch_image",
      expect.objectContaining({ fileIdx: 0, torrentFileB64: "B64_PAYLOAD" }),
    );
  });

  it("defaults torrentFileB64 to null when omitted", async () => {
    mockInvoke.mockResolvedValueOnce("data:tc");
    await getTorrentImageDataUrl("magnet:A", 0);
    expect(mockInvoke).toHaveBeenCalledWith(
      "torrent_fetch_image",
      expect.objectContaining({ torrentFileB64: null }),
    );
  });

  it("negative result is NOT returned by peek (shape-compat: undefined, not null)", async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const r = await getTorrentImageDataUrl("magnet:A", 1);
    expect(r).toBe(null);
    // Shared core stores this as a negative TTL; shim hides it from peek callers.
    expect(peekTorrentImage("magnet:A", 1)).toBe(undefined);
  });

  it("dedupes concurrent fetches for the same (magnet, fileIdx)", async () => {
    let resolveFetch: ((v: string) => void) | null = null;
    mockInvoke.mockImplementationOnce(() => new Promise<string>((r) => { resolveFetch = r; }));
    const p1 = getTorrentImageDataUrl("magnet:X", 7);
    const p2 = getTorrentImageDataUrl("magnet:X", 7);
    // Let the in-flight invoke mock execute so resolveFetch gets captured.
    await Promise.resolve(); await Promise.resolve();
    resolveFetch?.("data:shared");
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe("data:shared");
    expect(b).toBe("data:shared");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("invoke rejection surfaces as null and does not cache positively", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("boom"));
    const r = await getTorrentImageDataUrl("magnet:err", 0);
    expect(r).toBe(null);
    expect(peekTorrentImage("magnet:err", 0)).toBe(undefined);
  });

  it("clearTorrentImageCache drops cached entries", async () => {
    mockInvoke.mockResolvedValue("data:cached");
    await getTorrentImageDataUrl("magnet:clear", 0);
    expect(peekTorrentImage("magnet:clear", 0)).toBe("data:cached");
    clearTorrentImageCache();
    expect(peekTorrentImage("magnet:clear", 0)).toBe(undefined);
  });

  it("different (magnet, fileIdx) pairs cache independently", async () => {
    mockInvoke
      .mockResolvedValueOnce("data:a")
      .mockResolvedValueOnce("data:b");
    const a = await getTorrentImageDataUrl("magnet:A", 0);
    const b = await getTorrentImageDataUrl("magnet:A", 1);
    expect(a).toBe("data:a");
    expect(b).toBe("data:b");
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});
