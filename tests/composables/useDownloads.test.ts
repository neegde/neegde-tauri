import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { ref, computed } from "vue";

const { exportTorrentFilesMock, exportPlaylistTracksMock, exportSlskTrackMock } = vi.hoisted(() => ({
  exportTorrentFilesMock: vi.fn(),
  exportPlaylistTracksMock: vi.fn(),
  exportSlskTrackMock: vi.fn(),
}));
vi.mock("../../src/torrent/torrentExport.js", () => ({
  exportTorrentFiles: exportTorrentFilesMock,
  exportPlaylistTracks: exportPlaylistTracksMock,
  exportSlskTrack: exportSlskTrackMock,
}));

import { useDownloads } from "../../src/composables/useDownloads.js";
import type { Track } from "../../src/track/Track.js";

function track(id: string, exportFn: (p?: unknown) => Promise<void> = async () => {}): Track {
  return { id, type: "track", exportToDisk: exportFn } as unknown as Track;
}

beforeEach(() => {
  exportTorrentFilesMock.mockReset();
  exportPlaylistTracksMock.mockReset();
  exportSlskTrackMock.mockReset();
});

function setup(opts: {
  source?: string; magnet?: string; files?: Array<Record<string, unknown>>;
  currentPlaylist?: { tracks: Track[] } | null;
} = {}) {
  const selected = ref<Record<string, unknown> | null>(
    opts.source ? { id: "t", source: opts.source, name: "SelName" } : null,
  );
  const torrentMagnet = ref(opts.magnet ?? "");
  const files = ref(opts.files ?? []);
  const currentPlaylist = computed(() => opts.currentPlaylist ?? null);
  const api = useDownloads({ selected, torrentMagnet, files, currentPlaylist });
  return { api, selected, torrentMagnet, files };
}

describe("useDownloads — handleDownloadTrack (by origIdx)", () => {
  it("RT: invokes exportTorrentFiles with idx + label + magnet", () => {
    const { api } = setup({
      magnet: "magnet:?x",
      files: [{ origIdx: 3, path: "Album/01.mp3" }],
    });
    api.handleDownloadTrack(3);
    expect(exportTorrentFilesMock).toHaveBeenCalled();
    const call = exportTorrentFilesMock.mock.calls[0];
    expect(call?.[0]).toBe("magnet:?x");
    expect(call?.[1]).toEqual([3]);
  });

  it("SoulSeek: uses exportSlskTrack when selected.source=soulseek", () => {
    const { api } = setup({
      source: "soulseek",
      files: [{
        origIdx: 0, path: "A/a.mp3", slskUsername: "u", slskFilepath: "A/a.mp3", slskFilesize: 10,
      }],
    });
    api.handleDownloadTrack(0);
    expect(exportSlskTrackMock).toHaveBeenCalled();
    const call = exportSlskTrackMock.mock.calls[0];
    expect(call?.[0]).toMatchObject({ slskUsername: "u", slskFilepath: "A/a.mp3" });
  });

  it("RT RuTracker source attaches torrentId opts", () => {
    const { api, selected } = setup({ magnet: "m", files: [{ origIdx: 1, path: "a.mp3" }] });
    selected.value = { id: "TOPIC1", source: "rutracker" };
    api.handleDownloadTrack(1);
    const call = exportTorrentFilesMock.mock.calls[0];
    expect(call?.[3]).toMatchObject({ track: { source: "rutracker", torrentId: "TOPIC1" } });
  });
});

describe("useDownloads — handleDownloadTrackFromLike", () => {
  it("null-safe: no-op for null / missing magnet / fileIdx", () => {
    const { api } = setup();
    api.handleDownloadTrackFromLike(null as unknown as never);
    api.handleDownloadTrackFromLike({ source: "rutracker" } as unknown as never);
    expect(exportTorrentFilesMock).not.toHaveBeenCalled();
  });
  it("SoulSeek like routes to exportSlskTrack", () => {
    const { api } = setup();
    api.handleDownloadTrackFromLike({
      source: "soulseek",
      slskUsername: "u",
      slskFilepath: "a",
    } as unknown as never);
    expect(exportSlskTrackMock).toHaveBeenCalled();
  });
  it("RT like routes to exportTorrentFiles", () => {
    const { api } = setup();
    api.handleDownloadTrackFromLike({
      source: "rutracker",
      magnet: "m", fileIdx: 2, fileName: "01.mp3", torrentId: "42",
    } as unknown as never);
    expect(exportTorrentFilesMock).toHaveBeenCalled();
  });
});

