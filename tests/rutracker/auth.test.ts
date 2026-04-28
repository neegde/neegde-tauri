import { describe, it, expect, beforeEach } from "vitest";
import { mockInvoke, fakeLocalStorage } from "../_setup.js";

import {
  markRutrackerHadAccount, clearRutrackerHadAccount, hadRutrackerAccount,
} from "../../src/rutracker/accountHint.js";
import { normalizeLoginStatus } from "../../src/rutracker/sessionStatus.js";
import { login, logout, restoreSession, getStatus } from "../../src/rutracker/auth.js";

beforeEach(() => {
  fakeLocalStorage.clear();
  mockInvoke.mockReset();
});

describe("accountHint", () => {
  it("round-trips via localStorage", () => {
    expect(hadRutrackerAccount()).toBe(false);
    markRutrackerHadAccount();
    expect(hadRutrackerAccount()).toBe(true);
    clearRutrackerHadAccount();
    expect(hadRutrackerAccount()).toBe(false);
  });
});

describe("normalizeLoginStatus", () => {
  it("rejects non-objects", () => {
    expect(normalizeLoginStatus(null)).toEqual({ loggedIn: false, username: null, avatarUrl: null });
    expect(normalizeLoginStatus(undefined)).toEqual({ loggedIn: false, username: null, avatarUrl: null });
    expect(normalizeLoginStatus("x")).toEqual({ loggedIn: false, username: null, avatarUrl: null });
    expect(normalizeLoginStatus(42)).toEqual({ loggedIn: false, username: null, avatarUrl: null });
  });
  it("snake_case input", () => {
    expect(normalizeLoginStatus({ logged_in: true, username: "u", avatar_url: "a.png" }))
      .toEqual({ loggedIn: true, username: "u", avatarUrl: "a.png" });
  });
  it("camelCase input", () => {
    expect(normalizeLoginStatus({ loggedIn: true, username: "u", avatarUrl: "a" }))
      .toEqual({ loggedIn: true, username: "u", avatarUrl: "a" });
  });
  it("missing username/avatar → null", () => {
    expect(normalizeLoginStatus({ logged_in: true })).toEqual({ loggedIn: true, username: null, avatarUrl: null });
  });
  it("stringifies non-string username/avatar", () => {
    expect(normalizeLoginStatus({ loggedIn: true, username: 42, avatarUrl: ["x"] })).toEqual({
      loggedIn: true, username: "42", avatarUrl: "x",
    });
  });
});

describe("rutracker/auth — Tauri invoke passthrough", () => {
  it("login forwards mirror + creds", async () => {
    mockInvoke.mockResolvedValueOnce({ success: true, username: "neo" });
    const r = await login("neo", "pw");
    expect(mockInvoke).toHaveBeenCalledWith("rutracker_login", {
      mirror: "https://rutracker.test", username: "neo", password: "pw",
    });
    expect(r.success).toBe(true);
  });
  it("logout invokes rutracker_logout", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await logout();
    expect(mockInvoke).toHaveBeenCalledWith("rutracker_logout");
  });
  it("restoreSession forwards mirror", async () => {
    mockInvoke.mockResolvedValueOnce({ logged_in: true });
    await restoreSession();
    expect(mockInvoke).toHaveBeenCalledWith("rutracker_restore_session", {
      mirror: "https://rutracker.test",
    });
  });
  it("getStatus invokes rutracker_status", async () => {
    mockInvoke.mockResolvedValueOnce({ logged_in: false });
    await getStatus();
    expect(mockInvoke).toHaveBeenCalledWith("rutracker_status");
  });
});
