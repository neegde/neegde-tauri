import { describe, it, expect, vi, afterEach } from "vitest";
import "../_setup.js";
import { defineComponent, h, ref } from "vue";
import { mount } from "@vue/test-utils";
import { useMouseSideButtonNav } from "../../src/composables/useMouseSideButtonNav.js";

function mountWith(onBack: () => void, onForward: () => void, flags = { back: true, forward: true }) {
  const canGoBack = ref(flags.back);
  const canGoForward = ref(flags.forward);
  const Wrapper = defineComponent({
    setup() {
      useMouseSideButtonNav({ canGoBack, canGoForward, onBack, onForward });
      return () => h("div");
    },
  });
  const w = mount(Wrapper, { attachTo: document.body });
  return { canGoBack, canGoForward, wrapper: w };
}

function mouseDown(button: number, buttons = 0) {
  const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "button", { value: button });
  Object.defineProperty(e, "buttons", { value: buttons });
  const sp = vi.spyOn(e, "stopPropagation");
  const pd = vi.spyOn(e, "preventDefault");
  window.dispatchEvent(e);
  return { e, sp, pd };
}

function mouseUp(button: number) {
  const e = new MouseEvent("mouseup", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "button", { value: button });
  const sp = vi.spyOn(e, "stopPropagation");
  const pd = vi.spyOn(e, "preventDefault");
  window.dispatchEvent(e);
  return { e, sp, pd };
}

afterEach(() => { document.body.innerHTML = ""; });

describe("useMouseSideButtonNav", () => {
  it("button 3 (X1) fires onBack", () => {
    const back = vi.fn(); const fwd = vi.fn();
    mountWith(back, fwd);
    const { sp, pd } = mouseDown(3);
    expect(back).toHaveBeenCalled();
    expect(fwd).not.toHaveBeenCalled();
    expect(sp).toHaveBeenCalled();
    expect(pd).toHaveBeenCalled();
  });

  it("button 4 (X2) fires onForward", () => {
    const back = vi.fn(); const fwd = vi.fn();
    mountWith(back, fwd);
    mouseDown(4);
    expect(fwd).toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it("buttons bitmask 8 → back", () => {
    const back = vi.fn();
    mountWith(back, vi.fn());
    mouseDown(0, 8);
    expect(back).toHaveBeenCalled();
  });

  it("buttons bitmask 16 → forward", () => {
    const fwd = vi.fn();
    mountWith(vi.fn(), fwd);
    mouseDown(0, 16);
    expect(fwd).toHaveBeenCalled();
  });

  it("regular left click is ignored", () => {
    const back = vi.fn(); const fwd = vi.fn();
    mountWith(back, fwd);
    mouseDown(0);
    expect(back).not.toHaveBeenCalled();
    expect(fwd).not.toHaveBeenCalled();
  });

  it("canGoBack=false swallows back event", () => {
    const back = vi.fn();
    mountWith(back, vi.fn(), { back: false, forward: true });
    mouseDown(3);
    expect(back).not.toHaveBeenCalled();
  });

  it("mouseup with side button preventDefault's default action", () => {
    mountWith(vi.fn(), vi.fn());
    const { pd } = mouseUp(4);
    expect(pd).toHaveBeenCalled();
  });

  it("mouseup with non-side button is left alone", () => {
    mountWith(vi.fn(), vi.fn());
    const { pd } = mouseUp(0);
    expect(pd).not.toHaveBeenCalled();
  });

  it("unmount removes listeners", () => {
    const back = vi.fn();
    const { wrapper } = mountWith(back, vi.fn());
    wrapper.unmount();
    mouseDown(3);
    expect(back).not.toHaveBeenCalled();
  });
});
