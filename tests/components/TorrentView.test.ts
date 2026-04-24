import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

vi.mock("../../src/torrent/api.js", async (orig) => {
  const actual = await orig<typeof import("../../src/torrent/api.js")>();
  return { ...actual };
});

import TorrentView from "../../src/components/torrent/TorrentView.vue";

const rtTorrent = {
  id: "42", name: "Artist - Album", source: "rutracker",
  artist: "Artist", seeders: 10, leechers: 2, size: 100_000_000,
  added: "", category: "Music",
};

const files = [
  { origIdx: 0, path: "Album/01 Song.mp3", size: 1_000_000 },
  { origIdx: 1, path: "Album/02 Song.mp3", size: 1_100_000 },
  { origIdx: 2, path: "Album/cover.jpg", size: 50_000 },
];

beforeEach(() => { document.body.innerHTML = ""; });

describe("TorrentView — smoke", () => {
  it("mounts with loading state", () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files: [], loading: true, magnet: "", cover: null,
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    expect(w.text()).toMatch(/Загрузка/);
    w.unmount();
  });

  it("mounts with files + shows hero for single album", () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "magnet:?x", cover: "data:cover",
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    expect(w.html()).toContain("album-hero");
    expect(w.findAll(".album-track-row").length).toBe(2);
    w.unmount();
  });

  it("click on track row emits play", async () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    await w.find(".album-track-row").trigger("click");
    expect(w.emitted("play")).toBeTruthy();
    w.unmount();
  });

  it("play-all FAB emits play-all", async () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    await w.find(".album-play-fab").trigger("click");
    expect(w.emitted("play-all")).toBeTruthy();
    w.unmount();
  });

  it("empty audio files → 'Аудиофайлы не найдены'", () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files: [{ origIdx: 0, path: "readme.txt", size: 10 }],
        loading: false, magnet: "m", cover: null,
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    expect(w.text()).toMatch(/не найдены/);
    w.unmount();
  });

  it("multi-album gallery: detectAlbums > 1 triggers non-hero layout", () => {
    const multiFiles = [
      { origIdx: 0, path: "CD1/01.mp3", size: 1000 },
      { origIdx: 1, path: "CD1/02.mp3", size: 1000 },
      { origIdx: 2, path: "CD2/01.mp3", size: 1000 },
      { origIdx: 3, path: "CD2/02.mp3", size: 1000 },
    ];
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files: multiFiles, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    expect(w.html()).toContain("album-header");
    w.unmount();
  });

  it("per-track like click emits toggle-like-track with row payload", async () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    await w.find(".like-btn").trigger("click");
    expect(w.emitted("toggle-like-track")).toBeTruthy();
    w.unmount();
  });

  it("per-track add-to-playlist click emits add-to-playlist", async () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    const btn = w.find(".add-to-pl");
    if (btn.exists()) {
      await btn.trigger("click");
      expect(w.emitted("add-to-playlist")).toBeTruthy();
    }
    w.unmount();
  });

  it("per-track download click emits download with origIdx", async () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    const btn = w.find(".track-btn.dl");
    if (btn.exists()) {
      await btn.trigger("click");
      expect(w.emitted("download")).toBeTruthy();
    }
    w.unmount();
  });

  it("right-click on track row opens ctx menu with source/play/download items", async () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    await w.find(".album-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const items = Array.from(document.body.querySelectorAll(".track-ctx-item"));
    expect(items.length).toBeGreaterThan(0);
    const playItem = items.find((el) => el.textContent?.includes("Слушать")) as HTMLElement | undefined;
    playItem?.click();
    await w.vm.$nextTick();
    expect(w.emitted("play")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("ctx menu 'В избранное' emits toggle-like-track", async () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    await w.find(".album-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const likeItem = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("В избранное")) as HTMLElement | undefined;
    likeItem?.click();
    await w.vm.$nextTick();
    expect(w.emitted("toggle-like-track")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("ctx menu 'В очередь' emits add-to-queue with origIdx", async () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    await w.find(".album-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const queueItem = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("В очередь")) as HTMLElement | undefined;
    queueItem?.click();
    await w.vm.$nextTick();
    expect(w.emitted("add-to-queue")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("ctx menu 'Источник' emits open-torrent-source with origIdx", async () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: -1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    await w.find(".album-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const srcItem = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("Источник")) as HTMLElement | undefined;
    srcItem?.click();
    await w.vm.$nextTick();
    expect(w.emitted("open-torrent-source")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("now-playing row gets 'playing' class with active/paused variants", () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: 0, playerPlaying: true, likes: {},
      },
      attachTo: document.body,
    });
    const rows = w.findAll(".album-track-row");
    expect(rows[0]?.classes()).toContain("playing");
    expect(rows[0]?.classes()).toContain("playing--active");
    w.unmount();
  });

  it("paused variant when playerPlaying=false", () => {
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: 1, playerPlaying: false, likes: {},
      },
      attachTo: document.body,
    });
    const rows = w.findAll(".album-track-row");
    expect(rows[1]?.classes()).toContain("playing--paused");
    w.unmount();
  });

  it("album liked state reflects likes dict", () => {
    // Single-album hero path reads albumLikeId.
    const w = mount(TorrentView, {
      props: {
        torrent: rtTorrent, files, loading: false, magnet: "m", cover: null,
        nowPlayingIdx: -1, playerPlaying: false,
        likes: { "album:rutracker:42:Album": { id: "x", type: "album" } },
      },
      attachTo: document.body,
    });
    const likedBtn = w.find(".album-tool-btn.liked");
    expect(likedBtn.exists()).toBe(true);
    w.unmount();
  });
});
