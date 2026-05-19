import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

import CoverLightbox from "../../src/components/shared/CoverLightbox.vue";

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.style.overflow = "";
});

afterEach(() => {
  document.documentElement.style.overflow = "";
});

function mountBox(props: Record<string, unknown> = {}) {
  return mount(CoverLightbox, {
    props: { open: true, src: "data:image/png;base64,AAA", alt: "cover", ...props },
    attachTo: document.body,
  });
}

describe("CoverLightbox", () => {
  it("renders nothing when closed or src empty", () => {
    mountBox({ open: false });
    expect(document.body.querySelector(".cover-lb-overlay")).toBe(null);
    document.body.innerHTML = "";
    mountBox({ src: "" });
    expect(document.body.querySelector(".cover-lb-overlay")).toBe(null);
  });

  it("renders image with src + alt when open", () => {
    mountBox({ src: "data:image/jpg;base64,XYZ", alt: "cover art" });
    const img = document.body.querySelector(".cover-lb-img") as HTMLImageElement;
    expect(img.src).toContain("data:image/jpg");
    expect(img.alt).toBe("cover art");
  });

  it("large variant toggles CSS class on img+frame", () => {
    mountBox({ large: true });
    expect(document.body.querySelector(".cover-lb-img--large")).not.toBe(null);
    expect(document.body.querySelector(".cover-lb-frame--large")).not.toBe(null);
  });

  it("overlay self-click emits update:open=false", async () => {
    const w = mountBox();
    const overlay = document.body.querySelector(".cover-lb-overlay") as HTMLElement;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await w.vm.$nextTick();
    expect(w.emitted("update:open")?.[0]).toEqual([false]);
  });

  it("close button emits update:open=false", async () => {
    const w = mountBox();
    const btn = document.body.querySelector(".cover-lb-close") as HTMLElement;
    btn.click();
    await w.vm.$nextTick();
    expect(w.emitted("update:open")?.[0]).toEqual([false]);
  });

  it("Escape key closes the lightbox when open", async () => {
    const w = mountBox();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await w.vm.$nextTick();
    expect(w.emitted("update:open")?.[0]).toEqual([false]);
  });

  it("Escape is ignored when not open", async () => {
    const w = mountBox({ open: false });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await w.vm.$nextTick();
    expect(w.emitted("update:open")).toBeFalsy();
  });

  it("locks body scroll when open, unlocks on close", async () => {
    // Watch only triggers on change; start closed.
    const w = mountBox({ open: false });
    await w.setProps({ open: true });
    expect(document.documentElement.style.overflow).toBe("hidden");
    await w.setProps({ open: false });
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("unmount clears the overflow lock", async () => {
    const w = mountBox({ open: false });
    await w.setProps({ open: true });
    expect(document.documentElement.style.overflow).toBe("hidden");
    w.unmount();
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("click on frame does not bubble to overlay (stopPropagation)", async () => {
    const w = mountBox();
    const frame = document.body.querySelector(".cover-lb-frame") as HTMLElement;
    frame.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await w.vm.$nextTick();
    // No close event should fire from clicking inside the frame.
    expect(w.emitted("update:open")).toBeFalsy();
  });

  it("keeps overlay image when src becomes empty while still open", async () => {
    const w = mount(CoverLightbox, {
      props: { open: true, src: "data:image/png;base64,AAA", alt: "cover" },
      attachTo: document.body,
    });
    const img0 = document.body.querySelector(".cover-lb-img") as HTMLImageElement;
    expect(img0.src).toContain("data:image/png");
    await w.setProps({ src: "" });
    await w.vm.$nextTick();
    expect(document.body.querySelector(".cover-lb-overlay")).not.toBe(null);
    const img1 = document.body.querySelector(".cover-lb-img") as HTMLImageElement;
    expect(img1.src).toContain("data:image/png");
    w.unmount();
    document.body.innerHTML = "";
  });
});
