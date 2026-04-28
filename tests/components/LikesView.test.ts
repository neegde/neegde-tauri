import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import LikesView from "../../src/components/likes/LikesView.vue";
import { buildTrack } from "../../src/track/factory.js";
import { buildAlbum } from "../../src/album/factory.js";
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

const likedRtAlbum = buildAlbum({
  type: "album",
  id: "album:rutracker:99:root",
  title: "Liked LP",
  artist: "Band",
  trackIds: ["rt:track:99:0"],
  sources: [{ kind: "rutracker", refs: { topicId: "99", rootPath: undefined }, raw: { details: { magnet: "" } } }],
});

describe("LikesView", () => {
  it("empty state when no tracks", () => {
    const w = mount(LikesView, {
      props: { tracks: [], albums: [], nowPlayingId: null, playerPlaying: false },
    });
    expect(w.find(".empty-msg").text()).toMatch(/понравившихся/);
  });

  it("albums tab shows liked albums and emits open-liked-album", async () => {
    const w = mount(LikesView, {
      props: { tracks: [track], albums: [likedRtAlbum], nowPlayingId: null, playerPlaying: false },
    });
    await w.findAll(".likes-tab").at(1)?.trigger("click");
    expect(w.findAll(".album-card")).toHaveLength(1);
    await w.find(".album-card").trigger("click");
    expect((w.emitted("open-liked-album")?.[0]?.[0] as { id: string })?.id).toBe(likedRtAlbum.id);
  });

  it("albums tab has no like overlay on cover (unlike from AlbumView)", async () => {
    const w = mount(LikesView, {
      props: { tracks: [], albums: [likedRtAlbum], nowPlayingId: null, playerPlaying: false },
    });
    await w.findAll(".likes-tab").at(1)?.trigger("click");
    expect(w.find(".album-art-like").exists()).toBe(false);
  });

  it("renders one row per track with hero count", () => {
    const w = mount(LikesView, {
      props: { tracks: [track], albums: [], nowPlayingId: null, playerPlaying: false },
    });
    expect(w.findAll(".likes-track-row")).toHaveLength(1);
    expect(w.find(".likes-hero-title").text()).toBe("Мне нравится");
  });

  it("row click emits play-track", async () => {
    const w = mount(LikesView, {
      props: { tracks: [track], albums: [], nowPlayingId: null, playerPlaying: false },
    });
    await w.find(".likes-track-row").trigger("click");
    expect(w.emitted("play-track")).toBeTruthy();
    expect((w.emitted("play-track")?.[0]?.[0] as { id: string })?.id).toBe("t1");
  });

  it("like button emits toggle-like-track", async () => {
    const w = mount(LikesView, {
      props: { tracks: [track], albums: [], nowPlayingId: null, playerPlaying: false },
    });
    await w.find(".like-btn").trigger("click");
    expect(w.emitted("toggle-like-track")).toBeTruthy();
  });

  it("applies 'playing' class on now-playing row", () => {
    const w = mount(LikesView, {
      props: { tracks: [track], albums: [], nowPlayingId: "t1", playerPlaying: true },
    });
    expect(w.find(".likes-track-row").classes()).toContain("playing");
    expect(w.find(".likes-track-row").classes()).toContain("playing--active");
  });

  it("paused state sets playing--paused", () => {
    const w = mount(LikesView, {
      props: { tracks: [track], albums: [], nowPlayingId: "t1", playerPlaying: false },
    });
    expect(w.find(".likes-track-row").classes()).toContain("playing--paused");
  });

  it("context menu opens on right-click + emits add-to-queue", async () => {
    const w = mount(LikesView, {
      props: { tracks: [track], albums: [], nowPlayingId: null, playerPlaying: false },
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

  it("download button emits download-track", async () => {
    const w = mount(LikesView, { props: { tracks: [track], albums: [], nowPlayingId: null, playerPlaying: false } });
    const dl = w.find(".dl");
    if (dl.exists()) {
      await dl.trigger("click");
      expect(w.emitted("download-track")).toBeTruthy();
    }
  });

  it("ctx menu 'Скачать' emits download-track", async () => {
    const w = mount(LikesView, {
      props: { tracks: [track], albums: [], nowPlayingId: null, playerPlaying: false },
      attachTo: document.body,
    });
    await w.find(".likes-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const item = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("Скачать")) as HTMLElement | undefined;
    item?.click();
    await w.vm.$nextTick();
    expect(w.emitted("download-track")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("ctx menu 'В плейлист' emits add-to-playlist", async () => {
    const w = mount(LikesView, {
      props: { tracks: [track], albums: [], nowPlayingId: null, playerPlaying: false },
      attachTo: document.body,
    });
    await w.find(".likes-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const item = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("В плейлист")) as HTMLElement | undefined;
    item?.click();
    await w.vm.$nextTick();
    expect(w.emitted("add-to-playlist")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("ctx menu 'Источник' emits open-track-source", async () => {
    const w = mount(LikesView, {
      props: { tracks: [track], albums: [], nowPlayingId: null, playerPlaying: false },
      attachTo: document.body,
    });
    await w.find(".likes-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const item = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("Источник")) as HTMLElement | undefined;
    item?.click();
    await w.vm.$nextTick();
    expect(w.emitted("open-track-source")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});
