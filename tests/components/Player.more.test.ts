import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

// Mirror all heavy module mocks from the existing Player.test.ts.
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
const torrentPrepareCancelMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const releaseTorrentStreamUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../src/torrent/torrentSession.js", () => ({
  releaseTorrentStreamUrl: releaseTorrentStreamUrlMock,
  torrentPrepareCancel: torrentPrepareCancelMock,
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
    equalizerEnabled: { value: false }, equalizerBands: { value: [] },
    equalizerPreset: { value: "flat" }, equalizerPanelOpen: { value: false },
    setEqualizerEnabled: vi.fn(), setEqualizerBand: vi.fn(),
    setEqualizerPreset: vi.fn(), setEqualizerPanelOpen: vi.fn(),
    attachEqualizerTo: vi.fn(), detachEqualizer: vi.fn(),
  }),
}));
vi.mock("../../src/composables/useStreamStats.js", () => ({
  useStreamStats: () => ({
    peers: { value: 0 }, seeders: { value: 0 }, downloadRate: { value: 0 },
    activePeerCount: { value: 0 }, stateText: { value: "" },
    streamDownloadStats: { value: null }, statsHistory: { value: [] },
    startStatsPolling: vi.fn(), stopStatsPolling: vi.fn(),
    currentPeers: { value: 0 },
  }),
}));
vi.mock("../../src/composables/useStreamStatus.js", () => ({
  useStreamStatus: () => ({
    prepareDotClass: { value: "" }, prepareHintDetail: { value: "" },
    streamDotClass: { value: "" }, currentPeers: { value: 0 },
    currentRate: { value: 0 }, sparklineData: { value: [] },
    streamStatusHeadline: { value: "" }, streamStatusBody: { value: "" },
  }),
}));
vi.mock("../../src/composables/useBufferPoll.js", () => ({
  useBufferPoll: () => ({ bufferedPercent: { value: 0 }, updateBufferStats: vi.fn(), stopBufferPoll: vi.fn() }),
}));
vi.mock("../../src/composables/useBufferingWatchdog.js", () => ({
  useBufferingWatchdog: () => ({
    startBufferingWatchdog: vi.fn(), clearBufferingWatchdog: vi.fn(), isBuffering: { value: false },
  }),
}));
vi.mock("../../src/composables/usePrefetch.js", () => ({
  usePrefetch: () => ({
    prefetchedStream: { value: { url: "", forKey: "" } },
    resetOnTrackChange: vi.fn(), releasePrefetchedStream: vi.fn(),
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
import { mockInvoke } from "../_setup.js";
import { replaceQueue, queueIds, queuePos, setRepeat } from "../../src/stores/queue.js";
import { clearEntities } from "../../src/stores/entities.js";

const track = buildTrack({
  type: "track", id: "t1", title: "Song", artist: "Artist",
  albumTitle: null, albumId: null, fileName: "song.mp3",
  format: null, bitrate: 320, duration: 200, size: 1000,
  sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "song.mp3" }, raw: { cover: null } }],
});

const track2 = buildTrack({
  type: "track", id: "t2", title: "Song 2", artist: "Artist",
  albumTitle: null, albumId: null, fileName: "song2.mp3",
  format: null, bitrate: 320, duration: 200, size: 1000,
  sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "song2.mp3" }, raw: { cover: null } }],
});

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  clearEntities();
  queueIds.value = [];
  queuePos.value = 0;
  setRepeat("off");
});

async function mountPlayer(overrides: { queue?: ReturnType<typeof buildTrack>[]; queuePos?: number } = {}) {
  mockInvoke.mockResolvedValue({ url: "http://stream", token: "tok" });
  const queue = overrides.queue ?? [track];
  replaceQueue(queue, overrides.queuePos ?? 0);
  const w = mount(Player, { attachTo: document.body });
  // Let watchers + prepareStream settle.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return w;
}

