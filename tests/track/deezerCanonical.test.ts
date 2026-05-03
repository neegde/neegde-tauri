import { beforeEach, describe, expect, it, vi } from "vitest";
import "../_setup.js";

const invokeMock = vi.fn();
const bumpEntitiesVersionMock = vi.fn();
const putTrackMock = vi.fn();
const appDebugLogMock = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("../../src/stores/entities.js", () => ({
  bumpEntitiesVersion: (...args: unknown[]) => bumpEntitiesVersionMock(...args),
}));

vi.mock("../../src/persistence/trackCache.js", () => ({
  putTrack: (...args: unknown[]) => putTrackMock(...args),
}));

vi.mock("../../src/appDebugLog.js", () => ({
  appDebugLog: (...args: unknown[]) => appDebugLogMock(...args),
}));

vi.mock("../../src/lib/RateLimitedFetchQueue.js", () => ({
  RateLimitedFetchQueue: class RateLimitedFetchQueue<TReq, TRes> {
    private readonly executor: (req: TReq) => Promise<TRes>;

    constructor(opts: { executor: (req: TReq) => Promise<TRes> }) {
      this.executor = opts.executor;
    }

    enqueue(req: TReq): Promise<TRes> {
      return this.executor(req);
    }
  },
}));

function makeTrack(id: string, artist: string, title: string) {
  const data = {
    type: "track" as const,
    id,
    title,
    artist,
    albumTitle: null as string | null,
  };
  return {
    id,
    get artist() {
      return data.artist;
    },
    get title() {
      return data.title;
    },
    toJSON() {
      return data;
    },
  };
}

