import { describe, it, expect } from "vitest";
import "../_setup.js";

import { buildTrack, ensureTrack } from "../../src/track/factory.js";
import { SoulseekTrack } from "../../src/track/SoulseekTrack.js";
import type { TrackData } from "../../src/track/types.js";

function slskData(): TrackData {
  return {
    type: "track", id: "x", title: "x", artist: null, albumId: null,
    fileName: "x.mp3", format: null, bitrate: null, duration: null, size: null,
    sources: [{
      kind: "soulseek",
      refs: { slskUsername: "u", slskFilepath: "x.mp3" },
      raw: { cover: null },
    }],
  };
}

describe("ensureTrack", () => {
  it("passes an existing Track instance through unchanged", () => {
    const t = buildTrack(slskData());
    expect(ensureTrack(t)).toBe(t);
  });

  it("wraps raw TrackData into a Track instance", () => {
    const data = slskData();
    const t = ensureTrack(data);
    expect(t).toBeInstanceOf(SoulseekTrack);
    expect(t.id).toBe("x");
  });
});
