import { describe, it, expect, beforeEach, vi } from "vitest";
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

  it("enrichment arriving after mount starts erase/type animation", async () => {
    vi.useFakeTimers();
    const w = mount(SlskTrackRow, { props: { track, enriched: null } });
    await w.vm.$nextTick();
    await w.setProps({ enriched: { artist: "A", title: "New Title", coverUrl: null } });
    vi.advanceTimersByTime(2000);
    await w.vm.$nextTick();
    vi.useRealTimers();
    expect(w.html()).toBeTruthy();
  });

  it("context menu download emits download", async () => {
    const w = mount(SlskTrackRow, { props: { track }, attachTo: document.body });
    await w.find(".slsk-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const item = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("Скачать")) as HTMLElement | undefined;
    item?.click();
    await w.vm.$nextTick();
    expect(w.emitted("download")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("context menu like emits like", async () => {
    const w = mount(SlskTrackRow, { props: { track }, attachTo: document.body });
    await w.find(".slsk-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const item = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("В избранное")) as HTMLElement | undefined;
    item?.click();
    await w.vm.$nextTick();
    expect(w.emitted("like")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("context menu add-to-playlist emits add-to-playlist", async () => {
    const w = mount(SlskTrackRow, { props: { track }, attachTo: document.body });
    await w.find(".slsk-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const item = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("В плейлист")) as HTMLElement | undefined;
    item?.click();
    await w.vm.$nextTick();
    expect(w.emitted("add-to-playlist")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("context menu source emits open-source", async () => {
    const w = mount(SlskTrackRow, { props: { track }, attachTo: document.body });
    await w.find(".slsk-track-row").trigger("contextmenu", { clientX: 0, clientY: 0 });
    const item = Array.from(document.body.querySelectorAll(".track-ctx-item"))
      .find((el) => el.textContent?.includes("SoulSeek")) as HTMLElement | undefined;
    item?.click();
    await w.vm.$nextTick();
    expect(w.emitted("open-source")).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });
});
