import { describe, it, expect } from "vitest";
import { legacyAlbumLikeRowToAlbumData } from "../../src/persistence/legacyAlbumLikeRowToAlbumData.js";

const BTIH40 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("legacyAlbumLikeRowToAlbumData", () => {
  it("returns null when row is not a legacy album with id", () => {
    expect(legacyAlbumLikeRowToAlbumData({})).toBe(null);
    expect(legacyAlbumLikeRowToAlbumData({ type: "track", id: "x" })).toBe(null);
    expect(legacyAlbumLikeRowToAlbumData({ type: "album" })).toBe(null);
  });

  it("maps rutracker album row with audioFiles origIdx", () => {
    const d = legacyAlbumLikeRowToAlbumData({
      type: "album",
      id: "album:rutracker:1:root",
      source: "rutracker",
      torrentId: "1",
      torrentName: "Rel",
      albumName: "LP",
      dirPath: "root",
      magnet: `magnet:?xt=urn:btih:${BTIH40}`,
      audioFiles: [{ origIdx: 2, path: "a.flac" }],
    });
    expect(d).not.toBe(null);
    expect(d!.trackIds).toEqual(["rt:track:1:2"]);
    expect(d!.sources[0]?.kind).toBe("rutracker");
    expect(d!.title).toBe("LP");
    expect(d!.sources[0]?.kind === "rutracker" && d!.sources[0].refs.topicId).toBe("1");
  });

  it("skips rutracker files without finite origIdx", () => {
    const d = legacyAlbumLikeRowToAlbumData({
      type: "album",
      id: "album:rutracker:9:root",
      source: "rutracker",
      torrentId: 9,
      audioFiles: [{ path: "x.flac" }, { origIdx: 0 }],
    });
    expect(d).not.toBe(null);
    expect(d!.trackIds).toEqual(["rt:track:9:0"]);
  });

  it("uses magnet btih when source is magnet and topic id absent", () => {
    const d = legacyAlbumLikeRowToAlbumData({
      type: "album",
      id: "album:mag:1:root",
      source: "magnet",
      magnet: `magnet:?xt=urn:btih:${BTIH40}`,
      audioFiles: [{ origIdx: 0 }],
    });
    expect(d).not.toBe(null);
    expect(d!.trackIds).toEqual([`magnet:track:${BTIH40}:0`]);
  });

  it("builds soulseek album when files resolve user and path", () => {
    const d = legacyAlbumLikeRowToAlbumData({
      type: "album",
      id: "album:slsk:x",
      source: "soulseek",
      torrentName: "FolderName",
      dirPath: "root",
      audioFiles: [
        {
          slskUsername: "u",
          slskFilepath: "music/a/b.mp3",
        },
      ],
    });
    expect(d).not.toBe(null);
    expect(d!.sources[0]?.kind).toBe("soulseek");
    if (d!.sources[0]?.kind === "soulseek") {
      expect(d!.sources[0].refs.slskUsername).toBe("u");
      expect(d!.sources[0].refs.slskFolder).toBe("music/a");
    }
    expect(d!.trackIds).toContain("slsk:track:u|music/a/b.mp3");
  });

  it("returns null for soulseek album without resolvable username", () => {
    expect(
      legacyAlbumLikeRowToAlbumData({
        type: "album",
        id: "album:slsk:bad",
        source: "soulseek",
        audioFiles: [{ path: "only.mp3" }],
      }),
    ).toBe(null);
  });
});
