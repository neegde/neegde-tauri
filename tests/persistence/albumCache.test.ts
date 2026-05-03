import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import {
  putAlbum,
  hydrateAlbum,
  hasAlbumInCache,
  clearAlbumCache,
  loadAlbumCache,
} from "../../src/persistence/albumCache.js";
import { RutrackerAlbum } from "../../src/album/RutrackerAlbum.js";
import type { AlbumData } from "../../src/album/types.js";

function rtAlbum(id: string): AlbumData {
  return {
    type: "album",
    id,
    title: id,
    artist: null,
    trackIds: ["rt:track:42:0"],
    sources: [{ kind: "rutracker", refs: { topicId: "42", rootPath: undefined } }],
  };
}

beforeEach(() => {
  fakeLocalStorage.clear();
  clearAlbumCache();
});

describe("albumCache", () => {
  it("putAlbum + hydrateAlbum preserves class identity", () => {
    putAlbum(rtAlbum("album:rt:1:root"));
    expect(hasAlbumInCache("album:rt:1:root")).toBe(true);
    expect(hydrateAlbum("album:rt:1:root")).toBeInstanceOf(RutrackerAlbum);
  });

  it("loads persisted entries from localStorage on boot", () => {
    const data = rtAlbum("album:rt:2:root");
    fakeLocalStorage.set("neegde.albumCache.v1", JSON.stringify({ [data.id]: data }));
    loadAlbumCache();
    expect(hasAlbumInCache("album:rt:2:root")).toBe(true);
    expect(hydrateAlbum("album:rt:2:root")).toBeInstanceOf(RutrackerAlbum);
  });

  it("debounced save writes to localStorage", async () => {
    putAlbum(rtAlbum("album:rt:persist:root"));
    await new Promise((r) => setTimeout(r, 300));
    const raw = fakeLocalStorage.get("neegde.albumCache.v1");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)["album:rt:persist:root"]).toMatchObject({
      id: "album:rt:persist:root",
    });
  });

  it("hydrateAlbum returns null for unknown id", () => {
    expect(hydrateAlbum("missing")).toBe(null);
  });
});
