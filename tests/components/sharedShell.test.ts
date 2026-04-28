import { describe, it, expect } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

import SystemIcon from "../../src/components/shared/SystemIcon.vue";
import CoverThumb from "../../src/components/shared/CoverThumb.vue";
import CoverLightbox from "../../src/components/shared/CoverLightbox.vue";
import NavArrows from "../../src/components/shell/NavArrows.vue";
import AchievementToast from "../../src/components/shell/AchievementToast.vue";
import DownloadProgressOverlay from "../../src/components/shell/DownloadProgressOverlay.vue";
import MagnetLinkDialog from "../../src/components/shell/MagnetLinkDialog.vue";

describe("shared / shell components — smoke", () => {
  it("SystemIcon", () => {
    expect(mount(SystemIcon, { props: { name: "link" } }).html()).toBeTruthy();
  });

  it("CoverThumb mounts with image src prop (smoke only — name varies)", () => {
    // Try a few common prop names; pass all to be safe.
    const w = mount(CoverThumb, { props: { url: "data:img", src: "data:img", size: 48 } });
    expect(w.html()).toBeTruthy();
  });

  it("CoverLightbox mounts with open=true", () => {
    const w = mount(CoverLightbox, {
      props: { open: true, url: "data:img", src: "data:img", alt: "cover" },
      attachTo: document.body,
    });
    expect(w.html()).toBeTruthy();
    w.unmount(); document.body.innerHTML = "";
  });

  it("NavArrows renders two buttons", () => {
    const w = mount(NavArrows, {
      props: { canBack: true, canForward: true, onBack: () => {}, onForward: () => {} },
    });
    expect(w.findAll("button").length).toBeGreaterThanOrEqual(2);
  });

  it("AchievementToast mounts when open", () => {
    const w = mount(AchievementToast, {
      props: { open: true, title: "Tour", description: "D" },
      attachTo: document.body,
    });
    expect(w.html()).toBeTruthy();
    w.unmount(); document.body.innerHTML = "";
  });

  it("DownloadProgressOverlay mounts with progress null", () => {
    expect(mount(DownloadProgressOverlay, { props: { progress: null, expanded: false } }).html()).toBeTruthy();
  });

  it("MagnetLinkDialog mounts when open", () => {
    const w = mount(MagnetLinkDialog, {
      props: { open: true, draft: "magnet:?x", error: null, resolving: false },
      attachTo: document.body,
    });
    expect(w.html()).toBeTruthy();
    w.unmount(); document.body.innerHTML = "";
  });
});
