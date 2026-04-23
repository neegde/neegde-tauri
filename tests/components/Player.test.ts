import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

// Mock all heavy audio / system modules Player uses — these are excluded from
// coverage anyway and jsdom can't run Web Audio / Canvas / MediaSession.
vi.mock("../../src/audio/mediaSession.js", () => ({
  setMediaSessionApi: vi.fn(), installMediaSessionHandlers: vi.fn(),
  clearMediaSessionHandlers: vi.fn(), syncMediaSessionMetadata: vi.fn(),
  syncMediaSessionPlaybackState: vi.fn(), syncMediaSessionPositionState: vi.fn(),
  clearMediaSessionPresentation: vi.fn(), reaffirmTrackSkipHandlers: vi.fn(),
}));
vi.mock("../../src/audio/visualizerBroadcast.js", () => ({
  setVisualizerBroadcastPlaying: vi.fn(),
}));
vi.mock("../../src/audio/equalizerGraph.js", () => ({
  resumeEqualizerContext: vi.fn(),
  buildEqualizerGraph: vi.fn(() => null),
  disposeEqualizerGraph: vi.fn(),
  applyGainToContext: vi.fn(),
}));
vi.mock("../../src/discordPresence.js", () => ({ clearDiscordPresence: vi.fn() }));
vi.mock("../../src/torrent/torrentSession.js", () => ({
  releaseTorrentStreamUrl: vi.fn().mockResolvedValue(undefined),
  torrentPrepareCancel: vi.fn().mockResolvedValue(undefined),
  hoverTorrentStreamUrl: vi.fn().mockResolvedValue(""),
  activateHoverStream: vi.fn().mockResolvedValue(undefined),
  releaseHoverStream: vi.fn().mockResolvedValue(undefined),
  vozduxanNotifyPosition: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/composables/useDiscordPresence.js", () => ({
  useDiscordPresence: () => ({}),
}));
vi.mock("../../src/composables/usePlayerEqualizer.js", () => ({
  usePlayerEqualizer: () => ({
    equalizerEnabled: { value: false },
    equalizerBands: { value: [] },
    equalizerPreset: { value: "flat" },
    equalizerPanelOpen: { value: false },
    setEqualizerEnabled: vi.fn(),
    setEqualizerBand: vi.fn(),
    setEqualizerPreset: vi.fn(),
    setEqualizerPanelOpen: vi.fn(),
    attachEqualizerTo: vi.fn(),
    detachEqualizer: vi.fn(),
  }),
}));
vi.mock("../../src/composables/useStreamStats.js", () => ({
  useStreamStats: () => ({
    peers: { value: 0 }, seeders: { value: 0 }, downloadRate: { value: 0 },
    activePeerCount: { value: 0 }, stateText: { value: "" },
    currentPeers: { value: 0 },
  }),
}));
vi.mock("../../src/composables/useStreamStatus.js", () => ({
  useStreamStatus: () => ({
    streamPhase: { value: "idle" }, streamStatusOpen: { value: false },
    setStreamPhase: vi.fn(), clearStreamPhase: vi.fn(),
    openStreamStatus: vi.fn(), closeStreamStatus: vi.fn(),
  }),
}));
vi.mock("../../src/composables/useBufferPoll.js", () => ({
  useBufferPoll: () => ({ startBufferPoll: vi.fn(), stopBufferPoll: vi.fn() }),
}));
vi.mock("../../src/composables/useBufferingWatchdog.js", () => ({
  useBufferingWatchdog: () => ({
    kickWatchdog: vi.fn(), cancelWatchdog: vi.fn(), isBuffering: { value: false },
  }),
}));
vi.mock("../../src/composables/usePrefetch.js", () => ({
  usePrefetch: () => ({
    prefetchedStream: { value: { url: "", forKey: "" } },
    resetOnTrackChange: vi.fn(),
    releasePrefetchedStream: vi.fn(),
    get inFlight() { return false; },
  }),
}));
vi.mock("../../src/composables/useMarquee.js", () => ({
  useMarquee: () => ({
    titleScroll: { value: false }, artistScroll: { value: false },
    titleMarqueeStyle: { value: {} }, artistMarqueeStyle: { value: {} },
  }),
}));

import Player from "../../src/components/player/Player.vue";
import { buildTrack } from "../../src/track/factory.js";

const track = buildTrack({
  type: "track", id: "t1", title: "Song", artist: "Artist",
  albumTitle: null, albumId: null, fileName: "song.mp3",
  format: null, bitrate: 320, duration: 200, size: 1000,
  sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "song.mp3" }, raw: { cover: null } }],
});

beforeEach(() => { document.body.innerHTML = ""; });

describe("Player — smoke", () => {
  it("mounts with null track", () => {
    const w = mount(Player, {
      props: { track: null, likedIds: new Set<string>(), playbackQueue: [], queueIndex: 0 },
      attachTo: document.body,
    });
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("mounts with a Track", () => {
    const w = mount(Player, {
      props: { track, likedIds: new Set<string>(), playbackQueue: [track], queueIndex: 0 },
      attachTo: document.body,
    });
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("shows liked state when id is in likedIds", () => {
    const w = mount(Player, {
      props: { track, likedIds: new Set(["t1"]), playbackQueue: [track], queueIndex: 0 },
      attachTo: document.body,
    });
    expect(w.html()).toContain("liked");
    w.unmount();
  });
});
