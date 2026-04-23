import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub localStorage (Node env has none).
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
} as Storage;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn(), open: vi.fn() }));
vi.mock("../soulseek/coverCache.js", () => ({
  getSlskCoverReactive: vi.fn(() => null),
  getSlskCoverDataUrl: vi.fn(),
  peekSlskCover: vi.fn(() => undefined),
}));
vi.mock("../rutracker/coverCache.js", () => ({
  getCoverReactive: vi.fn(() => null),
  getRutrackerCoverDataUrl: vi.fn(),
  peekRutrackerCover: vi.fn(() => undefined),
}));
vi.mock("../stores/entities.js", () => ({
  getAlbum: vi.fn(() => null),
  entitiesVersion: { value: 0 },
}));

import { putTrack, hydrateTrack, clearTrackCache, hasTrack, loadTrackCache } from "./trackCache.js";
import { loadLikesSnapshot, saveLikesSnapshot, LIKES_STORAGE_KEY } from "./likes.js";
import { loadPlaylistsSnapshot, savePlaylistsSnapshot } from "./playlists.js";
import { loadQueueSnapshot, saveQueueSnapshot, clearQueueSnapshot } from "./queue.js";
import { migrateLegacyStorage } from "./migrateLegacy.js";
import { SoulseekTrack } from "../track/SoulseekTrack.js";
import { RutrackerTrack } from "../track/RutrackerTrack.js";
import type { TrackData } from "../track/types.js";

beforeEach(() => {
  store.clear();
  clearTrackCache();
});

function slsk(id: string, user: string, filepath: string): TrackData {
  return {
    type: "track",
    id,
    title: filepath,
    artist: "A",
    albumTitle: null,
    albumId: null,
    fileName: filepath,
    format: null,
    bitrate: null,
    duration: null,
    size: 1000,
    sources: [{ kind: "soulseek", refs: { slskUsername: user, slskFilepath: filepath }, raw: { cover: null } }],
  };
}

function rt(id: string, topicId: string, fileIdx: number): TrackData {
  return {
    type: "track",
    id,
    title: `track ${fileIdx}`,
    artist: null,
    albumTitle: "Album",
    albumId: null,
    fileName: `track${fileIdx}.mp3`,
    format: null,
    bitrate: null,
    duration: null,
    size: null,
    sources: [{
      kind: "rutracker",
      refs: { topicId, magnet: "magnet:?xt=urn:btih:ABC", fileIdx, coverFileIdx: null, albumDirPath: null },
    }],
  };
}

// ── trackCache ──────────────────────────────────────────────────────────────

describe("trackCache", () => {
  it("putTrack + hydrateTrack round-trip preserves class identity", async () => {
    const data = slsk("slsk:1", "alice", "a/b.mp3");
    putTrack(data);
    expect(hasTrack("slsk:1")).toBe(true);
    const t = hydrateTrack("slsk:1");
    expect(t).toBeInstanceOf(SoulseekTrack);
    expect(t?.id).toBe("slsk:1");
  });

  it("loads persisted entries from localStorage on boot", () => {
    const data = rt("rt:1", "12345", 2);
    store.set("neegde.trackCache.v1", JSON.stringify({ [data.id]: data }));
    loadTrackCache();
    expect(hasTrack("rt:1")).toBe(true);
    expect(hydrateTrack("rt:1")).toBeInstanceOf(RutrackerTrack);
  });

  it("debounced save ends up in localStorage", async () => {
    const data = slsk("slsk:persist", "u", "p");
    putTrack(data);
    await new Promise((r) => setTimeout(r, 300));
    const raw = store.get("neegde.trackCache.v1");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)[data.id]).toMatchObject({ id: "slsk:persist" });
  });
});

// ── likes / playlists / queue snapshots ─────────────────────────────────────

