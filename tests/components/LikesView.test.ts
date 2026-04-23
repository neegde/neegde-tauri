import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import LikesView from "../../src/components/likes/LikesView.vue";
import { buildTrack } from "../../src/track/factory.js";
import { clearEntities } from "../../src/stores/entities.js";

beforeEach(() => clearEntities());

const track = buildTrack({
  type: "track", id: "t1", title: "Song 1", artist: "Artist",
  albumTitle: "Alb", albumId: null,
  fileName: "01 - Song.mp3", format: null, bitrate: null, duration: null, size: 1024,
  sources: [{
    kind: "soulseek",
    refs: { slskUsername: "u", slskFilepath: "a/01.mp3" },
    raw: { cover: null },
  }],
});

describe("LikesView", () => {
  it("empty state when no tracks", () => {
    const w = mount(LikesView, {
      props: { tracks: [], nowPlayingId: null, playerPlaying: false },
    });
    expect(w.find(".empty-msg").text()).toMatch(/понравившихся/);
  });

  it("renders one row per track with hero count", () => {
    const w = mount(LikesView, {
      props: { tracks: [track], nowPlayingId: null, playerPlaying: false },
    });
    expect(w.findAll(".likes-track-row")).toHaveLength(1);
    expect(w.find(".likes-hero-title").text()).toBe("Мне нравится");
  });

  it("row click emits play", async () => {
    const w = mount(LikesView, {
      props: { tracks: [track], nowPlayingId: null, playerPlaying: false },
    });
    await w.find(".likes-track-row").trigger("click");
    expect(w.emitted("play")).toBeTruthy();
    expect((w.emitted("play")?.[0]?.[0] as { id: string })?.id).toBe("t1");
  });

  it("like button emits toggle-like", async () => {
    const w = mount(LikesView, {
      props: { tracks: [track], nowPlayingId: null, playerPlaying: false },
    });
    await w.find(".like-btn").trigger("click");
    expect(w.emitted("toggle-like")).toBeTruthy();
  });

  it("applies 'playing' class on now-playing row", () => {
    const w = mount(LikesView, {
      props: { tracks: [track], nowPlayingId: "t1", playerPlaying: true },
    });
    expect(w.find(".likes-track-row").classes()).toContain("playing");
    expect(w.find(".likes-track-row").classes()).toContain("playing--active");
  });

  it("paused state sets playing--paused", () => {
    const w = mount(LikesView, {
      props: { tracks: [track], nowPlayingId: "t1", playerPlaying: false },
    });
    expect(w.find(".likes-track-row").classes()).toContain("playing--paused");
  });

  it("context menu opens on right-click + emits add-to-queue", async () => {
    const w = mount(LikesView, {
      props: { tracks: [track], nowPlayingId: null, playerPlaying: false },
      attachTo: document.body,
    });
    await w.find(".likes-track-row").trigger("contextmenu", { clientX: 10, clientY: 10 });
    const queueItem = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("В очередь")) as HTMLElement | undefined;
    expect(queueItem).toBeDefined();
    queueItem?.click();
    await w.vm.$nextTick();
    expect(w.emitted("add-to-queue")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});