async function flushTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("enrichTrackNames", () => {
  it("skips tracks with high confidence", async () => {
    const { enrichTrackNames } = await import("../../src/track/deezerCanonical.js");
    const { nameConfidence } = await import("../../src/track/factory.js");
    const track = makeTrack("t-high", "Artist", "Song");
    nameConfidence.set(track.id, "high");

    enrichTrackNames(track as never);
    await flushTasks();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(putTrackMock).not.toHaveBeenCalled();
  });

  it("applies canonical names for a matching Deezer hit", async () => {
    const { enrichTrackNames } = await import("../../src/track/deezerCanonical.js");
    const { nameConfidence } = await import("../../src/track/factory.js");
    const track = makeTrack("t-hit", "Artist", "Song");
    nameConfidence.set(track.id, "medium");
    invokeMock.mockResolvedValueOnce(JSON.stringify({
      data: [
        {
          title: "Song (Live)",
          artist: { name: "Artist" },
          album: { title: "Album", cover_medium: "https://img/cover.jpg" },
        },
      ],
    }));

    enrichTrackNames(track as never);
    await flushTasks();

    expect(invokeMock).toHaveBeenCalledWith("deezer_search", {
      query: "Artist Song",
      limit: 3,
    });
    expect(track.toJSON().title).toBe("Song (Live)");
    expect(track.toJSON().artist).toBe("Artist");
    expect(track.toJSON().albumTitle).toBe("Album");
    expect(nameConfidence.get(track.id)).toBe("high");
    expect(putTrackMock).toHaveBeenCalledWith(expect.objectContaining({
      id: "t-hit",
      artist: "Artist",
      title: "Song (Live)",
      albumTitle: "Album",
    }));
    expect(bumpEntitiesVersionMock).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched hits and leaves track untouched", async () => {
    const { enrichTrackNames } = await import("../../src/track/deezerCanonical.js");
    const { nameConfidence } = await import("../../src/track/factory.js");
    const track = makeTrack("t-mismatch", "Artist", "Song");
    nameConfidence.set(track.id, "low");
    invokeMock.mockResolvedValueOnce(JSON.stringify({
      data: [
        {
          title: "Completely Different",
          artist: { name: "Another Artist" },
          album: { title: "Other" },
        },
      ],
    }));

    enrichTrackNames(track as never);
    await flushTasks();

    expect(track.toJSON().title).toBe("Song");
    expect(track.toJSON().artist).toBe("Artist");
    expect(putTrackMock).not.toHaveBeenCalled();
    expect(bumpEntitiesVersionMock).not.toHaveBeenCalled();
  });

  it("uses cache for repeated artist/title query", async () => {
    const { enrichTrackNames } = await import("../../src/track/deezerCanonical.js");
    const { nameConfidence } = await import("../../src/track/factory.js");
    const first = makeTrack("t-cache-1", "Artist", "Song");
    const second = makeTrack("t-cache-2", "Artist", "Song");
    nameConfidence.set(first.id, "medium");
    nameConfidence.set(second.id, "medium");
    invokeMock.mockResolvedValueOnce(JSON.stringify({
      data: [
        {
          title: "Song",
          artist: { name: "Artist" },
          album: { title: "Album" },
        },
      ],
    }));

    enrichTrackNames(first as never);
    await flushTasks();
    enrichTrackNames(second as never);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(second.toJSON().albumTitle).toBe("Album");
    expect(putTrackMock).toHaveBeenCalledTimes(2);
  });

  it("skips lookup when title is too short", async () => {
    const { enrichTrackNames } = await import("../../src/track/deezerCanonical.js");
    const { nameConfidence } = await import("../../src/track/factory.js");
    const track = makeTrack("t-short", "Artist", "ab");
    nameConfidence.set(track.id, "medium");

    enrichTrackNames(track as never);
    await flushTasks();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(putTrackMock).not.toHaveBeenCalled();
  });

  it("handles non-JSON Deezer response as miss", async () => {
    const { enrichTrackNames } = await import("../../src/track/deezerCanonical.js");
    const { nameConfidence } = await import("../../src/track/factory.js");
    const track = makeTrack("t-bad-json", "Artist", "Song");
    nameConfidence.set(track.id, "low");
    invokeMock.mockResolvedValueOnce("not-json");

    enrichTrackNames(track as never);
    await flushTasks();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(track.toJSON().title).toBe("Song");
    expect(putTrackMock).not.toHaveBeenCalled();
  });

  it("dedupes concurrent in-flight requests for same key", async () => {
    const { enrichTrackNames } = await import("../../src/track/deezerCanonical.js");
    const { nameConfidence } = await import("../../src/track/factory.js");
    const first = makeTrack("t-pending-1", "Artist", "Song");
    const second = makeTrack("t-pending-2", "Artist", "Song");
    nameConfidence.set(first.id, "low");
    nameConfidence.set(second.id, "low");

    let resolveInvoke: ((v: string) => void) | null = null;
    invokeMock.mockReturnValueOnce(new Promise<string>((resolve) => {
      resolveInvoke = resolve;
    }));

    enrichTrackNames(first as never);
    enrichTrackNames(second as never);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    resolveInvoke?.(JSON.stringify({
      data: [{ title: "Song", artist: { name: "Artist" }, album: { title: "Album" } }],
    }));
    await flushTasks();

    expect(first.toJSON().albumTitle).toBe("Album");
    expect(second.toJSON().albumTitle).toBe("Album");
    expect(putTrackMock).toHaveBeenCalledTimes(2);
  });

  it("caches miss result and avoids re-fetch", async () => {
    const { enrichTrackNames } = await import("../../src/track/deezerCanonical.js");
    const { nameConfidence } = await import("../../src/track/factory.js");
    const first = makeTrack("t-miss-1", "Artist", "Song");
    const second = makeTrack("t-miss-2", "Artist", "Song");
    nameConfidence.set(first.id, "medium");
    nameConfidence.set(second.id, "medium");
    invokeMock.mockResolvedValueOnce(JSON.stringify({ data: [] }));

    enrichTrackNames(first as never);
    await flushTasks();
    enrichTrackNames(second as never);
    await flushTasks();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(putTrackMock).not.toHaveBeenCalled();
    expect(second.toJSON().albumTitle).toBeNull();
  });

  it("handles Deezer transport errors as miss", async () => {
    const { enrichTrackNames } = await import("../../src/track/deezerCanonical.js");
    const { nameConfidence } = await import("../../src/track/factory.js");
    const track = makeTrack("t-err", "Artist", "Song");
    nameConfidence.set(track.id, "medium");
    invokeMock.mockRejectedValueOnce(new Error("network down"));

    enrichTrackNames(track as never);
    await flushTasks();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(putTrackMock).not.toHaveBeenCalled();
  });

  it("rejects hit when artist does not match", async () => {
    const { enrichTrackNames } = await import("../../src/track/deezerCanonical.js");
    const { nameConfidence } = await import("../../src/track/factory.js");
    const track = makeTrack("t-artist-mismatch", "Known Artist", "Song");
    nameConfidence.set(track.id, "low");
    invokeMock.mockResolvedValueOnce(JSON.stringify({
      data: [{ title: "Song", artist: { name: "Other Artist" }, album: { title: "Album" } }],
    }));

    enrichTrackNames(track as never);
    await flushTasks();

    expect(track.toJSON().artist).toBe("Known Artist");
    expect(putTrackMock).not.toHaveBeenCalled();
  });

  it("rejects hit without artist/title payload", async () => {
    const { enrichTrackNames } = await import("../../src/track/deezerCanonical.js");
    const { nameConfidence } = await import("../../src/track/factory.js");
    const track = makeTrack("t-empty-hit", "Artist", "Song");
    nameConfidence.set(track.id, "medium");
    invokeMock.mockResolvedValueOnce(JSON.stringify({
      data: [{ title: "", artist: { name: "" }, album: { title: "Album" } }],
    }));

    enrichTrackNames(track as never);
    await flushTasks();

    expect(track.toJSON().title).toBe("Song");
    expect(putTrackMock).not.toHaveBeenCalled();
  });

  it("does nothing when both artist and title are empty", async () => {
    const { enrichTrackNames } = await import("../../src/track/deezerCanonical.js");
    const { nameConfidence } = await import("../../src/track/factory.js");
    const track = makeTrack("t-empty", "", "");
    nameConfidence.set(track.id, "medium");

    enrichTrackNames(track as never);
    await flushTasks();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(putTrackMock).not.toHaveBeenCalled();
  });
});
