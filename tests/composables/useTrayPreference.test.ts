import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeLocalStorage, mockInvoke } from "../_setup.js";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { flushPromises } from "@vue/test-utils";

import { useTrayPreference } from "../../src/composables/useTrayPreference.js";

const STORAGE_KEY = "neegde.closeTray.v1";

function mountComposable() {
  let api!: ReturnType<typeof useTrayPreference>;
  const Wrapper = defineComponent({
    setup() {
      api = useTrayPreference();
      return () => h("div");
    },
  });
  const w = mount(Wrapper);
  return { api, w };
}

beforeEach(() => {
  fakeLocalStorage.clear();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(null);
});

describe("useTrayPreference — initial state", () => {
  it("defaults to false when storage is empty", () => {
    const { api } = mountComposable();
    expect(api.closeTray.value).toBe(false);
  });

  it("reads true from storage", () => {
    fakeLocalStorage.set(STORAGE_KEY, "true");
    const { api } = mountComposable();
    expect(api.closeTray.value).toBe(true);
  });

  it("reads false from storage", () => {
    fakeLocalStorage.set(STORAGE_KEY, "false");
    const { api } = mountComposable();
    expect(api.closeTray.value).toBe(false);
  });

  it("treats absent key as false (not truthy string coercion)", () => {
    fakeLocalStorage.set(STORAGE_KEY, "");
    const { api } = mountComposable();
    expect(api.closeTray.value).toBe(false);
  });
});

describe("useTrayPreference — onMounted sync", () => {
  it("invokes set_close_to_tray with current value on mount", async () => {
    fakeLocalStorage.set(STORAGE_KEY, "true");
    mountComposable();
    await flushPromises();
    expect(mockInvoke).toHaveBeenCalledWith("set_close_to_tray", { enabled: true });
  });

  it("invokes with false when storage is empty", async () => {
    mountComposable();
    await flushPromises();
    expect(mockInvoke).toHaveBeenCalledWith("set_close_to_tray", { enabled: false });
  });

  it("does not throw when invoke rejects (no Tauri API)", async () => {
    mockInvoke.mockRejectedValue(new Error("no tauri"));
    await expect(async () => {
      mountComposable();
      await flushPromises();
    }).not.toThrow();
  });
});

describe("useTrayPreference — setCloseTray", () => {
  it("updates ref to true", async () => {
    const { api } = mountComposable();
    await api.setCloseTray(true);
    expect(api.closeTray.value).toBe(true);
  });

  it("updates ref to false", async () => {
    fakeLocalStorage.set(STORAGE_KEY, "true");
    const { api } = mountComposable();
    await api.setCloseTray(false);
    expect(api.closeTray.value).toBe(false);
  });

  it("persists true to localStorage", async () => {
    const { api } = mountComposable();
    await api.setCloseTray(true);
    expect(fakeLocalStorage.get(STORAGE_KEY)).toBe("true");
  });

  it("persists false to localStorage", async () => {
    fakeLocalStorage.set(STORAGE_KEY, "true");
    const { api } = mountComposable();
    await api.setCloseTray(false);
    expect(fakeLocalStorage.get(STORAGE_KEY)).toBe("false");
  });

  it("calls invoke with enabled: true", async () => {
    const { api } = mountComposable();
    await flushPromises(); // clear mount call
    mockInvoke.mockReset();
    await api.setCloseTray(true);
    expect(mockInvoke).toHaveBeenCalledWith("set_close_to_tray", { enabled: true });
  });

  it("calls invoke with enabled: false", async () => {
    const { api } = mountComposable();
    await flushPromises();
    mockInvoke.mockReset();
    await api.setCloseTray(false);
    expect(mockInvoke).toHaveBeenCalledWith("set_close_to_tray", { enabled: false });
  });

  it("does not throw when invoke rejects", async () => {
    const { api } = mountComposable();
    await flushPromises();
    mockInvoke.mockRejectedValue(new Error("no tauri"));
    await expect(api.setCloseTray(true)).resolves.toBeUndefined();
  });
});
