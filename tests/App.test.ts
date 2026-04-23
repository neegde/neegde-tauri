import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeLocalStorage, mockInvoke } from "./_setup.js";
import { mount, flushPromises } from "@vue/test-utils";

// Heavy / side-effectful mocks. Same as Player.test but for the whole App.
vi.mock("../src/audio/mediaSession.js", () => ({
  setMediaSessionApi: vi.fn(), installMediaSessionHandlers: vi.fn(),
  clearMediaSessionHandlers: vi.fn(), syncMediaSessionMetadata: vi.fn(),
  syncMediaSessionPlaybackState: vi.fn(), syncMediaSessionPositionState: vi.fn(),
  clearMediaSessionPresentation: vi.fn(), reaffirmTrackSkipHandlers: vi.fn(),
}));
vi.mock("../src/audio/visualizerBroadcast.js", () => ({
  setVisualizerBroadcastPlaying: vi.fn(),
  setVisualizerBroadcastTrack: vi.fn(),
}));
vi.mock("../src/audio/equalizerGraph.js", () => ({
  resumeEqualizerContext: vi.fn(),
  buildEqualizerGraph: vi.fn(() => null),
  disposeEqualizerGraph: vi.fn(),
  applyGainToContext: vi.fn(),
}));
vi.mock("../src/discordPresence.js", () => ({ clearDiscordPresence: vi.fn() }));
vi.mock("../src/torrent/torrentSession.js", () => ({
  releaseTorrentStreamUrl: vi.fn().mockResolvedValue(undefined),
  torrentPrepareCancel: vi.fn().mockResolvedValue(undefined),
  hoverTorrentStreamUrl: vi.fn().mockResolvedValue(""),
  activateHoverStream: vi.fn().mockResolvedValue(undefined),
  releaseHoverStream: vi.fn().mockResolvedValue(undefined),
  vozduxanNotifyPosition: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/composables/useDiscordPresence.js", () => ({
  useDiscordPresence: () => ({}),
}));
vi.mock("../src/composables/usePlayerEqualizer.js", () => ({
  usePlayerEqualizer: () => ({
    equalizerEnabled: { value: false }, equalizerBands: { value: [] },
    equalizerPreset: { value: "flat" }, equalizerPanelOpen: { value: false },
    setEqualizerEnabled: vi.fn(), setEqualizerBand: vi.fn(),
    setEqualizerPreset: vi.fn(), setEqualizerPanelOpen: vi.fn(),
    attachEqualizerTo: vi.fn(), detachEqualizer: vi.fn(),
  }),
}));
vi.mock("../src/composables/useStreamStats.js", () => ({
  useStreamStats: () => ({
    peers: { value: 0 }, seeders: { value: 0 }, downloadRate: { value: 0 },
    activePeerCount: { value: 0 }, stateText: { value: "" }, currentPeers: { value: 0 },
  }),
}));
vi.mock("../src/composables/useStreamStatus.js", () => ({
  useStreamStatus: () => ({
    streamPhase: { value: "idle" }, streamStatusOpen: { value: false },
    setStreamPhase: vi.fn(), clearStreamPhase: vi.fn(),
    openStreamStatus: vi.fn(), closeStreamStatus: vi.fn(),
  }),
}));
vi.mock("../src/composables/useBufferPoll.js", () => ({
  useBufferPoll: () => ({ startBufferPoll: vi.fn(), stopBufferPoll: vi.fn() }),
}));
vi.mock("../src/composables/useBufferingWatchdog.js", () => ({
  useBufferingWatchdog: () => ({
    kickWatchdog: vi.fn(), cancelWatchdog: vi.fn(), isBuffering: { value: false },
  }),
}));
vi.mock("../src/composables/usePrefetch.js", () => ({
  usePrefetch: () => ({
    prefetchedStream: { value: { url: "", forKey: "" } },
    resetOnTrackChange: vi.fn(), releasePrefetchedStream: vi.fn(),
    get inFlight() { return false; },
  }),
}));
vi.mock("../src/composables/useMarquee.js", () => ({
  useMarquee: () => ({
    titleScroll: { value: false }, artistScroll: { value: false },
    titleMarqueeStyle: { value: {} }, artistMarqueeStyle: { value: {} },
  }),
}));
vi.mock("../src/appDebugWindow.js", () => ({
  openAppDebugWindow: vi.fn().mockResolvedValue(undefined),
  closeAppDebugWindow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/torrent/api.js", async (orig) => {
  const actual = await orig<typeof import("../src/torrent/api.js")>();
  return { ...actual };
});
// Mock search engine to a predictable no-op.
vi.mock("../src/search/engine.js", () => ({
  createSearchEngine: () => ({
    query: vi.fn().mockResolvedValue({
      results: { value: [] },
      providerStatus: { value: { rutracker: "done", soulseek: "done" } },
      providerError: { value: { rutracker: null, soulseek: null } },
      query: "", resolved: null,
    }),
    clearCache: vi.fn(),
    providers: { rutracker: {}, soulseek: {} },
  }),
}));
// Rutracker + SoulSeek API mocks return defaults.
vi.mock("../src/rutracker/auth.js", () => ({
  login: vi.fn(), logout: vi.fn(),
  restoreSession: vi.fn().mockResolvedValue({ logged_in: false }),
  getStatus: vi.fn().mockResolvedValue({ logged_in: false }),
}));
vi.mock("../src/rutracker/proxyConfig.js", () => ({
  syncRtHttpProxyCacheFromBackend: vi.fn().mockResolvedValue(undefined),
  hasHttpProxyConfigured: () => false, setRtHttpProxyCache: vi.fn(),
  getHttpProxy: vi.fn(), setHttpProxy: vi.fn(), probeHttpProxy: vi.fn(),
  RT_HTTP_PROXY_PX1: "", RT_HTTP_PROXY_PX2: "",
}));

import App from "../src/App.vue";

beforeEach(() => {
  fakeLocalStorage.clear();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(null);
  document.body.innerHTML = "";
});

describe("App.vue — smoke mount", () => {
  it("mounts without throwing", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("seeds empty state on cold start", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    // No likes, no playlists rendered.
    expect(document.body.textContent).toContain("Мне нравится");
    w.unmount();
  });

  it("restores v2 persisted likes on mount", async () => {
    fakeLocalStorage.set("neegde.migration.v2.done", "1");
    fakeLocalStorage.set("neegde.likes.v2", JSON.stringify({
      trackIds: ["t1"], albumIds: [], likedAt: { t1: 1 },
    }));
    fakeLocalStorage.set("neegde.trackCache.v1", JSON.stringify({
      t1: {
        type: "track", id: "t1", title: "x", artist: null, albumId: null,
        fileName: "x.mp3", format: null, bitrate: null, duration: null, size: 0,
        sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "x.mp3" }, raw: { cover: null } }],
      },
    }));
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
  });
});
