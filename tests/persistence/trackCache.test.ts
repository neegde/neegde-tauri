import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import {
  putTrack,
  hydrateTrack,
  hasTrack,
  clearTrackCache,
  loadTrackCache,
} from "../../src/persistence/trackCache.js";
import { SoulseekTrack } from "../../src/track/SoulseekTrack.js";
import { RutrackerTrack } from "../../src/track/RutrackerTrack.js";
import type { TrackData } from "../../src/track/types.js";

function slsk(id: string): TrackData {
  return {
    type: "track", id, title: id, artist: null, albumTitle: null, albumId: null,
    fileName: `${id}.mp3`, format: null, bitrate: null, duration: null, size: 1000,
    sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: `${id}.mp3` }, raw: { cover: null } }],
  };
}

function rt(id: string, topicId: string): TrackData {
  return {
    type: "track", id, title: id, artist: null, albumTitle: null, albumId: null,
    fileName: `${id}.mp3`, format: null, bitrate: null, duration: null, size: null,
    sources: [{
      kind: "rutracker",
      refs: { topicId, magnet: "magnet:?xt=urn:btih:ABC", fileIdx: 0, coverFileIdx: null, albumDirPath: null },
    }],
  };
}

beforeEach(() => {
  fakeLocalStorage.clear();
  clearTrackCache();
});

describe("trackCache", () => {
  it("putTrack + hydrateTrack preserves class identity", () => {
    putTrack(slsk("slsk:1"));
    expect(hasTrack("slsk:1")).toBe(true);
    expect(hydrateTrack("slsk:1")).toBeInstanceOf(SoulseekTrack);
  });

  it("loads persisted entries from localStorage on boot", () => {
    const data = rt("rt:1", "12345");
    fakeLocalStorage.set("neegde.trackCache.v1", JSON.stringify({ [data.id]: data }));
    loadTrackCache();
    expect(hasTrack("rt:1")).toBe(true);
    expect(hydrateTrack("rt:1")).toBeInstanceOf(RutrackerTrack);
  });

  it("debounced save writes to localStorage", async () => {
    putTrack(slsk("slsk:persist"));
    await new Promise((r) => setTimeout(r, 300));
    const raw = fakeLocalStorage.get("neegde.trackCache.v1");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)["slsk:persist"]).toMatchObject({ id: "slsk:persist" });
  });

  it("hydrateTrack returns null for unknown id", () => {
    expect(hydrateTrack("missing")).toBe(null);
  });
});
