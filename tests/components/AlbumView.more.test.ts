import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import AlbumView from "../../src/components/album/AlbumView.vue";
import { buildTrack } from "../../src/track/factory.js";
import { clearEntities, registerEntity, type AlbumData } from "../../src/stores/entities.js";

beforeEach(() => clearEntities());

function slskTrack(i: number) {
  return buildTrack({
    type: "track", id: `t${i}`, title: `Song ${i}`, artist: "Artist",
    albumTitle: "Alb", albumId: "alb1",
    fileName: `${i}.mp3`, format: null, bitrate: null, duration: null, size: 1024,
    sources: [{
      kind: "soulseek",
      refs: { slskUsername: "u", slskFilepath: `alb/${i}.mp3` },
      raw: { cover: null },
    }],
  });
}

function makeAlbum(trackIds: string[], overrides: Partial<AlbumData> = {}): AlbumData {
  return {
    type: "album", id: "alb1", title: "Great Album", artist: "Artist",
    trackIds, peers: null, seeders: null, size: 2048,
    sources: [{ kind: "soulseek", refs: {}, raw: { cover: null } }],
    ...overrides,
  };
}

function seed(album: AlbumData) {
  for (const id of album.trackIds) registerEntity(slskTrack(parseInt(id.slice(1), 10)));
  registerEntity(album);
}

const baseProps = {
  nowPlayingId: null, playerPlaying: false,
  likedTrackIds: new Set<string>(), albumLiked: false,
};

describe("AlbumView — labels and rowClass variants", () => {
  it.each([
    [1, "1 трек"],
    [2, "2 трека"],
    [4, "4 трека"],
    [5, "5 треков"],
  ])("track count %i → '%s'", (n, expected) => {
    const ids = Array.from({ length: n }, (_, i) => `t${i + 1}`);
    const album = makeAlbum(ids);
    seed(album);
    const w = mount(AlbumView, { props: { album, ...baseProps } });
    expect(w.text()).toContain(expected);
  });

  it.each([
    [1, "1 сид"],
    [2, "2 сида"],
    [4, "4 сида"],
    [5, "5 сидов"],
  ])("seeders %i → seedsLabel '%s'", (s, expected) => {
    const album = makeAlbum(["t1"], { seeders: s });
    seed(album);
    const w = mount(AlbumView, { props: { album, ...baseProps } });
    expect(w.find(".seeds-ok").text()).toBe(expected);
  });

  it("seeders null renders no seeds label", () => {
    const album = makeAlbum(["t1"], { seeders: null });
    seed(album);
    const w = mount(AlbumView, { props: { album, ...baseProps } });
    expect(w.find(".seeds-ok").exists()).toBe(false);
  });

  it("seeders 0 renders no seeds label", () => {
    const album = makeAlbum(["t1"], { seeders: 0 });
    seed(album);
    const w = mount(AlbumView, { props: { album, ...baseProps } });
    expect(w.find(".seeds-ok").exists()).toBe(false);
  });

  it("missing artist falls back to 'Неизвестный исполнитель'", () => {
    const album = makeAlbum(["t1"], { artist: null });
    seed(album);
    const w = mount(AlbumView, { props: { album, ...baseProps } });
    expect(w.find(".album-hero-artist").text()).toBe("Неизвестный исполнитель");
  });

  it("empty artist (whitespace only) also falls back", () => {
    const album = makeAlbum(["t1"], { artist: "   " });
    seed(album);
    const w = mount(AlbumView, { props: { album, ...baseProps } });
    expect(w.find(".album-hero-artist").text()).toBe("Неизвестный исполнитель");
  });

  it("now-playing row gets 'playing--active' when player playing", () => {
    const album = makeAlbum(["t1", "t2"]);
    seed(album);
    const w = mount(AlbumView, {
      props: { album, ...baseProps, nowPlayingId: "t2", playerPlaying: true },
    });
    const rows = w.findAll(".album-track-row");
    expect(rows[1]?.classes()).toContain("playing--active");
  });

  it("now-playing row gets 'playing--paused' when player paused", () => {
    const album = makeAlbum(["t1", "t2"]);
    seed(album);
    const w = mount(AlbumView, {
      props: { album, ...baseProps, nowPlayingId: "t2", playerPlaying: false },
    });
    const rows = w.findAll(".album-track-row");
    expect(rows[1]?.classes()).toContain("playing--paused");
  });
});

describe("AlbumView — context menu actions", () => {
  it("ctx menu fires play / queue / like / playlist / download / source emits", async () => {
    const album = makeAlbum(["t1"]);
    seed(album);
    const w = mount(AlbumView, { props: { album, ...baseProps }, attachTo: document.body });
    const row = w.findAll(".album-track-row")[0]!;

    async function clickAction(label: string) {
      await row.trigger("contextmenu", { clientX: 10, clientY: 10 });
      const buttons = Array.from(
        document.body.querySelectorAll(".track-ctx-panel button"),
      ) as HTMLElement[];
      const btn = buttons.find((b) => b.textContent?.includes(label));
      if (btn) btn.click();
      await w.vm.$nextTick();
    }

    await clickAction("Слушать");
    await clickAction("В очередь");
    await clickAction("В избранное");
    await clickAction("В плейлист");
    await clickAction("Источник");
    // Download is enabled since SoulSeek tracks have playback identity.
    await clickAction("Скачать");

    expect(w.emitted("play-track")).toBeTruthy();
    expect(w.emitted("add-to-queue")).toBeTruthy();
    expect(w.emitted("toggle-like-track")).toBeTruthy();
    expect(w.emitted("add-to-playlist")).toBeTruthy();
    expect(w.emitted("open-track-source")).toBeTruthy();
    expect(w.emitted("download-track")).toBeTruthy();

    w.unmount();
    document.body.innerHTML = "";
  });

  it("liked-track sees 'Убрать из любимых' in ctx menu", async () => {
    const album = makeAlbum(["t1"]);
    seed(album);
    const w = mount(AlbumView, {
      props: { album, ...baseProps, likedTrackIds: new Set(["t1"]) },
      attachTo: document.body,
    });
    await w.findAll(".album-track-row")[0]!.trigger("contextmenu", { clientX: 1, clientY: 1 });
    const items = Array.from(document.body.querySelectorAll(".track-ctx-panel button")) as HTMLElement[];
    expect(items.some((b) => b.textContent?.includes("Убрать из любимых"))).toBe(true);
    w.unmount(); document.body.innerHTML = "";
  });
});
