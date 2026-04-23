import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import { migrateLegacyStorage } from "../../src/persistence/migrateLegacy.js";
import { loadLikesSnapshot, saveLikesSnapshot } from "../../src/persistence/likes.js";
import { hydrateTrack, clearTrackCache } from "../../src/persistence/trackCache.js";
import { SoulseekTrack } from "../../src/track/SoulseekTrack.js";
import { RutrackerTrack } from "../../src/track/RutrackerTrack.js";

beforeEach(() => {
  fakeLocalStorage.clear();
  clearTrackCache();
});

describe("migrateLegacyStorage", () => {
  it("converts v1 likes into v2 trackIds + trackCache", () => {
    fakeLocalStorage.set("neegde.likes", JSON.stringify({
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
    fakeLocalStorage.set("neegde.likes", JSON.stringify({
      "x": { id: "x", type: "track", source: "soulseek", slskUsername: "u", slskFilepath: "f" },
    }));
    migrateLegacyStorage();
    expect(loadLikesSnapshot().trackIds).toEqual(["existing"]);
  });

  it("is idempotent", () => {
    fakeLocalStorage.set("neegde.likes", JSON.stringify({
      "x": { id: "x", type: "track", source: "soulseek", slskUsername: "u", slskFilepath: "f", addedAt: 1 },
    }));
    migrateLegacyStorage();
    const first = loadLikesSnapshot();
    migrateLegacyStorage();
    const second = loadLikesSnapshot();
    expect(second).toEqual(first);
  });
});
