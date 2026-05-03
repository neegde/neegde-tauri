import { describe, it, expect, beforeEach } from "vitest";
import { mockInvoke } from "../_setup.js";

import {
  peekRutrackerCover,
  getCoverReactive,
  rememberRutrackerCover,
  getRutrackerCoverDataUrl,
  clearRutrackerCoverCache,
} from "../../src/rutracker/coverCache.js";

beforeEach(() => {
  clearRutrackerCoverCache();
  mockInvoke.mockReset();
});

describe("rutracker coverCache", () => {
  it("miss → undefined/null", () => {
    expect(peekRutrackerCover("1")).toBeUndefined();
    expect(getCoverReactive("1")).toBe(null);
  });
  it("remember → hit via peek", () => {
    rememberRutrackerCover("1", "data:image/png;base64,AAA");
    expect(peekRutrackerCover("1")).toBe("data:image/png;base64,AAA");
  });
  it("fetch invokes rutracker_get_cover with mirror", async () => {
    mockInvoke.mockResolvedValueOnce("data:image/png;base64,YYY");
    const url = await getRutrackerCoverDataUrl("42");
    expect(url).toBe("data:image/png;base64,YYY");
    expect(mockInvoke).toHaveBeenCalledWith("rutracker_get_cover", {
      mirror: "https://rutracker.test",
      topicId: "42",
    });
  });
  it("null response → negative cache", async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const url = await getRutrackerCoverDataUrl("7");
    expect(url).toBe(null);
    expect(peekRutrackerCover("7")).toBe(null);
  });
  it("invoke throw → negative", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("404"));
    const url = await getRutrackerCoverDataUrl("z");
    expect(url).toBe(null);
  });
  it("clearRutrackerCoverCache wipes", () => {
    rememberRutrackerCover("1", "data:X");
    clearRutrackerCoverCache();
    expect(peekRutrackerCover("1")).toBeUndefined();
  });
});
