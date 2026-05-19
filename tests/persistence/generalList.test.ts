import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";
import {
  loadGeneralList,
  recordGeneralList,
  refreshGeneralListCache,
  removeGeneralListEntry,
  clearGeneralList,
  flushGeneralList,
} from "../../src/persistence/generalList.js";
import { clearTrackCache } from "../../src/persistence/trackCache.js";
import type { TrackData } from "../../src/track/types.js";

function rtTrack(topicId: string, title = "Test Track"): TrackData {
  return {
    type: "track",
    id: `rt:track:${topicId}:0`,
    title,
    artist: "Artist",
    albumTitle: "Album",
    albumId: null,
    fileName: `${title}.flac`,
    format: "flac",
    bitrate: null,
    duration: null,
    size: null,
    coverUrl: null,
    sources: [{
      kind: "rutracker",
      refs: { topicId, magnet: "magnet:?xt=urn:btih:BEEF", fileIdx: 0, coverFileIdx: null, albumDirPath: null },
    }],
  };
}

function slskTrack(id = "slsk:1"): TrackData {
  return {
    type: "track",
    id,
    title: "SLSK Track",
    artist: "Peer",
    albumTitle: null,
    albumId: null,
    fileName: "track.flac",
    format: null,
    bitrate: null,
    duration: null,
    size: 1000,
    coverUrl: null,
    sources: [{
      kind: "soulseek",
      refs: { slskUsername: "user1", slskFilepath: "/music/track.flac" },
      raw: { cover: null },
    }],
  };
}

beforeEach(() => {
  fakeLocalStorage.clear();
  clearTrackCache();
  clearGeneralList();
});