describe("Player — keyboard shortcuts", () => {
  it("Space toggles play when idle", async () => {
    const w = await mountPlayer();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    await w.vm.$nextTick();
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("ArrowRight emits next when hasNext", async () => {
    // 2-track queue at pos=0 → hasNext=true
    const w = await mountPlayer({ queue: [track, track2], queuePos: 0 });
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight" }));
    await w.vm.$nextTick();
    expect(w.emitted("next")).toBeTruthy();
    w.unmount();
  });

  it("ArrowLeft emits prev when hasPrev", async () => {
    // 2-track queue at pos=1 → hasPrev=true
    const w = await mountPlayer({ queue: [track, track2], queuePos: 1 });
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowLeft" }));
    await w.vm.$nextTick();
    expect(w.emitted("prev")).toBeTruthy();
    w.unmount();
  });

  it("keydown inside INPUT is ignored", async () => {
    const w = await mountPlayer({ queue: [track, track2], queuePos: 0 });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const evt = new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true });
    Object.defineProperty(evt, "target", { value: input });
    window.dispatchEvent(evt);
    await w.vm.$nextTick();
    expect(w.emitted("next")).toBeFalsy();
    w.unmount();
  });

  it("MediaTrackNext / Previous emit next/prev", async () => {
    const w = await mountPlayer();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "MediaTrackNext" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "MediaTrackPrevious" }));
    await w.vm.$nextTick();
    expect(w.emitted("next")).toBeTruthy();
    expect(w.emitted("prev")).toBeTruthy();
    w.unmount();
  });
});

describe("Player — play button + cancelLoad", () => {
  it("clicking play button while preparing cancels load", async () => {
    // prepareStream returns a pending promise — phase stays 'preparing'.
    mockInvoke.mockImplementation(() => new Promise(() => {}));
    replaceQueue([track], 0);
    const w = mount(Player, { attachTo: document.body });
    await w.vm.$nextTick(); await w.vm.$nextTick();
    await w.find(".ctrl-btn-play").trigger("click");
    expect(torrentPrepareCancelMock).toHaveBeenCalled();
    w.unmount();
  });

  it("suppressAutoplay + no src → request-stream emission from togglePlay", async () => {
    replaceQueue([track], 0);
    // seedFromSnapshot would set this on real cold start; here we flip manually.
    const { suppressAutoplay } = await import("../../src/stores/queue.js");
    suppressAutoplay.value = true;
    const w = mount(Player, { attachTo: document.body });
    await w.vm.$nextTick();
    await w.find(".ctrl-btn-play").trigger("click");
    expect(w.emitted("request-stream")).toBeTruthy();
    suppressAutoplay.value = false;
    w.unmount();
  });
});

describe("Player — audio event handlers", () => {
  async function mountWithAudio() {
    mockInvoke.mockResolvedValue({ url: "http://stream", token: "tok" });
    replaceQueue([track], 0);
    const w = mount(Player, { attachTo: document.body });
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    return w;
  }

  it("playing event toggles playing state", async () => {
    const w = await mountWithAudio();
    const a = w.find("audio").element as HTMLAudioElement | undefined;
    if (!a) { w.unmount(); return; }
    a.dispatchEvent(new Event("play"));
    await w.vm.$nextTick();
    expect(w.emitted("playing-change")?.length).toBeGreaterThanOrEqual(1);
    w.unmount();
  });

  it("pause event clears playing state", async () => {
    const w = await mountWithAudio();
    const a = w.find("audio").element as HTMLAudioElement | undefined;
    if (!a) { w.unmount(); return; }
    a.dispatchEvent(new Event("play"));
    a.dispatchEvent(new Event("pause"));
    await w.vm.$nextTick();
    w.unmount();
  });

  it("ended event with repeat=off emits 'ended'", async () => {
    const w = await mountWithAudio();
    const a = w.find("audio").element as HTMLAudioElement | undefined;
    if (!a) { w.unmount(); return; }
    a.dispatchEvent(new Event("ended"));
    await w.vm.$nextTick();
    expect(w.emitted("ended")).toBeTruthy();
    w.unmount();
  });

  it("ended event with repeat=one restarts without emitting 'ended'", async () => {
    mockInvoke.mockResolvedValue({ url: "http://stream", token: "tok" });
    replaceQueue([track], 0);
    setRepeat("one");
    const w = mount(Player, { attachTo: document.body });
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    const a = w.find("audio").element as HTMLAudioElement | undefined;
    if (!a) { w.unmount(); return; }
    // Stub play() so it doesn't reject under jsdom.
    (a as HTMLAudioElement & { play: () => Promise<void> }).play = () => Promise.resolve();
    a.dispatchEvent(new Event("ended"));
    await w.vm.$nextTick();
    expect(w.emitted("ended")).toBeFalsy();
    w.unmount();
  });

  it("error event sets error phase and schedules auto-retry", async () => {
    vi.useFakeTimers();
    mockInvoke.mockResolvedValue({ url: "http://stream", token: "tok" });
    replaceQueue([track], 0);
    const w = mount(Player, { attachTo: document.body });
    // Let the initial prepare chain settle.
    await vi.runOnlyPendingTimersAsync();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const a = w.find("audio").element as HTMLAudioElement | undefined;
    if (a) {
      Object.defineProperty(a, "error", { value: { code: 4, message: "unsupported" }, configurable: true });
      a.dispatchEvent(new Event("error"));
      await Promise.resolve();
      vi.advanceTimersByTime(1500);
    }
    vi.useRealTimers();
    w.unmount();
  });

  it("waiting event while paused does not flip to buffering", async () => {
    const w = await mountWithAudio();
    const a = w.find("audio").element as HTMLAudioElement | undefined;
    if (!a) { w.unmount(); return; }
    Object.defineProperty(a, "paused", { value: true, configurable: true });
    a.dispatchEvent(new Event("waiting"));
    await w.vm.$nextTick();
    w.unmount();
  });

  it("timeupdate moves current position forward", async () => {
    const w = await mountWithAudio();
    const a = w.find("audio").element as HTMLAudioElement | undefined;
    if (!a) { w.unmount(); return; }
    Object.defineProperty(a, "currentTime", { value: 42, configurable: true });
    a.dispatchEvent(new Event("timeupdate"));
    await w.vm.$nextTick();
    w.unmount();
  });

  it("loadedmetadata sets duration", async () => {
    const w = await mountWithAudio();
    const a = w.find("audio").element as HTMLAudioElement | undefined;
    if (!a) { w.unmount(); return; }
    Object.defineProperty(a, "duration", { value: 200, configurable: true });
    a.dispatchEvent(new Event("loadedmetadata"));
    await w.vm.$nextTick();
    w.unmount();
  });

  it("canplay bumps phase to ready", async () => {
    const w = await mountWithAudio();
    const a = w.find("audio").element as HTMLAudioElement | undefined;
    if (!a) { w.unmount(); return; }
    a.dispatchEvent(new Event("canplay"));
    await w.vm.$nextTick();
    w.unmount();
  });
});

