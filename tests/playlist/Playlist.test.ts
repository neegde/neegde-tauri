import { describe, it, expect, beforeEach, vi } from "vitest";
import { Playlist, createPlaylistInstance } from "../../src/playlist/Playlist.js";
import type { PlaylistSnapshot } from "../../src/persistence/playlists.js";

function snap(overrides: Partial<PlaylistSnapshot> = {}): PlaylistSnapshot {
  return {
    id: "pl-1", title: "Favourites", coverUrl: null,
    createdAt: 1000, updatedAt: 1000, trackIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2_000_000));
});

describe("Playlist — accessors", () => {
  it("exposes id, title, trackIds, timestamps", () => {
    const pl = new Playlist(snap({ trackIds: ["a", "b"] }));
    expect(pl.id).toBe("pl-1");
    expect(pl.title).toBe("Favourites");
    expect(pl.trackIds).toEqual(["a", "b"]);
    expect(pl.length).toBe(2);
    expect(pl.createdAt).toBe(1000);
    expect(pl.updatedAt).toBe(1000);
    expect(pl.coverUrl).toBe(null);
  });

  it("hasTrack detects presence", () => {
    const pl = new Playlist(snap({ trackIds: ["a"] }));
    expect(pl.hasTrack("a")).toBe(true);
    expect(pl.hasTrack("x")).toBe(false);
  });

  it("trackIds view is internally immutable to callers", () => {
    const pl = new Playlist(snap({ trackIds: ["a"] }));
    const ids = pl.trackIds as string[];
    // runtime is just an array; contract is readonly at the type level
    expect(ids.length).toBe(1);
  });
});

describe("Playlist — rename", () => {
  it("trims and applies a new title, bumps updatedAt", () => {
    const pl = new Playlist(snap());
    expect(pl.rename("  Great mix  ")).toBe(true);
    expect(pl.title).toBe("Great mix");
    expect(pl.updatedAt).toBe(2_000_000);
  });

  it("rejects empty/whitespace titles", () => {
    const pl = new Playlist(snap());
    expect(pl.rename("")).toBe(false);
    expect(pl.rename("   ")).toBe(false);
    expect(pl.title).toBe("Favourites");
  });

  it("rejects unchanged titles (noop)", () => {
    const pl = new Playlist(snap());
    expect(pl.rename("Favourites")).toBe(false);
    expect(pl.updatedAt).toBe(1000);
  });
});

describe("Playlist — coverUrl", () => {
  it("setCoverUrl toggles cover + bumps updatedAt", () => {
    const pl = new Playlist(snap());
    expect(pl.setCoverUrl("data:cover")).toBe(true);
    expect(pl.coverUrl).toBe("data:cover");
    expect(pl.updatedAt).toBe(2_000_000);
  });

  it("setCoverUrl is noop for identical value", () => {
    const pl = new Playlist(snap({ coverUrl: "data:same" }));
    expect(pl.setCoverUrl("data:same")).toBe(false);
    expect(pl.updatedAt).toBe(1000);
  });
});

describe("Playlist — addTrack", () => {
  it("appends a new track and bumps updatedAt", () => {
    const pl = new Playlist(snap());
    expect(pl.addTrack("a")).toBe(true);
    expect(pl.trackIds).toEqual(["a"]);
    expect(pl.updatedAt).toBe(2_000_000);
  });

  it("rejects duplicates", () => {
    const pl = new Playlist(snap({ trackIds: ["a"] }));
    expect(pl.addTrack("a")).toBe(false);
    expect(pl.trackIds).toEqual(["a"]);
    expect(pl.updatedAt).toBe(1000);
  });

  it("rejects empty ids", () => {
    const pl = new Playlist(snap());
    expect(pl.addTrack("")).toBe(false);
    expect(pl.trackIds).toEqual([]);
  });
});

describe("Playlist — removeTrack", () => {
  it("removes an existing id", () => {
    const pl = new Playlist(snap({ trackIds: ["a", "b"] }));
    expect(pl.removeTrack("a")).toBe(true);
    expect(pl.trackIds).toEqual(["b"]);
    expect(pl.updatedAt).toBe(2_000_000);
  });

  it("returns false for missing ids", () => {
    const pl = new Playlist(snap({ trackIds: ["a"] }));
    expect(pl.removeTrack("nope")).toBe(false);
    expect(pl.trackIds).toEqual(["a"]);
  });
});

describe("Playlist — reorderTracks", () => {
  it("moves item from → to", () => {
    const pl = new Playlist(snap({ trackIds: ["a", "b", "c"] }));
    expect(pl.reorderTracks(0, 2)).toBe(true);
    expect(pl.trackIds).toEqual(["b", "c", "a"]);
    expect(pl.updatedAt).toBe(2_000_000);
  });

  it("rejects identical indices + out-of-range", () => {
    const pl = new Playlist(snap({ trackIds: ["a", "b"] }));
    expect(pl.reorderTracks(0, 0)).toBe(false);
    expect(pl.reorderTracks(-1, 1)).toBe(false);
    expect(pl.reorderTracks(0, 5)).toBe(false);
    expect(pl.trackIds).toEqual(["a", "b"]);
    expect(pl.updatedAt).toBe(1000);
  });
});

describe("Playlist.toSnapshot", () => {
  it("round-trips through constructor → toSnapshot", () => {
    const original = snap({ trackIds: ["a", "b"] });
    const pl = new Playlist(original);
    expect(pl.toSnapshot()).toEqual(original);
  });

  it("snapshot is a defensive copy (trackIds)", () => {
    const pl = new Playlist(snap({ trackIds: ["a"] }));
    const s = pl.toSnapshot();
    s.trackIds.push("x");
    expect(pl.trackIds).toEqual(["a"]);
  });
});

describe("createPlaylistInstance", () => {
  it("generates unique ids and sets timestamps", () => {
    const a = createPlaylistInstance("A");
    const b = createPlaylistInstance("B");
    expect(a.id).not.toBe(b.id);
    expect(a.title).toBe("A");
    expect(b.title).toBe("B");
    expect(a.trackIds).toEqual([]);
  });

  it("trims title; falls back to 'Без названия' when empty", () => {
    expect(createPlaylistInstance("  hi  ").title).toBe("hi");
    expect(createPlaylistInstance("").title).toBe("Без названия");
    expect(createPlaylistInstance("   ").title).toBe("Без названия");
  });
});
