import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";

import {
  registerEntity,
  registerEntities,
  clearEntities,
  getEntity,
  getTrack,
  getAlbum,
  getTracksOfAlbum,
  allEntities,
  entitiesVersion,
  type AlbumData,
} from "../../src/stores/entities.js";
import { clearTrackCache } from "../../src/persistence/trackCache.js";
import type { TrackData } from "../../src/track/types.js";

function slsk(id: string): TrackData {
  return {
    type: "track", id, title: id, artist: "A", albumTitle: null, albumId: null,
    fileName: `${id}.mp3`, format: null, bitrate: null, duration: null, size: 1000,
    sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: `${id}.mp3` }, raw: { cover: null } }],
  };
}

function album(id: string, trackIds: string[] = []): AlbumData {
  return {
    type: "album", id, title: id, artist: null, trackIds,
    sources: [{ kind: "rutracker", refs: { topicId: id } }],
  };
}

beforeEach(() => {
  clearEntities();
  clearTrackCache();
});

describe("entities registry — edge paths", () => {
  it("registerEntity ignores nullish and id-less entities", () => {
    const before = entitiesVersion.value;
    registerEntity(null);
    registerEntity(undefined);
    registerEntity({
      type: "album", id: "", title: "", artist: null, trackIds: [],
      sources: [{ kind: "rutracker", refs: { topicId: "x" } }],
    });
    expect(entitiesVersion.value).toBe(before);
    expect(allEntities()).toEqual([]);
  });

  it("registerEntity drops entities with an unknown type", () => {
    // @ts-expect-error — intentionally bogus entity type
    registerEntity({ type: "bogus", id: "x" });
    expect(getEntity("x")).toBe(null);
  });

  it("registerEntities returns empty array for empty / nullish input", () => {
    expect(registerEntities([])).toEqual([]);
    // @ts-expect-error — null input
    expect(registerEntities(null)).toEqual([]);
  });

  it("registerEntities returns normalized entities in input order", () => {
    const result = registerEntities([slsk("a"), album("alb:1", ["a"]), slsk("b")]);
    expect(result.map((e) => e.id)).toEqual(["a", "alb:1", "b"]);
  });

  it("registerEntities bumps entitiesVersion only once per batch", () => {
    const before = entitiesVersion.value;
    registerEntities([slsk("a"), slsk("b"), slsk("c")]);
    expect(entitiesVersion.value).toBe(before + 1);
  });

  it("getTracksOfAlbum resolves ids in declared order", () => {
    registerEntities([slsk("x"), slsk("y"), slsk("z")]);
    const tracks = getTracksOfAlbum(album("alb", ["z", "x", "y"]));
    expect(tracks.map((t) => t.id)).toEqual(["z", "x", "y"]);
  });

  it("getTracksOfAlbum silently skips missing ids", () => {
    registerEntity(slsk("real"));
    const tracks = getTracksOfAlbum(album("alb", ["real", "missing", "gone"]));
    expect(tracks.map((t) => t.id)).toEqual(["real"]);
  });

  it("getTracksOfAlbum returns [] for null / albums without trackIds", () => {
    expect(getTracksOfAlbum(null)).toEqual([]);
    expect(getTracksOfAlbum(undefined)).toEqual([]);
    // @ts-expect-error — missing trackIds
    expect(getTracksOfAlbum({ type: "album", id: "x", title: "", artist: null })).toEqual([]);
  });

  it("allEntities returns a snapshot of every registered item", () => {
    registerEntities([slsk("a"), slsk("b")]);
    registerEntity(album("alb", []));
    expect(allEntities()).toHaveLength(3);
    expect(allEntities().map((e) => e.id).sort()).toEqual(["a", "alb", "b"]);
  });

  it("clearEntities is a noop when the registry is empty (no version bump)", () => {
    const before = entitiesVersion.value;
    clearEntities();
    expect(entitiesVersion.value).toBe(before);
  });

  it("clearEntities empties the registry and bumps version", () => {
    registerEntity(slsk("a"));
    const before = entitiesVersion.value;
    clearEntities();
    expect(entitiesVersion.value).toBe(before + 1);
    expect(getTrack("a")).toBe(null);
    expect(allEntities()).toEqual([]);
  });

  it("getEntity returns null for unknown ids", () => {
    expect(getEntity("nope")).toBe(null);
  });

  it("getAlbum returns null for track ids", () => {
    registerEntity(slsk("t"));
    expect(getAlbum("t")).toBe(null);
  });
});
