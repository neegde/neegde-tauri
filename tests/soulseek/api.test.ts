import { describe, it, expect, beforeEach } from "vitest";
import { mockInvoke } from "../_setup.js";

import {
  soulseekLogin, soulseekLogout, soulseekStatus, soulseekSearch,
  soulseekPrepareStream, soulseekCoverPreview, soulseekReleaseStream,
  soulseekSaveCredentials, soulseekLoadCredentials, soulseekClearSavedCredentials,
} from "../../src/soulseek/api.js";

beforeEach(() => mockInvoke.mockReset());

describe("soulseek/api passthroughs", () => {
  it("login", async () => {
    mockInvoke.mockResolvedValueOnce({ success: true, error: null, username: "u" });
    await soulseekLogin("u", "p");
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_login", { username: "u", password: "p" });
  });
  it("logout", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await soulseekLogout();
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_logout");
  });
  it("status", async () => {
    mockInvoke.mockResolvedValueOnce({ connected: false, username: null });
    await soulseekStatus();
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_status");
  });
  it("search", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await soulseekSearch("query", 42);
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_search", { query: "query", requestId: 42 });
  });
  it("search default requestId=0", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await soulseekSearch("q");
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_search", { query: "q", requestId: 0 });
  });
  it("prepareStream coerces filesize", async () => {
    mockInvoke.mockResolvedValueOnce({ url: "u", token: "t" });
    await soulseekPrepareStream("u", "f", "123");
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_prepare_stream", {
      username: "u", filepath: "f", filesize: 123,
    });
    mockInvoke.mockResolvedValueOnce({ url: "u", token: "t" });
    await soulseekPrepareStream("u", "f", null);
    expect(mockInvoke).toHaveBeenLastCalledWith("soulseek_prepare_stream", {
      username: "u", filepath: "f", filesize: 0,
    });
  });
  it("coverPreview passes same args", async () => {
    mockInvoke.mockResolvedValueOnce({ mime: "image/png", base64: "B" });
    await soulseekCoverPreview("u", "c.jpg", "256");
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_cover_preview", {
      username: "u", filepath: "c.jpg", filesize: 256,
    });
  });
  it("releaseStream", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await soulseekReleaseStream("TOKEN");
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_release_stream", { token: "TOKEN" });
  });
  it("saveCredentials", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await soulseekSaveCredentials("u", "p");
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_save_credentials", { username: "u", password: "p" });
  });
  it("loadCredentials", async () => {
    mockInvoke.mockResolvedValueOnce(["u", "p"]);
    await soulseekLoadCredentials();
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_load_credentials");
  });
  it("clearSavedCredentials", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await soulseekClearSavedCredentials();
    expect(mockInvoke).toHaveBeenCalledWith("soulseek_clear_saved_credentials");
  });
});
