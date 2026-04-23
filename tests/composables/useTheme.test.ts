import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeLocalStorage } from "../_setup.js";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";

import { useTheme } from "../../src/composables/useTheme.js";

const originalMatchMedia = globalThis.matchMedia;

function installMatchMedia(darkPreferred: boolean) {
  const listeners: Array<(e: unknown) => void> = [];
  const mql = {
    matches: darkPreferred,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, cb: (e: unknown) => void) => listeners.push(cb),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
  } as unknown as MediaQueryList;
  (globalThis as unknown as { matchMedia: typeof matchMedia }).matchMedia = () => mql;
  return { mql, fire: () => listeners.forEach((l) => l({})) };
}

function mountWithTheme<R>(run: (api: ReturnType<typeof useTheme>) => R): R {
  let out!: R;
  const Wrapper = defineComponent({
    setup() {
      out = run(useTheme());
      return () => h("div");
    },
  });
  mount(Wrapper);
  return out;
}

beforeEach(() => {
  fakeLocalStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  if (originalMatchMedia) {
    (globalThis as unknown as { matchMedia: typeof matchMedia }).matchMedia = originalMatchMedia;
  }
});
import { afterEach } from "vitest";

describe("useTheme — initial state", () => {
  it("defaults to 'dark' when storage empty", () => {
    installMatchMedia(true);
    const api = mountWithTheme((api) => api);
    expect(api.theme.value).toBe("dark");
  });
  it("restores 'light' from storage", () => {
    fakeLocalStorage.set("theme", "light");
    installMatchMedia(false);
    const api = mountWithTheme((api) => api);
    expect(api.theme.value).toBe("light");
  });
  it("restores 'system' from storage", () => {
    fakeLocalStorage.set("theme", "system");
    installMatchMedia(true);
    const api = mountWithTheme((api) => api);
    expect(api.theme.value).toBe("system");
  });
  it("unknown value → dark fallback", () => {
    fakeLocalStorage.set("theme", "nonsense");
    installMatchMedia(false);
    const api = mountWithTheme((api) => api);
    expect(api.theme.value).toBe("dark");
  });
});

describe("useTheme — setTheme", () => {
  it("writes to storage + sets data-theme", () => {
    installMatchMedia(false);
    const api = mountWithTheme((api) => api);
    api.setTheme("light");
    expect(api.theme.value).toBe("light");
    expect(fakeLocalStorage.get("theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("'system' resolves to dark when OS prefers dark", () => {
    installMatchMedia(true);
    const api = mountWithTheme((api) => api);
    api.setTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("'system' resolves to light when OS prefers light", () => {
    installMatchMedia(false);
    const api = mountWithTheme((api) => api);
    api.setTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});

describe("useTheme — OS change subscription", () => {
  it("re-applies when OS flips and mode is 'system'", () => {
    const mm = installMatchMedia(false);
    const api = mountWithTheme((api) => api);
    api.setTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // Simulate OS flip to dark.
    (mm.mql as unknown as { matches: boolean }).matches = true;
    mm.fire();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("OS flip ignored when mode is explicit", () => {
    const mm = installMatchMedia(false);
    const api = mountWithTheme((api) => api);
    api.setTheme("light");
    (mm.mql as unknown as { matches: boolean }).matches = true;
    mm.fire();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
