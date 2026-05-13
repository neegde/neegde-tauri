import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";

import {
  registerEntity,
  clearEntities,
  getTrack,
  getAlbum,
  type AlbumData,
} from "../../src/stores/entities.js";
import { clearTrackCache, hasTrack, putTrack } from "../../src/persistence/trackCache.js";
import { buildTrack } from "../../src/track/factory.js";
import { SoulseekTrack } from "../../src/track/SoulseekTrack.js";
import type { TrackData } from "../../src/track/types.js";

function slsk(id: string): TrackData {
  return {
    type: "track", id, title: id, artist: "A", albumTitle: null, albumId: null,
    fileName: `${id}.mp3`, format: null, bitrate: null, duration: null, size: 1000,
    sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: `${id}.mp3` }, raw: { cover: null } }],
  };
}

beforeEach(() => {
  clearEntities();
  clearTrackCache();
});

describe("entities registry", () => {
  it("normalizes plain TrackData to Track class instance", () => {
    registerEntity(slsk("x"));
    const t = getTrack("x");
    expect(t).toBeInstanceOf(SoulseekTrack);
    expect(t?.title).toBe("x");
  });

  it("passes Track instance through untouched", () => {
    const t = buildTrack(slsk("y"));
    registerEntity(t);
    expect(getTrack("y")).toBe(t);
  });

  it("registerEntity merges persisted coverUrl and albumTitle for repeat search rows", () => {
    const enriched: TrackData = {
      ...slsk("slsk:merge"),
      coverUrl: "https://cdn.example/cover.jpg",
      albumTitle: "Album X",
    };
    putTrack(enriched);
    registerEntity(slsk("slsk:merge"));
    expect(getTrack("slsk:merge")?.toJSON().coverUrl).toBe("https://cdn.example/cover.jpg");
    expect(getTrack("slsk:merge")?.toJSON().albumTitle).toBe("Album X");
  });

  it("getAlbum returns album entity; getTrack for an album id returns null", () => {
    const album: AlbumData = {
      type: "album", id: "alb", title: "A", artist: null, trackIds: [],
      sources: [{ kind: "rutracker", refs: { topicId: "alb" } }],
    };
    registerEntity(album);
    expect(getAlbum("alb")?.id).toBe("alb");
    expect(getAlbum("alb")?.title).toBe("A");
    expect(getTrack("alb")).toBe(null);
  });
});
