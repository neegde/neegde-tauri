import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/torrent/embeddedCover.js", () => ({
  fetchTorrentEmbeddedCoverFullFile: vi.fn(),
}));
vi.mock("../../src/cover/coverReloadStatus.js", () => ({
  beginCoverReload: vi.fn(() => "run-1"),
  addCoverReloadStep: vi.fn(),
  updateCoverReloadSummary: vi.fn(),
  finishCoverReload: vi.fn(),
}));

import { loadTorrentFullEmbeddedCoverArt } from "../../src/torrent/loadTorrentFullEmbeddedCoverArt.js";
import { fetchTorrentEmbeddedCoverFullFile } from "../../src/torrent/embeddedCover.js";

describe("loadTorrentFullEmbeddedCoverArt", () => {
  beforeEach(() => {
    vi.mocked(fetchTorrentEmbeddedCoverFullFile).mockReset();
  });

  it("returns null when magnet is missing", async () => {
    const out = await loadTorrentFullEmbeddedCoverArt({
      torrentSource: "rutracker",
      torrentId: "1",
      magnet: "",
      origIdx: 0,
    });
    expect(out.embeddedDataUrl).toBeNull();
    expect(fetchTorrentEmbeddedCoverFullFile).not.toHaveBeenCalled();
  });

  it("returns embedded data URL on success", async () => {
    vi.mocked(fetchTorrentEmbeddedCoverFullFile).mockResolvedValueOnce("data:image/jpeg;base64,zz");
    const out = await loadTorrentFullEmbeddedCoverArt({
      torrentSource: "rutracker",
      torrentId: "1",
      magnet: "magnet:?xt=urn:btih:X",
      origIdx: 3,
    });
    expect(out.embeddedDataUrl).toBe("data:image/jpeg;base64,zz");
  });

  it("returns null when full-file scan finds nothing", async () => {
    vi.mocked(fetchTorrentEmbeddedCoverFullFile).mockResolvedValueOnce(null);
    const out = await loadTorrentFullEmbeddedCoverArt({
      torrentSource: "rutracker",
      torrentId: null,
      magnet: "magnet:?xt=urn:btih:X",
      origIdx: 0,
    });
    expect(out.embeddedDataUrl).toBeNull();
  });
});
