import { describe, it, expect, beforeEach } from "vitest";
import {
  clearPersistedDeezerAlbumArt,
  clearPersistedDeezerTrackCanonical,
  clearPersistedRutrackerCovers,
  loadPersistedDeezerAlbumArt,
  loadPersistedDeezerTrackCanonicals,
  persistDeezerAlbumArt,
  persistDeezerTrackCanonical,
  persistRutrackerCoverPositive,
  loadPersistedRutrackerCovers,
} from "../../src/persistence/coverArtLocal.js";

beforeEach(() => {
  clearPersistedRutrackerCovers();
  clearPersistedDeezerAlbumArt();
  clearPersistedDeezerTrackCanonical();
});

describe("coverArtLocal RuTracker", () => {
  it("round-trips logicalKey + data URL", () => {
    const key = "https://mirror\n42";
    const url = "data:image/png;base64,QUJD";
    persistRutrackerCoverPositive(key, url);
    const rows = loadPersistedRutrackerCovers();
    expect(rows.some(([k, u]) => k === key && u === url)).toBe(true);
  });
});

describe("coverArtLocal Deezer album art", () => {
  it("round-trips album cache key + HTTPS URL", () => {
    const key = "deezer-album-art|x|y";
    const u = "https://cdn.example/a.jpg";
    persistDeezerAlbumArt(key, u);
    const rows = loadPersistedDeezerAlbumArt();
    expect(rows.some(([k, v]) => k === key && v === u)).toBe(true);
  });
});

describe("coverArtLocal Deezer track canonical", () => {
  it("round-trips canonical JSON", () => {
    const key = "artist|title";
    const row = { artist: "A", title: "T", album: "Al", coverUrl: "https://c/x.png" };
    persistDeezerTrackCanonical(key, row);
    const rows = loadPersistedDeezerTrackCanonicals();
    expect(rows.find(([k]) => k === key)?.[1]).toEqual(row);
  });

  it("persists null miss", () => {
    const key = "miss|key";
    persistDeezerTrackCanonical(key, null);
    const rows = loadPersistedDeezerTrackCanonicals();
    expect(rows.find(([k]) => k === key)).toEqual([key, null]);
  });
});
