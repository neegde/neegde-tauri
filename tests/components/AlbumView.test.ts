import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import AlbumView from "../../src/components/album/AlbumView.vue";
import { buildTrack } from "../../src/track/factory.js";
import { clearEntities, registerEntity, type AlbumData } from "../../src/stores/entities.js";

beforeEach(() => clearEntities());

const slskTrackData = (i: number) => ({
  type: "track" as const, id: `t${i}`, title: `Song ${i}`, artist: "Artist",
  albumTitle: "Alb", albumId: "alb1",
  fileName: `${i}.mp3`, format: null, bitrate: null, duration: null, size: 1024,
  sources: [{
    kind: "soulseek" as const,
    refs: { slskUsername: "u", slskFilepath: `alb/${i}.mp3` },
    raw: { cover: null },
  }],
});

const album: AlbumData = {
  type: "album", id: "alb1", title: "Great Album", artist: "Artist",
  trackIds: ["t1", "t2"], peers: null, seeders: 7, size: 2048,
  sources: [{ kind: "soulseek", refs: {}, raw: { cover: null } }],
};

function seedEntities() {
  registerEntity(buildTrack(slskTrackData(1)));
  registerEntity(buildTrack(slskTrackData(2)));
  registerEntity(album);
}

describe("AlbumView", () => {
  it("renders hero with title and artist", () => {
    seedEntities();
    const w = mount(AlbumView, {
      props: {
        album, nowPlayingId: null, playerPlaying: false,
        likedTrackIds: new Set<string>(), albumLiked: false,
      },
    });
    expect(w.find(".album-hero-title").text()).toBe("Great Album");
    expect(w.find(".album-hero-artist").text()).toBe("Artist");
    expect(w.findAll(".album-track-row")).toHaveLength(2);
  });

  it("play-all click emits play-all", async () => {
    seedEntities();
    const w = mount(AlbumView, {
      props: { album, nowPlayingId: null, playerPlaying: false, likedTrackIds: new Set<string>(), albumLiked: false },
    });
    await w.find(".album-play-fab").trigger("click");
    expect(w.emitted("play-all")).toBeTruthy();
  });

  it("track row click emits play-track with Track", async () => {
    seedEntities();
    const w = mount(AlbumView, {
      props: { album, nowPlayingId: null, playerPlaying: false, likedTrackIds: new Set<string>(), albumLiked: false },
    });
    await w.findAll(".album-track-row")[0]!.trigger("click");
    const emitted = w.emitted("play-track");
    expect(emitted).toBeTruthy();
    expect((emitted?.[0]?.[0] as { id: string })?.id).toBe("t1");
  });

  it("album like toggle emits toggle-like-album", async () => {
    seedEntities();
    const w = mount(AlbumView, {
      props: { album, nowPlayingId: null, playerPlaying: false, likedTrackIds: new Set<string>(), albumLiked: false },
    });
    const btn = w.findAll(".album-tool-btn").at(0);
    await btn!.trigger("click");
    expect(w.emitted("toggle-like-album")).toBeTruthy();
  });

  it("track like button emits toggle-like-track", async () => {
    seedEntities();
    const w = mount(AlbumView, {
      props: { album, nowPlayingId: null, playerPlaying: false, likedTrackIds: new Set<string>(), albumLiked: false },
    });
    // First like-btn inside first track row.
    await w.findAll(".like-btn")[0]!.trigger("click");
    expect(w.emitted("toggle-like-track")).toBeTruthy();
  });

  it("download-album button emits download-album", async () => {
    seedEntities();
    const w = mount(AlbumView, {
      props: { album, nowPlayingId: null, playerPlaying: false, likedTrackIds: new Set<string>(), albumLiked: false },
    });
    const buttons = w.findAll(".album-tool-btn");
    await buttons.at(1)!.trigger("click"); // second tool btn = download
    expect(w.emitted("download-album")).toBeTruthy();
  });

  it("empty tracks shows empty-msg", () => {
    const albumEmpty = { ...album, trackIds: [] as string[] };
    const w = mount(AlbumView, {
      props: { album: albumEmpty, nowPlayingId: null, playerPlaying: false, likedTrackIds: new Set<string>(), albumLiked: false },
    });
    expect(w.find(".empty-msg").text()).toMatch(/Треки ещё не/);
  });

  it("highlights nowPlaying with PlayingIndicator", () => {
    seedEntities();
    const w = mount(AlbumView, {
      props: { album, nowPlayingId: "t2", playerPlaying: true, likedTrackIds: new Set<string>(), albumLiked: false },
    });
    const rows = w.findAll(".album-track-row");
    expect(rows[1]!.classes()).toContain("playing");
  });

  it("opens context menu on right-click", async () => {
    seedEntities();
    const w = mount(AlbumView, {
      props: { album, nowPlayingId: null, playerPlaying: false, likedTrackIds: new Set<string>(), albumLiked: false },
      attachTo: document.body,
    });
    const row = w.findAll(".album-track-row")[0]!;
    await row.trigger("contextmenu", { clientX: 10, clientY: 10 });
    const menu = document.body.querySelector(".track-ctx-panel");
    expect(menu).not.toBeNull();
    w.unmount();
    document.body.innerHTML = "";
  });
});
