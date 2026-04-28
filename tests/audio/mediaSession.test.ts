import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";

// Cover resolvers — mock to keep the test hermetic.
vi.mock("../../src/torrent/torrentImageCache.js", () => ({
  peekTorrentImage: vi.fn(() => undefined),
  getTorrentImageDataUrl: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../../src/rutracker/search.js", () => ({
  peekRutrackerCover: vi.fn(() => undefined),
  getRutrackerCoverDataUrl: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../../src/soulseek/coverCache.js", () => ({
  getSlskCoverReactive: vi.fn(() => null),
  getSlskCoverDataUrl: vi.fn(() => Promise.resolve(null)),
}));

import {
  MediaSessionManager,
  mediaSessionManager,
  setMediaSessionApi,
  installMediaSessionHandlers,
  clearMediaSessionHandlers,
  reaffirmTrackSkipHandlers,
  syncMediaSessionMetadata,
  syncMediaSessionPlaybackState,
  syncMediaSessionPositionState,
  clearMediaSessionPresentation,
  type MediaSessionApi,
} from "../../src/audio/mediaSession.js";
import * as torrentImageCache from "../../src/torrent/torrentImageCache.js";
import * as rutrackerSearch from "../../src/rutracker/search.js";
import * as slskCover from "../../src/soulseek/coverCache.js";

const peekTorrentMock = torrentImageCache.peekTorrentImage as unknown as ReturnType<typeof vi.fn>;
const getTorrentMock = torrentImageCache.getTorrentImageDataUrl as unknown as ReturnType<typeof vi.fn>;
const peekRtMock = rutrackerSearch.peekRutrackerCover as unknown as ReturnType<typeof vi.fn>;
const getRtMock = rutrackerSearch.getRutrackerCoverDataUrl as unknown as ReturnType<typeof vi.fn>;
const getSlskReactiveMock = slskCover.getSlskCoverReactive as unknown as ReturnType<typeof vi.fn>;
const getSlskDataUrlMock = slskCover.getSlskCoverDataUrl as unknown as ReturnType<typeof vi.fn>;

// Minimal mediaSession stub — jsdom doesn't provide one.
type Stub = {
  metadata: MediaMetadata | null;
  playbackState: MediaSessionPlaybackState;
  setActionHandler: ReturnType<typeof vi.fn>;
  setPositionState: ReturnType<typeof vi.fn>;
};

function fakeMediaSession(): Stub {
  const stub: Stub = {
    metadata: null,
    playbackState: "none",
    setActionHandler: vi.fn(),
    setPositionState: vi.fn(),
  };
  // @ts-expect-error — navigator is read-only in lib dom, but we patch in tests.
  globalThis.navigator.mediaSession = stub as unknown as MediaSession;
  if (typeof globalThis.MediaMetadata === "undefined") {
    (globalThis as unknown as { MediaMetadata: typeof MediaMetadata }).MediaMetadata =
      class { constructor(public init: MediaMetadataInit) {} } as unknown as typeof MediaMetadata;
  }
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeMediaSession();
  // Reset singleton state by calling clear so every test starts clean.
  mediaSessionManager.clear();
});

describe("MediaSessionManager — install / clear lifecycle", () => {
  it("install binds all action handlers", () => {
    const stub = fakeMediaSession();
    installMediaSessionHandlers();
    const bound = stub.setActionHandler.mock.calls.map((c) => c[0]);
    for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"]) {
      expect(bound).toContain(action);
    }
  });

  it("install is idempotent (no double-bind)", () => {
    const stub = fakeMediaSession();
    installMediaSessionHandlers();
    const before = stub.setActionHandler.mock.calls.length;
    installMediaSessionHandlers();
    expect(stub.setActionHandler.mock.calls.length).toBe(before);
  });

  it("clear unbinds all action handlers (sets each to null)", () => {
    const stub = fakeMediaSession();
    installMediaSessionHandlers();
    stub.setActionHandler.mockClear();
    clearMediaSessionHandlers();
    const nullSetCalls = stub.setActionHandler.mock.calls
      .filter((c) => c[1] === null)
      .map((c) => c[0]);
    expect(nullSetCalls).toContain("play");
    expect(nullSetCalls).toContain("pause");
    expect(nullSetCalls).toContain("previoustrack");
    expect(nullSetCalls).toContain("nexttrack");
    expect(nullSetCalls).toContain("seekto");
  });

  it("clear is a noop when not installed", () => {
    const stub = fakeMediaSession();
    // Don't install.
    clearMediaSessionHandlers();
    expect(stub.setActionHandler).not.toHaveBeenCalled();
  });

  it("install rolls back on exception; flag stays false", () => {
    const stub = fakeMediaSession();
    stub.setActionHandler.mockImplementationOnce(() => {
      // First call (play handler) is fine.
    }).mockImplementationOnce(() => {
      throw new Error("denied");
    });
    const mgr = new MediaSessionManager();
    mgr.install();
    // install caught the exception. clear should be a no-op since installed flag
    // was never flipped.
    stub.setActionHandler.mockClear();
    mgr.clear();
    expect(stub.setActionHandler).not.toHaveBeenCalled();
  });
});

