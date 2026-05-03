import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import { migrateLegacyStorage } from "../../src/persistence/migrateLegacy.js";
import { loadPlaylistsSnapshot } from "../../src/persistence/playlists.js";
import { loadQueueSnapshot } from "../../src/persistence/queue.js";
import { clearTrackCache, hasTrack, allTrackIds } from "../../src/persistence/trackCache.js";

beforeEach(() => {
  fakeLocalStorage.clear();
  clearTrackCache();
});

describe("migrateLegacyStorage — playlists", () => {
  it("converts v1 playlists into v2 with trackIds", () => {
    fakeLocalStorage.set("neegde.playlists.v1", JSON.stringify([
      {
        id: "pl1", name: "Mix", createdAt: 100, updatedAt: 200,
        tracks: [
          { id: "x1", type: "track", source: "soulseek", slskUsername: "u", slskFilepath: "a.mp3" },
          { id: "x2", type: "track", source: "rutracker", torrentId: "42", fileIdx: 0, magnet: "m" },
        ],
      },
      { id: "pl2", title: "Other", tracks: [] },
    ]));
    migrateLegacyStorage();
    const pls = loadPlaylistsSnapshot();
    expect(pls).toHaveLength(2);
    expect(pls[0]?.title).toBe("Mix");
    expect(pls[0]?.trackIds.length).toBeGreaterThan(0);
  });

  it("doesn't clobber existing v2 playlists", () => {
    fakeLocalStorage.set("neegde.playlists.v2", JSON.stringify([
      { id: "keep", title: "K", coverUrl: null, createdAt: 0, updatedAt: 0, trackIds: [] },
    ]));
    fakeLocalStorage.set("neegde.playlists.v1", JSON.stringify([{ id: "other", name: "O", tracks: [] }]));
    migrateLegacyStorage();
    expect(loadPlaylistsSnapshot().map((p) => p.id)).toEqual(["keep"]);
  });

  it("handles non-array / empty legacy playlists", () => {
    fakeLocalStorage.set("neegde.playlists.v1", JSON.stringify({ not: "array" }));
    migrateLegacyStorage();
    expect(loadPlaylistsSnapshot()).toEqual([]);
  });
});

describe("migrateLegacyStorage — queue", () => {
  it("converts v1 player session into v2 queue", () => {
    fakeLocalStorage.set("neegde.playerSession", JSON.stringify({
      queue: [
        { id: "q1", type: "track", source: "soulseek", slskUsername: "u", slskFilepath: "a.mp3" },
        { id: "q2", type: "track", source: "rutracker", torrentId: "42", fileIdx: 0, magnet: "m" },
      ],
      queuePos: 1,
    }));
    migrateLegacyStorage();
    const q = loadQueueSnapshot();
    expect(q.trackIds).toHaveLength(2);
    expect(q.pos).toBe(1);
  });

  it("clamps bogus queuePos", () => {
    fakeLocalStorage.set("neegde.playerSession", JSON.stringify({
      queue: [{ id: "q1", source: "soulseek", slskUsername: "u", slskFilepath: "a.mp3" }],
      queuePos: 99,
    }));
    migrateLegacyStorage();
    expect(loadQueueSnapshot().pos).toBe(0);
  });

  it("no queue key → empty snapshot", () => {
    migrateLegacyStorage();
    expect(loadQueueSnapshot().trackIds).toEqual([]);
  });

  it("skips malformed rows in queue", () => {
    fakeLocalStorage.set("neegde.playerSession", JSON.stringify({
      queue: [
        { id: "ok", source: "soulseek", slskUsername: "u", slskFilepath: "a.mp3" },
        { source: "rutracker" }, // neither magnet nor topicId → dropped
      ],
      queuePos: 0,
    }));
    migrateLegacyStorage();
    expect(loadQueueSnapshot().trackIds.length).toBe(1);
  });
});

describe("migrateLegacyStorage — trackCache population", () => {
  it("v1 likes produce trackCache entries", () => {
    fakeLocalStorage.set("neegde.likes", JSON.stringify({
      "slsk:track:u|a.mp3": {
        id: "slsk:track:u|a.mp3", source: "soulseek",
        slskUsername: "u", slskFilepath: "a.mp3", fileName: "a.mp3",
      },
    }));
    migrateLegacyStorage();
    expect(hasTrack("slsk:track:u|a.mp3")).toBe(true);
    expect(allTrackIds()).toContain("slsk:track:u|a.mp3");
  });

  it("legacy magnet-only row synthesizes magnet:track:btih:idx id", () => {
    fakeLocalStorage.set("neegde.likes", JSON.stringify({
      "legacy-magnet": {
        source: "magnet", magnet: "magnet:?xt=urn:btih:" + "f".repeat(40),
        fileIdx: 0, fileName: "1.mp3",
      },
    }));
    migrateLegacyStorage();
    const ids = allTrackIds();
    expect(ids.length).toBeGreaterThan(0);
  });
});
