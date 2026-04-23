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
});
