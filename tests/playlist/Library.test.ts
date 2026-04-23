import { describe, it, expect, beforeEach, vi } from "vitest";
import { Library } from "../../src/playlist/Library.js";
import type { PlaylistSnapshot } from "../../src/persistence/playlists.js";

function mk() {
  const persist = vi.fn();
  return { lib: new Library(persist), persist };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Library — create / get / list / delete", () => {
  it("starts empty", () => {
    const { lib } = mk();
    expect(lib.list()).toEqual([]);
    expect(lib.get("nope")).toBe(null);
  });

  it("create appends, get returns instance, list reflects new length", () => {
    const { lib, persist } = mk();
    const pl = lib.create("Tour");
    expect(lib.list()).toHaveLength(1);
    expect(lib.get(pl.id)?.id).toBe(pl.id);
    expect(lib.get(pl.id)?.title).toBe("Tour");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("delete removes entry and returns true; returns false if missing", () => {
    const { lib, persist } = mk();
    const pl = lib.create("Temp");
    persist.mockClear();
    expect(lib.delete(pl.id)).toBe(true);
    expect(lib.get(pl.id)).toBe(null);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(lib.delete("missing")).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1); // no extra persist
  });

  it("seedFromSnapshots hydrates from persisted data (no persist call)", () => {
    const { lib, persist } = mk();
    const snapshots: PlaylistSnapshot[] = [
      { id: "a", title: "A", coverUrl: null, createdAt: 1, updatedAt: 1, trackIds: ["t1"] },
      { id: "b", title: "B", coverUrl: null, createdAt: 2, updatedAt: 2, trackIds: [] },
    ];
    lib.seedFromSnapshots(snapshots);
    expect(lib.list().map((p) => p.id)).toEqual(["a", "b"]);
    expect(lib.get("a")?.trackIds).toEqual(["t1"]);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("Library — rename / addTrackId / removeTrackId / reorder", () => {
  it("rename delegates to Playlist and persists on change", () => {
    const { lib, persist } = mk();
    const pl = lib.create("old");
    persist.mockClear();
    expect(lib.rename(pl.id, "new")).toBe(true);
    expect(lib.get(pl.id)?.title).toBe("new");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("rename returns false for unknown id and makes no persist call", () => {
    const { lib, persist } = mk();
    expect(lib.rename("ghost", "x")).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it("rename skips persist on noop (same title)", () => {
    const { lib, persist } = mk();
    const pl = lib.create("same");
    persist.mockClear();
    expect(lib.rename(pl.id, "same")).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it("addTrackId inserts + persists; rejects duplicates silently", () => {
    const { lib, persist } = mk();
    const pl = lib.create("tst");
    persist.mockClear();
    expect(lib.addTrackId(pl.id, "t1")).toBe(true);
    expect(lib.addTrackId(pl.id, "t1")).toBe(false);
    expect(lib.get(pl.id)?.trackIds).toEqual(["t1"]);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("addTrackId returns false for missing playlist", () => {
    const { lib } = mk();
    expect(lib.addTrackId("ghost", "t")).toBe(false);
  });

  it("removeTrackId strips + persists", () => {
    const { lib, persist } = mk();
    const pl = lib.create("tst");
    lib.addTrackId(pl.id, "t1");
    persist.mockClear();
    expect(lib.removeTrackId(pl.id, "t1")).toBe(true);
    expect(lib.get(pl.id)?.trackIds).toEqual([]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(lib.removeTrackId(pl.id, "t1")).toBe(false); // already gone
  });

  it("reorder swaps and persists; rejects out-of-range + noop", () => {
    const { lib, persist } = mk();
    const pl = lib.create("tst");
    lib.addTrackId(pl.id, "a");
    lib.addTrackId(pl.id, "b");
    lib.addTrackId(pl.id, "c");
    persist.mockClear();
    expect(lib.reorder(pl.id, 0, 2)).toBe(true);
    expect(lib.get(pl.id)?.trackIds).toEqual(["b", "c", "a"]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(lib.reorder(pl.id, 0, 0)).toBe(false);
    expect(lib.reorder(pl.id, -1, 1)).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe("Library — persistence payload shape", () => {
  it("persist callback receives PlaylistSnapshot[] via toSnapshot()", () => {
    const { lib, persist } = mk();
    const pl = lib.create("Demo");
    lib.addTrackId(pl.id, "t1");
    const lastCall = persist.mock.calls[persist.mock.calls.length - 1]?.[0] as PlaylistSnapshot[];
    expect(lastCall).toBeDefined();
    const saved = lastCall.find((p) => p.id === pl.id);
    expect(saved?.title).toBe("Demo");
    expect(saved?.trackIds).toEqual(["t1"]);
    expect(typeof saved?.createdAt).toBe("number");
  });
});

describe("Library — reactive ref reflects mutations", () => {
  it("exposes a Vue Ref<Playlist[]> that re-renders on create/delete", () => {
    const { lib } = mk();
    const before = lib.playlists.value;
    lib.create("a");
    const afterCreate = lib.playlists.value;
    expect(afterCreate).not.toBe(before);
    const [created] = afterCreate;
    lib.delete(created!.id);
    expect(lib.playlists.value).toHaveLength(0);
    expect(lib.playlists.value).not.toBe(afterCreate);
  });

  it("bumps ref array reference after a Playlist-internal mutation", () => {
    const { lib } = mk();
    const pl = lib.create("x");
    const beforeArr = lib.playlists.value;
    lib.rename(pl.id, "y");
    expect(lib.playlists.value).not.toBe(beforeArr);
  });
});
