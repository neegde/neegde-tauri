import { describe, it, expect } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

import MagnetLinkDialog from "../../src/components/shell/MagnetLinkDialog.vue";

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(MagnetLinkDialog, {
    props: { open: true, draft: "magnet:?xt=urn:btih:A", error: null, resolving: false, ...props },
    attachTo: document.body,
  });
}

describe("MagnetLinkDialog", () => {
  it("renders nothing when open=false", () => {
    const w = mountDialog({ open: false });
    // Teleport target (document.body) should not contain the overlay.
    expect(document.body.querySelector(".magnet-link-overlay")).toBe(null);
    w.unmount(); document.body.innerHTML = "";
  });

  it("clicking the overlay (self) emits close", async () => {
    const w = mountDialog();
    const overlay = document.body.querySelector(".magnet-link-overlay") as HTMLElement;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await w.vm.$nextTick();
    expect(w.emitted("close")).toBeTruthy();
    w.unmount(); document.body.innerHTML = "";
  });

  it("clicking the primary button emits submit", async () => {
    const w = mountDialog();
    const btn = document.body.querySelector(".magnet-link-btn--primary") as HTMLElement;
    btn.click();
    await w.vm.$nextTick();
    expect(w.emitted("submit")).toBeTruthy();
    w.unmount(); document.body.innerHTML = "";
  });

  it("Ctrl+Enter in the textarea emits submit", async () => {
    const w = mountDialog();
    const ta = document.body.querySelector(".magnet-link-input") as HTMLTextAreaElement;
    const evt = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    ta.dispatchEvent(evt);
    await w.vm.$nextTick();
    expect(w.emitted("submit")).toBeTruthy();
    w.unmount(); document.body.innerHTML = "";
  });

  it("Meta+Enter (Mac) also submits", async () => {
    const w = mountDialog();
    const ta = document.body.querySelector(".magnet-link-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    await w.vm.$nextTick();
    expect(w.emitted("submit")).toBeTruthy();
    w.unmount(); document.body.innerHTML = "";
  });

  it("plain Enter does not submit", async () => {
    const w = mountDialog();
    const ta = document.body.querySelector(".magnet-link-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await w.vm.$nextTick();
    expect(w.emitted("submit")).toBeFalsy();
    w.unmount(); document.body.innerHTML = "";
  });

  it("Ctrl+Enter does NOT submit while resolving", async () => {
    const w = mountDialog({ resolving: true });
    const ta = document.body.querySelector(".magnet-link-input") as HTMLTextAreaElement;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await w.vm.$nextTick();
    expect(w.emitted("submit")).toBeFalsy();
    w.unmount(); document.body.innerHTML = "";
  });

  it("shows the error message and resolving placeholder text", () => {
    const w = mountDialog({ error: "Неверный magnet", resolving: false });
    const err = document.body.querySelector(".magnet-link-error");
    expect(err?.textContent).toContain("Неверный magnet");
    w.unmount(); document.body.innerHTML = "";

    const w2 = mountDialog({ resolving: true });
    const title = document.body.querySelector(".magnet-link-phase");
    expect(title?.textContent).toContain("Получение метаданных");
    w2.unmount(); document.body.innerHTML = "";
  });

  it("disables the textarea and primary button while resolving", () => {
    const w = mountDialog({ resolving: true });
    const ta = document.body.querySelector(".magnet-link-input") as HTMLTextAreaElement;
    const primary = document.body.querySelector(".magnet-link-btn--primary") as HTMLButtonElement;
    expect(ta.disabled).toBe(true);
    expect(primary.disabled).toBe(true);
    w.unmount(); document.body.innerHTML = "";
  });

  it("v-model:draft propagates textarea input", async () => {
    const w = mountDialog();
    const ta = document.body.querySelector(".magnet-link-input") as HTMLTextAreaElement;
    ta.value = "magnet:?xt=urn:btih:B";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await w.vm.$nextTick();
    const emitted = w.emitted("update:draft");
    expect(emitted?.[emitted.length - 1]).toEqual(["magnet:?xt=urn:btih:B"]);
    w.unmount(); document.body.innerHTML = "";
  });
});
