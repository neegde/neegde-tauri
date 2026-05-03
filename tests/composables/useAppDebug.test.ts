import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { defineComponent, h, ref, computed } from "vue";
import { mount } from "@vue/test-utils";
import { mockInvoke } from "../_setup.js";

import { useAppDebug } from "../../src/composables/useAppDebug.js";

type Api = ReturnType<typeof useAppDebug>;

function mountWith(
  view: ReturnType<typeof ref<string>>,
  queuePos: ReturnType<typeof ref<number>>,
  nowPlaying: ReturnType<typeof computed<object | null>>,
): { api: Api; unmount: () => void } {
  let api!: Api;
  const W = defineComponent({
    setup() { api = useAppDebug({ view, queuePos, nowPlaying }); return () => h("div"); },
  });
  const w = mount(W);
  return { api, unmount: () => w.unmount() };
}

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("useAppDebug", () => {
  it("reads initial appDebugEnabled via invoke", async () => {
    mockInvoke.mockResolvedValueOnce(true);
    const { api, unmount } = mountWith(ref("home"), ref(0), computed(() => null));
    await Promise.resolve(); await Promise.resolve();
    expect(api.appDebugEnabled.value).toBe(true);
    unmount();
  });

  it("falls back to false when invoke fails", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("no tauri"));
    const { api, unmount } = mountWith(ref("home"), ref(0), computed(() => null));
    await Promise.resolve(); await Promise.resolve();
    expect(api.appDebugEnabled.value).toBe(false);
    unmount();
  });

});
