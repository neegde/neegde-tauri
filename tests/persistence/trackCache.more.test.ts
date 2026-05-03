import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import {
  putTrack, putTracks, getTrackData, hydrateTrack, removeTrack,
  hasTrack, allTrackIds, clearTrackCache, loadTrackCache,
} from "../../src/persistence/trackCache.js";
import { buildTrack } from "../../src/track/factory.js";
import type { TrackData } from "../../src/track/types.js";

function data(id: string): TrackData {
  return {
    type: "track", id, title: id, artist: null,
    albumTitle: null, albumId: null, fileName: `${id}.mp3`,
    format: null, bitrate: null, duration: null, size: 1,
    sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: `${id}.mp3` }, raw: { cover: null } }],
  };
}

beforeEach(() => {
  fakeLocalStorage.clear();
  clearTrackCache();
});

describe("trackCache", () => {
  it("putTrack: accepts TrackData or Track instance", () => {
    putTrack(data("a"));
    putTrack(buildTrack(data("b")));
    expect(hasTrack("a")).toBe(true);
    expect(hasTrack("b")).toBe(true);
  });

  it("putTrack is a no-op when shallow-equal replacement", () => {
    putTrack(data("x"));
    const before = getTrackData("x");
    putTrack(data("x"));
    expect(getTrackData("x")).toBe(before);
  });

  it("putTracks batches", () => {
    putTracks([data("a"), data("b"), data("c")]);
    expect(allTrackIds()).toEqual(["a", "b", "c"]);
  });

  it("putTracks dedups identical shapes in batch", () => {
    putTrack(data("x"));
    const before = getTrackData("x");
    putTracks([data("x"), data("y")]);
    expect(getTrackData("x")).toBe(before);
    expect(hasTrack("y")).toBe(true);
  });

  it("hydrateTrack returns null for unknown id", () => {
    expect(hydrateTrack("nope")).toBeNull();
  });

  it("hydrateTrack returns Track instance for known id", () => {
    putTrack(data("z"));
    const t = hydrateTrack("z");
    expect(t?.id).toBe("z");
  });

  it("removeTrack + hasTrack", () => {
    putTrack(data("rm"));
    expect(removeTrack("rm")).toBe(true);
    expect(removeTrack("rm")).toBe(false);
    expect(hasTrack("rm")).toBe(false);
  });

  it("clearTrackCache wipes state + storage", () => {
    putTrack(data("a"));
    clearTrackCache();
    expect(allTrackIds()).toEqual([]);
    expect(fakeLocalStorage.get("neegde.trackCache.v1")).toBeUndefined();
  });

  it("loadTrackCache restores from localStorage", () => {
    fakeLocalStorage.set("neegde.trackCache.v1", JSON.stringify({
      a: data("a"), b: data("b"),
    }));
    loadTrackCache();
    expect(hasTrack("a")).toBe(true);
    expect(hasTrack("b")).toBe(true);
  });

  it("loadTrackCache rejects corrupt JSON", () => {
    fakeLocalStorage.set("neegde.trackCache.v1", "not json");
    loadTrackCache();
    expect(allTrackIds()).toEqual([]);
  });

  it("loadTrackCache rejects entries where data.id mismatch", () => {
    fakeLocalStorage.set("neegde.trackCache.v1", JSON.stringify({
      a: { ...data("a"), id: "b" },
    }));
    loadTrackCache();
    expect(hasTrack("a")).toBe(false);
  });

  it("hydrateTrack returns null when data malformed", () => {
    // Put data with bad sources kind.
    const bad = { ...data("bad"), sources: [{ kind: "unknown" as never, refs: {} }] } as unknown as TrackData;
    putTrack(bad);
    expect(hydrateTrack("bad")).toBeNull();
  });
});
