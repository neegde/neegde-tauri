import { describe, expect, it } from "vitest";
import "../_setup.js";

import {
  canDownload,
  canPlay,
  sourceContextLabel,
  sourceShortLabel,
} from "../../src/track/labels.js";

function fakeTrack(kind: "soulseek" | "rutracker", canStream: boolean) {
  return {
    kind,
    hasPlaybackIdentity: () => canStream,
  };
}

describe("track labels helpers", () => {
  it("formats source labels for SoulSeek", () => {
    const track = fakeTrack("soulseek", true);
    expect(sourceShortLabel(track as never)).toBe("SoulSeek");
    expect(sourceContextLabel(track as never)).toBe("Источник (SoulSeek)");
  });

  it("formats source labels for torrent-backed tracks", () => {
    const track = fakeTrack("rutracker", true);
    expect(sourceShortLabel(track as never)).toBe("RuTracker");
    expect(sourceContextLabel(track as never)).toBe("Источник (Torrent)");
  });

  it("play/download availability mirrors playback identity", () => {
    expect(canPlay(fakeTrack("soulseek", true) as never)).toBe(true);
    expect(canDownload(fakeTrack("soulseek", true) as never)).toBe(true);
    expect(canPlay(fakeTrack("rutracker", false) as never)).toBe(false);
    expect(canDownload(fakeTrack("rutracker", false) as never)).toBe(false);
  });
});
