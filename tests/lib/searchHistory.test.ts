import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import {
  loadSearchHistory,
  addToSearchHistory,
  removeFromSearchHistory,
} from "../../src/lib/searchHistory.js";

beforeEach(() => fakeLocalStorage.clear());

describe("searchHistory", () => {
  it("empty when storage is empty", () => {
    expect(loadSearchHistory()).toEqual([]);
  });

  it("rejects malformed JSON", () => {
    fakeLocalStorage.set("neegde.searchHistory.v1", "{broken");
    expect(loadSearchHistory()).toEqual([]);
  });

  it("keeps only string entries", () => {
    fakeLocalStorage.set("neegde.searchHistory.v1", JSON.stringify(["a", 42, null, "b"]));
    expect(loadSearchHistory()).toEqual(["a", "b"]);
  });

  it("rejects non-array parse", () => {
    fakeLocalStorage.set("neegde.searchHistory.v1", JSON.stringify({ nope: true }));
    expect(loadSearchHistory()).toEqual([]);
  });

  it("adds + trims + bumps-to-front", () => {
    addToSearchHistory("alpha");
    addToSearchHistory("beta");
    const h = addToSearchHistory(" alpha ");
    expect(h).toEqual(["alpha", "beta"]);
  });

  it("empty query returns current history unchanged", () => {
    addToSearchHistory("alpha");
    expect(addToSearchHistory("")).toEqual(["alpha"]);
    expect(addToSearchHistory("   ")).toEqual(["alpha"]);
  });

  it("caps at 15", () => {
    for (let i = 0; i < 20; i++) addToSearchHistory(`q${i}`);
    const h = loadSearchHistory();
    expect(h).toHaveLength(15);
    expect(h[0]).toBe("q19");
  });

  it("remove strips matching query and persists", () => {
    addToSearchHistory("a");
    addToSearchHistory("b");
    const after = removeFromSearchHistory("a");
    expect(after).toEqual(["b"]);
    expect(loadSearchHistory()).toEqual(["b"]);
  });

  it("remove of missing query is a no-op", () => {
    addToSearchHistory("a");
    expect(removeFromSearchHistory("x")).toEqual(["a"]);
  });
});
