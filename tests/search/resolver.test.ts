import { describe, it, expect, vi } from "vitest";
import { mockInvoke } from "../_setup.js";

import { resolveQuery } from "../../src/search/resolver.js";

describe("resolveQuery", () => {
  it("forwards the query through invoke('resolve_query')", async () => {
    mockInvoke.mockResolvedValueOnce({
      query: "metallica",
      canonical: { artist: "Metallica", title: "One" },
      candidates: [],
      intent: "track",
      elapsed_ms: 120,
    });
    const out = await resolveQuery("metallica");
    expect(mockInvoke).toHaveBeenCalledWith("resolve_query", { query: "metallica" });
    expect(out.canonical?.artist).toBe("Metallica");
  });
  it("returns the raw fallback shape when resolver finds nothing", async () => {
    mockInvoke.mockResolvedValueOnce({
      query: "gibberish",
      canonical: null,
      candidates: [],
      intent: "raw",
      elapsed_ms: 40,
    });
    const out = await resolveQuery("gibberish");
    expect(out.intent).toBe("raw");
    expect(out.canonical).toBeNull();
  });
  it("propagates IPC errors", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("ipc boom"));
    await expect(resolveQuery("x")).rejects.toThrow(/ipc boom/);
  });
});
