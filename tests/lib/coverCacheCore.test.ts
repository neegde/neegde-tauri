import { describe, it, expect, vi, beforeEach } from "vitest";
import "../_setup.js";
import { makeCoverCache } from "../../src/lib/coverCacheCore.js";

beforeEach(() => {
  vi.useRealTimers();
});

// ── peek / remember / get ─────────────────────────────────────────────────

describe("makeCoverCache basics", () => {
  it("peek returns undefined on miss, positive URL on hit", () => {
    const c = makeCoverCache({ fetch: async () => null });
    expect(c.peek("k")).toBeUndefined();
    c.remember("k", "data:X");
    expect(c.peek("k")).toBe("data:X");
  });

  it("getReactive returns null on miss", () => {
    const c = makeCoverCache({ fetch: async () => null });
    expect(c.getReactive("missing")).toBe(null);
  });

  it("remember(null) does NOT remove an existing positive", () => {
    const c = makeCoverCache({ fetch: async () => null });
    c.remember("k", "data:X");
    c.remember("k", null);                  // ← the key test: failure must not nuke the cover
    expect(c.peek("k")).toBe("data:X");
    expect(c.getReactive("k")).toBe("data:X");
  });

  it("remember(null) on fresh key stores a negative TTL entry", () => {
    const c = makeCoverCache({ fetch: async () => null });
    c.remember("k", null);
    expect(c.peek("k")).toBe(null);         // null = negative cache still active
  });

  it("negative TTL expires and next peek is a miss", () => {
    vi.useFakeTimers();
    const c = makeCoverCache({ fetch: async () => null, negativeTtlMs: 1000 });
    c.remember("k", null);
    expect(c.peek("k")).toBe(null);

    vi.advanceTimersByTime(1001);
    expect(c.peek("k")).toBeUndefined();    // TTL expired → cache miss, next fetch allowed
  });

  it("positive can be written after negative TTL", () => {
    vi.useFakeTimers();
    const c = makeCoverCache({ fetch: async () => null, negativeTtlMs: 500 });
    c.remember("k", null);
    expect(c.peek("k")).toBe(null);

    vi.advanceTimersByTime(501);
    c.remember("k", "data:recovered");
    expect(c.peek("k")).toBe("data:recovered");
    expect(c.getReactive("k")).toBe("data:recovered");
  });
});

// ── Soft eviction ──────────────────────────────────────────────────────────

describe("makeCoverCache eviction", () => {
  it("evicts oldest when exceeding maxEntries", () => {
    const c = makeCoverCache({ fetch: async () => null, maxEntries: 3 });
    c.remember("a", "A"); c.remember("b", "B"); c.remember("c", "C");
    expect(c.peek("a")).toBe("A");
    c.remember("d", "D");                   // overflow — a is oldest, gets evicted
    expect(c.peek("a")).toBeUndefined();
    expect(c.peek("d")).toBe("D");
  });

  it("evicts on byte cap", () => {
    const c = makeCoverCache({ fetch: async () => null, maxEntries: 1000, maxBytes: 10 });
    c.remember("a", "AAAAA");               // 5 bytes
    c.remember("b", "BBBBB");               // total 10
    c.remember("c", "CCCCC");               // pushes over cap → evict oldest
    expect(c.peek("a")).toBeUndefined();
    expect(c.peek("c")).toBe("CCCCC");
  });

  it("overwriting an existing positive does not grow totalBytes", () => {
    const c = makeCoverCache({ fetch: async () => null, maxEntries: 2, maxBytes: 20 });
    c.remember("a", "12345");
    c.remember("a", "67890");               // same key → replace, no growth
    c.remember("b", "abcde");
    c.remember("c", "xyzxy");               // total exceeds cap → a oldest gets evicted
    expect(c.peek("a")).toBeUndefined();
    expect(c.peek("b")).toBe("abcde");
    expect(c.peek("c")).toBe("xyzxy");
  });
});

// ── getOrFetch / dedup / concurrency gate ──────────────────────────────────

describe("makeCoverCache getOrFetch", () => {
  it("returns cached positive immediately without calling fetch", async () => {
    const fetchFn = vi.fn(async () => "fresh");
    const c = makeCoverCache({ fetch: fetchFn });
    c.remember("k", "cached");
    expect(await c.getOrFetch("k")).toBe("cached");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("dedupes concurrent requests to the same key", async () => {
    let resolveIt: (v: string) => void = () => {};
    const fetchFn = vi.fn(() => new Promise<string>((r) => { resolveIt = r; }));
    const c = makeCoverCache({ fetch: fetchFn });

    const p1 = c.getOrFetch("k");
    const p2 = c.getOrFetch("k");

    // Let the async IIFE reach `await networkFetch(key)` so fetchFn is called.
    await Promise.resolve(); await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    resolveIt("shared");
    expect(await p1).toBe("shared");
    expect(await p2).toBe("shared");
  });

  it("writes result to cache after successful fetch", async () => {
    const c = makeCoverCache({ fetch: async () => "new" });
    await c.getOrFetch("k");
    expect(c.peek("k")).toBe("new");
  });

  it("writes negative on fetch throw, without nuking a prior positive", async () => {
    const c = makeCoverCache({ fetch: async () => { throw new Error("boom"); }, negativeTtlMs: 1000 });
    c.remember("k", "prior");
    await c.getOrFetch("keyB");               // throws → negative
    expect(c.peek("keyB")).toBe(null);
    expect(c.peek("k")).toBe("prior");        // unrelated positive untouched
  });

  it("concurrency gate serialises fetches beyond maxConcurrent", async () => {
    const inflight: Array<(v: string) => void> = [];
    const fetchFn = vi.fn((_k: string) => new Promise<string>((r) => { inflight.push(r); }));
    const c = makeCoverCache({ fetch: fetchFn, maxConcurrent: 2 });

    const p1 = c.getOrFetch("a");
    const p2 = c.getOrFetch("b");
    const p3 = c.getOrFetch("c");

    // Wait one microtask so the two gated fetches reach invoke
    await Promise.resolve(); await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(2);  // "c" blocked on the gate

    inflight[0]?.("A");
    await p1;
    // After one release, c should now enter fetch
    await Promise.resolve(); await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(3);

    inflight[1]?.("B"); inflight[2]?.("C");
    expect(await p2).toBe("B");
    expect(await p3).toBe("C");
  });
});

// ── clear ──────────────────────────────────────────────────────────────────

describe("makeCoverCache clear", () => {
  it("wipes everything — positives, negatives, pending", () => {
    const c = makeCoverCache({ fetch: async () => null });
    c.remember("pos", "data:A");
    c.remember("neg", null);
    expect(c.peek("pos")).toBe("data:A");
    expect(c.peek("neg")).toBe(null);
    c.clear();
    expect(c.peek("pos")).toBeUndefined();
    expect(c.peek("neg")).toBeUndefined();
  });
});
