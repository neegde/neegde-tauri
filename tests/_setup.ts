/**
 * Shared test setup — minimal Tauri / cache shims so imports don't touch the
 * real Tauri bridges. Individual tests override specific mocks as needed.
 */

import { vi } from "vitest";

// ── Fake localStorage (Node has none) ──────────────────────────────────────

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

// ── Tauri bridge stubs ──────────────────────────────────────────────────────

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(null),
}));

// ── Rutracker config (legacy JS) ───────────────────────────────────────────

vi.mock("../src/rutracker/config.js", () => ({
  getMirror: () => "https://rutracker.test",
}));

// ── App debug log ──────────────────────────────────────────────────────────

vi.mock("../src/appDebugLog.js", () => ({
  appDebugLog: vi.fn(),
  appDebugClickDetail: vi.fn(),
}));
