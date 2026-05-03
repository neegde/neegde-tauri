import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import { migrateLegacyStorage } from "../../src/persistence/migrateLegacy.js";
import { loadLikesSnapshot, saveLikesSnapshot } from "../../src/persistence/likes.js";
import { hydrateTrack, clearTrackCache } from "../../src/persistence/trackCache.js";
import { clearAlbumCache, hasAlbumInCache, hydrateAlbum } from "../../src/persistence/albumCache.js";
import { SoulseekTrack } from "../../src/track/SoulseekTrack.js";
import { RutrackerTrack } from "../../src/track/RutrackerTrack.js";

beforeEach(() => {
  fakeLocalStorage.clear();
  clearTrackCache();
  clearAlbumCache();
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

  it("converts v1 album rows into v2 albumIds + albumCache", () => {
    fakeLocalStorage.set("neegde.likes", JSON.stringify({
      "album:rutracker:100:root": {
        id: "album:rutracker:100:root",
        type: "album",
        source: "rutracker",
        magnet: "magnet:?xt=urn:btih:ABC",
        torrentId: "100",
        torrentName: "Release",
        albumName: "My LP",
        dirPath: "root",
        audioFiles: [{ origIdx: 0, path: "01.flac" }],
        addedAt: 400,
      },
    }));
    migrateLegacyStorage();
    const likes = loadLikesSnapshot();
    expect(likes.albumIds).toContain("album:rutracker:100:root");
    expect(likes.likedAt["album:rutracker:100:root"]).toBe(400);
    expect(hasAlbumInCache("album:rutracker:100:root")).toBe(true);
    expect(hydrateAlbum("album:rutracker:100:root")?.title).toBe("My LP");
  });
});
