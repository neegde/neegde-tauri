import { describe, it, expect } from "vitest";
import "../_setup.js";

import { buildTrack } from "../../src/track/factory.js";
import { RutrackerTrack, MagnetTrack } from "../../src/track/RutrackerTrack.js";
import { SoulseekTrack } from "../../src/track/SoulseekTrack.js";
import type { TrackData } from "../../src/track/types.js";

function rt(): TrackData {
  return {
    type: "track",
    id: "rt:track:12345:3",
    title: "track",
    artist: "A",
    albumTitle: "Al",
    albumId: null,
    fileName: "03.mp3",
    format: null,
    bitrate: null,
    duration: null,
    size: null,
    sources: [{
      kind: "rutracker",
      refs: { topicId: "12345", magnet: "m", fileIdx: 3, coverFileIdx: null, albumDirPath: null },
    }],
  };
}

function slsk(): TrackData {
  return {
    type: "track",
    id: "slsk:track:u|p",
    title: "p",
    artist: null,
    albumTitle: null,
    albumId: null,
    fileName: "p",
    format: null,
    bitrate: null,
    duration: null,
    size: 1000,
    sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "p" }, raw: { cover: null } }],
  };
}

describe("Track serialization", () => {
  it("toJSON returns the raw data object", () => {
    const data = rt();
    const t = buildTrack(data);
    const json = JSON.parse(JSON.stringify(t));
    expect(json).toEqual(data);
  });

  it("SoulseekTrack round-trip preserves class type + fields", () => {
    const t1 = buildTrack(slsk());
    const t2 = buildTrack(JSON.parse(JSON.stringify(t1)));
    expect(t2).toBeInstanceOf(SoulseekTrack);
    expect(t2.id).toBe(t1.id);
    expect(t2.kind).toBe("soulseek");
  });

  it("RutrackerTrack round-trip preserves class type", () => {
    const t1 = buildTrack(rt());
    const t2 = buildTrack(JSON.parse(JSON.stringify(t1)));
    expect(t2).toBeInstanceOf(RutrackerTrack);
    expect(t2.kind).toBe("rutracker");
  });

  it("MagnetTrack round-trip preserves class type", () => {
    const data: TrackData = {
      type: "track", id: "mag:1", title: "x", artist: null, albumId: null,
      fileName: "x", format: null, bitrate: null, duration: null, size: null,
      sources: [{ kind: "magnet", refs: { magnet: "m", fileIdx: 0, coverFileIdx: null, albumDirPath: null } }],
    };
    const t2 = buildTrack(JSON.parse(JSON.stringify(buildTrack(data))));
    expect(t2).toBeInstanceOf(MagnetTrack);
    expect(t2.kind).toBe("magnet");
  });
});
