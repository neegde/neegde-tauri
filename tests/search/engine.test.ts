import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";

// Mock resolver + providers BEFORE importing engine (vi.hoisted for fn refs).
const { mockResolveQuery, rutrackerSearch, soulseekSearch } = vi.hoisted(() => ({
  mockResolveQuery: vi.fn(),
  rutrackerSearch: vi.fn(),
  soulseekSearch: vi.fn(),
}));
vi.mock("../../src/search/resolver.js", () => ({
  resolveQuery: mockResolveQuery,
}));
vi.mock("../../src/search/providers/rutracker.js", () => ({
  rutrackerProvider: {
    kind: "rutracker",
    async *search(q: string) { yield* rutrackerSearch(q); },
  },
}));
vi.mock("../../src/search/providers/soulseek.js", () => ({
  soulseekProvider: {
    kind: "soulseek",
    async *search(q: string) { yield* soulseekSearch(q); },
  },
}));

// rAF shim so flushes happen deterministically.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queueMicrotask(() => cb(0));
    return 0 as unknown as number;
  });
  mockResolveQuery.mockReset();
  rutrackerSearch.mockReset();
  soulseekSearch.mockReset();
});

async function load() {
  const mod = await import("../../src/search/engine.js");
  return mod.createSearchEngine({});
}

describe("createSearchEngine — empty query", () => {
  it("returns an already-completed empty session without hitting resolver", async () => {
    const eng = await load();
    const session = await eng.query("", {});
    expect(mockResolveQuery).not.toHaveBeenCalled();
    await session.completed;
    expect(session.results.value).toEqual([]);
  });
});

describe("createSearchEngine — caching", () => {
  it("second call with same query+enabled returns same session", async () => {
    mockResolveQuery.mockResolvedValue({
      query: "x", canonical: null, candidates: [], intent: "raw", elapsed_ms: 10,
    });
    rutrackerSearch.mockImplementation(async function* () { yield [{ id: "r1" }]; });

    const eng = await load();
    const a = await eng.query("ABC", { rutracker: true });
    const b = await eng.query("ABC", { rutracker: true });
    expect(a).toBe(b);
    expect(mockResolveQuery).toHaveBeenCalledTimes(1);
  });

  it("skipResolver bypasses cache", async () => {
    rutrackerSearch.mockImplementation(async function* () { yield []; });
    const eng = await load();
    const a = await eng.query("x", { rutracker: true }, { skipResolver: true });
    const b = await eng.query("x", { rutracker: true }, { skipResolver: true });
    expect(a).not.toBe(b);
    expect(mockResolveQuery).not.toHaveBeenCalled();
  });

  it("different enabled set → different session", async () => {
    mockResolveQuery.mockResolvedValue({ query: "x", canonical: null, candidates: [], intent: "raw", elapsed_ms: 0 });
    rutrackerSearch.mockImplementation(async function* () { yield []; });
    soulseekSearch.mockImplementation(async function* () { yield []; });
    const eng = await load();
    const rtOnly = await eng.query("x", { rutracker: true });
    const both = await eng.query("x", { rutracker: true, soulseek: true });
    expect(rtOnly).not.toBe(both);
  });

  it("clearCache removes entries", async () => {
    mockResolveQuery.mockResolvedValue({ query: "x", canonical: null, candidates: [], intent: "raw", elapsed_ms: 0 });
    rutrackerSearch.mockImplementation(async function* () { yield []; });
    const eng = await load();
    const a = await eng.query("x", { rutracker: true });
    eng.clearCache();
    const b = await eng.query("x", { rutracker: true });
    expect(a).not.toBe(b);
  });

  it("exposes provider registry (read-only)", async () => {
    const eng = await load();
    expect(Object.keys(eng.providers)).toEqual(["rutracker", "soulseek"]);
  });
});

describe("createSearchEngine — resolver integration", () => {
  it("passes canonical Artist + Title to providers", async () => {
    mockResolveQuery.mockResolvedValue({
      query: "paranoid android",
      canonical: { artist: "Radiohead", title: "Paranoid Android" },
      candidates: [],
      intent: "track",
      elapsed_ms: 20,
    });
    rutrackerSearch.mockImplementation(async function* (q) { yield [{ id: `q:${q}` }]; });

    const eng = await load();
    const s = await eng.query("paranoid android", { rutracker: true });
    await s.completed;
    expect(rutrackerSearch).toHaveBeenCalledWith("Radiohead Paranoid Android");
  });

  it("strips (brackets) and [brackets] from canonical parts", async () => {
    mockResolveQuery.mockResolvedValue({
      query: "x",
      canonical: { artist: "Artist [RU]", title: "Song (Translation)" },
      candidates: [], intent: "track", elapsed_ms: 0,
    });
    rutrackerSearch.mockImplementation(async function* () { yield []; });
    const eng = await load();
    const s = await eng.query("x", { rutracker: true });
    await s.completed;
    expect(rutrackerSearch).toHaveBeenCalledWith("Artist Song");
  });

  it("empty canonical.title → artist-only query", async () => {
    mockResolveQuery.mockResolvedValue({
      query: "x",
      canonical: { artist: "Metallica", title: "" },
      candidates: [], intent: "artist", elapsed_ms: 0,
    });
    rutrackerSearch.mockImplementation(async function* () { yield []; });
    const eng = await load();
    const s = await eng.query("x", { rutracker: true });
    await s.completed;
    expect(rutrackerSearch).toHaveBeenCalledWith("Metallica");
  });

  it("no canonical → raw user input used", async () => {
    mockResolveQuery.mockResolvedValue({
      query: "x", canonical: null, candidates: [], intent: "raw", elapsed_ms: 0,
    });
    rutrackerSearch.mockImplementation(async function* () { yield []; });
    const eng = await load();
    const s = await eng.query("rawtext", { rutracker: true });
    await s.completed;
    expect(rutrackerSearch).toHaveBeenCalledWith("rawtext");
  });

  it("resolver error is swallowed; raw query used", async () => {
    mockResolveQuery.mockRejectedValue(new Error("net"));
    rutrackerSearch.mockImplementation(async function* () { yield []; });
    const eng = await load();
    const s = await eng.query("text", { rutracker: true });
    await s.completed;
    expect(rutrackerSearch).toHaveBeenCalledWith("text");
  });

  it("skipResolver → raw query direct to providers", async () => {
    rutrackerSearch.mockImplementation(async function* () { yield []; });
    const eng = await load();
    const s = await eng.query("literal", { rutracker: true }, { skipResolver: true });
    await s.completed;
    expect(mockResolveQuery).not.toHaveBeenCalled();
    expect(rutrackerSearch).toHaveBeenCalledWith("literal");
  });
});
