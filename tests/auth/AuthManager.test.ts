import { describe, it, expect } from "vitest";
import "../_setup.js";

import { AuthManager } from "../../src/auth/AuthManager.js";
import { RutrackerAuthProvider } from "../../src/auth/RutrackerAuthProvider.js";
import { SoulseekAuthProvider } from "../../src/auth/SoulseekAuthProvider.js";

describe("AuthManager", () => {
  it("exposes typed rutracker and soulseek provider instances", () => {
    const m = new AuthManager();
    expect(m.rutracker).toBeInstanceOf(RutrackerAuthProvider);
    expect(m.soulseek).toBeInstanceOf(SoulseekAuthProvider);
    expect(m.rutracker.kind).toBe("rutracker");
    expect(m.soulseek.kind).toBe("soulseek");
  });

  it("get('rutracker') returns the same RutrackerAuthProvider", () => {
    const m = new AuthManager();
    expect(m.get("rutracker")).toBe(m.rutracker);
  });

  it("get('soulseek') returns the same SoulseekAuthProvider", () => {
    const m = new AuthManager();
    expect(m.get("soulseek")).toBe(m.soulseek);
  });

  it("get(unknown) returns undefined", () => {
    const m = new AuthManager();
    expect(m.get("nope")).toBeUndefined();
    expect(m.get("")).toBeUndefined();
  });

  it("each AuthManager owns independent provider instances", () => {
    const a = new AuthManager();
    const b = new AuthManager();
    expect(a.rutracker).not.toBe(b.rutracker);
    expect(a.soulseek).not.toBe(b.soulseek);
  });

  it("provider state mutates through the manager handle", () => {
    const m = new AuthManager();
    expect(m.rutracker.connected.value).toBe(false);
    m.rutracker.connect("neo", "avatar.png");
    expect(m.rutracker.connected.value).toBe(true);
    expect(m.rutracker.username.value).toBe("neo");
    expect(m.rutracker.avatarUrl.value).toBe("avatar.png");
    m.rutracker.disconnect();
    expect(m.rutracker.connected.value).toBe(false);
    expect(m.rutracker.avatarUrl.value).toBe(null);
  });
});
