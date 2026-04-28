import { describe, it, expect, vi, afterEach } from "vitest";
import { mockInvoke } from "../_setup.js";
import { buildTrack } from "../../src/track/factory.js";
import { SoulseekTrack } from "../../src/track/SoulseekTrack.js";
import { RutrackerTrack, MagnetTrack } from "../../src/track/RutrackerTrack.js";
import { clearEntities, registerEntity, type AlbumData } from "../../src/stores/entities.js";

afterEach(() => clearEntities());

describe("Track — serialization", () => {
  it("toJSON returns stored data", () => {
    const data = {
      type: "track" as const, id: "id", title: "t", artist: null,
      albumTitle: null, albumId: null, fileName: "t.mp3",
      format: null, bitrate: null, duration: null, size: 0,
      sources: [{ kind: "soulseek" as const, refs: { slskUsername: "u", slskFilepath: "t.mp3" }, raw: { cover: null } }],
    };
    const t = buildTrack(data);
    expect(t.toJSON()).toEqual(data);
  });

  it("exposes all simple getters", () => {
    const t = buildTrack({
      type: "track", id: "i", title: "Title", artist: "A",
      albumTitle: "Alb", albumId: "a1", fileName: "01.mp3",
      format: "MP3", bitrate: 320, duration: 100, size: 500,
      sources: [{ kind: "rutracker", refs: { topicId: "1", magnet: "m", fileIdx: 0, coverFileIdx: null, albumDirPath: null } }],
    });
    expect(t.id).toBe("i");
    expect(t.title).toBe("Title");
    expect(t.artist).toBe("A");
    expect(t.albumTitle).toBe("Alb");
    expect(t.albumId).toBe("a1");
    expect(t.fileName).toBe("01.mp3");
    expect(t.format).toBe("MP3");
    expect(t.bitrate).toBe(320);
    expect(t.duration).toBe(100);
    expect(t.size).toBe(500);
    expect(t.kind).toBe("rutracker");
    expect(t.sources.length).toBe(1);
  });
});

describe("SoulseekTrack", () => {
  it("prepareStream invokes soulseek_prepare_stream", async () => {
    mockInvoke.mockResolvedValueOnce({ url: "http://slsk", token: "tok" });
    const t = buildTrack({
      type: "track", id: "s1", title: "T", artist: null, albumTitle: null, albumId: null,
      fileName: "t.mp3", format: null, bitrate: null, duration: null, size: 100,
      sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "t.mp3" }, raw: { cover: null } }],
    }) as SoulseekTrack;
    const url = await t.prepareStream();
    expect(url).toBe("http://slsk");
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_prepare_stream", expect.any(Object));
  });

  it("hasPlaybackIdentity false when refs missing", () => {
    const t = buildTrack({
      type: "track", id: "x", title: "x", artist: null, albumTitle: null, albumId: null,
      fileName: "x.mp3", format: null, bitrate: null, duration: null, size: 0,
      sources: [{ kind: "soulseek", refs: { slskUsername: "", slskFilepath: "" }, raw: { cover: null } }],
    });
    expect(t.hasPlaybackIdentity()).toBe(false);
  });

  it("coverUrl from parent Album cover ref", () => {
    const album: AlbumData = {
      type: "album", id: "alb-1", title: "A", artist: null, trackIds: [],
      sources: [{
        kind: "soulseek",
        raw: { cover: { slsk_username: "u", slsk_filepath: "cover.jpg", size: 1 } },
      }],
    };
    registerEntity(album);
    const t = buildTrack({
      type: "track", id: "s2", title: "T", artist: null, albumTitle: null, albumId: "alb-1",
      fileName: "t.mp3", format: null, bitrate: null, duration: null, size: 0,
      sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "t.mp3" }, raw: { cover: null } }],
    });
    // With no positive cache, coverUrl returns null but code path executes.
    expect(t.coverUrl()).toBeNull();
  });

  it("navigationTarget returns shape", () => {
    const t = buildTrack({
      type: "track", id: "s3", title: "T", artist: null, albumTitle: null, albumId: null,
      fileName: "t.mp3", format: null, bitrate: null, duration: null, size: 0,
      sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "t.mp3" }, raw: { cover: null } }],
    });
    const nav = t.navigationTarget();
    expect(nav?.source).toBe("soulseek");
    expect(nav?.slskUsername).toBe("u");
  });
});

describe("RutrackerTrack", () => {
  it("magnet fallback to source.raw.details.magnet", () => {
    const t = buildTrack({
      type: "track", id: "rt1", title: "T", artist: null, albumTitle: null, albumId: null,
      fileName: "t.mp3", format: null, bitrate: null, duration: null, size: 0,
      sources: [{
        kind: "rutracker",
        refs: { topicId: "42", fileIdx: 0, coverFileIdx: null, albumDirPath: null, magnet: "" },
        raw: { details: { magnet: "magnet:?xt=urn:btih:DEAD" } },
      }],
    }) as RutrackerTrack;
    expect(t.hasPlaybackIdentity()).toBe(true);
  });

  it("prepareStream '' when no magnet anywhere", async () => {
    const t = buildTrack({
      type: "track", id: "rt2", title: "T", artist: null, albumTitle: null, albumId: null,
      fileName: "t.mp3", format: null, bitrate: null, duration: null, size: 0,
      sources: [{
        kind: "rutracker",
        refs: { topicId: "1", fileIdx: 0, coverFileIdx: null, albumDirPath: null, magnet: "" },
        raw: {},
      }],
    });
    expect(await t.prepareStream()).toBe("");
  });

  it("navigationTarget carries all fields", () => {
    const t = buildTrack({
      type: "track", id: "rt3", title: "T", artist: "A", albumTitle: "Alb", albumId: null,
      fileName: "t.mp3", format: null, bitrate: null, duration: null, size: 0,
      sources: [{
        kind: "rutracker",
        refs: { topicId: "100", fileIdx: 5, coverFileIdx: 10, albumDirPath: "Disc 1", magnet: "m" },
      }],
    });
    const nav = t.navigationTarget();
    expect(nav?.torrentId).toBe("100");
    expect(nav?.fileIdx).toBe(5);
    expect(nav?.magnet).toBe("m");
    expect(nav?.albumDirPath).toBe("Disc 1");
    expect(nav?.source).toBe("rutracker");
  });
});

describe("MagnetTrack", () => {
  it("kind label is 'magnet' in navigationTarget", () => {
    const t = buildTrack({
      type: "track", id: "m1", title: "T", artist: null, albumTitle: null, albumId: null,
      fileName: "t.mp3", format: null, bitrate: null, duration: null, size: 0,
      sources: [{
        kind: "magnet",
        refs: { magnet: "magnet:?xt=urn:btih:A", fileIdx: 3, coverFileIdx: null, albumDirPath: null },
      }],
    }) as MagnetTrack;
    expect(t.navigationTarget()?.source).toBe("magnet");
  });
});
