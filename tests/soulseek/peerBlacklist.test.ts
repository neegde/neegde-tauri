import { afterEach, describe, expect, it, vi } from "vitest";
import "../_setup.js";

import {
  clearPeerBlacklist,
  isPeerDead,
  markPeerDead,
  peerBlacklistVersion,
} from "../../src/soulseek/peerBlacklist.js";

afterEach(() => {
  clearPeerBlacklist();
  vi.restoreAllMocks();
});

describe("peerBlacklist", () => {
  it("ignores empty username inputs", () => {
    const before = peerBlacklistVersion.value;
    markPeerDead("");
    expect(isPeerDead("")).toBe(false);
    expect(peerBlacklistVersion.value).toBe(before);
  });

  it("marks peer as dead and reports true before TTL expiry", () => {
    const before = peerBlacklistVersion.value;
    markPeerDead("alice");
    expect(isPeerDead("alice")).toBe(true);
    expect(peerBlacklistVersion.value).toBe(before + 1);
  });

  it("expires dead peer after TTL and bumps version on cleanup", () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);
    markPeerDead("bob");
    const afterMark = peerBlacklistVersion.value;

    nowSpy.mockReturnValue(1_000 + 10 * 60 * 1000 + 1);
    expect(isPeerDead("bob")).toBe(false);
    expect(peerBlacklistVersion.value).toBe(afterMark + 1);
  });

  it("clears all peers and bumps version", () => {
    markPeerDead("u1");
    const beforeClear = peerBlacklistVersion.value;
    clearPeerBlacklist();
    expect(isPeerDead("u1")).toBe(false);
    expect(peerBlacklistVersion.value).toBe(beforeClear + 1);
  });
});
