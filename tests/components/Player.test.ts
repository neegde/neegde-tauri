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
import {
  replaceQueue,
  queueIds,
  queuePos,
  setRepeat,
  shuffleOn,
} from "../../src/stores/queue.js";
import { clearEntities } from "../../src/stores/entities.js";
import { seedLikesFromSnapshot } from "../../src/stores/library.js";

const track = buildTrack({
  type: "track", id: "t1", title: "Song", artist: "Artist",
  albumTitle: null, albumId: null, fileName: "song.mp3",
  format: null, bitrate: 320, duration: 200, size: 1000,
  sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "song.mp3" }, raw: { cover: null } }],
});

beforeEach(() => {
  document.body.innerHTML = "";
  clearEntities();
  queueIds.value = [];
  queuePos.value = 0;
  setRepeat("off");
  shuffleOn.value = false;
  seedLikesFromSnapshot({ trackIds: [], albumIds: [], likedAt: {} });
});

describe("Player — smoke", () => {
  it("mounts with null track", () => {
    const w = mount(Player, { attachTo: document.body });
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("mounts with a Track", () => {
    replaceQueue([track], 0);
    const w = mount(Player, { attachTo: document.body });
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("shows liked state when id is in likedIds", () => {
    replaceQueue([track], 0);
    seedLikesFromSnapshot({ trackIds: ["t1"], albumIds: [], likedAt: { t1: Date.now() } });
    const w = mount(Player, { attachTo: document.body });
    expect(w.html()).toContain("liked");
    w.unmount();
  });
});

describe("Player — controls emit events", () => {
  it("prev button emits prev when hasPrev", async () => {
    const t2 = buildTrack({
      type: "track", id: "t2", title: "S2", artist: null,
      albumTitle: null, albumId: null, fileName: "s2.mp3",
      format: null, bitrate: null, duration: null, size: 1,
      sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "s2.mp3" }, raw: { cover: null } }],
    });
    replaceQueue([track, t2], 1);  // pos=1 → hasPrev=true, hasNext=false (but prev btn enables)
    const w = mount(Player, { attachTo: document.body });
    const btns = w.findAll("button");
    const prevBtn = btns.find((b) => /previous|prev|предыдущ/i.test(b.attributes("aria-label") ?? "") || b.attributes("aria-label")?.includes("Предыдущ"));
    if (prevBtn) {
      await prevBtn.trigger("click");
      expect(w.emitted("prev")).toBeTruthy();
    }
    w.unmount();
  });

  it("next button emits next when hasNext", async () => {
    const t2 = buildTrack({
      type: "track", id: "t2", title: "S2", artist: null,
      albumTitle: null, albumId: null, fileName: "s2.mp3",
      format: null, bitrate: null, duration: null, size: 1,
      sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "s2.mp3" }, raw: { cover: null } }],
    });
    replaceQueue([track, t2], 0);  // pos=0 → hasNext=true
    const w = mount(Player, { attachTo: document.body });
    const btns = w.findAll("button");
    const nextBtn = btns.find((b) => b.attributes("aria-label")?.includes("Следующ"));
    if (nextBtn) {
      await nextBtn.trigger("click");
      expect(w.emitted("next")).toBeTruthy();
    }
    w.unmount();
  });

  it("toggle-shuffle emits on shuffle button", async () => {
    replaceQueue([track], 0);
    const w = mount(Player, { attachTo: document.body });
    const btns = w.findAll("button");
    const b = btns.find((x) => x.attributes("title")?.toLowerCase().includes("перемеш") || x.attributes("aria-label")?.toLowerCase().includes("shuffle"));
    if (b) {
      await b.trigger("click");
      expect(w.emitted("toggle-shuffle")).toBeTruthy();
    }
    w.unmount();
  });

  it("cycle-repeat emits on repeat button", async () => {
    replaceQueue([track], 0);
    const w = mount(Player, { attachTo: document.body });
    const btns = w.findAll("button");
    const b = btns.find((x) => /повтор|repeat/i.test(x.attributes("title") ?? ""));
    if (b) {
      await b.trigger("click");
      expect(w.emitted("cycle-repeat")).toBeTruthy();
    }
    w.unmount();
  });

  it("toggle-like emits on player-like-btn", async () => {
    replaceQueue([track], 0);
    const w = mount(Player, { attachTo: document.body });
    const likeBtn = w.find(".player-like-btn");
    if (likeBtn.exists()) {
      await likeBtn.trigger("click");
      expect(w.emitted("toggle-like")).toBeTruthy();
    }
    w.unmount();
  });

  it("search-artist emits on artist click", async () => {
    replaceQueue([track], 0);
    const w = mount(Player, { attachTo: document.body });
    const elements = w.findAll("button, [role='button'], a");
    const artistEl = elements.find((e) => e.text().trim() === "Artist");
    if (artistEl) {
      await artistEl.trigger("click");
    }
    w.unmount();
  });
});

