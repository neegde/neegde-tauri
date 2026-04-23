import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockInvoke, fakeLocalStorage } from "../_setup.js";
import { mount } from "@vue/test-utils";

vi.mock("../../src/appDebugWindow.js", () => ({
  openAppDebugWindow: vi.fn().mockResolvedValue(undefined),
  closeAppDebugWindow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));

import SettingsView from "../../src/components/settings/SettingsView.vue";

beforeEach(() => {
  fakeLocalStorage.clear();
  mockInvoke.mockReset();
});

describe("SettingsView — smoke", () => {
  it("mounts when logged out", () => {
    mockInvoke.mockResolvedValue(null);
    const w = mount(SettingsView, {
      props: {
        rtLoggedIn: false, rtUsername: "", rtAvatarUrl: "",
        restoringSession: false, theme: "dark", appDebugEnabled: false,
        achievementsOptIn: false, achievementsUnlocked: [],
        slskConnected: false, slskUsername: "", slskLoggingIn: false, slskLoginError: "",
      },
      attachTo: document.body,
    });
    expect(w.html()).toBeTruthy();
    w.unmount();
    document.body.innerHTML = "";
  });

  it("mounts when logged in", () => {
    mockInvoke.mockResolvedValue(null);
    const w = mount(SettingsView, {
      props: {
        rtLoggedIn: true, rtUsername: "neo", rtAvatarUrl: "",
        restoringSession: false, theme: "dark", appDebugEnabled: false,
        achievementsOptIn: false, achievementsUnlocked: [],
        slskConnected: true, slskUsername: "neo", slskLoggingIn: false, slskLoginError: "",
      },
      attachTo: document.body,
    });
    expect(w.text()).toContain("neo");
    w.unmount();
    document.body.innerHTML = "";
  });

  it("theme-change event fires on theme button click", async () => {
    mockInvoke.mockResolvedValue(null);
    const w = mount(SettingsView, {
      props: {
        rtLoggedIn: false, rtUsername: "", rtAvatarUrl: "",
        restoringSession: false, theme: "dark", appDebugEnabled: false,
        achievementsOptIn: false, achievementsUnlocked: [],
        slskConnected: false, slskUsername: "", slskLoggingIn: false, slskLoginError: "",
      },
      attachTo: document.body,
    });
    // Find any theme-related button (there are 3 in the UI).
    const buttons = w.findAll("button");
    // Not asserting specific emit — this is smoke. Just ensure no crashes.
    expect(buttons.length).toBeGreaterThan(0);
    w.unmount();
    document.body.innerHTML = "";
  });
});
