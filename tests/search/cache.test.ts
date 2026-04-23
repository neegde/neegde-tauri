import { describe, it, expect } from "vitest";
import "../_setup.js";
import { SessionCache } from "../../src/search/cache.js";

describe("SessionCache", () => {
  it("miss returns undefined", () => {
    const c = new SessionCache<number>();
    expect(c.get("x")).toBeUndefined();
  });

  it("hit returns value", () => {
    const c = new SessionCache<number>();
    c.set("x", 42);
    expect(c.get("x")).toBe(42);
  });

  it("overwrites same key without growing size", () => {
    const c = new SessionCache<number>(2);
    c.set("a", 1);
    c.set("a", 2);
    c.set("b", 3);
    c.set("c", 4); // pushes over cap — oldest non-touched is "a" (re-inserted at set) so still capped
    // The LRU after chain: a(set)→b→c → a evicted when c pushed
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(3);
    expect(c.get("c")).toBe(4);
  });

  it("LRU: get() promotes key", () => {
    const c = new SessionCache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");       // touch a → now b is oldest
    c.set("c", 3);    // evict b
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe(3);
  });

  it("clear wipes all", () => {
    const c = new SessionCache<number>();
    c.set("a", 1); c.set("b", 2);
    c.clear();
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBeUndefined();
  });

  it("respects max=1 (degenerate cap)", () => {
    const c = new SessionCache<number>(1);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
  });

  it("default max is 30", () => {
    const c = new SessionCache<number>();
    expect(c.max).toBe(30);
  });
});
