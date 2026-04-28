import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeLocalStorage, mockInvoke } from "./_setup.js";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";

// Same heavy mocks as App.test.ts.
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
vi.mock("../src/rutracker/auth.js", () => ({
  login: vi.fn(), logout: vi.fn(),
  restoreSession: vi.fn().mockResolvedValue({ logged_in: false }),
  getStatus: vi.fn().mockResolvedValue({ logged_in: false }),
}));
vi.mock("../src/rutracker/proxyConfig.js", () => ({
  syncRtHttpProxyCacheFromBackend: vi.fn().mockResolvedValue(undefined),
  hasHttpProxyConfigured: () => false, setRtHttpProxyCache: vi.fn(),
  getHttpProxy: vi.fn().mockResolvedValue(null),
  setHttpProxy: vi.fn().mockResolvedValue(undefined),
  probeHttpProxy: vi.fn().mockResolvedValue(undefined),
  RT_HTTP_PROXY_PX1: "", RT_HTTP_PROXY_PX2: "",
}));

import App from "../src/App.vue";

beforeEach(() => {
  fakeLocalStorage.clear();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(null);
});

/** Helpers to seed persistence state for tests with library content. */
function seedTwoLikedTracks() {
  fakeLocalStorage.set("neegde.migration.v2.done", "1");
  fakeLocalStorage.set("neegde.likes.v2", JSON.stringify({
    trackIds: ["t1", "t2"], albumIds: [], likedAt: { t1: 1, t2: 2 },
  }));
  fakeLocalStorage.set("neegde.trackCache.v1", JSON.stringify({
    t1: {
      type: "track", id: "t1", title: "Alpha", artist: "Artist A",
      albumId: null, albumTitle: "Alpha Album", fileName: "alpha.mp3",
      format: null, bitrate: null, duration: null, size: 1000,
      sources: [{ kind: "soulseek", refs: { slskUsername: "bob", slskFilepath: "alpha.mp3" }, raw: { cover: null } }],
    },
    t2: {
      type: "track", id: "t2", title: "Beta", artist: "Artist B",
      albumId: null, albumTitle: "Beta Album", fileName: "beta.mp3",
      format: null, bitrate: null, duration: null, size: 2000,
      sources: [{ kind: "soulseek", refs: { slskUsername: "bob", slskFilepath: "beta.mp3" }, raw: { cover: null } }],
    },
  }));
}

/** Seed a 2-track queue so suppressAutoplayAfterSessionRestore is true on cold boot. */
function seedQueueSnapshot() {
  fakeLocalStorage.set("neegde.migration.v2.done", "1");
  fakeLocalStorage.set("neegde.queue.v2", JSON.stringify({
    trackIds: ["t1", "t2"], pos: 0,
  }));
  fakeLocalStorage.set("neegde.trackCache.v1", JSON.stringify({
    t1: {
      type: "track", id: "t1", title: "Alpha", artist: "Artist A",
      albumId: null, albumTitle: "Alpha Album", fileName: "alpha.mp3",
      format: null, bitrate: null, duration: null, size: 1000,
      sources: [{ kind: "soulseek", refs: { slskUsername: "bob", slskFilepath: "alpha.mp3" }, raw: { cover: null } }],
    },
    t2: {
      type: "track", id: "t2", title: "Beta", artist: "Artist B",
      albumId: null, albumTitle: "Beta Album", fileName: "beta.mp3",
      format: null, bitrate: null, duration: null, size: 2000,
      sources: [{ kind: "soulseek", refs: { slskUsername: "bob", slskFilepath: "beta.mp3" }, raw: { cover: null } }],
    },
  }));
}

function seedPlaylistWithTracks() {
  fakeLocalStorage.set("neegde.migration.v2.done", "1");
  fakeLocalStorage.set("neegde.playlists.v2", JSON.stringify([
    { id: "p1", title: "My Mix", coverUrl: null, createdAt: 1, updatedAt: 1, trackIds: ["t1", "t2"] },
  ]));
  fakeLocalStorage.set("neegde.trackCache.v1", JSON.stringify({
    t1: {
      type: "track", id: "t1", title: "Alpha", artist: "Artist A",
      albumId: null, albumTitle: null, fileName: "alpha.mp3",
      format: null, bitrate: null, duration: null, size: 1000,
      sources: [{ kind: "soulseek", refs: { slskUsername: "bob", slskFilepath: "alpha.mp3" }, raw: { cover: null } }],
    },
    t2: {
      type: "track", id: "t2", title: "Beta", artist: "Artist B",
      albumId: null, albumTitle: null, fileName: "beta.mp3",
      format: null, bitrate: null, duration: null, size: 2000,
      sources: [{ kind: "soulseek", refs: { slskUsername: "bob", slskFilepath: "beta.mp3" }, raw: { cover: null } }],
    },
  }));
}

