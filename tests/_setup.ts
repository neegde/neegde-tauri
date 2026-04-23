/**
 * Global test setup.
 *
 * Installs shims for browser / Tauri globals that the code assumes, and mocks
 * Tauri IPC + dialog plugins so `import` doesn't crash on module load. Tests
 * override specific return values via `vi.mocked(invoke).mockResolvedValueOnce`.
 */

import { vi } from "vitest";

// ── Fake localStorage (jsdom provides one, but we want a handle for assertions).
// Replace it even under jsdom so tests can inspect / clear directly.
const _store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => _store.get(k) ?? null,
  setItem: (k: string, v: string) => { _store.set(k, v); },
  removeItem: (k: string) => { _store.delete(k); },
  clear: () => { _store.clear(); },
  key: (i: number) => Array.from(_store.keys())[i] ?? null,
  get length() { return _store.size; },
} as Storage;

export const fakeLocalStorage = _store;

// ── IntersectionObserver shim (jsdom lacks it). Covers need it for lazy load.
class FakeIntersectionObserver {
  root: Element | Document | null = null;
  rootMargin = "";
  scrollMargin = "";
  thresholds: ReadonlyArray<number> = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn((): IntersectionObserverEntry[] => []);
  constructor(
    public callback: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    if (options?.root instanceof Element || options?.root instanceof Document) {
      this.root = options.root;
    }
    this.rootMargin = options?.rootMargin ?? "";
  }
}
(globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver })
  .IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;

// ── Element.scrollTo shim (jsdom lacks it on HTMLElement prototype).
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollTo) {
  (HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
}

// ── ResizeObserver shim (jsdom lacks it). Used by layout-measurement code.
class FakeResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(_cb: ResizeObserverCallback) {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserver })
  .ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

// ── matchMedia shim (jsdom lacks it) ───────────────────────────────────────
if (typeof window !== "undefined" && !window.matchMedia) {
  (window as unknown as { matchMedia: typeof matchMedia }).matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof matchMedia;
}

// ── Tauri IPC + plugins ────────────────────────────────────────────────────
// A single shared invoke mock that individual tests can override per-call.

export const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(null),
  ask: vi.fn().mockResolvedValue(true),
  confirm: vi.fn().mockResolvedValue(true),
  save: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  onOpenUrl: vi.fn().mockResolvedValue(() => {}),
  getCurrent: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
}));

// ── Project-internal shims ─────────────────────────────────────────────────

vi.mock("../src/rutracker/config.js", () => ({
  getMirror: () => "https://rutracker.test",
  resolveMirrorIfNeeded: vi.fn().mockResolvedValue(undefined),
  DEFAULT_MIRROR: "https://rutracker.net",
  KNOWN_MIRRORS: ["https://rutracker.net", "https://rutracker.org"],
  MIRROR_MODE_AUTO: "auto",
  MIRROR_MODE_MANUAL: "manual",
  getMirrorMode: () => "manual",
  setMirrorMode: vi.fn(),
  setMirror: vi.fn(),
  resetMirror: vi.fn(),
  hasCustomMirror: () => false,
  getLastResolvedMirror: () => null,
  probeMirrorsNow: vi.fn().mockResolvedValue("https://rutracker.net"),
}));

vi.mock("../src/appDebugLog.js", () => ({
  appDebugLog: vi.fn(),
  appDebugClickDetail: vi.fn(),
}));
