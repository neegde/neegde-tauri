import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { ref } from "vue";

// Mock the search engine BEFORE importing the store. vi.mock is hoisted to
// the top of the file, so the fn must be created inside a vi.hoisted() block.
const { mockEngineQuery } = vi.hoisted(() => ({ mockEngineQuery: vi.fn() }));
vi.mock("../../src/search/engine.js", () => ({
  createSearchEngine: () => ({ query: mockEngineQuery }),
}));

import {
  searchEntities,
  searchLoadingRt,
  searchLoadingSlsk,
  searchResolving,
  searchError,
  searchRtError,
  searchSlskError,
  searchResultsEpoch,
  searchProviderQuery,
  runSearch,
  resetSearch,
} from "../../src/stores/search.js";
import { clearEntities } from "../../src/stores/entities.js";

function makeSession(overrides: Partial<{
  results: unknown[];
  providerStatus: Record<string, string>;
  providerError: Record<string, string | null>;
  resolved: unknown;
  query: string;
}> = {}) {
  return {
    results: ref(overrides.results ?? []),
    providerStatus: ref(overrides.providerStatus ?? { rutracker: "done", soulseek: "done" }),
    providerError: ref(overrides.providerError ?? { rutracker: null, soulseek: null }),
    resolved: overrides.resolved ?? null,
    query: overrides.query ?? "",
  };
}

beforeEach(() => {
  mockEngineQuery.mockReset();
  resetSearch();
  clearEntities();
});

describe("runSearch — empty query", () => {
  it("empty string resets state + does not hit engine", async () => {
    searchError.value = "stale";
    await runSearch("", { rtLoggedIn: true, slskConnected: true });
    expect(mockEngineQuery).not.toHaveBeenCalled();
    expect(searchEntities.value).toEqual([]);
    expect(searchError.value).toBe(null);
    expect(searchResolving.value).toBe(false);
  });
  it("whitespace-only query behaves as empty", async () => {
    await runSearch("   ", { rtLoggedIn: true, slskConnected: true });
    expect(mockEngineQuery).not.toHaveBeenCalled();
  });
  it("null query behaves as empty", async () => {
    await runSearch(null, { rtLoggedIn: false, slskConnected: false });
    expect(mockEngineQuery).not.toHaveBeenCalled();
  });
});

describe("runSearch — happy path", () => {
  it("sets preemptive loading flags then clears on session apply", async () => {
    const session = makeSession({
      results: [{ type: "album", id: "alb-1", title: "A", trackIds: [], sources: [{ kind: "rutracker", refs: {} }] }],
    });
    mockEngineQuery.mockResolvedValueOnce(session);
    await runSearch("the query", { rtLoggedIn: true, slskConnected: false });

    expect(mockEngineQuery).toHaveBeenCalledTimes(1);
    expect(mockEngineQuery).toHaveBeenCalledWith(
      "the query",
      { rutracker: true, soulseek: false },
      { skipResolver: false },
    );
    expect(searchResolving.value).toBe(false);
    expect(searchEntities.value).toHaveLength(1);
    expect(searchLoadingRt.value).toBe(false);
    expect(searchLoadingSlsk.value).toBe(false);
    expect(searchError.value).toBe(null);
  });

  it("bumps searchResultsEpoch on each call", async () => {
    mockEngineQuery.mockResolvedValue(makeSession());
    const before = searchResultsEpoch.value;
    await runSearch("a", { rtLoggedIn: true, slskConnected: false });
    await runSearch("b", { rtLoggedIn: true, slskConnected: false });
    expect(searchResultsEpoch.value).toBe(before + 2);
  });

  it("passes skipResolver through", async () => {
    mockEngineQuery.mockResolvedValue(makeSession());
    await runSearch("q", { rtLoggedIn: true, slskConnected: true }, { skipResolver: true });
    expect(mockEngineQuery).toHaveBeenCalledWith(
      "q",
      { rutracker: true, soulseek: true },
      { skipResolver: true },
    );
  });

  it("uses resolved provider query when session supplies one", async () => {
    mockEngineQuery.mockResolvedValue(makeSession({ query: "canonical" }));
    await runSearch("raw", { rtLoggedIn: true, slskConnected: false });
    expect(searchProviderQuery.value).toBe("canonical");
  });

  it("falls back to trimmed input when session.query is empty", async () => {
    mockEngineQuery.mockResolvedValue(makeSession({ query: "" }));
    await runSearch("  raw  ", { rtLoggedIn: true, slskConnected: false });
    expect(searchProviderQuery.value).toBe("raw");
  });
});

describe("runSearch — empty results error messaging", () => {
  it("no auth + empty results → no error", async () => {
    mockEngineQuery.mockResolvedValue(makeSession({ results: [] }));
    await runSearch("q", { rtLoggedIn: false, slskConnected: false });
    expect(searchError.value).toBe(null);
  });

  it("logged in + no results → 'Ничего не найдено.'", async () => {
    mockEngineQuery.mockResolvedValue(makeSession({ results: [] }));
    await runSearch("q", { rtLoggedIn: true, slskConnected: false });
    expect(searchError.value).toBe("Ничего не найдено.");
  });

  it("logged in + provider error → propagates", async () => {
    mockEngineQuery.mockResolvedValue(makeSession({
      results: [],
      providerError: { rutracker: "RT is down", soulseek: null },
    }));
    await runSearch("q", { rtLoggedIn: true, slskConnected: false });
    expect(searchRtError.value).toBe("RT is down");
    expect(searchError.value).toBe("RT is down");
  });

  it("soulseek error surfaces when rutracker is null", async () => {
    mockEngineQuery.mockResolvedValue(makeSession({
      results: [],
      providerError: { rutracker: null, soulseek: "SLSK dead" },
    }));
    await runSearch("q", { rtLoggedIn: false, slskConnected: true });
    expect(searchSlskError.value).toBe("SLSK dead");
    expect(searchError.value).toBe("SLSK dead");
  });
});

describe("runSearch — session cancellation", () => {
  it("later search supersedes earlier in-flight", async () => {
    // First call: queryPromise that never resolves until we say so.
    let resolveA: (v: unknown) => void = () => {};
    const sessionA = makeSession({ query: "A" });
    const promiseA = new Promise<unknown>((r) => { resolveA = r; });
    mockEngineQuery.mockReturnValueOnce(promiseA);

    const runA = runSearch("A", { rtLoggedIn: true, slskConnected: false });
    // Kick a second call before A resolves.
    mockEngineQuery.mockResolvedValueOnce(makeSession({ query: "B" }));
    const runB = runSearch("B", { rtLoggedIn: true, slskConnected: false });

    // Resolve A's engine — but the store should drop it.
    resolveA(sessionA);
    await runA;
    await runB;

    expect(searchProviderQuery.value).toBe("B");
  });
});

describe("resetSearch", () => {
  it("clears entities + flags without hitting engine", () => {
    searchEntities.value = [{ id: "x", type: "track" } as unknown as never];
    searchError.value = "err";
    resetSearch();
    expect(searchEntities.value).toEqual([]);
    expect(searchError.value).toBe(null);
    expect(mockEngineQuery).not.toHaveBeenCalled();
  });
});
