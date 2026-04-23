import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import {
  loadAchievementsOptIn, saveAchievementsOptIn,
  loadAchievementsState, saveAchievementsState,
  emptyAchievementsProgress,
} from "../../src/achievements/achievementsStorage.js";

import {
  ACHIEVEMENT_CATALOG, achievementMeta,
  applyPlaybackStarted, applyRetroactiveOptIn, applyLikeChange,
} from "../../src/achievements/achievementsCore.js";

beforeEach(() => fakeLocalStorage.clear());

describe("achievementsStorage — opt-in", () => {
  it("defaults off", () => {
    expect(loadAchievementsOptIn()).toBe(false);
  });
  it("save+load round-trip", () => {
    saveAchievementsOptIn(true);
    expect(loadAchievementsOptIn()).toBe(true);
    saveAchievementsOptIn(false);
    expect(loadAchievementsOptIn()).toBe(false);
  });
});

describe("achievementsStorage — state", () => {
  it("empty when no storage", () => {
    expect(loadAchievementsState()).toEqual({ unlocked: [], hasPlayedTrack: false });
  });
  it("rejects malformed json", () => {
    fakeLocalStorage.set("neegde.achievements.state.v1", "not json");
    expect(loadAchievementsState()).toEqual({ unlocked: [], hasPlayedTrack: false });
  });
  it("ignores non-string items in unlocked[]", () => {
    fakeLocalStorage.set(
      "neegde.achievements.state.v1",
      JSON.stringify({ unlocked: ["a", 1, null, "b"], hasPlayedTrack: true }),
    );
    expect(loadAchievementsState()).toEqual({ unlocked: ["a", "b"], hasPlayedTrack: true });
  });
  it("save persists + round-trip", () => {
    saveAchievementsState({ unlocked: ["first_sound"], hasPlayedTrack: true });
    expect(loadAchievementsState()).toEqual({ unlocked: ["first_sound"], hasPlayedTrack: true });
  });
  it("empty progress helper", () => {
    expect(emptyAchievementsProgress()).toEqual({ unlocked: [], hasPlayedTrack: false });
  });
  it("rejects non-object parsed value", () => {
    fakeLocalStorage.set("neegde.achievements.state.v1", JSON.stringify(42));
    expect(loadAchievementsState()).toEqual({ unlocked: [], hasPlayedTrack: false });
  });
});

describe("achievementsCore — catalog", () => {
  it("catalog has the 3 advertised ids", () => {
    expect(ACHIEVEMENT_CATALOG.map((a) => a.id))
      .toEqual(["first_sound", "first_heart", "same_track_1000_min"]);
  });
  it("meta lookup", () => {
    expect(achievementMeta("first_sound")?.title).toMatch(/Первый звук/);
    expect(achievementMeta("nonexistent")).toBeNull();
  });
});

describe("applyPlaybackStarted", () => {
  it("no-op if already played", () => {
    const st = { unlocked: [], hasPlayedTrack: true };
    const r = applyPlaybackStarted(st, true);
    expect(r.state).toBe(st);
    expect(r.newUnlocked).toEqual([]);
  });
  it("sets flag; unlocks first_sound when opt-in on", () => {
    const r = applyPlaybackStarted({ unlocked: [], hasPlayedTrack: false }, true);
    expect(r.state.hasPlayedTrack).toBe(true);
    expect(r.state.unlocked).toContain("first_sound");
    expect(r.newUnlocked).toEqual(["first_sound"]);
  });
  it("opt-in off → flag flips but no unlock", () => {
    const r = applyPlaybackStarted({ unlocked: [], hasPlayedTrack: false }, false);
    expect(r.state.hasPlayedTrack).toBe(true);
    expect(r.state.unlocked).toEqual([]);
    expect(r.newUnlocked).toEqual([]);
  });
  it("doesn't double-unlock when already in list", () => {
    const r = applyPlaybackStarted({ unlocked: ["first_sound"], hasPlayedTrack: false }, true);
    expect(r.state.unlocked).toEqual(["first_sound"]);
    expect(r.newUnlocked).toEqual([]);
  });
});

describe("applyRetroactiveOptIn", () => {
  it("grants both based on history", () => {
    const r = applyRetroactiveOptIn({ unlocked: [], hasPlayedTrack: true }, 5);
    expect(r.silentGranted.sort()).toEqual(["first_heart", "first_sound"].sort());
  });
  it("ignores invalid likesCount", () => {
    const r = applyRetroactiveOptIn({ unlocked: [], hasPlayedTrack: false }, NaN as unknown as number);
    expect(r.silentGranted).toEqual([]);
  });
  it("skips already-unlocked", () => {
    const r = applyRetroactiveOptIn({ unlocked: ["first_sound", "first_heart"], hasPlayedTrack: true }, 5);
    expect(r.silentGranted).toEqual([]);
  });
});

describe("applyLikeChange", () => {
  it("unlocks first_heart on 0→1 transition", () => {
    const r = applyLikeChange({ unlocked: [], hasPlayedTrack: false }, true, 1, 0);
    expect(r.newUnlocked).toEqual(["first_heart"]);
  });
  it("no-op 5→6", () => {
    const r = applyLikeChange({ unlocked: [], hasPlayedTrack: false }, true, 6, 5);
    expect(r.newUnlocked).toEqual([]);
  });
  it("no-op when opt-in off", () => {
    const r = applyLikeChange({ unlocked: [], hasPlayedTrack: false }, false, 1, 0);
    expect(r.newUnlocked).toEqual([]);
  });
  it("rejects non-finite counts", () => {
    const r = applyLikeChange({ unlocked: [], hasPlayedTrack: false }, true, NaN, 0);
    expect(r.newUnlocked).toEqual([]);
  });
});
