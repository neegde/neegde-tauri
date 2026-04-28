import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import {
  loadRecentHistory,
  addToRecentHistory,
  removeFromRecentHistory,
} from "../../src/lib/recentHistory.js";

beforeEach(() => fakeLocalStorage.clear());
afterEach(() => vi.useRealTimers());

describe("recentHistory", () => {
  it("empty when storage is empty", () => {
    expect(loadRecentHistory()).toEqual([]);
  });

  it("rejects malformed JSON gracefully", () => {
    fakeLocalStorage.set("neegde.recentHistory.v1", "this is not json");
    expect(loadRecentHistory()).toEqual([]);
  });

  it("rejects non-array parsed JSON", () => {
    fakeLocalStorage.set("neegde.recentHistory.v1", JSON.stringify({ foo: 1 }));
    expect(loadRecentHistory()).toEqual([]);
  });

  it("adds an entry with openedAt timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const h = addToRecentHistory({ id: "t1", name: "A", source: "rutracker" });
    expect(h).toHaveLength(1);
    expect(h[0]?.openedAt).toBe(new Date("2024-01-01T00:00:00Z").getTime());
  });

  it("bumps existing entry to the front (dedup by id)", () => {
    addToRecentHistory({ id: "t1", name: "A", source: "rutracker" });
    addToRecentHistory({ id: "t2", name: "B", source: "rutracker" });
    const h = addToRecentHistory({ id: "t1", name: "A-updated", source: "rutracker" });
    expect(h.map((e) => e.id)).toEqual(["t1", "t2"]);
    expect(h[0]?.name).toBe("A-updated");
  });

  it("caps history at 20 entries", () => {
    for (let i = 0; i < 25; i++) addToRecentHistory({ id: `t${i}`, name: "n", source: "rutracker" });
    const h = loadRecentHistory();
    expect(h).toHaveLength(20);
    expect(h[0]?.id).toBe("t24");
    expect(h[19]?.id).toBe("t5");
  });

  it("remove strips by id and persists", () => {
    addToRecentHistory({ id: "t1", name: "A", source: "rutracker" });
    addToRecentHistory({ id: "t2", name: "B", source: "rutracker" });
    const after = removeFromRecentHistory("t1");
    expect(after.map((e) => e.id)).toEqual(["t2"]);
    expect(loadRecentHistory().map((e) => e.id)).toEqual(["t2"]);
  });

  it("remove of missing id is a no-op", () => {
    addToRecentHistory({ id: "t1", name: "A", source: "rutracker" });
    const after = removeFromRecentHistory("nope");
    expect(after.map((e) => e.id)).toEqual(["t1"]);
  });
});
