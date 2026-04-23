import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import TrackCover from "../../src/components/shared/TrackCover.vue";
import { clearEntities, registerEntity } from "../../src/stores/entities.js";
import { buildAlbum } from "../../src/album/factory.js";
import type { AlbumData } from "../../src/album/types.js";
import { rememberSlskCover, clearSlskCoverCache } from "../../src/soulseek/coverCache.js";

beforeEach(() => {
  clearEntities();
  clearSlskCoverCache();
});

const albumData: AlbumData = {
  type: "album",
  id: "slsk:album:u|folder",
  title: "A",
  artist: null,
  trackIds: [],
  sources: [{
    kind: "soulseek",
    refs: { slskUsername: "u", slskFolder: "folder" },
    raw: { cover: { slsk_username: "u", slsk_filepath: "folder/cover.jpg", size: 1024 } },
  }],
};

describe("TrackCover", () => {
  it("renders fallback when no entity + no override", () => {
    const w = mount(TrackCover, { props: { entity: null } });
    expect(w.find("svg.track-cover-fallback").exists()).toBe(true);
    expect(w.find("img").exists()).toBe(false);
  });

  it("renders override-url image when provided", () => {
    const w = mount(TrackCover, { props: { entity: null, overrideUrl: "data:override" } });
    expect(w.find("img").attributes("src")).toBe("data:override");
  });

  it("renders entity cover when cached (album path)", () => {
    const album = buildAlbum(albumData);
    registerEntity(album);
    rememberSlskCover("u", "folder/cover.jpg", "data:image/png;base64,AAA");
    const w = mount(TrackCover, { props: { entity: album, size: 80 } });
    expect(w.find("img").exists()).toBe(true);
  });

  it("fill variant does not set inline width/height", () => {
    const w = mount(TrackCover, { props: { entity: null, fill: true } });
    const root = w.find(".track-cover");
    expect(root.classes()).toContain("track-cover--fill");
  });

  it("size prop controls inline dimensions", () => {
    const w = mount(TrackCover, { props: { entity: null, size: 120 } });
    const root = w.find(".track-cover");
    expect(root.attributes("style")).toContain("120px");
  });
});
