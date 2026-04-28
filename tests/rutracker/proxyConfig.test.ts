import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage, mockInvoke } from "../_setup.js";

import {
  RT_HTTP_PROXY_PX1, RT_HTTP_PROXY_PX2,
  syncRtHttpProxyCacheFromBackend,
  hasHttpProxyConfigured,
  setRtHttpProxyCache,
  getHttpProxy,
  setHttpProxy,
  probeHttpProxy,
} from "../../src/rutracker/proxyConfig.js";

beforeEach(() => {
  fakeLocalStorage.clear();
  mockInvoke.mockReset();
});

describe("proxy presets", () => {
  it("presets are stable constants", () => {
    expect(RT_HTTP_PROXY_PX1).toContain("blockme.site");
    expect(RT_HTTP_PROXY_PX2).toContain("blockme.site");
  });
});

describe("local cache", () => {
  it("hasHttpProxyConfigured reflects storage", () => {
    expect(hasHttpProxyConfigured()).toBe(false);
    setRtHttpProxyCache("http://p.example");
    expect(hasHttpProxyConfigured()).toBe(true);
  });
  it("setRtHttpProxyCache trims + blank clears", () => {
    setRtHttpProxyCache("  http://p ");
    expect(hasHttpProxyConfigured()).toBe(true);
    setRtHttpProxyCache("   ");
    expect(hasHttpProxyConfigured()).toBe(false);
  });
  it("setRtHttpProxyCache(null)/undefined clears", () => {
    setRtHttpProxyCache("http://p");
    setRtHttpProxyCache(null);
    expect(hasHttpProxyConfigured()).toBe(false);
  });
});

describe("sync from backend", () => {
  it("writes cache when backend returns a proxy", async () => {
    mockInvoke.mockResolvedValueOnce("http://back.example");
    await syncRtHttpProxyCacheFromBackend();
    expect(hasHttpProxyConfigured()).toBe(true);
  });
  it("clears cache when backend returns null", async () => {
    setRtHttpProxyCache("http://p");
    mockInvoke.mockResolvedValueOnce(null);
    await syncRtHttpProxyCacheFromBackend();
    expect(hasHttpProxyConfigured()).toBe(false);
  });
});

describe("Tauri wrappers", () => {
  it("getHttpProxy invokes rutracker_get_http_proxy", async () => {
    mockInvoke.mockResolvedValueOnce("http://x");
    const r = await getHttpProxy();
    expect(r).toBe("http://x");
    expect(mockInvoke).toHaveBeenCalledWith("rutracker_get_http_proxy");
  });
  it("setHttpProxy trims and passes null for blank", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await setHttpProxy("  http://x  ");
    expect(mockInvoke).toHaveBeenLastCalledWith("rutracker_set_http_proxy", { proxyUrl: "http://x" });
    await setHttpProxy("");
    expect(mockInvoke).toHaveBeenLastCalledWith("rutracker_set_http_proxy", { proxyUrl: null });
    await setHttpProxy(null);
    expect(mockInvoke).toHaveBeenLastCalledWith("rutracker_set_http_proxy", { proxyUrl: null });
  });
  it("probeHttpProxy forwards proxyUrl + targetUrl", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await probeHttpProxy("http://p", "https://target");
    expect(mockInvoke).toHaveBeenCalledWith("rutracker_probe_http_proxy", {
      proxyUrl: "http://p", targetUrl: "https://target",
    });
    await probeHttpProxy("", "https://target");
    expect(mockInvoke).toHaveBeenLastCalledWith("rutracker_probe_http_proxy", {
      proxyUrl: null, targetUrl: "https://target",
    });
  });
});
