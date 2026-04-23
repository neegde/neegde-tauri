import { describe, it, expect, beforeEach, vi } from "vitest";

// localStorage stub
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

import { registerEntity, clearEntities, getTrack, getAlbum } from "./entities.js";
import {
  likedTrackIds,
  likedTracks,
  toggleLikeTrack,
  seedLikesFromSnapshot,
  playlists,
  createPlaylist,
  addTrackToPlaylist,
  getPlaylistTracks,
  removeTrackFromPlaylist,
  seedPlaylistsFromSnapshot,
} from "./library.js";
import {
  queueIds,
  queuePos,
  nowPlayingTrack,
  nextTrack,
  hasPrev,
  hasNext,
  replaceQueue,
  enqueueTrack,
  removeAt,
  clear as clearQueue,
  repeatMode,
  setRepeat,
  seedQueueFromSnapshot,
} from "./queue.js";
import { clearTrackCache, hasTrack } from "../persistence/trackCache.js";
import { loadLikesSnapshot } from "../persistence/likes.js";
import { loadQueueSnapshot } from "../persistence/queue.js";
import { loadPlaylistsSnapshot } from "../persistence/playlists.js";
import { buildTrack } from "../track/factory.js";
import { SoulseekTrack } from "../track/SoulseekTrack.js";
import type { TrackData } from "../track/types.js";
import type { AlbumData } from "./entities.js";

function slsk(id: string): TrackData {
  return {
    type: "track",
    id,
    title: `t-${id}`,
    artist: "A",
    albumTitle: null,
    albumId: null,
    fileName: `${id}.mp3`,
    format: null,
    bitrate: null,
    duration: null,
    size: 1000,
    sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: `${id}.mp3` }, raw: { cover: null } }],
  };
}

beforeEach(() => {
  store.clear();
  clearTrackCache();
  clearEntities();
  queueIds.value = [];
  queuePos.value = 0;
  repeatMode.value = "off";
  likedTrackIds.value = new Set();
  playlists.value = [];
});

// ── entities registry ──────────────────────────────────────────────────────

describe("entities registry", () => {
  it("normalizes plain TrackData to Track class instance", () => {
    registerEntity(slsk("x"));
    const t = getTrack("x");
    expect(t).toBeInstanceOf(SoulseekTrack);
    expect(t?.title).toBe("t-x");
  });

  it("passes through Track instance untouched", () => {
    const t = buildTrack(slsk("y"));
    registerEntity(t);
    expect(getTrack("y")).toBe(t);
  });

  it("auto-pushes registered track into trackCache", () => {
    registerEntity(slsk("z"));
    expect(hasTrack("z")).toBe(true);
  });

  it("getAlbum returns album entity; getTrack returns null for album", () => {
    const album: AlbumData = { type: "album", id: "alb", title: "A", artist: null, trackIds: [] };
    registerEntity(album);
    expect(getAlbum("alb")).toBe(album);
    expect(getTrack("alb")).toBe(null);
  });
});

// ── likes store ────────────────────────────────────────────────────────────

