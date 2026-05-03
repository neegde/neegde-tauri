import { describe, it, expect, afterEach, vi } from "vitest";
import "./_setup.js";

import {
  normalizeVersionTag, compareSemver, fetchLatestGithubRelease,
} from "../src/githubReleaseCheck.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("normalizeVersionTag", () => {
  it("strips leading v/V", () => {
    expect(normalizeVersionTag("v1.2.3")).toBe("1.2.3");
    expect(normalizeVersionTag("V2.0")).toBe("2.0");
    expect(normalizeVersionTag("1.0")).toBe("1.0");
    expect(normalizeVersionTag("  v1.1  ")).toBe("1.1");
  });
  it("empty stays empty", () => {
    expect(normalizeVersionTag("")).toBe("");
  });
});

describe("compareSemver", () => {
  it("segments compared numerically", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareSemver("1.10.0", "1.9.9")).toBeGreaterThan(0);
  });
  it("missing segments treated as 0", () => {
    expect(compareSemver("1.0", "1.0.1")).toBeLessThan(0);
    expect(compareSemver("1", "1.0.0")).toBe(0);
  });
  it("strips pre-release + build metadata", () => {
    expect(compareSemver("1.2.3-beta", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3+meta", "1.2.3")).toBe(0);
  });
  it("ignores non-numeric segments", () => {
    expect(compareSemver("1.x.3", "1.0.3")).toBe(0);
  });
  it("accepts 'v' prefix", () => {
    expect(compareSemver("v1.1", "1.1")).toBe(0);
  });
});

describe("fetchLatestGithubRelease", () => {
  it("null when no apiUrl", async () => {
    expect(await fetchLatestGithubRelease("")).toBeNull();
  });
  it("parses tag_name + html_url", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v2.0.1", html_url: "https://gh/x" }),
    }) as unknown as typeof fetch;
    const r = await fetchLatestGithubRelease("https://api/x");
    expect(r?.tagName).toBe("v2.0.1");
    expect(r?.htmlUrl).toBe("https://gh/x");
  });
  it("404 → null (not found)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 404, ok: false }) as unknown as typeof fetch;
    expect(await fetchLatestGithubRelease("https://api/x")).toBeNull();
  });
  it("non-OK non-404 → rejects", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 500, ok: false }) as unknown as typeof fetch;
    await expect(fetchLatestGithubRelease("https://api/x")).rejects.toThrow(/GitHub API/);
  });
  it("network error → rejects", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("net")) as unknown as typeof fetch;
    await expect(fetchLatestGithubRelease("https://api/x")).rejects.toThrow(/net/);
  });
  it("malformed json → null", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ foo: "bar" }),
    }) as unknown as typeof fetch;
    expect(await fetchLatestGithubRelease("https://api/x")).toBeNull();
  });
});
