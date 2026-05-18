import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/rutracker/coverCache.js", () => ({
  invalidateRutrackerCover: vi.fn(),
}));
vi.mock("../../src/torrent/torrentImageCache.js", () => ({
  invalidateTorrentImage: vi.fn(),
  getTorrentImageDataUrl: vi.fn(),
}));
vi.mock("../../src/torrent/api.js", () => ({
  torrentFileB64ForTrack: vi.fn(),
}));
vi.mock("../../src/torrent/embeddedCover.js", () => ({
  fetchTorrentEmbeddedCoverBytes: vi.fn(),
}));
vi.mock("../../src/cover/coverReloadStatus.js", () => ({
  beginCoverReload: vi.fn(() => "run-1"),
  addCoverReloadStep: vi.fn(),
  updateCoverReloadSummary: vi.fn(),
  finishCoverReload: vi.fn(),
}));

import { reloadTorrentRowCoverArt } from "../../src/torrent/reloadTorrentRowCoverArt.js";
import { torrentFileB64ForTrack } from "../../src/torrent/api.js";
import { getTorrentImageDataUrl } from "../../src/torrent/torrentImageCache.js";
import { fetchTorrentEmbeddedCoverBytes } from "../../src/torrent/embeddedCover.js";

describe("reloadTorrentRowCoverArt", () => {
  beforeEach(() => {
    vi.mocked(torrentFileB64ForTrack).mockReset();
    vi.mocked(torrentFileB64ForTrack).mockResolvedValue(null);
    vi.mocked(getTorrentImageDataUrl).mockReset();
    vi.mocked(fetchTorrentEmbeddedCoverBytes).mockReset();
  });

  it("returns null when magnet is missing", async () => {
    const out = await reloadTorrentRowCoverArt({
      torrentSource: "rutracker",
      torrentId: "1",
      magnet: "",
      origIdx: 0,
      albums: [],
    });
    expect(out.embeddedDataUrl).toBeNull();
    expect(getTorrentImageDataUrl).not.toHaveBeenCalled();
  });

  it("returns null when folder image succeeds", async () => {
    vi.mocked(getTorrentImageDataUrl).mockResolvedValueOnce("data:image/jpeg;base64,xx");
    const out = await reloadTorrentRowCoverArt({
      torrentSource: "rutracker",
      torrentId: "9",
      magnet: "magnet:?xt=urn:btih:ABC",
      origIdx: 2,
      albums: [
        {
          audioFiles: [{ origIdx: 2 }],
          coverFile: { origIdx: 0 },
        },
      ],
    });
    expect(out.embeddedDataUrl).toBeNull();
    expect(getTorrentImageDataUrl).toHaveBeenCalledWith("magnet:?xt=urn:btih:ABC", 0, null);
  });

  it("falls back to embedded bytes when folder image fails", async () => {
    vi.mocked(getTorrentImageDataUrl).mockResolvedValueOnce(null);
    vi.mocked(fetchTorrentEmbeddedCoverBytes).mockResolvedValueOnce("data:image/png;base64,yy");
    const out = await reloadTorrentRowCoverArt({
      torrentSource: "rutracker",
      torrentId: "9",
      magnet: "magnet:?xt=urn:btih:ABC",
      origIdx: 2,
      albums: [
        {
          audioFiles: [{ origIdx: 2 }],
          coverFile: { origIdx: 0 },
        },
      ],
    });
    expect(out.embeddedDataUrl).toBe("data:image/png;base64,yy");
  });
});