describe("useDownloads — handleDownloadSlskTrack (Track instance)", () => {
  it("ignores non-Track", () => {
    const { api } = setup();
    api.handleDownloadSlskTrack({} as unknown as Track);
    expect(exportSlskTrackMock).not.toHaveBeenCalled();
  });
  it("calls track.exportToDisk with progress callback", () => {
    const fn = vi.fn();
    const { api } = setup();
    api.handleDownloadSlskTrack(track("x", fn));
    expect(fn).toHaveBeenCalled();
  });
});

describe("useDownloads — playlist + queue", () => {
  it("handleDownloadPlaylist null-safe", () => {
    const { api } = setup();
    api.handleDownloadPlaylist();
    expect(exportPlaylistTracksMock).not.toHaveBeenCalled();
  });
  it("handleDownloadPlaylist passes tracks", () => {
    const tracks = [track("a"), track("b")];
    const { api } = setup({ currentPlaylist: { tracks } });
    api.handleDownloadPlaylist();
    expect(exportPlaylistTracksMock).toHaveBeenCalledWith(tracks, expect.any(Function));
  });
  it("handleDownloadFromQueue skips when magnet/fileIdx missing", () => {
    const { api } = setup();
    api.handleDownloadFromQueue({ magnet: "", fileIdx: null } as unknown as never);
    api.handleDownloadFromQueue(null as unknown as never);
    expect(exportTorrentFilesMock).not.toHaveBeenCalled();
  });
  it("handleDownloadFromQueue invokes export with idx + label", () => {
    const { api } = setup();
    api.handleDownloadFromQueue({ magnet: "m", fileIdx: 7, fileName: "07 T.mp3" } as unknown as never);
    expect(exportTorrentFilesMock).toHaveBeenCalledWith("m", [7], expect.any(Array), expect.any(Object), expect.any(Function));
  });
});

describe("useDownloads — download all / album", () => {
  it("downloadAll routes to exportTorrentFiles for RT", () => {
    const { api } = setup({
      magnet: "m",
      files: [{ origIdx: 0, path: "a.mp3" }, { origIdx: 1, path: "b.txt" }],
    });
    api.handleDownloadAll();
    expect(exportTorrentFilesMock).toHaveBeenCalled();
    const call = exportTorrentFilesMock.mock.calls[0];
    expect(call?.[1]).toEqual([0]); // only audio
  });
  it("downloadAll routes to slsk batch for soulseek", async () => {
    const { api } = setup({
      source: "soulseek",
      files: [
        { origIdx: 0, path: "a.mp3", slskUsername: "u", slskFilepath: "a.mp3" },
        { origIdx: 1, path: "b.mp3", slskUsername: "u", slskFilepath: "b.mp3" },
      ],
    });
    exportSlskTrackMock.mockResolvedValue(undefined);
    api.handleDownloadAll();
    await Promise.resolve(); await Promise.resolve();
    expect(exportSlskTrackMock).toHaveBeenCalled();
  });
  it("downloadAlbum accepts explicit albumFiles", () => {
    const { api } = setup({ magnet: "m" });
    api.handleDownloadAlbum([
      { origIdx: 2, path: "one.mp3" },
      { origIdx: 3, path: "two.txt" },
    ]);
    const call = exportTorrentFilesMock.mock.calls[0];
    expect(call?.[1]).toEqual([2]);
    expect(call?.[3]).toMatchObject({ albumDirName: expect.any(String) });
  });
  it("downloadAlbum SLSK path", async () => {
    const { api } = setup({ source: "soulseek" });
    exportSlskTrackMock.mockResolvedValue(undefined);
    api.handleDownloadAlbum([{
      origIdx: 0, path: "a.mp3", slskUsername: "u", slskFilepath: "a.mp3",
    }]);
    await Promise.resolve(); await Promise.resolve();
    expect(exportSlskTrackMock).toHaveBeenCalled();
  });
});