describe("likes snapshot", () => {
  it("default is empty", () => {
    expect(loadLikesSnapshot()).toEqual({ trackIds: [], albumIds: [], likedAt: {} });
  });

  it("round-trips", () => {
    const snap = { trackIds: ["a", "b"], albumIds: ["x"], likedAt: { a: 1, b: 2, x: 3 } };
    saveLikesSnapshot(snap);
    expect(loadLikesSnapshot()).toEqual(snap);
  });

  it("rejects malformed entries", () => {
    store.set(LIKES_STORAGE_KEY, JSON.stringify({ trackIds: ["ok", 42, null], likedAt: "bogus" }));
    const loaded = loadLikesSnapshot();
    expect(loaded.trackIds).toEqual(["ok"]);
    expect(loaded.albumIds).toEqual([]);
    expect(loaded.likedAt).toEqual({});
  });
});

describe("playlists snapshot", () => {
  it("round-trips", () => {
    savePlaylistsSnapshot([
      { id: "pl-1", title: "A", coverUrl: null, createdAt: 1, updatedAt: 2, trackIds: ["t1", "t2"] },
    ]);
    expect(loadPlaylistsSnapshot()).toHaveLength(1);
    expect(loadPlaylistsSnapshot()[0]?.trackIds).toEqual(["t1", "t2"]);
  });
});

describe("queue snapshot", () => {
  it("clamps pos to valid range", () => {
    saveQueueSnapshot({ trackIds: ["a", "b", "c"], pos: 99 });
    expect(loadQueueSnapshot().pos).toBe(2);
  });

  it("zero-length queue resets pos", () => {
    saveQueueSnapshot({ trackIds: [], pos: 5 });
    expect(loadQueueSnapshot()).toEqual({ trackIds: [], pos: 0 });
  });

  it("clear wipes snapshot", () => {
    saveQueueSnapshot({ trackIds: ["a"], pos: 0 });
    clearQueueSnapshot();
    expect(loadQueueSnapshot().trackIds).toEqual([]);
  });
});

// ── Legacy migration ───────────────────────────────────────────────────────

describe("migrateLegacyStorage", () => {
  it("converts v1 likes into v2 trackIds + trackCache", () => {
    store.set("neegde.likes", JSON.stringify({
      "track:soulseek:slskuser|music/a.mp3": {
        id: "track:soulseek:slskuser|music/a.mp3",
        type: "track",
        source: "soulseek",
        slskUsername: "slskuser",
        slskFilepath: "music/a.mp3",
        slskFilesize: 12345,
        fileName: "music/a.mp3",
        artist: "X",
        addedAt: 42,
      },
      "track:rutracker:topic123:5": {
        id: "track:rutracker:topic123:5",
        type: "track",
        source: "rutracker",
        magnet: "magnet:?xt=urn:btih:FFF",
        torrentId: "topic123",
        fileIdx: 5,
        fileName: "05.song.mp3",
        torrentName: "Artist - Album",
        artist: "Artist",
        addedAt: 100,
      },
    }));

    migrateLegacyStorage();

    const likes = loadLikesSnapshot();
    expect(likes.trackIds).toContain("track:soulseek:slskuser|music/a.mp3");
    expect(likes.trackIds).toContain("track:rutracker:topic123:5");
    expect(likes.likedAt["track:soulseek:slskuser|music/a.mp3"]).toBe(42);

    expect(hydrateTrack("track:soulseek:slskuser|music/a.mp3")).toBeInstanceOf(SoulseekTrack);
    expect(hydrateTrack("track:rutracker:topic123:5")).toBeInstanceOf(RutrackerTrack);
  });

  it("does not clobber existing v2 likes", () => {
    saveLikesSnapshot({ trackIds: ["existing"], albumIds: [], likedAt: { existing: 1 } });
    store.set("neegde.likes", JSON.stringify({
      "x": { id: "x", type: "track", source: "soulseek", slskUsername: "u", slskFilepath: "f" },
    }));

    migrateLegacyStorage();

    expect(loadLikesSnapshot().trackIds).toEqual(["existing"]);
  });

  it("is idempotent", () => {
    store.set("neegde.likes", JSON.stringify({
      "x": { id: "x", type: "track", source: "soulseek", slskUsername: "u", slskFilepath: "f", addedAt: 1 },
    }));
    migrateLegacyStorage();
    const first = loadLikesSnapshot();
    migrateLegacyStorage();
    const second = loadLikesSnapshot();
    expect(second).toEqual(first);
  });
});
