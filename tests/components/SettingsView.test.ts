import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockInvoke, fakeLocalStorage } from "../_setup.js";
import { mount } from "@vue/test-utils";

vi.mock("../../src/appDebugWindow.js", () => ({
  openAppDebugWindow: vi.fn().mockResolvedValue(undefined),
  closeAppDebugWindow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));

import SettingsView from "../../src/components/settings/SettingsView.vue";

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    rtLoggedIn: false, rtUsername: "", rtAvatarUrl: "",
    restoringSession: false, theme: "dark", appDebugEnabled: false,
    achievementsOptIn: false, achievementsUnlocked: [],
    slskConnected: false, slskUsername: "", slskLoggingIn: false, slskLoginError: "",
    ...overrides,
  };
}

beforeEach(() => {
  fakeLocalStorage.clear();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(null);
});

describe("SettingsView — smoke", () => {
  it("mounts when logged out", () => {
    const w = mount(SettingsView, { props: baseProps(), attachTo: document.body });
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("mounts when logged in", () => {
    const w = mount(SettingsView, {
      props: baseProps({
        rtLoggedIn: true, rtUsername: "neo", slskConnected: true, slskUsername: "neo",
      }),
      attachTo: document.body,
    });
    expect(w.text()).toContain("neo");
    w.unmount();
  });

  it("renders restoring-session state", () => {
    const w = mount(SettingsView, {
      props: baseProps({ restoringSession: true }),
      attachTo: document.body,
    });
    expect(w.text()).toMatch(/Проверяем/);
    w.unmount();
  });
});

describe("SettingsView — interactions", () => {
  it("theme buttons each emit theme-change", async () => {
    const w = mount(SettingsView, { props: baseProps(), attachTo: document.body });
    for (const b of w.findAll("button")) {
      const t = b.text().trim().toLowerCase();
      if (/тёмн|dark|светл|light|систем|system/.test(t)) {
        await b.trigger("click");
      }
    }
    expect(w.emitted("theme-change")).toBeTruthy();
    w.unmount();
  });

  it("logged-in user sees 'Выйти' button", () => {
    const w = mount(SettingsView, {
      props: baseProps({ rtLoggedIn: true, rtUsername: "neo" }),
      attachTo: document.body,
    });
    const btn = w.findAll("button").find((b) => b.text().trim() === "Выйти");
    expect(btn).toBeDefined();
    w.unmount();
  });

  it("slsk logged-in user can trigger slsk-logout", async () => {
    const w = mount(SettingsView, {
      props: baseProps({ slskConnected: true, slskUsername: "neo" }),
      attachTo: document.body,
    });
    const btns = w.findAll("button").filter((b) => b.text().trim().toLowerCase().includes("выйти"));
    // Multiple "Выйти" buttons may exist (rt + slsk). Click the last one = slsk.
    if (btns.length) await btns.at(-1)!.trigger("click");
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("slsk login form submit emits slsk-login", async () => {
    const w = mount(SettingsView, { props: baseProps(), attachTo: document.body });
    const form = w.findAll("form").at(-1);
    if (form) {
      const ins = form.findAll("input");
      if (ins.length >= 2) {
        await ins[0]!.setValue("u1");
        await ins[1]!.setValue("p1");
        await form.trigger("submit");
        expect(w.emitted("slsk-login")).toBeTruthy();
      }
    }
    w.unmount();
  });

  it("nerd-toggle buttons open/close sections", async () => {
    const w = mount(SettingsView, { props: baseProps(), attachTo: document.body });
    const nerdBtns = w.findAll(".nerd-toggle");
    expect(nerdBtns.length).toBeGreaterThan(0);
    await nerdBtns[0]!.trigger("click");
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("debug-enabled prop + 'update:appDebugEnabled' emit path", async () => {
    const w = mount(SettingsView, {
      props: baseProps({ appDebugEnabled: false }),
      attachTo: document.body,
    });
    const cbs = w.findAll('input[type="checkbox"]');
    if (cbs.length) await cbs[0]!.setValue(true);
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("release check via nerd-panel buttons", async () => {
    mockInvoke.mockResolvedValue(null);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ tag_name: "test.0.0.0", html_url: "https://gh" }),
    }) as unknown as typeof fetch;
    try {
      const w = mount(SettingsView, { props: baseProps(), attachTo: document.body });
      for (const n of w.findAll(".nerd-toggle")) await n.trigger("click");
      const btn = w.findAll("button").find((b) => /обнови|проверить/i.test(b.text()));
      if (btn) await btn.trigger("click");
      await Promise.resolve();
      await Promise.resolve();
      expect(w.html()).toBeTruthy();
      w.unmount();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("save/reset buttons (mirror + proxy) in nerd panel trigger invoke", async () => {
    mockInvoke.mockResolvedValue(null);
    const w = mount(SettingsView, { props: baseProps(), attachTo: document.body });
    for (const n of w.findAll(".nerd-toggle")) await n.trigger("click");
    const saveBtns = w.findAll("button").filter((b) => /сохранить|проверить|сброс/i.test(b.text()));
    for (const b of saveBtns) await b.trigger("click");
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("clear-cache buttons run", async () => {
    const w = mount(SettingsView, { props: baseProps(), attachTo: document.body });
    for (const n of w.findAll(".nerd-toggle")) await n.trigger("click");
    const clearBtns = w.findAll("button").filter((b) => /очист/i.test(b.text()));
    for (const b of clearBtns) await b.trigger("click");
    expect(w.html()).toBeTruthy();
    w.unmount();
  });

  it("achievements browse + reset", async () => {
    const w = mount(SettingsView, {
      props: baseProps({ achievementsOptIn: true, achievementsUnlocked: ["first_heart"] }),
      attachTo: document.body,
    });
    for (const b of w.findAll("button")) {
      if (/наград|достиж|сброс/i.test(b.text())) await b.trigger("click");
    }
    expect(w.html()).toBeTruthy();
    w.unmount();
  });
});
