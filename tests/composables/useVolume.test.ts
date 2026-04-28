import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeLocalStorage } from "../_setup.js";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { useVolume, type UseVolumeApi } from "../../src/composables/useVolume.js";

function mountVolume(): UseVolumeApi {
  let api!: UseVolumeApi;
  const W = defineComponent({ setup() { api = useVolume(); return () => h("div"); } });
  mount(W);
  return api;
}

async function flush() {
  // let vue process ref watchers
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => fakeLocalStorage.clear());

describe("useVolume — initial", () => {
  it("defaults to 1", () => {
    expect(mountVolume().volume.value).toBe(1);
  });
  it("restores numeric value from storage", () => {
    fakeLocalStorage.set("playerVolume", "0.5");
    expect(mountVolume().volume.value).toBe(0.5);
  });
  it("clamps out-of-range restored value", () => {
    fakeLocalStorage.set("playerVolume", "2");
    expect(mountVolume().volume.value).toBe(1);
    fakeLocalStorage.clear();
    fakeLocalStorage.set("playerVolume", "-1");
    expect(mountVolume().volume.value).toBe(0);
  });
  it("rejects NaN / gibberish", () => {
    fakeLocalStorage.set("playerVolume", "abc");
    expect(mountVolume().volume.value).toBe(1);
  });
});

describe("useVolume — persistence", () => {
  it("writes to storage on volume change", async () => {
    const api = mountVolume();
    api.volume.value = 0.3;
    await flush();
    expect(fakeLocalStorage.get("playerVolume")).toBe("0.3");
  });
});

describe("useVolume — toggleMute", () => {
  it("mutes, then unmutes back to saved level", () => {
    const api = mountVolume();
    api.volume.value = 0.6;
    api.toggleMute();
    expect(api.volume.value).toBe(0);
    expect(api.volumeBeforeMute.value).toBe(0.6);
    api.toggleMute();
    expect(api.volume.value).toBe(0.6);
  });
  it("unmute from 0 without prior muted-value restores storage or 0.25 fallback", () => {
    fakeLocalStorage.set("playerVolume", "0.8");
    const api = mountVolume();
    api.volume.value = 0;
    api.toggleMute();
    // prev volumeBeforeMute is null; storage has 0.8 → returns 0.8.
    expect(api.volume.value).toBe(0.8);
  });
  it("falls back to 0.25 when no saved volume either", () => {
    const api = mountVolume();
    api.volume.value = 0;
    // Simulate storage cleared before unmute.
    fakeLocalStorage.clear();
    api.toggleMute();
    expect(api.volume.value).toBeGreaterThanOrEqual(0.25);
  });
});

describe("useVolume — wheel", () => {
  it("scroll up increases, clamped to 1", () => {
    const api = mountVolume();
    api.volume.value = 0.97;
    const e = new WheelEvent("wheel", { deltaY: -10 });
    const pd = vi.spyOn(e, "preventDefault");
    api.onVolumeWheel(e);
    expect(pd).toHaveBeenCalled();
    expect(api.volume.value).toBeCloseTo(1);
  });
  it("scroll down decreases, clamped to 0", () => {
    const api = mountVolume();
    api.volume.value = 0.03;
    api.onVolumeWheel(new WheelEvent("wheel", { deltaY: 10 }));
    expect(api.volume.value).toBe(0);
  });
});
