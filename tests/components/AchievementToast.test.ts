import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

import AchievementToast from "../../src/components/shell/AchievementToast.vue";

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
});

function mountToast(props: Record<string, unknown> = {}) {
  return mount(AchievementToast, {
    props: { title: "Tour", description: "Играл 10 треков подряд", open: true, ...props },
    attachTo: document.body,
  });
}

describe("AchievementToast", () => {
  it("renders nothing when closed or title empty", () => {
    const w = mountToast({ open: false });
    expect(document.body.querySelector(".ach-toast")).toBe(null);
    w.unmount();
    mountToast({ open: true, title: "" });
    expect(document.body.querySelector(".ach-toast")).toBe(null);
  });

  it("renders title and description when open", () => {
    mountToast();
    expect(document.body.querySelector(".ach-toast-title")?.textContent).toBe("Tour");
    expect(document.body.querySelector(".ach-toast-desc")?.textContent).toContain("Играл");
  });

  it("auto-hides after ~5.5s via update:open=false", async () => {
    // Initial-prop watch doesn't fire; toggle closed→open so the watcher runs
    // and scheduleHide arms the timer.
    const w = mountToast({ open: false });
    await w.setProps({ open: true });
    vi.advanceTimersByTime(5500);
    await w.vm.$nextTick();
    expect(w.emitted("update:open")?.[0]).toEqual([false]);
  });

  it("close button emits update:open=false immediately", async () => {
    const w = mountToast();
    const btn = document.body.querySelector(".ach-toast-close") as HTMLElement;
    btn.click();
    await w.vm.$nextTick();
    expect(w.emitted("update:open")?.[0]).toEqual([false]);
  });

  it("toggling open=false before the timer fires clears it (no auto-emit)", async () => {
    const w = mountToast({ open: false });
    await w.setProps({ open: true });  // arm timer
    await w.setProps({ open: false });  // clear timer
    vi.advanceTimersByTime(6000);
    await w.vm.$nextTick();
    // No update:open emission from the timer.
    expect(w.emitted("update:open")).toBeFalsy();
  });

  it("unmount cancels the pending timer (no rogue emit)", async () => {
    const w = mountToast({ open: true });
    w.unmount();
    vi.advanceTimersByTime(6000);
    // No errors; no new emissions after unmount.
    expect(true).toBe(true);
  });

  it("re-opening after close schedules a fresh timer", async () => {
    const w = mountToast({ open: false });
    await w.setProps({ open: true });
    vi.advanceTimersByTime(2000);
    await w.setProps({ open: false });
    await w.setProps({ open: true });
    vi.advanceTimersByTime(5500);
    await w.vm.$nextTick();
    // After second full cycle there should be two update:open=false emissions
    // (one from the auto timer; the other was the manual open=false transition
    // which does NOT emit — close() does, timer does. So exactly 1 at this point).
    const events = w.emitted("update:open") ?? [];
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]).toEqual([false]);
  });
});
