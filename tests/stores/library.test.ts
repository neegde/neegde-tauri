import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

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
} from "../../src/stores/library.js";
import { clearEntities } from "../../src/stores/entities.js";
import { clearTrackCache } from "../../src/persistence/trackCache.js";
import { loadLikesSnapshot } from "../../src/persistence/likes.js";
import { loadPlaylistsSnapshot } from "../../src/persistence/playlists.js";
import { buildTrack } from "../../src/track/factory.js";
import type { TrackData } from "../../src/track/types.js";

function slsk(id: string): TrackData {
  return {
    type: "track", id, title: id, artist: "A", albumTitle: null, albumId: null,
    fileName: `${id}.mp3`, format: null, bitrate: null, duration: null, size: 1000,
    sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: `${id}.mp3` }, raw: { cover: null } }],
  };
}

beforeEach(() => {
  fakeLocalStorage.clear();
  clearTrackCache();
  clearEntities();
  likedTrackIds.value = new Set();
  playlists.value = [];
});

describe("likes store", () => {
  it("toggleLikeTrack adds, then removes", () => {
    const t = buildTrack(slsk("x"));
    expect(toggleLikeTrack(t)).toBe(true);
    expect(likedTrackIds.value.has("x")).toBe(true);
    expect(toggleLikeTrack(t)).toBe(false);
    expect(likedTrackIds.value.has("x")).toBe(false);
  });

  it("likedTracks is ordered by recency desc", () => {
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
    toggleLikeTrack(buildTrack(slsk("persist")));
    const snap = loadLikesSnapshot();
    expect(snap.trackIds).toContain("persist");
    expect(snap.likedAt.persist).toBeGreaterThan(0);
  });

  it("seedLikesFromSnapshot populates state", () => {
    seedLikesFromSnapshot({ trackIds: ["a", "b"], albumIds: [], likedAt: { a: 100, b: 200 } });
    expect(likedTrackIds.value.size).toBe(2);
  });
});

describe("playlist store", () => {
  it("create / add / remove round-trip", () => {
    const pl = createPlaylist("My PL");
    const t = buildTrack(slsk("x"));
    addTrackToPlaylist(pl.id, t);
    expect(getPlaylistTracks(pl.id).map((x) => x.id)).toEqual(["x"]);
    removeTrackFromPlaylist(pl.id, "x");
    expect(getPlaylistTracks(pl.id)).toEqual([]);
  });

  it("persists across restart", () => {
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

  it("addTrackToPlaylist dedups by id", () => {
    const pl = createPlaylist("D");
    const t = buildTrack(slsk("dup"));
    addTrackToPlaylist(pl.id, t);
    addTrackToPlaylist(pl.id, t);
    expect(getPlaylistTracks(pl.id)).toHaveLength(1);
  });
});
