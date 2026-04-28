import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

import AchievementsModal from "../../src/components/settings/AchievementsModal.vue";

interface Row { id: string; title: string; description: string; unlocked?: boolean; stub?: boolean }

function mountModal(props: { open?: boolean; rows?: Row[] } = {}) {
  return mount(AchievementsModal, {
    props: { open: true, rows: [], ...props },
    attachTo: document.body,
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("AchievementsModal", () => {
  it("renders nothing when closed", () => {
    mountModal({ open: false });
    expect(document.body.querySelector(".ach-modal-overlay")).toBe(null);
  });

  it("renders heading and empty list when open with no rows", () => {
    mountModal({ open: true, rows: [] });
    expect(document.body.querySelector("#ach-modal-title")?.textContent).toContain("Достижения");
    expect(document.body.querySelectorAll(".ach-modal-row")).toHaveLength(0);
  });

  it("renders row variants: unlocked / locked / stub", () => {
    mountModal({
      open: true,
      rows: [
        { id: "a", title: "A", description: "da", unlocked: true },
        { id: "b", title: "B", description: "db", unlocked: false },
        { id: "c", title: "C", description: "dc", stub: true },
      ],
    });
    expect(document.body.querySelector(".ach-modal-row--ok")).not.toBe(null);
    expect(document.body.querySelector(".ach-modal-row--locked")).not.toBe(null);
    expect(document.body.querySelector(".ach-modal-row--stub")).not.toBe(null);
    expect(document.body.querySelector(".ach-modal-stub-badge")?.textContent).toContain("заглушка");
  });

  it("overlay self-click emits update:open=false", async () => {
    const w = mountModal();
    const overlay = document.body.querySelector(".ach-modal-overlay") as HTMLElement;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await w.vm.$nextTick();
    expect(w.emitted("update:open")?.[0]).toEqual([false]);
  });

  it("close button emits update:open=false", async () => {
    const w = mountModal();
    const btn = document.body.querySelector(".ach-modal-x") as HTMLElement;
    btn.click();
    await w.vm.$nextTick();
    expect(w.emitted("update:open")?.[0]).toEqual([false]);
  });

  it("clicking the panel itself does not close the modal (stopPropagation)", async () => {
    const w = mountModal();
    const panel = document.body.querySelector(".ach-modal-panel") as HTMLElement;
    panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await w.vm.$nextTick();
    expect(w.emitted("update:open")).toBeFalsy();
  });
});