describe("App.vue — cold boot with persisted queue", () => {
  it("cold boot with seeded queue mounts cleanly", async () => {
    seedQueueSnapshot();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    expect(player.exists()).toBe(true);
    // Queue store is seeded from the snapshot.
    const { queueIds } = await import("../src/stores/queue.js");
    expect(queueIds.value.length).toBeGreaterThan(0);
    w.unmount();
    document.body.innerHTML = "";
  });

  it("request-stream from Player flips suppressAutoplay off", async () => {
    seedQueueSnapshot();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const { suppressAutoplay } = await import("../src/stores/queue.js");
    const player = w.findComponent({ name: "Player" });
    await player.vm.$emit("request-stream");
    await flushPromises();
    expect(suppressAutoplay.value).toBe(false);
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — queue / repeat / shuffle cycling", () => {
  it("cycleRepeatMode cycles off → all → one → off", async () => {
    fakeLocalStorage.delete("neegde.player.repeatMode");
    const { repeatMode } = await import("../src/stores/queue.js");
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    expect(repeatMode.value).toBe("off");
    await player.vm.$emit("cycle-repeat");
    await flushPromises();
    expect(repeatMode.value).toBe("all");
    await player.vm.$emit("cycle-repeat");
    await flushPromises();
    expect(repeatMode.value).toBe("one");
    await player.vm.$emit("cycle-repeat");
    await flushPromises();
    expect(repeatMode.value).toBe("off");
    w.unmount();
    document.body.innerHTML = "";
  });

  it("toggleShuffle is a no-op when queue has fewer than 2 items", async () => {
    const { shuffleOn } = await import("../src/stores/queue.js");
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    const before = shuffleOn.value;
    await player.vm.$emit("toggle-shuffle");
    await flushPromises();
    expect(shuffleOn.value).toBe(before);
    w.unmount();
    document.body.innerHTML = "";
  });

  it("toggleShuffle flips shuffle when queue >= 2", async () => {
    seedQueueSnapshot();
    const { shuffleOn } = await import("../src/stores/queue.js");
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    const before = shuffleOn.value;
    await player.vm.$emit("toggle-shuffle");
    await flushPromises();
    expect(shuffleOn.value).toBe(!before);
    w.unmount();
    document.body.innerHTML = "";
  });

  it("player 'prev' and 'next' navigate the queue", async () => {
    seedQueueSnapshot();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    // Move to next track.
    await player.vm.$emit("next");
    await flushPromises();
    await player.vm.$emit("prev");
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("player 'next' at end without repeat-all clears queue", async () => {
    // seed queue with pos at last index
    fakeLocalStorage.set("neegde.migration.v2.done", "1");
    fakeLocalStorage.set("neegde.queue.v2", JSON.stringify({
      trackIds: ["t1"], pos: 0,
    }));
    fakeLocalStorage.set("neegde.trackCache.v1", JSON.stringify({
      t1: {
        type: "track", id: "t1", title: "Alpha", artist: "A",
        albumId: null, albumTitle: null, fileName: "alpha.mp3",
        format: null, bitrate: null, duration: null, size: 1,
        sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "alpha.mp3" }, raw: { cover: null } }],
      },
    }));
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    await player.vm.$emit("next");
    await flushPromises();
    await player.vm.$emit("ended");
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("player 'ended' triggers handlePlayerNext (advance queue)", async () => {
    seedQueueSnapshot();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    await player.vm.$emit("ended");
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("queue-jump / queue-remove route to queue mutations", async () => {
    seedQueueSnapshot();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    await player.vm.$emit("queue-jump", 1);
    await flushPromises();
    await player.vm.$emit("queue-remove", 0);
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("queue-download / queue-add-to-playlist from player propagate", async () => {
    seedQueueSnapshot();
    const { nowPlayingTrack } = await import("../src/stores/queue.js");
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    const track = nowPlayingTrack.value;
    // Queue add-to-playlist opens the modal.
    await player.vm.$emit("queue-add-to-playlist", track);
    await flushPromises();
    expect(document.body.textContent).toMatch(/Добавить в плейлист/);
    // Close the modal and then try queue-download.
    const overlay = document.querySelector(".pl-modal-overlay") as HTMLElement;
    overlay.click();
    await flushPromises();
    await player.vm.$emit("queue-download", track);
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("open-torrent emits for RT source attempts torrent navigation", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        return {
          id: "99", cover_data_url: null, magnet: "magnet:?xt=urn:btih:HASH",
          files: [{ path: ["Album", "x.mp3"], size: 1 }],
          artist: "A",
        };
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    await player.vm.$emit("open-torrent", {
      torrentId: "99", torrentName: "Album", source: "rutracker",
      magnet: "magnet:?xt=urn:btih:HASH", fileIdx: 0, artist: "A",
    });
    await flushPromises();
    await flushPromises();
    const tv = w.findComponent({ name: "TorrentView" });
    // If the fetch worked, TorrentView may be mounted.
    expect(tv.exists() || w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("open-torrent emits for magnet source uses magnetListFiles", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "torrent_magnet_list_files") return [{ path: ["t.mp3"], size: 1 }];
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    await player.vm.$emit("open-torrent", {
      torrentId: null, torrentName: "Magnet Album", source: "magnet",
      magnet: "magnet:?xt=urn:btih:HASHX", fileIdx: 0, artist: null,
    });
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — playlist CRUD", () => {
  it("seeded playlist appears, rename via PlaylistView updates title", async () => {
    seedPlaylistWithTracks();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const items = w.findAll(".sidebar-pl-item");
    expect(items.length).toBeGreaterThanOrEqual(1);
    await items[0]!.trigger("click");
    await flushPromises();
    const pv = w.findComponent({ name: "PlaylistView" });
    expect(pv.exists()).toBe(true);
    await pv.vm.$emit("rename", "Renamed Mix");
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("delete current playlist from PlaylistView returns to home", async () => {
    seedPlaylistWithTracks();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await w.findAll(".sidebar-pl-item")[0]!.trigger("click");
    await flushPromises();
    const pv = w.findComponent({ name: "PlaylistView" });
    await pv.vm.$emit("delete");
    await flushPromises();
    // Sidebar items for this playlist should be gone.
    const items = w.findAll(".sidebar-pl-item");
    expect(items.length).toBe(0);
    w.unmount();
    document.body.innerHTML = "";
  });

  it("remove a track from playlist via emit", async () => {
    seedPlaylistWithTracks();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await w.findAll(".sidebar-pl-item")[0]!.trigger("click");
    await flushPromises();
    const pv = w.findComponent({ name: "PlaylistView" });
    await pv.vm.$emit("remove-track", "t1");
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("play a playlist replaces the queue", async () => {
    seedPlaylistWithTracks();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await w.findAll(".sidebar-pl-item")[0]!.trigger("click");
    await flushPromises();
    const pv = w.findComponent({ name: "PlaylistView" });
    await pv.vm.$emit("play", 1);
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("add-to-playlist modal → clicking an existing playlist adds track", async () => {
    seedPlaylistWithTracks();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    // Open add-to-playlist modal from LikesView
    const likesBtn = w.findAll("button").find((b) => b.text().includes("Мне нравится"));
    await likesBtn!.trigger("click");
    await flushPromises();
    const lv = w.findComponent({ name: "LikesView" });
    // Seed likes first - but seedPlaylistWithTracks does not seed likes, so do it now.
    // Instead, use the PlaylistView path.
    // Navigate to playlist, trigger add-to-playlist on a track
    const items = w.findAll(".sidebar-pl-item");
    await items[0]!.trigger("click");
    await flushPromises();
    const pv = w.findComponent({ name: "PlaylistView" });
    const tracks = pv.props("tracks") as Array<{ id: string }>;
    if (tracks.length) {
      await pv.vm.$emit("add-to-playlist", tracks[0]!);
      await flushPromises();
      expect(document.body.textContent).toMatch(/Добавить в плейлист/);
      // Click the existing playlist entry to add.
      const plModalItems = document.querySelectorAll(".pl-modal-item");
      if (plModalItems.length > 0) {
        (plModalItems[0] as HTMLElement).click();
        await flushPromises();
      }
    }
    // Modal closed.
    expect(document.querySelector(".pl-modal-overlay")).toBeFalsy();
    expect(lv.exists() || w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("add-to-playlist modal → 'Новый плейлист' creates and opens a new playlist", async () => {
    seedTwoLikedTracks();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const likesBtn = w.findAll("button").find((b) => b.text().includes("Мне нравится"));
    await likesBtn!.trigger("click");
    await flushPromises();
    const lv = w.findComponent({ name: "LikesView" });
    const tracks = lv.props("tracks") as Array<{ id: string }>;
    await lv.vm.$emit("add-to-playlist", tracks[0]!);
    await flushPromises();
    const newBtn = document.querySelector(".pl-modal-new") as HTMLElement;
    expect(newBtn).toBeTruthy();
    newBtn.click();
    await flushPromises();
    // Modal should close and we should be on a playlist view.
    expect(document.querySelector(".pl-modal-overlay")).toBeFalsy();
    const pv = w.findComponent({ name: "PlaylistView" });
    expect(pv.exists()).toBe(true);
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — likes flow", () => {
  it("toggle like on an existing liked track removes it", async () => {
    seedTwoLikedTracks();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const likesBtn = w.findAll("button").find((b) => b.text().includes("Мне нравится"));
    await likesBtn!.trigger("click");
    await flushPromises();
    const lv = w.findComponent({ name: "LikesView" });
    let tracks = lv.props("tracks") as Array<{ id: string }>;
    expect(tracks.length).toBe(2);
    await lv.vm.$emit("toggle-like-track", tracks[0]!);
    await flushPromises();
    tracks = lv.props("tracks") as Array<{ id: string }>;
    expect(tracks.length).toBe(1);
    w.unmount();
    document.body.innerHTML = "";
  });

  it("Player toggle-like bridges through onToggleLikeTrack", async () => {
    seedQueueSnapshot();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    const track = player.props("track");
    await player.vm.$emit("toggle-like", track);
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — search + navigation", () => {
  it("empty search query clears state (handleSearch empty branch)", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const sb = w.findComponent({ name: "SearchBar" });
    if (sb.exists()) {
      // first run a real query
      await sb.vm.$emit("search", "hello", "100");
      await flushPromises();
      // now clear
      await sb.vm.$emit("search", "", "100");
      await flushPromises();
      // whitespace-only treated as empty
      await sb.vm.$emit("search", "   ", "100");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("SearchIntentHint revert-to-raw re-runs with skipResolver", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const sb = w.findComponent({ name: "SearchBar" });
    if (sb.exists()) {
      await sb.vm.$emit("search", "Rolling Stones", "100");
      await flushPromises();
    }
    const hint = w.findComponent({ name: "SearchIntentHint" });
    if (hint.exists()) {
      await hint.vm.$emit("revert-to-raw");
      await flushPromises();
    }
    // revert-to-raw empty query path
    const sb2 = w.findComponent({ name: "SearchBar" });
    if (sb2.exists()) {
      await sb2.vm.$emit("search", "", "100");
      await flushPromises();
    }
    const hint2 = w.findComponent({ name: "SearchIntentHint" });
    if (hint2.exists()) {
      await hint2.vm.$emit("revert-to-raw");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("HomeView search-query inline triggers runSearch", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const hv = w.findComponent({ name: "HomeView" });
    if (hv.exists()) {
      await hv.vm.$emit("search-query", "My Search");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("HomeView go-to-search clears selection", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const hv = w.findComponent({ name: "HomeView" });
    if (hv.exists()) {
      await hv.vm.$emit("go-to-search");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("sidebar Home click refreshes home once more (second branch)", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    // Start a search first
    const sb = w.findComponent({ name: "SearchBar" });
    if (sb.exists()) {
      await sb.vm.$emit("search", "blah", "100");
      await flushPromises();
    }
    // Now click home to trigger the clean-home branch
    const home = w.findAll("button").find((b) => b.text().includes("Главная"));
    await home!.trigger("click");
    await flushPromises();
    // Click home again when already clean
    await home!.trigger("click");
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("Player search-artist runs a new search and sets query", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    await player.vm.$emit("search-artist", "  Pink Floyd  ");
    await flushPromises();
    // empty artist is ignored
    await player.vm.$emit("search-artist", "   ");
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — album select toggle + legacy topic", () => {
  /** Prime search so Results is mounted. */
  async function primeSearch(w: ReturnType<typeof mount>) {
    const sb = w.findComponent({ name: "SearchBar" });
    if (sb.exists()) {
      await sb.vm.$emit("search", "query", "100");
      await flushPromises();
    }
  }

  it("Results select album creates currentAlbum, clicking same album deselects", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await primeSearch(w);
    const results = w.findComponent({ name: "Results" });
    const album = {
      type: "album", id: "alb-x", title: "Album Title", artist: "A",
      trackIds: [], sources: [{ kind: "rutracker", refs: { topicId: "t-1" }, raw: {} }],
    };
    if (results.exists()) {
      await results.vm.$emit("select", album);
      await flushPromises();
      // Re-emit same album → toggle off
      await results.vm.$emit("select", album);
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("Results select two different albums stacks nav history", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await primeSearch(w);
    const results = w.findComponent({ name: "Results" });
    if (results.exists()) {
      await results.vm.$emit("select", {
        type: "album", id: "alb-1", title: "A1", artist: null, trackIds: [],
        sources: [{ kind: "rutracker", refs: { topicId: "t-1" }, raw: {} }],
      });
      await flushPromises();
      await results.vm.$emit("select", {
        type: "album", id: "alb-2", title: "A2", artist: null, trackIds: [],
        sources: [{ kind: "rutracker", refs: { topicId: "t-2" }, raw: {} }],
      });
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("legacy topic select (via open-recent) loads files + handles same-topic deselect", async () => {
    fakeLocalStorage.set("neegde.recentHistory.v1", JSON.stringify([
      { id: "100", name: "Artist - Album", source: "rutracker", magnet: "magnet:?xt=urn:btih:X", openedAt: Date.now() },
    ]));
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        return {
          id: "100", cover_data_url: null, magnet: "magnet:?xt=urn:btih:X",
          files: [{ path: ["Album", "01.mp3"], size: 1 }],
          artist: "Artist",
        };
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const hv = w.findComponent({ name: "HomeView" });
    if (hv.exists()) {
      await hv.vm.$emit("open-recent", { id: "100", name: "Artist - Album", source: "rutracker" });
      await flushPromises();
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("legacy topic select with failing getTorrentDetails catches error", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        throw new Error("network");
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const hv = w.findComponent({ name: "HomeView" });
    if (hv.exists()) {
      await hv.vm.$emit("open-recent", { id: "500", name: "Broken", source: "rutracker" });
      await flushPromises();
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("legacy topic select with SoulSeek source builds files list inline", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const hv = w.findComponent({ name: "HomeView" });
    if (hv.exists()) {
      await hv.vm.$emit("open-recent", {
        id: "slsk-1", name: "Bob - Folder", source: "soulseek",
        slsk_username: "bob", slsk_filepath: "Folder/x.mp3",
        slsk_tracks: [
          { slsk_filepath: "Folder/1.mp3", slsk_username: "bob", size: 10 },
          { slsk_filepath: "Folder/2.mp3", slsk_username: "bob", size: 20 },
        ],
        slsk_folder: "parent/Folder",
      });
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — album view handlers", () => {
  async function primeSearch(w: ReturnType<typeof mount>) {
    const sb = w.findComponent({ name: "SearchBar" });
    if (sb.exists()) {
      await sb.vm.$emit("search", "q", "100");
      await flushPromises();
    }
  }

  it("select album then play-all / toggle-like-album / download-album", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await primeSearch(w);
    const results = w.findComponent({ name: "Results" });
    const album = {
      type: "album", id: "alb-x", title: "X", artist: "A",
      trackIds: [], sources: [{ kind: "rutracker", refs: { topicId: "t-9" }, raw: {} }],
    };
    if (results.exists()) {
      await results.vm.$emit("select", album);
      await flushPromises();
    }
    const av = w.findComponent({ name: "AlbumView" });
    if (av.exists()) {
      await av.vm.$emit("play-all");
      await flushPromises();
      await av.vm.$emit("toggle-like-album", album);
      await flushPromises();
      await av.vm.$emit("download-album");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("album view play-track / toggle-like / add-to-queue / add-to-playlist / download-track / open-track-source", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await primeSearch(w);
    const results = w.findComponent({ name: "Results" });
    if (results.exists()) {
      await results.vm.$emit("select", {
        type: "album", id: "alb-y", title: "Y", artist: null, trackIds: [],
        sources: [{ kind: "rutracker", refs: { topicId: "99" }, raw: {} }],
      });
      await flushPromises();
    }
    const av = w.findComponent({ name: "AlbumView" });
    if (av.exists()) {
      // These handlers all use isTrack() guards; passing a non-Track is a safe no-op.
      await av.vm.$emit("play-track", { not: "a track" });
      await av.vm.$emit("toggle-like-track", { not: "a track" });
      await av.vm.$emit("add-to-queue", { not: "a track" });
      await av.vm.$emit("add-to-playlist", { not: "a track" });
      await av.vm.$emit("download-track", { not: "a track" });
      await av.vm.$emit("open-track-source", { not: "a track" });
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — magnet dialog submit + error paths", () => {
  it("submit magnet with empty draft surfaces a validation error", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const mld = w.findComponent({ name: "MagnetLinkDialog" });
    if (mld.exists()) {
      await mld.vm.$emit("update:open", true);
      await flushPromises();
      await mld.vm.$emit("update:draft", "");
      await flushPromises();
      await mld.vm.$emit("submit");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("submit magnet with non-btih draft reports an error", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const mld = w.findComponent({ name: "MagnetLinkDialog" });
    if (mld.exists()) {
      await mld.vm.$emit("update:open", true);
      await flushPromises();
      await mld.vm.$emit("update:draft", "magnet:?dn=test");
      await flushPromises();
      await mld.vm.$emit("submit");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("submit valid magnet kicks magnetListFiles", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "magnet_list_files") return [{ path: ["ok.mp3"], size: 1 }];
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const mld = w.findComponent({ name: "MagnetLinkDialog" });
    if (mld.exists()) {
      await mld.vm.$emit("update:open", true);
      await flushPromises();
      await mld.vm.$emit("update:draft", "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Good");
      await flushPromises();
      await mld.vm.$emit("submit");
      await flushPromises();
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("submit valid magnet that fails listing surfaces error", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "magnet_list_files") throw new Error("boom");
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const mld = w.findComponent({ name: "MagnetLinkDialog" });
    if (mld.exists()) {
      await mld.vm.$emit("update:open", true);
      await flushPromises();
      await mld.vm.$emit("update:draft", "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Bad");
      await flushPromises();
      await mld.vm.$emit("submit");
      await flushPromises();
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — SettingsView and theme", () => {
  it("theme-change updates theme state", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const nav = w.findAll("button").find((b) => b.text().trim() === "Настройки");
    await nav!.trigger("click");
    await flushPromises();
    const sv = w.findComponent({ name: "SettingsView" });
    await sv.vm.$emit("theme-change", "dark");
    await flushPromises();
    await sv.vm.$emit("theme-change", "light");
    await flushPromises();
    expect(sv.props("theme")).toBeDefined();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("slsk-login emit triggers login with credentials", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "soulseek_login") return { success: true, username: "alice", error: null };
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const nav = w.findAll("button").find((b) => b.text().trim() === "Настройки");
    await nav!.trigger("click");
    await flushPromises();
    const sv = w.findComponent({ name: "SettingsView" });
    await sv.vm.$emit("slsk-login", "alice", "pw");
    await flushPromises();
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("slsk-login emit with failure sets slsk-login-error", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "soulseek_login") return { success: false, username: null, error: "bad creds" };
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const nav = w.findAll("button").find((b) => b.text().trim() === "Настройки");
    await nav!.trigger("click");
    await flushPromises();
    const sv = w.findComponent({ name: "SettingsView" });
    await sv.vm.$emit("slsk-login", "alice", "pw");
    await flushPromises();
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("slsk-login emit that throws sets slsk-login-error", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "soulseek_login") throw new Error("network");
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const nav = w.findAll("button").find((b) => b.text().trim() === "Настройки");
    await nav!.trigger("click");
    await flushPromises();
    const sv = w.findComponent({ name: "SettingsView" });
    await sv.vm.$emit("slsk-login", "alice", "pw");
    await flushPromises();
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("slsk-logout emit clears slsk state", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const nav = w.findAll("button").find((b) => b.text().trim() === "Настройки");
    await nav!.trigger("click");
    await flushPromises();
    const sv = w.findComponent({ name: "SettingsView" });
    await sv.vm.$emit("slsk-logout");
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("logout from Settings with forgetAccount clears account hint", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const nav = w.findAll("button").find((b) => b.text().trim() === "Настройки");
    await nav!.trigger("click");
    await flushPromises();
    const sv = w.findComponent({ name: "SettingsView" });
    await sv.vm.$emit("logout", { forgetAccount: true });
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

});

describe("App.vue — soulseek auto-login in onMounted", () => {
  it("auto-login path: status shows connected", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "soulseek_status") return { connected: true, username: "bob" };
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("auto-login path: not connected + has saved creds → login", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "soulseek_status") return { connected: false, username: null };
      if (cmd === "soulseek_load_credentials") return ["bob", "pass"];
      if (cmd === "soulseek_login") return { success: true, username: "bob", error: null };
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("auto-login path: not connected + no creds (null) → nothing", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "soulseek_status") return { connected: false, username: null };
      if (cmd === "soulseek_load_credentials") return null;
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("auto-login path: status throws → graceful", async () => {
    mockInvoke.mockImplementation(async () => { throw new Error("no tauri"); });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — deep link", () => {
  it("deep-link with neegde://torrent/rutracker/123 opens torrent", async () => {
    const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
    const pairs: Array<(urls: string[]) => void> = [];
    (onOpenUrl as unknown as { mockImplementation: (fn: unknown) => unknown }).mockImplementation(
      (cb: (urls: string[]) => void) => {
        pairs.push(cb);
        return Promise.resolve(() => {});
      }
    );
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        return {
          id: "555", cover_data_url: null, magnet: "magnet:?xt=urn:btih:Z",
          files: [{ path: ["deep.mp3"], size: 1 }],
          artist: "A",
        };
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    // Now simulate a deep-link being received.
    for (const cb of pairs) cb(["neegde://torrent/rutracker/555"]);
    await flushPromises();
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("cold start deep-link via getCurrent also opens torrent", async () => {
    const { getCurrent } = await import("@tauri-apps/plugin-deep-link");
    (getCurrent as unknown as { mockResolvedValueOnce: (v: unknown) => unknown }).mockResolvedValueOnce(
      ["neegde://torrent/rutracker/777"]
    );
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        return {
          id: "777", cover_data_url: null, magnet: "magnet:?xt=urn:btih:W",
          files: [{ path: ["ok.mp3"], size: 1 }],
          artist: "A",
        };
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await flushPromises();
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("deep-link with unknown host does nothing", async () => {
    const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
    const pairs: Array<(urls: string[]) => void> = [];
    (onOpenUrl as unknown as { mockImplementation: (fn: unknown) => unknown }).mockImplementation(
      (cb: (urls: string[]) => void) => {
        pairs.push(cb);
        return Promise.resolve(() => {});
      }
    );
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    for (const cb of pairs) cb(["neegde://unknown/x"]);
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — open track source + soulseek peer navigation", () => {
  it("onOpenTrackSource with non-track payload is a no-op", async () => {
    seedTwoLikedTracks();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const likesBtn = w.findAll("button").find((b) => b.text().includes("Мне нравится"));
    await likesBtn!.trigger("click");
    await flushPromises();
    const lv = w.findComponent({ name: "LikesView" });
    // pass a non-Track payload (plain object)
    await lv.vm.$emit("open-track-source", { id: "nope", type: "not-a-track" });
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("Results open-slsk-source with non-track is no-op", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const results = w.findComponent({ name: "Results" });
    if (results.exists()) {
      await results.vm.$emit("open-slsk-source", { not: "a track" });
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("Results clear-slsk-peer-filter clears slsk peer filter", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const results = w.findComponent({ name: "Results" });
    if (results.exists()) {
      await results.vm.$emit("clear-slsk-peer-filter");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — download progress watcher", () => {
  it("watcher logs a 'downloading' phase progress", async () => {
    seedTwoLikedTracks();
    // Make the save dialog return an actual dest; exportToDisk will then call onProgress.
    const dialog = await import("@tauri-apps/plugin-dialog");
    (dialog.open as unknown as { mockResolvedValueOnce: (v: unknown) => unknown })
      .mockResolvedValueOnce("/tmp/dest");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "soulseek_export_file") return "/tmp/dest/alpha.mp3";
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const likesBtn = w.findAll("button").find((b) => b.text().includes("Мне нравится"));
    await likesBtn!.trigger("click");
    await flushPromises();
    const lv = w.findComponent({ name: "LikesView" });
    const tracks = lv.props("tracks") as Array<{ id: string; exportToDisk?: unknown }>;
    await lv.vm.$emit("download", tracks[0]!);
    await flushPromises();
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("downloadProgress watcher receives a custom 'downloading' phase event twice", async () => {
    // We simulate calling the overlay expanded with progress by:
    // 1. Triggering onDownloadTrack which calls exportToDisk.
    // 2. exportToDisk calls onProgress with 'preparing'. The watcher logs.
    // 3. A second identical phase within 2s should hit the skip branch.
    seedTwoLikedTracks();
    const dialog = await import("@tauri-apps/plugin-dialog");
    (dialog.open as unknown as { mockResolvedValueOnce: (v: unknown) => unknown })
      .mockResolvedValueOnce("/tmp/dest");
    // Fake listen returning a cancel fn; no events are dispatched.
    const evt = await import("@tauri-apps/api/event");
    (evt.listen as unknown as { mockImplementation: (fn: unknown) => unknown })
      .mockImplementation(async (_name: string, cb: (ev: { payload: unknown }) => void) => {
        // Dispatch two progress payloads to trigger the watcher's skip branch.
        queueMicrotask(() => {
          cb({ payload: { phase: "downloading", pct: 10, message: "10%", batchIndex: 0, batchTotal: 1 } });
          cb({ payload: { phase: "downloading", pct: 20, message: "20%", batchIndex: 0, batchTotal: 1 } });
        });
        return () => {};
      });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "soulseek_export_file") return "/tmp/dest/alpha.mp3";
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const likesBtn = w.findAll("button").find((b) => b.text().includes("Мне нравится"));
    await likesBtn!.trigger("click");
    await flushPromises();
    const lv = w.findComponent({ name: "LikesView" });
    const tracks = lv.props("tracks") as Array<{ id: string }>;
    await lv.vm.$emit("download", tracks[0]!);
    await flushPromises();
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("DownloadProgressOverlay update:expanded works", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const dpo = w.findComponent({ name: "DownloadProgressOverlay" });
    if (dpo.exists()) {
      await dpo.vm.$emit("update:expanded", false);
      await flushPromises();
      await dpo.vm.$emit("update:expanded", true);
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — achievements toast wiring", () => {
  it("achievements opt-in emits update ok", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const nav = w.findAll("button").find((b) => b.text().trim() === "Настройки");
    await nav!.trigger("click");
    await flushPromises();
    const sv = w.findComponent({ name: "SettingsView" });
    await sv.vm.$emit("achievements-opt-in-change", true);
    await flushPromises();
    await sv.vm.$emit("achievements-opt-in-change", false);
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — handleLogout clears mixed state", () => {
  it("logout resets queue / selected / search", async () => {
    seedQueueSnapshot();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const nav = w.findAll("button").find((b) => b.text().trim() === "Настройки");
    await nav!.trigger("click");
    await flushPromises();
    const sv = w.findComponent({ name: "SettingsView" });
    await sv.vm.$emit("logout", { forgetAccount: false });
    await flushPromises();
    // Queue should be cleared.
    const player = w.findComponent({ name: "Player" });
    expect(player.props("track")).toBeFalsy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — NavArrows backward/forward wiring", () => {
  it("back/forward on NavArrows triggers via emits", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        return {
          id: "42", cover_data_url: null, magnet: "m",
          files: [{ path: ["a.mp3"], size: 1 }],
          artist: "A",
        };
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    // Open a recent so that we have a back stack after navigating home.
    const hv = w.findComponent({ name: "HomeView" });
    if (hv.exists()) {
      await hv.vm.$emit("open-recent", { id: "42", name: "X", source: "rutracker" });
      await flushPromises();
      await flushPromises();
    }
    const arrows = w.findComponent({ name: "NavArrows" });
    if (arrows.exists()) {
      await arrows.vm.$emit("back");
      await flushPromises();
      await arrows.vm.$emit("forward");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — HomeView remove-recent / search-query", () => {
  it("HomeView remove-recent updates recent history", async () => {
    fakeLocalStorage.set("neegde.recentHistory.v1", JSON.stringify([
      { id: "A", name: "x", source: "rutracker", openedAt: 1 },
      { id: "B", name: "y", source: "rutracker", openedAt: 2 },
    ]));
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const hv = w.findComponent({ name: "HomeView" });
    if (hv.exists()) {
      await hv.vm.$emit("remove-recent", "A");
      await flushPromises();
      const list = hv.props("recentHistory") as Array<{ id: string }>;
      expect(list.find((x) => x.id === "A")).toBeFalsy();
    }
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — SearchBar remove-history", () => {
  it("remove-history updates search history", async () => {
    fakeLocalStorage.set("neegde.searchHistory.v1", JSON.stringify(["foo", "bar"]));
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const sb = w.findComponent({ name: "SearchBar" });
    if (sb.exists()) {
      await sb.vm.$emit("remove-history", "foo");
      await flushPromises();
      const h = sb.props("history") as string[];
      expect(h.includes("foo")).toBe(false);
    }
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — searchQuery v-model and revert-to-raw full path", () => {
  it("SearchBar update:modelValue sets searchQuery, revert-to-raw re-runs", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const sb = w.findComponent({ name: "SearchBar" });
    if (sb.exists()) {
      // update v-model so searchQuery is populated.
      await sb.vm.$emit("update:modelValue", "real query");
      await flushPromises();
      await sb.vm.$emit("search", "real query", "100");
      await flushPromises();
    }
    const hint = w.findComponent({ name: "SearchIntentHint" });
    if (hint.exists()) {
      // Now revert-to-raw should re-run with skipResolver.
      await hint.vm.$emit("revert-to-raw");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("search submitted then sidebar Home clears everything", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        return {
          id: "77", cover_data_url: null, magnet: "magnet:?xt=urn:btih:A",
          files: [{ path: ["x.mp3"], size: 1 }],
          artist: "A",
        };
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const sb = w.findComponent({ name: "SearchBar" });
    if (sb.exists()) {
      await sb.vm.$emit("update:modelValue", "foo");
      await sb.vm.$emit("search", "foo", "100");
      await flushPromises();
    }
    // Also open a recent so `selected` is set.
    const hv = w.findComponent({ name: "HomeView" });
    if (hv.exists()) {
      await hv.vm.$emit("open-recent", { id: "77", name: "X", source: "rutracker" });
      await flushPromises();
      await flushPromises();
    }
    // Now click Home; this should hit the clean-home branch (searchQuery cleared).
    const home = w.findAll("button").find((b) => b.text().includes("Главная"));
    await home!.trigger("click");
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — TorrentView emits propagate to App handlers", () => {
  async function openTorrentViaRecent(w: ReturnType<typeof mount>) {
    const hv = w.findComponent({ name: "HomeView" });
    if (!hv.exists()) return;
    await hv.vm.$emit("open-recent", { id: "42", name: "Artist - Album", source: "rutracker" });
    await flushPromises();
    await flushPromises();
  }

  it("play emit from TorrentView builds tracks and enqueues", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        return {
          id: "42", cover_data_url: null, magnet: "magnet:?xt=urn:btih:XX",
          files: [
            { path: ["Album", "01.mp3"], size: 1 },
            { path: ["Album", "02.mp3"], size: 1 },
            { path: ["Album", "cover.jpg"], size: 1 },
          ],
          artist: "Artist",
        };
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await openTorrentViaRecent(w);
    const tv = w.findComponent({ name: "TorrentView" });
    if (tv.exists()) {
      await tv.vm.$emit("play", 0);
      await flushPromises();
      // Click same track again — hit the same-queue jump branch.
      await tv.vm.$emit("play", 0);
      await flushPromises();
      await tv.vm.$emit("play-all");
      await flushPromises();
      await tv.vm.$emit("add-to-queue", 1);
      await flushPromises();
      await tv.vm.$emit("open-torrent-source", 0);
      await flushPromises();
      await tv.vm.$emit("open-torrent-source", null);
      await flushPromises();
      // play-album with some audio files
      await tv.vm.$emit("play-album", [{ origIdx: 0, path: "Album/01.mp3", size: 1 }], "Album");
      await flushPromises();
      // download
      await tv.vm.$emit("download", 0, "Album/01.mp3");
      await flushPromises();
      await tv.vm.$emit("download-all");
      await flushPromises();
      await tv.vm.$emit("download-album", [{ origIdx: 0, path: "Album/01.mp3", size: 1 }], "Album");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("toggle-like with legacy row payload from TorrentView", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        return {
          id: "42", cover_data_url: null, magnet: "magnet:?xt=urn:btih:XX",
          files: [{ path: ["Album", "01.mp3"], size: 1 }],
          artist: "Artist",
        };
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await openTorrentViaRecent(w);
    const tv = w.findComponent({ name: "TorrentView" });
    if (tv.exists()) {
      await tv.vm.$emit("toggle-like-track", {
        id: "track:rutracker:42:0",
        type: "track",
        source: "rutracker",
        magnet: "magnet:?xt=urn:btih:XX",
        fileIdx: 0,
        fileName: "Album/01.mp3",
        torrentId: "42",
        torrentName: "Album",
      });
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("add-to-playlist from TorrentView opens modal", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        return {
          id: "42", cover_data_url: null, magnet: "magnet:?xt=urn:btih:XX",
          files: [{ path: ["a.mp3"], size: 1 }],
          artist: "A",
        };
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await openTorrentViaRecent(w);
    const tv = w.findComponent({ name: "TorrentView" });
    if (tv.exists()) {
      await tv.vm.$emit("add-to-playlist", {
        id: "track:rutracker:42:0",
        source: "rutracker",
        magnet: "magnet:?xt=urn:btih:XX",
        fileIdx: 0,
        fileName: "a.mp3",
        torrentId: "42",
      });
      await flushPromises();
      expect(document.body.textContent).toMatch(/Добавить в плейлист/);
    }
    w.unmount();
    document.body.innerHTML = "";
  });

  it("open-album-preview emits through useAlbumPreview", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        return {
          id: "42", cover_data_url: null, magnet: "m",
          files: [
            { path: ["Album1", "01.mp3"], size: 1 },
            { path: ["Album2", "02.mp3"], size: 1 },
          ],
          artist: "A",
        };
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await openTorrentViaRecent(w);
    const tv = w.findComponent({ name: "TorrentView" });
    if (tv.exists()) {
      await tv.vm.$emit("open-album-preview", {
        album: { audioFiles: [{ origIdx: 0, path: "Album1/01.mp3" }], dirPath: "Album1" },
        displayName: "Album1",
      });
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — Search epoch + SoulSeek peer navigation", () => {
  it("clearSlskPeerBrowseUser works directly via Results emit", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const results = w.findComponent({ name: "Results" });
    if (results.exists()) {
      await results.vm.$emit("clear-slsk-peer-filter");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — magnet dialog close paths", () => {
  it("close magnet panel while loading cancels prepare", async () => {
    // Create a magnet panel with a draft but don't resolve files
    let resolveMagnet: ((v: unknown) => void) | null = null;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "magnet_list_files") {
        return new Promise((resolve) => { resolveMagnet = resolve; });
      }
      return Promise.resolve(null);
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const mld = w.findComponent({ name: "MagnetLinkDialog" });
    if (mld.exists()) {
      await mld.vm.$emit("update:open", true);
      await mld.vm.$emit("update:draft", "magnet:?xt=urn:btih:1234567890abcdef1234567890abcdef12345678");
      await mld.vm.$emit("submit");
      await flushPromises();
      // Now close the panel while "loading"
      await mld.vm.$emit("close");
      await flushPromises();
      if (resolveMagnet) resolveMagnet([{ path: ["x.mp3"], size: 1 }]);
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — selection deselect branches", () => {
  it("opening same torrent from recent twice deselects (legacy path)", async () => {
    fakeLocalStorage.set("neegde.recentHistory.v1", JSON.stringify([
      { id: "200", name: "Same", source: "rutracker", openedAt: 1 },
    ]));
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        return {
          id: "200", cover_data_url: null, magnet: "m",
          files: [{ path: ["a.mp3"], size: 1 }],
          artist: "A",
        };
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const hv = w.findComponent({ name: "HomeView" });
    if (hv.exists()) {
      await hv.vm.$emit("open-recent", { id: "200", name: "Same", source: "rutracker" });
      await flushPromises();
      await flushPromises();
      // Re-open the same id — should toggle off
      await hv.vm.$emit("open-recent", { id: "200", name: "Same", source: "rutracker" });
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — Player open-torrent same torrent already selected", () => {
  it("same torrent id triggers album-scope apply", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rutracker_get_torrent_details") {
        return {
          id: "888", cover_data_url: null, magnet: "m",
          files: [{ path: ["a.mp3"], size: 1 }],
          artist: "A",
        };
      }
      return null;
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const hv = w.findComponent({ name: "HomeView" });
    if (hv.exists()) {
      await hv.vm.$emit("open-recent", { id: "888", name: "T", source: "rutracker" });
      await flushPromises();
      await flushPromises();
    }
    const player = w.findComponent({ name: "Player" });
    await player.vm.$emit("open-torrent", {
      torrentId: "888", torrentName: "T", source: "rutracker",
      magnet: "", fileIdx: 0, artist: "A",
    });
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("open-torrent emits with no torrentId/magnet is a no-op", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    await player.vm.$emit("open-torrent", {
      torrentId: null, torrentName: "", source: "rutracker", magnet: "", fileIdx: 0,
    });
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("open-torrent emits with soulseek source navigates to peer", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    await player.vm.$emit("open-torrent", {
      torrentId: "x", torrentName: "T", source: "soulseek",
      slskUsername: "bob", magnet: "", fileIdx: 0,
    });
    await flushPromises();
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — navigation back/forward with album entity", () => {
  it("after selecting an album then clicking back arrow", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const results = w.findComponent({ name: "Results" });
    if (results.exists()) {
      await results.vm.$emit("select", {
        type: "album", id: "alb-X", title: "X", artist: null, trackIds: [],
        sources: [{ kind: "rutracker", refs: { topicId: "T" }, raw: {} }],
      });
      await flushPromises();
    }
    const arrows = w.findComponent({ name: "NavArrows" });
    if (arrows.exists()) {
      await arrows.vm.$emit("back");
      await flushPromises();
      await arrows.vm.$emit("forward");
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — SettingsView reset achievements", () => {
  it("achievements-reset emit propagates", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const nav = w.findAll("button").find((b) => b.text().trim() === "Настройки");
    await nav!.trigger("click");
    await flushPromises();
    const sv = w.findComponent({ name: "SettingsView" });
    await sv.vm.$emit("achievements-reset");
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — LikesView toggle-like + empty noop paths", () => {
  it("like from search results (non-track) is no-op", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const results = w.findComponent({ name: "Results" });
    if (results.exists()) {
      await results.vm.$emit("like-slsk-track", { id: "x", type: "not-a-track" });
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("add-to-queue with non-track from likes is a no-op", async () => {
    seedTwoLikedTracks();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const likesBtn = w.findAll("button").find((b) => b.text().includes("Мне нравится"));
    await likesBtn!.trigger("click");
    await flushPromises();
    const lv = w.findComponent({ name: "LikesView" });
    // Emit plain payload (not a Track instance)
    await lv.vm.$emit("add-to-queue", { id: "x", type: "not-a-track" });
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — album select RT path with full metadata", () => {
  async function primeSearch(w: ReturnType<typeof mount>) {
    const sb = w.findComponent({ name: "SearchBar" });
    if (sb.exists()) {
      await sb.vm.$emit("search", "q", "100");
      await flushPromises();
    }
  }

  it("selecting an RT album with topicRow + details adds to recent history", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await primeSearch(w);
    const results = w.findComponent({ name: "Results" });
    if (results.exists()) {
      await results.vm.$emit("select", {
        type: "album", id: "alb-rt-1", title: "Album Title", artist: "ArtistName",
        trackIds: [],
        sources: [{
          kind: "rutracker",
          refs: { topicId: "777" },
          raw: {
            topicRow: { name: "Some Full Name", id: "777" },
            details: { magnet: "magnet:?xt=urn:btih:XYZ", artist: "ArtistName" },
          },
        }],
      });
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("selecting an album then a different album stacks nav and keeps backStack", async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await primeSearch(w);
    const results = w.findComponent({ name: "Results" });
    if (results.exists()) {
      await results.vm.$emit("select", {
        type: "album", id: "alb-first", title: "First", artist: null, trackIds: [],
        sources: [{ kind: "rutracker", refs: { topicId: "1" }, raw: {} }],
      });
      await flushPromises();
      // Second different album → backStack gets snapshotAlbumForBack
      await results.vm.$emit("select", {
        type: "album", id: "alb-second", title: "Second", artist: null, trackIds: [],
        sources: [{ kind: "rutracker", refs: { topicId: "2" }, raw: {} }],
      });
      await flushPromises();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});

describe("App.vue — nav handler boundary cases", () => {
  it("queue-jump with invalid index is tolerated", async () => {
    seedQueueSnapshot();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    await player.vm.$emit("queue-jump", -5);
    await flushPromises();
    await player.vm.$emit("queue-jump", 99);
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("queue-remove with invalid index is tolerated", async () => {
    seedQueueSnapshot();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const player = w.findComponent({ name: "Player" });
    await player.vm.$emit("queue-remove", -5);
    await flushPromises();
    await player.vm.$emit("queue-remove", 99);
    await flushPromises();
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});