describe("recordGeneralList — new entry", () => {
  it("creates an entry with correct id and track data", () => {
    const data = rtTrack("100");
    recordGeneralList(data, "search_results");
    const list = loadGeneralList();
    expect(list.entries[data.id]).toBeDefined();
    expect(list.entries[data.id]!.track.title).toBe("Test Track");
  });

  it("sets meta.seenCount to 1 on first record", () => {
    const data = rtTrack("101");
    recordGeneralList(data, "search_results");
    expect(loadGeneralList().entries[data.id]!.meta.seenCount).toBe(1);
  });

  it("sets meta.firstSeenAt and lastSeenAt to roughly now", () => {
    const before = Date.now();
    recordGeneralList(rtTrack("102"), "search_results");
    const m = loadGeneralList().entries["rt:track:102:0"]!.meta;
    expect(m.firstSeenAt).toBeGreaterThanOrEqual(before);
    expect(m.lastSeenAt).toBe(m.firstSeenAt);
  });

  it("sets meta.lastContext", () => {
    recordGeneralList(rtTrack("103"), "player");
    expect(loadGeneralList().entries["rt:track:103:0"]!.meta.lastContext).toBe("player");
  });

  it("records meta.lastSearchQuery when provided", () => {
    recordGeneralList(rtTrack("104"), "search_results", "radiohead paranoid");
    expect(loadGeneralList().entries["rt:track:104:0"]!.meta.lastSearchQuery).toBe("radiohead paranoid");
  });

  it("omits lastSearchQuery when not provided", () => {
    recordGeneralList(rtTrack("105"), "search_results");
    const entry = loadGeneralList().entries["rt:track:105:0"]!;
    expect("lastSearchQuery" in entry.meta).toBe(false);
  });

  it("populates cacheKeys.trackCacheId", () => {
    const data = rtTrack("106");
    recordGeneralList(data, "registered");
    const entry = loadGeneralList().entries[data.id]!;
    expect(entry.cacheKeys.trackCacheId).toBe(data.id);
  });

  it("populates cache.capturedAt", () => {
    const before = Date.now();
    recordGeneralList(rtTrack("107"), "registered");
    const entry = loadGeneralList().entries["rt:track:107:0"]!;
    expect(entry.cache.capturedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("recordGeneralList — update existing entry", () => {
  it("increments seenCount on repeat call", () => {
    const data = rtTrack("200");
    recordGeneralList(data, "search_results");
    recordGeneralList(data, "player");
    expect(loadGeneralList().entries[data.id]!.meta.seenCount).toBe(2);
  });

  it("accumulates distinct contexts", () => {
    const data = rtTrack("201");
    recordGeneralList(data, "search_results");
    recordGeneralList(data, "player");
    const contexts = loadGeneralList().entries[data.id]!.meta.contexts;
    expect(contexts).toContain("search_results");
    expect(contexts).toContain("player");
  });

  it("does not duplicate the same context", () => {
    const data = rtTrack("202");
    recordGeneralList(data, "search_results");
    recordGeneralList(data, "search_results");
    const contexts = loadGeneralList().entries[data.id]!.meta.contexts;
    expect(contexts.filter((c) => c === "search_results").length).toBe(1);
  });

  it("updates track data to latest version", () => {
    const data = rtTrack("203");
    recordGeneralList(data, "search_results");
    const updated = { ...data, coverUrl: "https://example.com/cover.jpg" };
    recordGeneralList(updated, "player");
    expect(loadGeneralList().entries[data.id]!.track.coverUrl).toBe("https://example.com/cover.jpg");
  });

  it("updates lastContext on repeat call", () => {
    const data = rtTrack("204");
    recordGeneralList(data, "search_results");
    recordGeneralList(data, "player");
    expect(loadGeneralList().entries[data.id]!.meta.lastContext).toBe("player");
  });

  it("preserves firstSeenAt across updates", () => {
    const data = rtTrack("205");
    recordGeneralList(data, "search_results");
    const first = loadGeneralList().entries[data.id]!.meta.firstSeenAt;
    recordGeneralList(data, "player");
    expect(loadGeneralList().entries[data.id]!.meta.firstSeenAt).toBe(first);
  });
});

describe("refreshGeneralListCache", () => {
  it("noop when entry does not exist", () => {
    refreshGeneralListCache("nonexistent");
    expect(loadGeneralList().entries["nonexistent"]).toBeUndefined();
  });

  it("re-probes cache and updates capturedAt", async () => {
    const data = rtTrack("300");
    recordGeneralList(data, "registered");
    const oldAt = loadGeneralList().entries[data.id]!.cache.capturedAt;
    await new Promise((r) => setTimeout(r, 2));
    refreshGeneralListCache(data.id);
    const newAt = loadGeneralList().entries[data.id]!.cache.capturedAt;
    expect(newAt).toBeGreaterThanOrEqual(oldAt);
  });

  it("preserves meta on refresh", () => {
    const data = rtTrack("301");
    recordGeneralList(data, "registered", "q");
    const before = loadGeneralList().entries[data.id]!.meta;
    refreshGeneralListCache(data.id);
    const after = loadGeneralList().entries[data.id]!.meta;
    expect(after.seenCount).toBe(before.seenCount);
    expect(after.lastSearchQuery).toBe("q");
  });
});

describe("removeGeneralListEntry", () => {
  it("removes the entry", () => {
    const data = rtTrack("400");
    recordGeneralList(data, "registered");
    removeGeneralListEntry(data.id);
    expect(loadGeneralList().entries[data.id]).toBeUndefined();
  });

  it("noop when entry does not exist", () => {
    removeGeneralListEntry("ghost");
    expect(loadGeneralList().entries["ghost"]).toBeUndefined();
  });

  it("does not remove other entries", () => {
    const a = rtTrack("401");
    const b = rtTrack("402");
    recordGeneralList(a, "registered");
    recordGeneralList(b, "registered");
    removeGeneralListEntry(a.id);
    expect(loadGeneralList().entries[b.id]).toBeDefined();
  });
});

describe("persistence — flush + reload", () => {
  it("persists to localStorage on flushGeneralList", () => {
    const data = rtTrack("500");
    recordGeneralList(data, "registered");
    flushGeneralList();
    const raw = fakeLocalStorage.get("neegde.generalList.v1");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw as string) as { entries: Record<string, unknown> };
    expect(parsed.entries[data.id]).toBeDefined();
  });

  it("reloads entries from localStorage after a cold start", () => {
    const data = rtTrack("501");
    recordGeneralList(data, "registered");
    flushGeneralList();
    // clearGeneralList resets both memory and localStorage; re-seed to simulate
    // that localStorage survived across an app restart.
    const saved = fakeLocalStorage.get("neegde.generalList.v1")!;
    clearGeneralList();
    fakeLocalStorage.set("neegde.generalList.v1", saved);
    expect(loadGeneralList().entries[data.id]).toBeDefined();
  });

  it("persisted file has schemaVersion: 1", () => {
    recordGeneralList(rtTrack("502"), "registered");
    flushGeneralList();
    const raw = JSON.parse(fakeLocalStorage.get("neegde.generalList.v1") as string) as { schemaVersion: number };
    expect(raw.schemaVersion).toBe(1);
  });

  it("debounced save writes to localStorage", async () => {
    recordGeneralList(rtTrack("503"), "registered");
    await new Promise((r) => setTimeout(r, 600));
    expect(fakeLocalStorage.has("neegde.generalList.v1")).toBe(true);
  });
});

describe("soulseek track entry", () => {
  it("creates entry for soulseek track", () => {
    const data = slskTrack();
    recordGeneralList(data, "search_results");
    expect(loadGeneralList().entries[data.id]).toBeDefined();
  });

  it("soulseekCover key absent when no raw.cover", () => {
    const data = slskTrack();
    recordGeneralList(data, "registered");
    expect(loadGeneralList().entries[data.id]!.cacheKeys.soulseekCover).toBeUndefined();
  });
});

describe("generalList schema integrity", () => {
  it("loaded file always has schemaVersion 1 and entries object", () => {
    const f = loadGeneralList();
    expect(f.schemaVersion).toBe(1);
    expect(typeof f.entries).toBe("object");
  });

  it("ignores stored data with wrong schemaVersion", () => {
    fakeLocalStorage.set("neegde.generalList.v1", JSON.stringify({ schemaVersion: 99, entries: { x: {} } }));
    const f = loadGeneralList();
    expect(f.entries["x"]).toBeUndefined();
  });
});
