import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { defineComponent, h, ref, computed, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { mockInvoke } from "../_setup.js";

vi.mock("../../src/appDebugWindow.js", () => ({
  openAppDebugWindow: vi.fn().mockResolvedValue(undefined),
  closeAppDebugWindow: vi.fn().mockResolvedValue(undefined),
}));

import { useAppDebug } from "../../src/composables/useAppDebug.js";
import { appDebugLog } from "../../src/appDebugLog.js";

const appDebugLogMock = appDebugLog as unknown as ReturnType<typeof vi.fn>;

function mountWith(opts: {
  view?: ReturnType<typeof ref<string>>;
  queuePos?: ReturnType<typeof ref<number>>;
  nowPlaying?: ReturnType<typeof computed<{ fileIdx?: number; fileName?: string; torrentId?: string | number } | null>>;
}) {
  const view = opts.view ?? ref("home");
  const queuePos = opts.queuePos ?? ref(0);
  const nowPlaying = opts.nowPlaying ?? computed(() => null);
  let api: ReturnType<typeof useAppDebug>;
  const W = defineComponent({
    setup() {
      api = useAppDebug({ view, queuePos, nowPlaying });
      return () => h("div");
    },
  });
  const w = mount(W);
  return { api: api!, view, queuePos, unmount: () => w.unmount() };
}

beforeEach(() => {
  mockInvoke.mockReset();
  appDebugLogMock.mockReset?.();
});

describe("useAppDebug — document click + visibility + nav/queue watchers", () => {
  it("installs a document click listener when enabled and removes it when disabled", async () => {
    mockInvoke.mockResolvedValueOnce(true);
    const { api, unmount } = mountWith({});
    await nextTick(); await nextTick();
    expect(api.appDebugEnabled.value).toBe(true);

    // Fire a click — the handler logs "ui" / "click".
    document.body.click();
    await nextTick();
    const uiClickCalls = appDebugLogMock.mock.calls.filter(
      (c) => c[0] === "ui" && c[1] === "click",
    );
    expect(uiClickCalls.length).toBeGreaterThan(0);

    // Disable — next click should not add a new log entry.
    const before = appDebugLogMock.mock.calls.length;
    api.appDebugEnabled.value = false;
    await nextTick(); await nextTick();
    document.body.click();
    await nextTick();
    // Number of "ui"/"click" calls did not grow.
    const after = appDebugLogMock.mock.calls.filter((c) => c[0] === "ui" && c[1] === "click").length;
    expect(after).toBe(uiClickCalls.length);
    unmount();
  });

  it("logs navigation changes when view ref updates", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    const view = ref("home");
    const { unmount } = mountWith({ view });
    await nextTick(); await nextTick();
    view.value = "search";
    await nextTick();
    expect(appDebugLogMock).toHaveBeenCalledWith(
      "ui",
      expect.stringMatching(/nav: home → search/),
    );
    unmount();
  });

  it("logs queuePos changes and includes nowPlaying snapshot", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    const queuePos = ref(0);
    const nowPlaying = computed(() => ({ fileIdx: 7, fileName: "long_file_name.mp3", torrentId: "42" }));
    const { unmount } = mountWith({ queuePos, nowPlaying });
    await nextTick(); await nextTick();
    queuePos.value = 3;
    await nextTick();
    expect(appDebugLogMock).toHaveBeenCalledWith(
      "player",
      "queue position changed",
      expect.objectContaining({ pos: 3, fileIdx: 7, fileName: expect.stringContaining("long_file_name") }),
    );
    unmount();
  });

  it("logs now-playing cleared vs active", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    const nowPlayingRef = ref<{ fileIdx?: number; fileName?: string; torrentId?: string | number } | null>({
      fileIdx: 1, fileName: "a.mp3", torrentId: "42",
    });
    const nowPlaying = computed(() => nowPlayingRef.value);
    const { unmount } = mountWith({ nowPlaying });
    await nextTick(); await nextTick();
    nowPlayingRef.value = null;
    await nextTick();
    expect(appDebugLogMock).toHaveBeenCalledWith(
      "player",
      expect.stringContaining("now playing: cleared"),
    );
    nowPlayingRef.value = { fileIdx: 2, fileName: "b.mp3", torrentId: "99" };
    await nextTick();
    expect(appDebugLogMock).toHaveBeenCalledWith(
      "player",
      expect.stringMatching(/now playing: fileIdx=2/),
      expect.objectContaining({ torrentId: "99" }),
    );
    unmount();
  });

  it("registers a visibilitychange listener that logs on dispatch", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    const { unmount } = mountWith({});
    await nextTick(); await nextTick();
    appDebugLogMock.mockClear();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(appDebugLogMock).toHaveBeenCalledWith(
      "ui",
      expect.stringMatching(/window visibility:/),
    );
    unmount();
  });

  it("removes the visibilitychange listener on unmount", async () => {
    mockInvoke.mockResolvedValueOnce(false);
    const { unmount } = mountWith({});
    await nextTick(); await nextTick();
    unmount();
    appDebugLogMock.mockClear();
    document.dispatchEvent(new Event("visibilitychange"));
    const vis = appDebugLogMock.mock.calls.filter((c) =>
      typeof c[1] === "string" && c[1].includes("window visibility"),
    );
    expect(vis).toHaveLength(0);
  });
});
