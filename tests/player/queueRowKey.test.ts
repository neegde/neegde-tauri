import { describe, it, expect } from "vitest";
import "../_setup.js";

import {
  trackHasPlaybackIdentity,
  queueTrackKey,
  prefetchFingerprint,
} from "../../src/player/queueRowKey.js";
import type { Track } from "../../src/track/Track.js";

function t(id: string, playable = true): Track {
  return { id, hasPlaybackIdentity: () => playable } as unknown as Track;
}

describe("trackHasPlaybackIdentity", () => {
  it("returns false for null/undefined", () => {
    expect(trackHasPlaybackIdentity(null)).toBe(false);
    expect(trackHasPlaybackIdentity(undefined)).toBe(false);
  });
  it("delegates to the method", () => {
    expect(trackHasPlaybackIdentity(t("x", true))).toBe(true);
    expect(trackHasPlaybackIdentity(t("x", false))).toBe(false);
  });
});

describe("queueTrackKey", () => {
  it("uses track.id", () => {
    expect(queueTrackKey(t("abc"))).toBe("abc");
  });
  it("empty for null", () => {
    expect(queueTrackKey(null)).toBe("");
    expect(queueTrackKey(undefined)).toBe("");
  });
});

describe("prefetchFingerprint", () => {
  it("pair fingerprint is id\\0id", () => {
    expect(prefetchFingerprint(t("a"), t("b"))).toBe("a\0b");
  });
  it("empty if either side missing", () => {
    expect(prefetchFingerprint(null, t("b"))).toBe("");
    expect(prefetchFingerprint(t("a"), null)).toBe("");
    expect(prefetchFingerprint(null, null)).toBe("");
  });
});
