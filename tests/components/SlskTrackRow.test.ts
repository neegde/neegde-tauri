import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import SlskTrackRow from "../../src/components/search/SlskTrackRow.vue";
import { buildTrack } from "../../src/track/factory.js";
import { clearEntities } from "../../src/stores/entities.js";

beforeEach(() => clearEntities());

const track = buildTrack({
  type: "track", id: "slsk:track:u|A/01.mp3", title: "01.mp3", artist: null,
  albumTitle: null, albumId: null, fileName: "01.mp3",
  format: null, bitrate: 320, duration: 180, size: 2_000_000,
  sources: [{
    kind: "soulseek",
    refs: { slskUsername: "u", slskFilepath: "A/01.mp3" },
    raw: { cover: null },
  }],
});

describe("SlskTrackRow", () => {
  it("renders chip with bitrate + duration", () => {
    const w = mount(SlskTrackRow, { props: { track } });
    expect(w.text()).toContain("320 kbps");
    expect(w.text()).toContain("3:00");
  });

  it("click emits play", async () => {
    const w = mount(SlskTrackRow, { props: { track } });
    await w.find(".slsk-track-row").trigger("click");
    expect(w.emitted("play")).toBeTruthy();
  });

  it("play button emits play (stopPropagation inside component)", async () => {
    const w = mount(SlskTrackRow, { props: { track } });
    await w.find(".slsk-track-play").trigger("click");
    expect(w.emitted("play")).toBeTruthy();
  });

  it("now-playing: shows PlayingIndicator + class", () => {
    const w = mount(SlskTrackRow, {
      props: { track, nowPlaying: true, playerPlaying: true },
    });
    expect(w.find(".slsk-track-row").classes()).toContain("playing");
    expect(w.find(".slsk-track-row").classes()).toContain("playing--active");
  });

  it("right-click opens context menu + 'Слушать' emits play", async () => {
    const w = mount(SlskTrackRow, { props: { track }, attachTo: document.body });
    await w.find(".slsk-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const playItem = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("Слушать")) as HTMLElement | undefined;
    playItem?.click();
    await w.vm.$nextTick();
    expect(w.emitted("play")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("enriched prop shows artist after animation", async () => {
    const w = mount(SlskTrackRow, {
      props: { track, enriched: { artist: "A", title: "T", coverUrl: null } },
    });
    await w.vm.$nextTick();
    expect(w.text()).toMatch(/T/);
  });
});
