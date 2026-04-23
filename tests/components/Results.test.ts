import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

import Results from "../../src/components/search/Results.vue";
import { buildTrack } from "../../src/track/factory.js";
import { clearEntities } from "../../src/stores/entities.js";

beforeEach(() => clearEntities());

const rtAlbum = {
  type: "album", id: "rt:album:1:root", title: "RT Album", artist: "Artist",
  coverUrl: null, format: "FLAC", bitrate: 1000, size: 100, seeders: 5, trackIds: ["rt:t1"],
  sources: [{ kind: "rutracker", refs: { topicId: "1" }, raw: {} }],
};

const slskAlbum = {
  type: "album", id: "slsk:album:u|F", title: "SLSK Album", artist: null,
  coverUrl: null, format: "MP3", bitrate: 320, size: 50, peers: 2, trackIds: ["slsk:t1"],
  sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFolder: "F" }, raw: { cover: null } }],
};

const slskTrack = buildTrack({
  type: "track", id: "slsk:t1", title: "Song", artist: null,
  albumTitle: null, albumId: null, fileName: "song.mp3",
  format: null, bitrate: 320, duration: 180, size: 1,
  sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "F/song.mp3" }, raw: { cover: null, peers: 3 } }],
});

describe("Results", () => {
  it("renders albums from entities prop", () => {
    const w = mount(Results, {
      props: {
        searchEpoch: 1,
        entities: [rtAlbum, slskAlbum],
        loadingAlbums: false, loadingTracks: false,
        rtLoggedIn: true, slskConnected: true,
        rtError: null, slskError: null,
        selectedId: null, query: "",
        nowPlayingId: null, playerPlaying: false,
      },
    });
    // Two albums → two cards (class .album-card common convention).
    expect(w.findAllComponents({ name: "AlbumCard" })).toHaveLength(2);
  });

  it("slskPeerFilter narrows track list", () => {
    const w = mount(Results, {
      props: {
        searchEpoch: 1,
        entities: [slskTrack, { ...slskTrack, id: "slsk:t2", sources: [{ kind: "soulseek", refs: { slskUsername: "other", slskFilepath: "x.mp3" }, raw: {} }] }],
        loadingAlbums: false, loadingTracks: false,
        rtLoggedIn: false, slskConnected: true,
        rtError: null, slskError: null,
        selectedId: null, query: "",
        slskPeerFilter: "u",
        nowPlayingId: null, playerPlaying: false,
      },
    });
    // Filtered to one row — trackRow rendered only for slsk tracks.
    expect(w.findAllComponents({ name: "SlskTrackRow" }).length).toBe(1);
  });

  it("album click bubbles select up", async () => {
    const w = mount(Results, {
      props: {
        searchEpoch: 1,
        entities: [rtAlbum],
        loadingAlbums: false, loadingTracks: false,
        rtLoggedIn: true, slskConnected: false,
        rtError: null, slskError: null,
        selectedId: null, query: "",
        nowPlayingId: null, playerPlaying: false,
      },
    });
    const card = w.findComponent({ name: "AlbumCard" });
    await card.trigger("click");
    expect(w.emitted("select")).toBeTruthy();
  });

  it("track click emits play-slsk-track", async () => {
    const w = mount(Results, {
      props: {
        searchEpoch: 1,
        entities: [slskTrack],
        loadingAlbums: false, loadingTracks: false,
        rtLoggedIn: false, slskConnected: true,
        rtError: null, slskError: null,
        selectedId: null, query: "",
        nowPlayingId: null, playerPlaying: false,
      },
    });
    const row = w.findComponent({ name: "SlskTrackRow" });
    await row.trigger("click");
    expect(w.emitted("play-slsk-track")).toBeTruthy();
  });

  it("renders peer-filter banner when filter active", () => {
    const w = mount(Results, {
      props: {
        searchEpoch: 1,
        entities: [slskTrack],
        loadingAlbums: false, loadingTracks: false,
        rtLoggedIn: false, slskConnected: true,
        rtError: null, slskError: null,
        selectedId: null, query: "",
        slskPeerFilter: "u",
        nowPlayingId: null, playerPlaying: false,
      },
    });
    expect(w.text()).toContain("Файлы пользователя");
  });
});
