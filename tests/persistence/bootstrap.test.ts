import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import { loadPersistedState } from "../../src/persistence/bootstrap.js";
import { clearTrackCache } from "../../src/persistence/trackCache.js";

beforeEach(() => {
  fakeLocalStorage.clear();
  clearTrackCache();
});

describe("loadPersistedState", () => {
  it("returns default empty snapshots when storage is empty", () => {
    const s = loadPersistedState();
    expect(s.likes).toEqual({ trackIds: [], albumIds: [], likedAt: {} });
    expect(s.playlists).toEqual([]);
    expect(s.queue).toEqual({ trackIds: [], pos: 0 });
  });

  it("loads v2 likes + playlists + queue", () => {
    fakeLocalStorage.set("neegde.likes.v2", JSON.stringify({
      trackIds: ["t1"], albumIds: [], likedAt: { t1: 1 },
    }));
    fakeLocalStorage.set("neegde.playlists.v2", JSON.stringify([
      { id: "pl-1", title: "X", coverUrl: null, createdAt: 1, updatedAt: 1, trackIds: [] },
    ]));
    fakeLocalStorage.set("neegde.queue.v2", JSON.stringify({ trackIds: ["a"], pos: 0 }));
    fakeLocalStorage.set("neegde.migration.v2.done", "1");

    const s = loadPersistedState();
    expect(s.likes.trackIds).toEqual(["t1"]);
    expect(s.playlists).toHaveLength(1);
    expect(s.queue.trackIds).toEqual(["a"]);
  });
});
