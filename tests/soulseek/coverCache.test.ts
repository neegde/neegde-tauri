import { describe, it, expect, beforeEach } from "vitest";
import { mockInvoke } from "../_setup.js";

import {
  slskCoverKey,
  peekSlskCover,
  getSlskCoverReactive,
  rememberSlskCover,
  getSlskCoverDataUrl,
  clearSlskCoverCache,
} from "../../src/soulseek/coverCache.js";

beforeEach(() => {
  clearSlskCoverCache();
  mockInvoke.mockReset();
});

describe("slskCoverKey", () => {
  it("joins user and filepath with \\n", () => {
    expect(slskCoverKey("u", "music/a.jpg")).toBe("u\nmusic/a.jpg");
  });
  it("normalises backslashes to forward slashes", () => {
    expect(slskCoverKey("u", "a\\b\\c.jpg")).toBe("u\na/b/c.jpg");
  });
  it("stringifies missing filepath", () => {
    expect(slskCoverKey("u", null)).toBe("u\n");
  });
});

describe("slsk coverCache — remember / peek / reactive", () => {
  it("peek returns undefined on miss", () => {
    expect(peekSlskCover("u", "f.jpg")).toBeUndefined();
  });
  it("remember stores + peek reads", () => {
    rememberSlskCover("u", "f.jpg", "data:image/png;base64,AAA");
    expect(peekSlskCover("u", "f.jpg")).toBe("data:image/png;base64,AAA");
  });
  it("getReactive returns null on miss", () => {
    expect(getSlskCoverReactive("u", "f.jpg")).toBe(null);
  });
});

describe("slsk coverCache — getOrFetch with invoke", () => {
  it("invokes soulseek_cover_preview and caches result", async () => {
    mockInvoke.mockResolvedValueOnce({ mime: "image/png", base64: "ZZZ" });
    const got = await getSlskCoverDataUrl("user", "music/a.jpg", 1024);
    expect(got).toBe("data:image/png;base64,ZZZ");
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_cover_preview", {
      username: "user", filepath: "music/a.jpg", filesize: 1024,
    });
    // second call: cache hit, no new invoke.
    const again = await getSlskCoverDataUrl("user", "music/a.jpg", 1024);
    expect(again).toBe("data:image/png;base64,ZZZ");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("null response → negative cache (next call re-fetches after TTL... but within TTL peek returns null)", async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const got = await getSlskCoverDataUrl("u", "x.jpg", 0);
    expect(got).toBe(null);
    expect(peekSlskCover("u", "x.jpg")).toBe(null);
  });

  it("invoke throw → negative cache", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("peer dead"));
    const got = await getSlskCoverDataUrl("u", "y.jpg", 0);
    expect(got).toBe(null);
  });

  it("clearSlskCoverCache wipes state", async () => {
    rememberSlskCover("u", "f.jpg", "data:X");
    clearSlskCoverCache();
    expect(peekSlskCover("u", "f.jpg")).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledWith("slsk_cover_disk_cache_clear");
  });
});
