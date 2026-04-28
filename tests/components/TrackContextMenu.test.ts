import { describe, it, expect, afterEach, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import TrackContextMenu from "../../src/components/shared/TrackContextMenu.vue";

afterEach(() => { document.body.innerHTML = ""; });

describe("TrackContextMenu", () => {
  it("renders nothing when closed", () => {
    const w = mount(TrackContextMenu, {
      props: { open: false, x: 0, y: 0, actions: [{ id: "play", label: "Play", icon: "play" }] },
      attachTo: document.body,
    });
    expect(document.body.querySelector(".track-ctx-panel")).toBeNull();
    w.unmount();
  });

  it("renders panel with actions when open", () => {
    const w = mount(TrackContextMenu, {
      props: {
        open: true, x: 100, y: 100,
        actions: [
          { id: "play", label: "Play", icon: "play" },
          { id: "divider" },
          { id: "like", label: "Like", icon: "heart" },
        ],
      },
      attachTo: document.body,
    });
    const items = document.body.querySelectorAll(".track-ctx-item");
    expect(items.length).toBe(2);
    const divider = document.body.querySelector(".track-ctx-divider");
    expect(divider).not.toBeNull();
    w.unmount();
  });

  it("click on action emits 'action' + 'update:open' false", async () => {
    const w = mount(TrackContextMenu, {
      props: { open: true, x: 0, y: 0, actions: [{ id: "play", label: "Play", icon: "play" }] },
      attachTo: document.body,
    });
    const btn = document.body.querySelector(".track-ctx-item") as HTMLElement;
    btn.click();
    await w.vm.$nextTick();
    expect(w.emitted("action")).toEqual([["play"]]);
    expect(w.emitted("update:open")?.[0]).toEqual([false]);
    w.unmount();
  });

  it("disabled action does not emit", async () => {
    const w = mount(TrackContextMenu, {
      props: {
        open: true, x: 0, y: 0,
        actions: [{ id: "play", label: "Play", icon: "play", disabled: true }],
      },
      attachTo: document.body,
    });
    const btn = document.body.querySelector(".track-ctx-item") as HTMLElement;
    btn.click();
    await w.vm.$nextTick();
    expect(w.emitted("action")).toBeUndefined();
    w.unmount();
  });

  it("backdrop click closes", async () => {
    const w = mount(TrackContextMenu, {
      props: { open: true, x: 0, y: 0, actions: [{ id: "x", label: "X", icon: "play" }] },
      attachTo: document.body,
    });
    const backdrop = document.body.querySelector(".track-ctx-backdrop") as HTMLElement;
    backdrop.click();
    await w.vm.$nextTick();
    expect(w.emitted("update:open")?.[0]).toEqual([false]);
    w.unmount();
  });

  it("Escape key closes when open (after open toggles)", async () => {
    const w = mount(TrackContextMenu, {
      props: { open: false, x: 0, y: 0, actions: [] },
      attachTo: document.body,
    });
    await w.setProps({ open: true });
    const ev = new KeyboardEvent("keydown", { code: "Escape" });
    document.dispatchEvent(ev);
    await w.vm.$nextTick();
    expect(w.emitted("update:open")).toBeTruthy();
    w.unmount();
  });

  it("clamps position away from right/bottom edges", () => {
    const w = mount(TrackContextMenu, {
      props: { open: true, x: 99999, y: 99999, actions: [{ id: "x", label: "X", icon: "play" }] },
      attachTo: document.body,
    });
    const panel = document.body.querySelector(".track-ctx-panel") as HTMLElement;
    expect(panel.style.left).not.toBe("99999px");
    w.unmount();
  });
});
