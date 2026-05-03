import { describe, it, expect, vi, beforeEach } from "vitest";
import "../_setup.js";

vi.mock("../../src/soulseek/coverCache.js", () => ({
  getSlskCoverReactive: vi.fn(() => null),
  getSlskCoverDataUrl: vi.fn(() => Promise.resolve(null)),
  peekSlskCover: vi.fn(() => undefined),
}));
vi.mock("../../src/stores/entities.js", () => ({
  getAlbum: vi.fn(() => null),
  entitiesVersion: { value: 0 },
}));

import { invoke } from "@tauri-apps/api/core";
import { message, open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { buildTrack } from "../../src/track/factory.js";
import type { TrackData } from "../../src/track/types.js";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const messageMock = message as unknown as ReturnType<typeof vi.fn>;
const openMock = open as unknown as ReturnType<typeof vi.fn>;
const listenMock = listen as unknown as ReturnType<typeof vi.fn>;

function slsk(overrides: Partial<TrackData> = {}): TrackData {
  return {
    type: "track",
    id: "slsk:t",
    title: "song.mp3",
    artist: "Alice",
    albumTitle: null,
    albumId: null,
    fileName: "song.mp3",
    format: "MP3",
    bitrate: 320,
    duration: 180,
    size: 5_000_000,
    sources: [{
      kind: "soulseek",
      refs: { slskUsername: "alice", slskFilepath: "music/song.mp3" },
      raw: { cover: null },
    }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SoulseekTrack.exportToDisk", () => {
  it("errors out early when track has no playback identity", async () => {
    const d = slsk();
    d.sources[0].refs = { slskUsername: "", slskFilepath: "" };
    const onProgress = vi.fn();
    await buildTrack(d).exportToDisk(onProgress);
    expect(messageMock).toHaveBeenCalledWith(
      expect.stringMatching(/SoulSeek/),
      expect.objectContaining({ kind: "error" }),
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("returns silently when user cancels the folder picker", async () => {
    openMock.mockResolvedValueOnce(null);
    const onProgress = vi.fn();
    await buildTrack(slsk()).exportToDisk(onProgress);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("saves the file and shows a success message", async () => {
    openMock.mockResolvedValueOnce("/tmp/out");
    const unlisten = vi.fn();
    listenMock.mockResolvedValueOnce(unlisten);
    invokeMock.mockResolvedValueOnce("/tmp/out/song.mp3");
    const onProgress = vi.fn();

    await buildTrack(slsk()).exportToDisk(onProgress);

    expect(invokeMock).toHaveBeenCalledWith("soulseek_export_file", {
      username: "alice",
      filepath: "music/song.mp3",
      filesize: 5_000_000,
      destDir: "/tmp/out",
      fileName: "song.mp3",
    });
    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("Сохранено: song.mp3"),
      expect.objectContaining({ title: "Скачивание" }),
    );
    expect(unlisten).toHaveBeenCalled();
    // onProgress called with preparing payload + final null
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "preparing" }));
    expect(onProgress).toHaveBeenLastCalledWith(null);
  });

  it("uses the first element when open returns an array", async () => {
    openMock.mockResolvedValueOnce(["/a", "/b"]);
    listenMock.mockResolvedValueOnce(() => {});
    invokeMock.mockResolvedValueOnce("/a/song.mp3");
    await buildTrack(slsk()).exportToDisk();
    expect(invokeMock).toHaveBeenCalledWith(
      "soulseek_export_file",
      expect.objectContaining({ destDir: "/a" }),
    );
  });

  it("surfaces cancellation as an info toast when error mentions 'остановлено'", async () => {
    openMock.mockResolvedValueOnce("/tmp/out");
    listenMock.mockResolvedValueOnce(() => {});
    invokeMock.mockRejectedValueOnce(new Error("Скачивание остановлено пользователем"));
    await buildTrack(slsk()).exportToDisk();
    expect(messageMock).toHaveBeenCalledWith(
      "Скачивание остановлено.",
      expect.objectContaining({ kind: "info" }),
    );
  });

  it("shows an error toast for generic failures", async () => {
    openMock.mockResolvedValueOnce("/tmp/out");
    listenMock.mockResolvedValueOnce(() => {});
    invokeMock.mockRejectedValueOnce(new Error("peer gone"));
    await buildTrack(slsk()).exportToDisk();
    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("peer gone"),
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("forwards listener payloads to onProgress", async () => {
    openMock.mockResolvedValueOnce("/tmp/out");
    listenMock.mockImplementationOnce((_event: string, cb: (ev: { payload: unknown }) => void) => {
      // Fire an event synchronously inside `listen` so the handler is called
      // before the caller awaits `invoke`.
      cb({ payload: { phase: "downloading", pct: 42 } });
      return Promise.resolve(() => {});
    });
    invokeMock.mockResolvedValueOnce("/tmp/out/song.mp3");

    const onProgress = vi.fn();
    await buildTrack(slsk()).exportToDisk(onProgress);

    expect(onProgress).toHaveBeenCalledWith({ phase: "downloading", pct: 42 });
  });

  it("falls back to 'track' when filepath has no basename AND no fileName", async () => {
    const d = slsk();
    d.sources[0].refs = { slskUsername: "alice", slskFilepath: "" } as {
      slskUsername: string;
      slskFilepath: string;
    };
    // hasPlaybackIdentity is false when filepath is empty — instead test a filepath
    // ending in a separator where pop() returns "".
    d.sources[0].refs = { slskUsername: "alice", slskFilepath: "music/" };
    d.fileName = "";
    openMock.mockResolvedValueOnce("/tmp/out");
    listenMock.mockResolvedValueOnce(() => {});
    invokeMock.mockResolvedValueOnce("/tmp/out/track");
    await buildTrack(d).exportToDisk();
    expect(invokeMock).toHaveBeenCalledWith(
      "soulseek_export_file",
      expect.objectContaining({ fileName: "track" }),
    );
  });
});
