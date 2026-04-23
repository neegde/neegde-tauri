import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";

import {
  rtLoggedIn, rtUsername, rtAvatarUrl,
  setRtLoggedIn, setRtLoggedOut,
  slskConnected, slskUsername, slskLoggingIn, slskLoginError,
  setSlskConnected, setSlskDisconnected,
} from "../../src/stores/auth.js";

beforeEach(() => {
  setRtLoggedOut();
  setSlskDisconnected();
  slskLoggingIn.value = false;
  slskLoginError.value = null;
});

describe("RuTracker auth state", () => {
  it("starts logged out with null fields", () => {
    expect(rtLoggedIn.value).toBe(false);
    expect(rtUsername.value).toBe(null);
    expect(rtAvatarUrl.value).toBe(null);
  });
  it("setRtLoggedIn stores username + avatar", () => {
    setRtLoggedIn("neo", "avatar.png");
    expect(rtLoggedIn.value).toBe(true);
    expect(rtUsername.value).toBe("neo");
    expect(rtAvatarUrl.value).toBe("avatar.png");
  });
  it("missing fields become null", () => {
    setRtLoggedIn("", null);
    expect(rtUsername.value).toBe(null);
    expect(rtAvatarUrl.value).toBe(null);
    expect(rtLoggedIn.value).toBe(true);
  });
  it("setRtLoggedOut clears everything", () => {
    setRtLoggedIn("neo", "a.png");
    setRtLoggedOut();
    expect(rtLoggedIn.value).toBe(false);
    expect(rtUsername.value).toBe(null);
    expect(rtAvatarUrl.value).toBe(null);
  });
});

describe("SoulSeek auth state", () => {
  it("starts disconnected", () => {
    expect(slskConnected.value).toBe(false);
    expect(slskUsername.value).toBe(null);
  });
  it("setSlskConnected sets username + clears error", () => {
    slskLoginError.value = "boom";
    setSlskConnected("user1");
    expect(slskConnected.value).toBe(true);
    expect(slskUsername.value).toBe("user1");
    expect(slskLoginError.value).toBe(null);
  });
  it("connected with empty username stores null", () => {
    setSlskConnected("");
    expect(slskUsername.value).toBe(null);
    expect(slskConnected.value).toBe(true);
  });
  it("setSlskDisconnected clears username but leaves error alone", () => {
    setSlskConnected("u");
    slskLoginError.value = "e";
    setSlskDisconnected();
    expect(slskConnected.value).toBe(false);
    expect(slskUsername.value).toBe(null);
    // setSlskDisconnected intentionally does not touch slskLoginError
    expect(slskLoginError.value).toBe("e");
  });
});