describe("library / likes", () => {
  it("toggleLikeTrack adds, second call removes", () => {
    const t = buildTrack(slsk("x"));
    expect(toggleLikeTrack(t)).toBe(true);
    expect(likedTrackIds.value.has("x")).toBe(true);
    expect(toggleLikeTrack(t)).toBe(false);
    expect(likedTrackIds.value.has("x")).toBe(false);
  });

  it("likedTracks reflects insertion order by recency desc", () => {
    const a = buildTrack(slsk("a"));
    const b = buildTrack(slsk("b"));
    toggleLikeTrack(a);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1000);
    toggleLikeTrack(b);
    vi.useRealTimers();
    expect(likedTracks.value.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("persists to v2 snapshot on toggle", () => {
    const t = buildTrack(slsk("persist"));
    toggleLikeTrack(t);
    const snap = loadLikesSnapshot();
    expect(snap.trackIds).toContain("persist");
    expect(snap.likedAt.persist).toBeGreaterThan(0);
  });

  it("seedLikesFromSnapshot populates state", () => {
    seedLikesFromSnapshot({
      trackIds: ["a", "b"],
      albumIds: [],
      likedAt: { a: 100, b: 200 },
    });
    expect(likedTrackIds.value.size).toBe(2);
  });
});

// ── playlist store ─────────────────────────────────────────────────────────

describe("library / playlists", () => {
  it("create / add / remove round-trip", () => {
    const pl = createPlaylist("My PL");
    const t = buildTrack(slsk("x"));
    addTrackToPlaylist(pl.id, t);
    expect(getPlaylistTracks(pl.id).map((x) => x.id)).toEqual(["x"]);
    removeTrackFromPlaylist(pl.id, "x");
    expect(getPlaylistTracks(pl.id)).toEqual([]);
  });

  it("persists across restart via snapshot", () => {
    const pl = createPlaylist("A");
    addTrackToPlaylist(pl.id, buildTrack(slsk("t1")));
    const snap = loadPlaylistsSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.trackIds).toEqual(["t1"]);
  });

  it("seedPlaylistsFromSnapshot replaces state", () => {
    seedPlaylistsFromSnapshot([
      { id: "P", title: "seeded", coverUrl: null, createdAt: 0, updatedAt: 0, trackIds: ["a"] },
    ]);
    expect(playlists.value).toHaveLength(1);
  });

  it("addTrackToPlaylist is dedup'd", () => {
    const pl = createPlaylist("D");
    const t = buildTrack(slsk("dup"));
    addTrackToPlaylist(pl.id, t);
    addTrackToPlaylist(pl.id, t);
    expect(getPlaylistTracks(pl.id)).toHaveLength(1);
  });
});

// ── queue store ────────────────────────────────────────────────────────────

describe("queue", () => {
  it("replaceQueue + nowPlayingTrack", () => {
    replaceQueue([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    expect(queueIds.value).toEqual(["a", "b"]);
    expect(queuePos.value).toBe(1);
    expect(nowPlayingTrack.value?.id).toBe("b");
  });

  it("nextTrack respects repeat=all at end", () => {
    replaceQueue([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    expect(nextTrack.value).toBe(null);
    setRepeat("all");
    expect(nextTrack.value?.id).toBe("a");
  });

  it("hasPrev / hasNext", () => {
    replaceQueue([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 1);
    expect(hasPrev.value).toBe(true);
    expect(hasNext.value).toBe(true);
    queuePos.value = 2;
    expect(hasNext.value).toBe(false);
  });

  it("removeAt shifts position correctly", () => {
    replaceQueue([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 1);
    removeAt(0);
    expect(queueIds.value).toEqual(["b", "c"]);
    expect(queuePos.value).toBe(0);
  });

  it("removeAt current track clamps pos to last", () => {
    replaceQueue([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    removeAt(1);
    expect(queueIds.value).toEqual(["a"]);
    expect(queuePos.value).toBe(0);
  });

  it("enqueueTrack appends", () => {
    replaceQueue([buildTrack(slsk("a"))], 0);
    enqueueTrack(buildTrack(slsk("b")));
    expect(queueIds.value).toEqual(["a", "b"]);
  });

  it("clear wipes", () => {
    replaceQueue([buildTrack(slsk("a"))], 0);
    clearQueue();
    expect(queueIds.value).toEqual([]);
    expect(queuePos.value).toBe(0);
  });

  it("persists across restart via snapshot", () => {
    replaceQueue([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    const snap = loadQueueSnapshot();
    expect(snap.trackIds).toEqual(["a", "b"]);
    expect(snap.pos).toBe(1);
  });

  it("seedQueueFromSnapshot clamps pos", () => {
    seedQueueFromSnapshot({ trackIds: ["a", "b"], pos: 99 });
    expect(queuePos.value).toBe(1);
  });

  it("nowPlayingTrack hydrates from trackCache when registry lacks the id", () => {
    // Clear registry but keep cache — simulates post-restart before registry seed.
    const data = slsk("cached");
    registerEntity(data);
    clearEntities();
    seedQueueFromSnapshot({ trackIds: ["cached"], pos: 0 });
    expect(nowPlayingTrack.value?.id).toBe("cached");
  });
});
