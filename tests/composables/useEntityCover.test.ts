import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { defineComponent, h, ref } from "vue";
import { mount } from "@vue/test-utils";

import { useEntityCover } from "../../src/composables/useEntityCover.js";
import { buildTrack } from "../../src/track/factory.js";
import { clearEntities, registerEntity, type AlbumData } from "../../src/stores/entities.js";
import { rememberSlskCover, clearSlskCoverCache } from "../../src/soulseek/coverCache.js";
import { rememberRutrackerCover, clearRutrackerCoverCache } from "../../src/rutracker/coverCache.js";

beforeEach(() => {
  clearEntities();
  clearSlskCoverCache();
  clearRutrackerCoverCache();
});

function mountWith(entityRef: ReturnType<typeof ref>) {
  let api!: ReturnType<typeof useEntityCover>;
  const rootRef = ref<HTMLElement | null>(document.createElement("div"));
  const Wrapper = defineComponent({
    setup() {
      api = useEntityCover(entityRef as never, rootRef);
      return () => h("div", { ref: rootRef });
    },
  });
  mount(Wrapper, { attachTo: document.body });
  return api;
}

describe("useEntityCover", () => {
  it("null entity → null cover", () => {
    const { coverUrl } = mountWith(ref(null));
    expect(coverUrl.value).toBe(null);
  });

  it("album data path: uses album.coverUrl if present", () => {
    const album: AlbumData = {
      type: "album", id: "a1", title: "T", artist: null, trackIds: [],
      coverUrl: "data:inline",
      sources: [{ kind: "rutracker", refs: {} }],
    };
    const { coverUrl } = mountWith(ref(album));
    expect(coverUrl.value).toBe("data:inline");
  });

  it("album soulseek branch reads reactive cache", () => {
    const album: AlbumData = {
      type: "album", id: "a2", title: "T", artist: null, trackIds: [],
      sources: [{
        kind: "soulseek",
        raw: { cover: { slsk_username: "u", slsk_filepath: "cover.jpg" } },
      }],
    };
    rememberSlskCover("u", "cover.jpg", "data:slsk");
    const { coverUrl } = mountWith(ref(album));
    expect(coverUrl.value).toBe("data:slsk");
  });

  it("album rutracker branch reads reactive cache", () => {
    const album: AlbumData = {
      type: "album", id: "a3", title: "T", artist: null, trackIds: [],
      sources: [{ kind: "rutracker", refs: { topicId: "42" } }],
    };
    rememberRutrackerCover("42", "data:rt");
    const { coverUrl } = mountWith(ref(album));
    expect(coverUrl.value).toBe("data:rt");
  });

  it("Track instance branch: delegates to track.coverUrl()", () => {
    // Create a track with a parent album for the cover ref.
    const album: AlbumData = {
      type: "album", id: "alb", title: "A", artist: null, trackIds: [],
      sources: [{
        kind: "soulseek",
        raw: { cover: { slsk_username: "u2", slsk_filepath: "c.jpg" } },
      }],
    };
    registerEntity(album);
    rememberSlskCover("u2", "c.jpg", "data:trk");
    const track = buildTrack({
      type: "track", id: "t1", title: "x", artist: null, albumTitle: null,
      albumId: "alb", fileName: "x.mp3",
      format: null, bitrate: null, duration: null, size: 1,
      sources: [{
        kind: "soulseek",
        refs: { slskUsername: "u2", slskFilepath: "x.mp3" },
        raw: { cover: null },
      }],
    });
    const { coverUrl } = mountWith(ref(track));
    expect(coverUrl.value).toBe("data:trk");
  });

  it("coverErr toggles on <img @error>", () => {
    const { coverErr } = mountWith(ref(null));
    expect(coverErr.value).toBe(false);
  });
});
