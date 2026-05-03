import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeLocalStorage, mockInvoke } from "../_setup.js";

// Override the global mock of rutracker/config.js so we test the real module.
vi.unmock("../../src/rutracker/config.js");

const cfg = await vi.importActual<typeof import("../../src/rutracker/config.js")>(
  "../../src/rutracker/config.js",
);

beforeEach(() => {
  fakeLocalStorage.clear();
  mockInvoke.mockReset();
  cfg.resetMirror();
});

describe("rutracker/config — mode", () => {
  it("default mode is manual", () => {
    fakeLocalStorage.clear();
    expect(cfg.getMirrorMode()).toBe(cfg.MIRROR_MODE_MANUAL);
  });
  it("setMirrorMode persists to storage", () => {
    cfg.setMirrorMode(cfg.MIRROR_MODE_AUTO);
    expect(cfg.getMirrorMode()).toBe(cfg.MIRROR_MODE_AUTO);
  });
});

describe("rutracker/config — mirror (manual)", () => {
  it("default is DEFAULT_MIRROR", () => {
    expect(cfg.getMirror()).toBe(cfg.DEFAULT_MIRROR);
  });
  it("custom mirror round-trips", () => {
    cfg.setMirror("https://mine.example/");
    expect(cfg.getMirror()).toBe("https://mine.example");
  });
  it("empty string resets to default", () => {
    cfg.setMirror("https://x");
    cfg.setMirror("");
    expect(cfg.getMirror()).toBe(cfg.DEFAULT_MIRROR);
  });
  it("hasCustomMirror reflects manual+custom", () => {
    cfg.setMirror("https://x");
    expect(cfg.hasCustomMirror()).toBe(true);
    cfg.setMirror("");
    expect(cfg.hasCustomMirror()).toBe(false);
  });
});

describe("rutracker/config — auto mode", () => {
  it("probeMirrorsNow invokes rutracker_pick_mirror and caches result", async () => {
    mockInvoke.mockResolvedValueOnce("https://auto.example");
    const p = await cfg.probeMirrorsNow();
    expect(p).toBe("https://auto.example");
    expect(mockInvoke).toHaveBeenCalledWith("rutracker_pick_mirror", {
      candidates: cfg.KNOWN_MIRRORS,
    });
    cfg.setMirrorMode(cfg.MIRROR_MODE_AUTO);
    expect(cfg.getMirror()).toBe("https://auto.example");
    expect(cfg.getLastResolvedMirror()).toBe("https://auto.example");
  });

  it("resolveMirrorIfNeeded is a no-op in manual mode", async () => {
    await cfg.resolveMirrorIfNeeded();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("resolveMirrorIfNeeded invokes in auto mode and caches", async () => {
    cfg.setMirrorMode(cfg.MIRROR_MODE_AUTO);
    mockInvoke.mockResolvedValueOnce("https://picked.example");
    await cfg.resolveMirrorIfNeeded();
    expect(cfg.getMirror()).toBe("https://picked.example");
  });

  it("resolveMirrorIfNeeded falls back to stored or default on error", async () => {
    cfg.setMirrorMode(cfg.MIRROR_MODE_AUTO);
    mockInvoke.mockRejectedValueOnce(new Error("dns"));
    await cfg.resolveMirrorIfNeeded();
    expect(cfg.getMirror()).toBe(cfg.DEFAULT_MIRROR);
  });

  it("hasCustomMirror is true in auto mode", () => {
    cfg.setMirrorMode(cfg.MIRROR_MODE_AUTO);
    expect(cfg.hasCustomMirror()).toBe(true);
  });
});

describe("rutracker/config — resetMirror", () => {
  it("clears manual + auto state", async () => {
    cfg.setMirror("https://x");
    cfg.setMirrorMode(cfg.MIRROR_MODE_AUTO);
    cfg.resetMirror();
    expect(cfg.getMirrorMode()).toBe(cfg.MIRROR_MODE_MANUAL);
    expect(cfg.getMirror()).toBe(cfg.DEFAULT_MIRROR);
    expect(cfg.getLastResolvedMirror()).toBe(null);
  });
});
