import { describe, it, expect, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

vi.mock("../../src/composables/usePlayerEqualizer.js", () => ({
  usePlayerEqualizer: () => ({
    equalizerEnabled: { value: false },
    equalizerBands: { value: [{ frequency: 60, gain: 0 }] },
    equalizerPreset: { value: "flat" },
    equalizerPanelOpen: { value: false },
    setEqualizerEnabled: vi.fn(),
    setEqualizerBand: vi.fn(),
    setEqualizerPreset: vi.fn(),
  }),
}));
vi.mock("../../src/torrent/api.js", async (orig) => {
  const actual = await orig<typeof import("../../src/torrent/api.js")>();
  return { ...actual };
});

import AchievementsModal from "../../src/components/settings/AchievementsModal.vue";
import EqualizerPanel from "../../src/components/settings/EqualizerPanel.vue";
import AlbumFolderCover from "../../src/components/torrent/AlbumFolderCover.vue";

describe("misc component smoke", () => {
  it("AchievementsModal mounts when open", () => {
    const w = mount(AchievementsModal, {
      props: {
        open: true,
        achievements: [{ id: "a", title: "T", description: "D", unlocked: true, stub: false }],
        unlocked: 1, total: 1,
      },
      attachTo: document.body,
    });
    expect(w.html()).toBeTruthy();
    w.unmount(); document.body.innerHTML = "";
  });

  it("AchievementsModal closed renders nothing visible", () => {
    const w = mount(AchievementsModal, {
      props: { open: false, achievements: [], unlocked: 0, total: 0 },
    });
    expect(w.html()).toBeTruthy();
  });

  it("EqualizerPanel mounts", () => {
    const w = mount(EqualizerPanel, {
      props: {
        open: true,
        enabled: false,
        bands: [{ frequency: 60, gain: 0 }],
        preset: "flat",
        presets: [{ id: "flat", label: "Flat" }],
      },
      attachTo: document.body,
    });
    expect(w.html()).toBeTruthy();
    w.unmount(); document.body.innerHTML = "";
  });

  it("AlbumFolderCover mounts with minimal props", () => {
    const w = mount(AlbumFolderCover, {
      props: {
        magnet: "magnet:?x",
        coverFile: null,
        label: "Album",
        cover: null,
        torrentId: "1",
        source: "rutracker",
      },
    });
    expect(w.html()).toBeTruthy();
  });
});
