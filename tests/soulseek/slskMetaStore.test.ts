import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";

import {
  slskMeta,
  coverGeneration,
  bumpCoverGeneration,
  setCoverTimer,
  clearCoverTimer,
} from "../../src/soulseek/slskMetaStore.js";

beforeEach(() => {
  slskMeta.clear();
  vi.useRealTimers();
});

describe("slskMetaStore", () => {
  it("slskMeta is an empty reactive Map initially", () => {
    expect(slskMeta.size).toBe(0);
  });

  it("map stores/retrieves records", () => {
    slskMeta.set("slsk:track:u|f.mp3", { artist: "A", title: "T" });
    expect(slskMeta.get("slsk:track:u|f.mp3")?.artist).toBe("A");
  });

  it("bumpCoverGeneration increments monotonically", () => {
    const before = coverGeneration;
    const a = bumpCoverGeneration();
    const b = bumpCoverGeneration();
    expect(a).toBe(before + 1);
    expect(b).toBe(before + 2);
  });

  it("setCoverTimer / clearCoverTimer interact with setTimeout", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const id = setTimeout(spy, 100);
    setCoverTimer(id);
    clearCoverTimer();
    vi.advanceTimersByTime(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it("clearCoverTimer on null timer is safe", () => {
    clearCoverTimer();
    clearCoverTimer();
    expect(true).toBe(true);
  });
});
