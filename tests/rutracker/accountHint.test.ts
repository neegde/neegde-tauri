import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import {
  markRutrackerHadAccount,
  clearRutrackerHadAccount,
  hadRutrackerAccount,
} from "../../src/rutracker/accountHint.js";

beforeEach(() => {
  fakeLocalStorage.clear();
});

describe("rutracker accountHint", () => {
  it("hadRutrackerAccount returns false when nothing stored", () => {
    expect(hadRutrackerAccount()).toBe(false);
  });

  it("mark sets the flag, read returns true", () => {
    markRutrackerHadAccount();
    expect(hadRutrackerAccount()).toBe(true);
  });

  it("clear removes the flag", () => {
    markRutrackerHadAccount();
    clearRutrackerHadAccount();
    expect(hadRutrackerAccount()).toBe(false);
  });

  it("read returns false when localStorage throws (unsupported env)", () => {
    const orig = globalThis.localStorage;
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage;
    try {
      expect(hadRutrackerAccount()).toBe(false);
    } finally {
      (globalThis as unknown as { localStorage: Storage }).localStorage = orig;
    }
  });

  it("mark silently swallows localStorage exceptions", () => {
    const orig = globalThis.localStorage;
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage;
    try {
      expect(() => markRutrackerHadAccount()).not.toThrow();
    } finally {
      (globalThis as unknown as { localStorage: Storage }).localStorage = orig;
    }
  });

  it("clear silently swallows exceptions", () => {
    const orig = globalThis.localStorage;
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => { throw new Error("locked"); },
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage;
    try {
      expect(() => clearRutrackerHadAccount()).not.toThrow();
    } finally {
      (globalThis as unknown as { localStorage: Storage }).localStorage = orig;
    }
  });
});
