import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";
import { defineComponent, h, ref, computed } from "vue";
import { mount } from "@vue/test-utils";
import { useAchievements } from "../../src/composables/useAchievements.js";

type Api = ReturnType<typeof useAchievements>;

function mountWith(
  playerPlaying: ReturnType<typeof ref<boolean>>,
  nowPlaying: ReturnType<typeof computed<object | null>>,
): Api {
  let api!: Api;
  const W = defineComponent({
    setup() { api = useAchievements({ playerPlaying, nowPlaying }); return () => h("div"); },
  });
  mount(W);
  return api;
}

beforeEach(() => fakeLocalStorage.clear());

describe("useAchievements — state", () => {
  it("initial: opt-in off, empty unlocked", () => {
    const api = mountWith(ref(false), computed(() => null));
    expect(api.achievementsOptIn.value).toBe(false);
    expect(api.achievementsState.value.unlocked).toEqual([]);
  });

  it("handleAchievementsOptInChange(true) stores opt-in and retroactive grants with likes", () => {
    fakeLocalStorage.set("neegde.achievements.state.v1", JSON.stringify({ unlocked: [], hasPlayedTrack: true }));
    const api = mountWith(ref(false), computed(() => null));
    api.handleAchievementsOptInChange(true, 5);
    expect(api.achievementsOptIn.value).toBe(true);
    expect(api.achievementsState.value.unlocked.sort()).toEqual(["first_heart", "first_sound"].sort());
  });

  it("opt-in off clears toast", () => {
    const api = mountWith(ref(false), computed(() => null));
    api.achievementToastOpen.value = true;
    api.handleAchievementsOptInChange(false, 0);
    expect(api.achievementToastOpen.value).toBe(false);
  });

  it("reset wipes state + closes toast", () => {
    fakeLocalStorage.set("neegde.achievements.state.v1", JSON.stringify({ unlocked: ["first_heart"], hasPlayedTrack: true }));
    const api = mountWith(ref(false), computed(() => null));
    api.achievementToastOpen.value = true;
    api.handleAchievementsReset();
    expect(api.achievementToastOpen.value).toBe(false);
    expect(api.achievementsState.value.unlocked).toEqual([]);
    expect(api.achievementsState.value.hasPlayedTrack).toBe(false);
  });
});

describe("useAchievements — like change", () => {
  it("no-op when opt-in off", () => {
    const api = mountWith(ref(false), computed(() => null));
    api.recordLikeChange(1, 0);
    expect(api.achievementsState.value.unlocked).toEqual([]);
  });
  it("0→1 unlocks first_heart when opt-in on", () => {
    const api = mountWith(ref(false), computed(() => null));
    api.handleAchievementsOptInChange(true, 0);
    api.recordLikeChange(1, 0);
    expect(api.achievementsState.value.unlocked).toContain("first_heart");
  });
  it("5→6 is a no-op", () => {
    const api = mountWith(ref(false), computed(() => null));
    api.handleAchievementsOptInChange(true, 5);
    api.recordLikeChange(6, 5);
    // first_heart is granted retroactively from likes=5, but 6→5 doesn't grant more.
    expect(api.achievementsState.value.unlocked).toContain("first_heart");
  });
});

describe("useAchievements — playback watcher", () => {
  it("first play with opt-in unlocks first_sound", async () => {
    const playing = ref(false);
    const now = computed<object | null>(() => ({ id: "t1" }));
    const api = mountWith(playing, now);
    api.handleAchievementsOptInChange(true, 0);
    playing.value = true;
    await Promise.resolve(); await Promise.resolve();
    expect(api.achievementsState.value.hasPlayedTrack).toBe(true);
    expect(api.achievementsState.value.unlocked).toContain("first_sound");
  });

  it("does nothing when nowPlaying is null", async () => {
    const playing = ref(false);
    const now = computed<object | null>(() => null);
    const api = mountWith(playing, now);
    api.handleAchievementsOptInChange(true, 0);
    playing.value = true;
    await Promise.resolve();
    expect(api.achievementsState.value.hasPlayedTrack).toBe(false);
  });
});