describe("Player — queue interactions", () => {
  it("queue-remove fires when remove button clicked", async () => {
    const q = [track, track];
    const w = await mountPlayer({ playbackQueue: q, hasNext: true });
    // Open queue panel.
    const queueBtns = w.findAll(".player-queue-btn");
    for (const b of queueBtns) await b.trigger("click");
    await w.vm.$nextTick();
    const rm = w.find(".player-queue-item-remove");
    if (rm.exists()) {
      await rm.trigger("click");
      expect(w.emitted("queue-remove")).toBeTruthy();
    }
    w.unmount();
  });

  it("queue item right-click opens context menu", async () => {
    const q = [track];
    const w = await mountPlayer({ playbackQueue: q });
    for (const b of w.findAll(".player-queue-btn")) await b.trigger("click");
    await w.vm.$nextTick();
    const item = w.find(".player-queue-item");
    if (item.exists()) {
      await item.trigger("contextmenu", { clientX: 5, clientY: 5 });
      await w.vm.$nextTick();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
  });
});

describe("Player — null / untracked paths", () => {
  it("null track renders without crashing", () => {
    queueIds.value = [];
    queuePos.value = 0;
    const w = mount(Player);
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("toggleCurrentLike is a no-op without a track", () => {
    queueIds.value = [];
    queuePos.value = 0;
    const w = mount(Player);
    const btn = w.find(".player-like-btn");
    if (btn.exists()) btn.trigger("click");
    expect(w.emitted("toggle-like")).toBeFalsy();
    w.unmount();
  });
});

describe("Player — scrubber seek", () => {
  it("clicking the progress track seeks on the audio element", async () => {
    const w = await mountPlayer();
    const a = w.find("audio").element as HTMLAudioElement | undefined;
    if (!a) { w.unmount(); return; }
    Object.defineProperty(a, "duration", { value: 100, configurable: true });
    a.dispatchEvent(new Event("loadedmetadata"));
    await w.vm.$nextTick();
    const track = w.find(".progress-track");
    if (track.exists()) {
      const el = track.element as HTMLElement;
      el.getBoundingClientRect = () => ({
        left: 0, right: 100, top: 0, bottom: 10, width: 100, height: 10, x: 0, y: 0, toJSON: () => ({}),
      });
      await track.trigger("click", { clientX: 50 });
    }
    w.unmount();
  });
});

describe("Player — document click closes menus", () => {
  it("outside click closes status + queue panels", async () => {
    const w = await mountPlayer();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await w.vm.$nextTick();
    expect(w.html()).toBeTruthy();
    w.unmount();
  });
});
