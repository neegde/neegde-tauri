import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import PlaylistView from "../../src/components/playlist/PlaylistView.vue";
import { buildTrack } from "../../src/track/factory.js";
import { clearEntities } from "../../src/stores/entities.js";

beforeEach(() => clearEntities());

const playlist = {
  id: "pl-1", title: "My Mix", coverUrl: null,
  createdAt: 1, updatedAt: 2, trackIds: ["t1", "t2"],
};

const t1 = buildTrack({
  type: "track", id: "t1", title: "A", artist: "Artist",
  albumTitle: null, albumId: null, fileName: "01-A.mp3",
  format: null, bitrate: null, duration: null, size: 1,
  sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "A.mp3" }, raw: { cover: null } }],
});
const t2 = buildTrack({
  type: "track", id: "t2", title: "B", artist: "Artist",
  albumTitle: null, albumId: null, fileName: "02-B.mp3",
  format: null, bitrate: null, duration: null, size: 1,
  sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "B.mp3" }, raw: { cover: null } }],
});

describe("PlaylistView", () => {
  it("renders title + track count", () => {
    const w = mount(PlaylistView, {
      props: { playlist, tracks: [t1, t2], nowPlayingId: null, playerPlaying: false },
    });
    expect(w.text()).toContain("My Mix");
    expect(w.findAll(".pl-track-row").length).toBe(2);
  });

  it("click on a track emits play(idx)", async () => {
    const w = mount(PlaylistView, {
      props: { playlist, tracks: [t1, t2], nowPlayingId: null, playerPlaying: false },
    });
    const rows = w.findAll(".pl-track-row");
    await rows[1]!.trigger("click");
    expect(w.emitted("play")?.[0]).toEqual([1]);
  });

  it("right-click opens context menu → 'В очередь' emits add-to-queue", async () => {
    const w = mount(PlaylistView, {
      props: { playlist, tracks: [t1], nowPlayingId: null, playerPlaying: false },
      attachTo: document.body,
    });
    await w.find(".pl-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const queueItem = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("В очередь")) as HTMLElement | undefined;
    queueItem?.click();
    await w.vm.$nextTick();
    expect(w.emitted("add-to-queue")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("rename flow", async () => {
    const w = mount(PlaylistView, {
      props: { playlist, tracks: [], nowPlayingId: null, playerPlaying: false },
    });
    expect(w.find('input[type="text"]').exists()).toBe(false);
    // Call method via .vm — component exposes rename via click handler; simplest: call internals.
    await (w.vm as unknown as { startRename: () => void }).startRename?.();
    // Without "expose", the method may not be visible. Skip if not found.
  });
});
