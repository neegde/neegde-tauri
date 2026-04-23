import { describe, it, expect } from "vitest";
import "../_setup.js";

import { buildTrack } from "../../src/track/factory.js";
import { SoulseekTrack } from "../../src/track/SoulseekTrack.js";
import { RutrackerTrack, MagnetTrack } from "../../src/track/RutrackerTrack.js";
import type { TrackData } from "../../src/track/types.js";

describe("buildTrack factory", () => {
  it("returns SoulseekTrack for soulseek source", () => {
    const data: TrackData = {
      type: "track", id: "x", title: "x", artist: null, albumId: null,
      fileName: "x", format: null, bitrate: null, duration: null, size: null,
      sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "p" } }],
    };
    expect(buildTrack(data)).toBeInstanceOf(SoulseekTrack);
  });

  it("returns RutrackerTrack for rutracker source", () => {
    const data: TrackData = {
      type: "track", id: "x", title: "x", artist: null, albumId: null,
      fileName: "x", format: null, bitrate: null, duration: null, size: null,
      sources: [{ kind: "rutracker", refs: { topicId: "1", magnet: "m", fileIdx: 0, coverFileIdx: null, albumDirPath: null } }],
    };
    expect(buildTrack(data)).toBeInstanceOf(RutrackerTrack);
  });

  it("returns MagnetTrack for magnet source", () => {
    const data: TrackData = {
      type: "track", id: "x", title: "x", artist: null, albumId: null,
      fileName: "x", format: null, bitrate: null, duration: null, size: null,
      sources: [{ kind: "magnet", refs: { magnet: "m", fileIdx: 0, coverFileIdx: null, albumDirPath: null } }],
    };
    expect(buildTrack(data)).toBeInstanceOf(MagnetTrack);
  });

  it("throws on unknown source kind", () => {
    const bad = {
      type: "track", id: "x", title: "x", artist: null, albumId: null,
      fileName: "x", format: null, bitrate: null, duration: null, size: null,
      sources: [{ kind: "youtube", refs: {} }],
    } as unknown as TrackData;
    expect(() => buildTrack(bad)).toThrow(/unsupported source kind/);
  });
});
