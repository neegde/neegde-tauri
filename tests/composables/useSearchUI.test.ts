import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { ref } from "vue";

// Mock the search engine so the store doesn't go to real providers.
const { mockEngineQuery } = vi.hoisted(() => ({ mockEngineQuery: vi.fn() }));
vi.mock("../../src/search/engine.js", () => ({
  createSearchEngine: () => ({ query: mockEngineQuery }),
}));

import { useSearchUI } from "../../src/composables/useSearchUI.js";
import { resetSearch } from "../../src/stores/search.js";
import { clearEntities } from "../../src/stores/entities.js";

function makeSession(query = "") {
  return {
    results: ref([]),
    providerStatus: ref({ rutracker: "done", soulseek: "done" }),
    providerError: ref({ rutracker: null, soulseek: null }),
    resolved: null,
    query,
  };
}

beforeEach(() => {
  mockEngineQuery.mockReset();
  resetSearch();
  clearEntities();
});

describe("useSearchUI — handleSearchCandidate", () => {
  function mountComposable() {
    const reset = vi.fn();
    const api = useSearchUI({
      resetViewForSearch: reset,
      authFlags: () => ({ rtLoggedIn: true, slskConnected: true }),
      searchHistory: ref<string[]>([]),
    });
    return { api, reset };
  }

  it("dispatches 'Artist - Title' with skipResolver=true", async () => {
    mockEngineQuery.mockResolvedValue(makeSession("Artist - Title"));
    const { api } = mountComposable();
    await api.handleSearchCandidate({ artist: "Artist", title: "Title" });
    expect(api.searchQuery.value).toBe("Artist - Title");
    expect(mockEngineQuery).toHaveBeenCalledWith(
      "Artist - Title",
      { rutracker: true, soulseek: true },
      { skipResolver: true },
    );
  });

  it("falls back to artist-only when title is missing", async () => {
    mockEngineQuery.mockResolvedValue(makeSession("Solo"));
    const { api } = mountComposable();
    await api.handleSearchCandidate({ artist: "Solo", title: "" });
    expect(api.searchQuery.value).toBe("Solo");
    expect(mockEngineQuery).toHaveBeenCalledWith(
      "Solo",
      { rutracker: true, soulseek: true },
      { skipResolver: true },
    );
  });

  it("treats null/empty artist as a no-op", async () => {
    const { api } = mountComposable();
    await api.handleSearchCandidate({ artist: "", title: "Title" });
    await api.handleSearchCandidate({ artist: "   ", title: "Title" });
    expect(mockEngineQuery).not.toHaveBeenCalled();
  });

  it("toggles homeSearchActive on so the results panel can render", async () => {
    mockEngineQuery.mockResolvedValue(makeSession("X - Y"));
    const { api } = mountComposable();
    expect(api.homeSearchActive.value).toBe(false);
    await api.handleSearchCandidate({ artist: "X", title: "Y" });
    expect(api.homeSearchActive.value).toBe(true);
  });
});