describe("MediaSessionManager — api delegation", () => {
  it("setApi wires play/pause to underlying functions", () => {
    const stub = fakeMediaSession();
    const api: MediaSessionApi = {
      play: vi.fn(), pause: vi.fn(), prev: vi.fn(), next: vi.fn(),
      seek: vi.fn(), seekRelative: vi.fn(),
    };
    setMediaSessionApi(api);
    installMediaSessionHandlers();
    const playHandler = stub.setActionHandler.mock.calls.find((c) => c[0] === "play")?.[1];
    const pauseHandler = stub.setActionHandler.mock.calls.find((c) => c[0] === "pause")?.[1];
    playHandler?.();
    pauseHandler?.();
    expect(api.play).toHaveBeenCalled();
    expect(api.pause).toHaveBeenCalled();
  });

  it("seekto handler reads seekTime from event detail", () => {
    const stub = fakeMediaSession();
    const api: MediaSessionApi = {
      play: vi.fn(), pause: vi.fn(), prev: vi.fn(), next: vi.fn(),
      seek: vi.fn(), seekRelative: vi.fn(),
    };
    setMediaSessionApi(api);
    installMediaSessionHandlers();
    const seekTo = stub.setActionHandler.mock.calls.find((c) => c[0] === "seekto")?.[1];
    seekTo?.({ seekTime: 42 });
    expect(api.seek).toHaveBeenCalledWith(42);
    seekTo?.({ seekTime: undefined });
    expect(api.seek).toHaveBeenCalledTimes(1);
  });

  it("non-Mac seekforward/back use seekRelative with offset", () => {
    const stub = fakeMediaSession();
    const originalUA = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", { value: "Windows NT", configurable: true });
    const api: MediaSessionApi = {
      play: vi.fn(), pause: vi.fn(), prev: vi.fn(), next: vi.fn(),
      seek: vi.fn(), seekRelative: vi.fn(),
    };
    setMediaSessionApi(api);
    const mgr = new MediaSessionManager();
    mgr.setApi(api);
    mgr.install();
    const seekForward = stub.setActionHandler.mock.calls.find((c) => c[0] === "seekforward")?.[1];
    const seekBackward = stub.setActionHandler.mock.calls.find((c) => c[0] === "seekbackward")?.[1];
    seekForward?.({ seekOffset: 15 });
    expect(api.seekRelative).toHaveBeenCalledWith(15);
    seekBackward?.({ seekOffset: 20 });
    expect(api.seekRelative).toHaveBeenCalledWith(-20);
    seekForward?.({});
    expect(api.seekRelative).toHaveBeenLastCalledWith(10); // default 10s
    Object.defineProperty(navigator, "userAgent", { value: originalUA, configurable: true });
  });

  it("Mac UA routes seekforward/back to next/prev", () => {
    const stub = fakeMediaSession();
    const originalUA = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Mac OS)", configurable: true });
    const api: MediaSessionApi = {
      play: vi.fn(), pause: vi.fn(), prev: vi.fn(), next: vi.fn(),
      seek: vi.fn(), seekRelative: vi.fn(),
    };
    const mgr = new MediaSessionManager();
    mgr.setApi(api);
    mgr.install();
    const seekForward = stub.setActionHandler.mock.calls.find((c) => c[0] === "seekforward")?.[1];
    const seekBackward = stub.setActionHandler.mock.calls.find((c) => c[0] === "seekbackward")?.[1];
    seekForward?.({});
    seekBackward?.({});
    expect(api.next).toHaveBeenCalled();
    expect(api.prev).toHaveBeenCalled();
    Object.defineProperty(navigator, "userAgent", { value: originalUA, configurable: true });
  });

  it("wrapped handlers swallow thrown exceptions (console.warn)", () => {
    const stub = fakeMediaSession();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api: MediaSessionApi = {
      play: () => { throw new Error("boom"); },
      pause: vi.fn(), prev: vi.fn(), next: vi.fn(),
      seek: vi.fn(), seekRelative: vi.fn(),
    };
    setMediaSessionApi(api);
    installMediaSessionHandlers();
    const playHandler = stub.setActionHandler.mock.calls.find((c) => c[0] === "play")?.[1];
    expect(() => playHandler?.()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("MediaSessionManager — syncMetadata", () => {
  it("clears metadata for null track without magnet/soulseek", async () => {
    const stub = fakeMediaSession();
    stub.metadata = new (globalThis.MediaMetadata as typeof MediaMetadata)({ title: "old" });
    await syncMediaSessionMetadata(null);
    expect(stub.metadata).toBe(null);
  });

  it("sets metadata with track title + artist", async () => {
    const stub = fakeMediaSession();
    await syncMediaSessionMetadata({
      magnet: "magnet:A",
      fileIdx: 0,
      source: "rutracker",
      fileName: "01. Song.mp3",
      artist: "Artist",
      torrentName: "Artist - Album",
    });
    const init = (stub.metadata as unknown as { init: MediaMetadataInit }).init;
    expect(init.title).toBeTruthy();
    expect(init.artist).toBe("Artist");
  });

  it("uses enriched metadata when provided", async () => {
    const stub = fakeMediaSession();
    await syncMediaSessionMetadata(
      { magnet: "magnet:A", fileIdx: 0, source: "rutracker", fileName: "x.mp3" },
      { artist: "E-artist", title: "E-title", album: "E-album", coverUrl: "data:cover" },
    );
    const init = (stub.metadata as unknown as { init: MediaMetadataInit }).init;
    expect(init.title).toBe("E-title");
    expect(init.artist).toBe("E-artist");
    expect(init.album).toBe("E-album");
    expect(init.artwork?.[0]?.src).toBe("data:cover");
  });

  it("SLSK cover path: uses reactive cache hit", async () => {
    const stub = fakeMediaSession();
    getSlskReactiveMock.mockReturnValueOnce("data:slsk-cache");
    await syncMediaSessionMetadata({
      source: "soulseek",
      slskFilepath: "folder/song.mp3",
      slskFolderCoverUsername: "u",
      slskFolderCoverFilepath: "folder/cover.jpg",
      fileName: "song.mp3",
    });
    const init = (stub.metadata as unknown as { init: MediaMetadataInit }).init;
    expect(init.artwork?.[0]?.src).toBe("data:slsk-cache");
  });

  it("SLSK cover path: falls back to data URL fetcher on cache miss", async () => {
    const stub = fakeMediaSession();
    getSlskReactiveMock.mockReturnValue(null);
    getSlskDataUrlMock.mockResolvedValueOnce("data:slsk-fetched");
    await syncMediaSessionMetadata({
      source: "soulseek",
      slskFilepath: "folder/song.mp3",
      slskFolderCoverUsername: "u",
      slskFolderCoverFilepath: "folder/cover.jpg",
      slskFolderCoverSize: 1000,
      fileName: "song.mp3",
    });
    expect(getSlskDataUrlMock).toHaveBeenCalledWith("u", "folder/cover.jpg", 1000);
    const init = (stub.metadata as unknown as { init: MediaMetadataInit }).init;
    expect(init.artwork?.[0]?.src).toBe("data:slsk-fetched");
  });

  it("torrent cover path: uses peek cache hit by fileIdx", async () => {
    const stub = fakeMediaSession();
    peekTorrentMock.mockReturnValueOnce("data:torrent-peek");
    await syncMediaSessionMetadata({
      magnet: "magnet:A",
      fileIdx: 0,
      source: "rutracker",
      coverFileIdx: 3,
      fileName: "x.mp3",
    });
    const init = (stub.metadata as unknown as { init: MediaMetadataInit }).init;
    expect(init.artwork?.[0]?.src).toBe("data:torrent-peek");
  });

  it("torrent cover fetch rejection falls through silently (no artwork)", async () => {
    const stub = fakeMediaSession();
    peekTorrentMock.mockReturnValue(undefined);
    getTorrentMock.mockRejectedValueOnce(new Error("no peers"));
    await syncMediaSessionMetadata({
      magnet: "magnet:A",
      fileIdx: 0,
      source: "rutracker",
      coverFileIdx: 3,
      fileName: "x.mp3",
    });
    const init = (stub.metadata as unknown as { init: MediaMetadataInit }).init;
    expect(init.artwork ?? []).toHaveLength(0);
  });

  it("RT cover path via topicId cache hit", async () => {
    const stub = fakeMediaSession();
    peekRtMock.mockReturnValueOnce("data:rt-peek");
    await syncMediaSessionMetadata({
      magnet: "magnet:A",
      fileIdx: 0,
      source: "rutracker",
      torrentId: "42",
      fileName: "x.mp3",
    });
    const init = (stub.metadata as unknown as { init: MediaMetadataInit }).init;
    expect(init.artwork?.[0]?.src).toBe("data:rt-peek");
  });

  it("noops when navigator.mediaSession is absent", async () => {
    // @ts-expect-error — test-only
    navigator.mediaSession = undefined;
    await expect(syncMediaSessionMetadata({ magnet: "x", fileIdx: 0, fileName: "y.mp3" })).resolves.toBeUndefined();
  });
});

describe("MediaSessionManager — playback + position state", () => {
  it("syncPlaybackState writes playing/paused", () => {
    const stub = fakeMediaSession();
    syncMediaSessionPlaybackState(true);
    expect(stub.playbackState).toBe("playing");
    syncMediaSessionPlaybackState(false);
    expect(stub.playbackState).toBe("paused");
  });

  it("syncPositionState writes valid state", () => {
    const stub = fakeMediaSession();
    syncMediaSessionPositionState(200, 42, 1);
    expect(stub.setPositionState).toHaveBeenCalledWith({ duration: 200, playbackRate: 1, position: 42 });
  });

  it("syncPositionState skips invalid duration/position", () => {
    const stub = fakeMediaSession();
    syncMediaSessionPositionState(-10, 0);
    syncMediaSessionPositionState(NaN, 0);
    syncMediaSessionPositionState(100, NaN);
    expect(stub.setPositionState).not.toHaveBeenCalled();
  });

  it("syncPositionState clamps position into [0, duration]", () => {
    const stub = fakeMediaSession();
    syncMediaSessionPositionState(100, 500);
    expect(stub.setPositionState).toHaveBeenCalledWith({ duration: 100, playbackRate: 1, position: 100 });
    stub.setPositionState.mockClear();
    syncMediaSessionPositionState(100, -50);
    expect(stub.setPositionState).toHaveBeenCalledWith({ duration: 100, playbackRate: 1, position: 0 });
  });

  it("syncPositionState default rate is 1 when non-finite", () => {
    const stub = fakeMediaSession();
    syncMediaSessionPositionState(100, 10, NaN);
    expect(stub.setPositionState).toHaveBeenCalledWith(expect.objectContaining({ playbackRate: 1 }));
  });

  it("clearPresentation resets metadata + state", () => {
    const stub = fakeMediaSession();
    stub.metadata = new (globalThis.MediaMetadata as typeof MediaMetadata)({ title: "old" });
    stub.playbackState = "playing";
    clearMediaSessionPresentation();
    expect(stub.metadata).toBe(null);
    expect(stub.playbackState).toBe("none");
    expect(stub.setPositionState).toHaveBeenCalledWith(null);
  });
});

describe("MediaSessionManager — reaffirm", () => {
  it("reaffirmSkipHandlers is a noop before install", () => {
    const stub = fakeMediaSession();
    reaffirmTrackSkipHandlers();
    expect(stub.setActionHandler).not.toHaveBeenCalled();
  });

  it("reaffirm re-binds prev/next after install", () => {
    const stub = fakeMediaSession();
    installMediaSessionHandlers();
    stub.setActionHandler.mockClear();
    reaffirmTrackSkipHandlers();
    const actions = stub.setActionHandler.mock.calls.map((c) => c[0]);
    expect(actions).toContain("previoustrack");
    expect(actions).toContain("nexttrack");
  });
});
