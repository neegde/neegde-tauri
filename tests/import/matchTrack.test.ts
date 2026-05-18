import { describe, it, expect } from "vitest";
import {
  normStr,
  formatQualityScore,
  scoreMatch,
  findBestMatch,
} from "../../src/import/matchTrack.js";
import type { TrackData } from "../../src/track/types.js";

function track(partial: Partial<TrackData> & Pick<TrackData, "fileName">): TrackData {
  return {
    type: "track",
    id: partial.id ?? "t1",
    title: partial.title ?? partial.fileName,
    artist: partial.artist ?? null,
    albumTitle: null,
    albumId: null,
    fileName: partial.fileName,
    format: partial.format ?? null,
    bitrate: partial.bitrate ?? null,
    duration: null,
    size: null,
    sources: partial.sources ?? [
      { kind: "soulseek", refs: { slskUsername: "u", slskFilepath: partial.fileName }, raw: {} },
    ],
  };
}

describe("normStr", () => {
  it("lowercases, strips extension and track number prefix", () => {
    expect(normStr("01. Artist - Song.flac")).toBe("artist song");
  });

  it("maps ё to е", () => {
    expect(normStr("ёлка")).toBe("елка");
  });
});

describe("formatQualityScore", () => {
  it("prefers lossless formats", () => {
    expect(formatQualityScore("FLAC", null)).toBeGreaterThan(formatQualityScore("MP3", null));
  });

  it("boosts high-bitrate MP3", () => {
    expect(formatQualityScore("MP3", 320)).toBeGreaterThan(formatQualityScore("MP3", 128));
  });
});

describe("scoreMatch / findBestMatch", () => {
  it("scores close filename match highly", () => {
    const s = scoreMatch(
      track({ fileName: "Radiohead - Karma Police.mp3", artist: "Radiohead", title: "Karma Police.mp3" }),
      "Radiohead",
      "Karma Police",
    );
    expect(s.score).toBeGreaterThan(0.7);
    expect(s.titleSim).toBeGreaterThan(0.5);
  });

  it("findBestMatch returns null below threshold", () => {
    const list = [track({ fileName: "unrelated.mp3", artist: "X", title: "Y" })];
    expect(findBestMatch(list, "Radiohead", "Karma Police")).toBeNull();
  });

  it("findBestMatch picks better quality on near tie", () => {
    const flac = track({ fileName: "Artist - Song.flac", format: "FLAC", id: "a" });
    const mp3 = track({ fileName: "Artist - Song.mp3", format: "MP3", id: "b" });
    const best = findBestMatch(
      [mp3, flac],
      "Artist",
      "Song",
      0.5,
      (t) => formatQualityScore(t.format, t.bitrate),
    );
    expect(best?.track.id).toBe("a");
  });
});
