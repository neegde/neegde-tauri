import { invoke } from "@tauri-apps/api/core";

/** Кэш для индикатора в блоке «задроты» — синхронизируется с бэкендом. */
const PROXY_CACHE_KEY = "rt_http_proxy_cache";

/** Пресеты HTTP-прокси. */
export const RT_HTTP_PROXY_PX1 = "http://px1.blockme.site:23128";
export const RT_HTTP_PROXY_PX2 = "http://px2.blockme.site:3128";

/** Синхронизирует localStorage с файлом на диске. */
export async function syncRtHttpProxyCacheFromBackend(): Promise<void> {
  const url = await invoke<string | null>("rutracker_get_http_proxy");
  if (url) {
    localStorage.setItem(PROXY_CACHE_KEY, url);
  } else {
    localStorage.removeItem(PROXY_CACHE_KEY);
  }
}

export function hasHttpProxyConfigured(): boolean {
  return Boolean(localStorage.getItem(PROXY_CACHE_KEY));
}

export function setRtHttpProxyCache(url: string | null | undefined): void {
  const u = typeof url === "string" ? url.trim() : "";
  if (u) {
    localStorage.setItem(PROXY_CACHE_KEY, u);
  } else {
    localStorage.removeItem(PROXY_CACHE_KEY);
  }
}

export async function getHttpProxy(): Promise<string | null> {
  return invoke<string | null>("rutracker_get_http_proxy");
}

/** `proxyUrl` — full HTTP proxy URL or empty/null = no proxy. */
export async function setHttpProxy(proxyUrl: string | null | undefined): Promise<void> {
  const u = typeof proxyUrl === "string" ? proxyUrl.trim() : "";
  await invoke<void>("rutracker_set_http_proxy", { proxyUrl: u || null });
}

/** GET target_url through an optional HTTP proxy (no Rutracker session). */
export async function probeHttpProxy(
  proxyUrl: string | null | undefined,
  targetUrl: string,
): Promise<void> {
  const u = typeof proxyUrl === "string" ? proxyUrl.trim() : "";
  await invoke<void>("rutracker_probe_http_proxy", {
    proxyUrl: u || null,
    targetUrl,
  });
}
