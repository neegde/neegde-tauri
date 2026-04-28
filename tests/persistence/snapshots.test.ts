import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import {
  LIKES_STORAGE_KEY,
  loadLikesSnapshot,
  saveLikesSnapshot,
} from "../../src/persistence/likes.js";
import {
  loadPlaylistsSnapshot,
  savePlaylistsSnapshot,
} from "../../src/persistence/playlists.js";
import {
  loadQueueSnapshot,
  saveQueueSnapshot,
  clearQueueSnapshot,
} from "../../src/persistence/queue.js";

beforeEach(() => {
  fakeLocalStorage.clear();
});

describe("likes snapshot", () => {
  it("default is empty", () => {
    expect(loadLikesSnapshot()).toEqual({ trackIds: [], albumIds: [], likedAt: {} });
  });

  it("round-trips", () => {
    const snap = { trackIds: ["a", "b"], albumIds: ["x"], likedAt: { a: 1, b: 2, x: 3 } };
    saveLikesSnapshot(snap);
    expect(loadLikesSnapshot()).toEqual(snap);
  });

  it("rejects malformed entries gracefully", () => {
    fakeLocalStorage.set(LIKES_STORAGE_KEY, JSON.stringify({ trackIds: ["ok", 42, null], likedAt: "bogus" }));
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

  it("empty array for missing storage", () => {
    expect(loadPlaylistsSnapshot()).toEqual([]);
  });
});

describe("queue snapshot", () => {
  it("clamps pos into valid range", () => {
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