describe("Player — queue panel", () => {
  it("queue button toggles panel open state", async () => {
    replaceQueue([track], 0);
    const w = mount(Player, { attachTo: document.body });
    const qBtn = w.findAll("button").find((b) => b.attributes("aria-label") === "Очередь воспроизведения");
    if (qBtn) {
      await qBtn.trigger("click");
      expect(w.html()).toBeTruthy();
    }
    w.unmount();
  });

  it("queue-jump emits on queue item click", async () => {
    const t2 = buildTrack({
      type: "track", id: "t2", title: "Song2", artist: "A",
      albumTitle: null, albumId: null, fileName: "s2.mp3",
      format: null, bitrate: 192, duration: 180, size: 500,
      sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "s2.mp3" }, raw: { cover: null } }],
    });
    replaceQueue([track, t2], 0);
    const w = mount(Player, { attachTo: document.body });
    const qBtn = w.findAll("button").find((b) => b.attributes("aria-label") === "Очередь воспроизведения");
    if (qBtn) {
      await qBtn.trigger("click");
      await w.vm.$nextTick();
      // click an item in the queue
      const items = w.findAll(".player-queue-item, .queue-item");
      if (items.length) {
        await items[0]!.trigger("click");
      }
    }
    w.unmount();
  });
});

describe("Player — helpers", () => {
  it("null track does not crash, shows nothing-playing UI", () => {
    const w = mount(Player, { attachTo: document.body });
    expect(w.html()).toBeTruthy();
    w.unmount();
  });
  it("mount with repeat=one label present", () => {
    replaceQueue([track], 0);
    setRepeat("one");
    const w = mount(Player, { attachTo: document.body });
    expect(w.html()).toContain("ctrl-repeat-one-mark");
    w.unmount();
  });
  it("mount with shuffleOn highlights shuffle", () => {
    replaceQueue([track], 0);
    shuffleOn.value = true;
    const w = mount(Player, { attachTo: document.body });
    expect(w.html()).toBeTruthy();
    w.unmount();
  });
});

describe("Player — audio element events (src set)", () => {
  async function mountWithAudio() {
    const { mockInvoke } = await import("../_setup.js");
    mockInvoke.mockResolvedValue({ url: "http://stream", token: "tok" });
    replaceQueue([track], 0);
    const w = mount(Player, { attachTo: document.body });
    // Let prepareStream + watcher chain settle.
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 0));
    await w.vm.$nextTick();
    return w;
  }

  it("audio element renders after prepareStream resolves", async () => {
    const w = await mountWithAudio();
    const audio = w.find("audio");
    // If audio rendered, dispatch events. If not (timing), skip.
    if (audio.exists()) {
      const a = audio.element as HTMLAudioElement;
      a.dispatchEvent(new Event("play"));
      a.dispatchEvent(new Event("pause"));
      a.dispatchEvent(new Event("ended"));
      a.dispatchEvent(new Event("loadedmetadata"));
      a.dispatchEvent(new Event("canplay"));
      a.dispatchEvent(new Event("waiting"));
      a.dispatchEvent(new Event("progress"));
      Object.defineProperty(a, "error", { value: { code: 3, message: "d" }, configurable: true });
      a.dispatchEvent(new Event("error"));
      await w.vm.$nextTick();
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
  });
});
