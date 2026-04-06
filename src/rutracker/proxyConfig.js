import { invoke } from "@tauri-apps/api/core";

/** Кэш для индикатора в блоке «задроты» (синхронизируется с бэкендом при старте и при сохранении). */
const PROXY_CACHE_KEY = "rt_http_proxy_cache";

/** Тип: HTTP. Только пресеты из запроса. */
export const RT_HTTP_PROXY_PX1 = "http://px1.blockme.site:23128";
export const RT_HTTP_PROXY_PX2 = "http://px2.blockme.site:3128";

/**
 * Синхронизирует localStorage с файлом на диске (для точки у «Параметры для задротов»).
 *
 * @returns {Promise<void>}
 */
export async function syncRtHttpProxyCacheFromBackend() {
  const url = await invoke("rutracker_get_http_proxy");
  if (url) {
    localStorage.setItem(PROXY_CACHE_KEY, url);
  } else {
    localStorage.removeItem(PROXY_CACHE_KEY);
  }
}

/**
 * @returns {boolean}
 */
export function hasHttpProxyConfigured() {
  return Boolean(localStorage.getItem(PROXY_CACHE_KEY));
}

/**
 * @param {string | null | undefined} url
 * @returns {void}
 */
export function setRtHttpProxyCache(url) {
  const u = typeof url === "string" ? url.trim() : "";
  if (u) {
    localStorage.setItem(PROXY_CACHE_KEY, u);
  } else {
    localStorage.removeItem(PROXY_CACHE_KEY);
  }
}

/**
 * @returns {Promise<string | null>}
 */
export async function getHttpProxy() {
  return invoke("rutracker_get_http_proxy");
}

/**
 * @param {string | null | undefined} proxyUrl — полный URL HTTP-прокси или пусто/ null = без прокси.
 * @returns {Promise<void>}
 */
export async function setHttpProxy(proxyUrl) {
  const u = typeof proxyUrl === "string" ? proxyUrl.trim() : "";
  await invoke("rutracker_set_http_proxy", { proxyUrl: u || null });
}

/**
 * GET target_url through an optional HTTP proxy (no Rutracker session).
 *
 * @param {string | null | undefined} proxyUrl
 * @param {string} targetUrl
 * @returns {Promise<void>}
 */
export async function probeHttpProxy(proxyUrl, targetUrl) {
  const u = typeof proxyUrl === "string" ? proxyUrl.trim() : "";
  await invoke("rutracker_probe_http_proxy", {
    proxyUrl: u || null,
    targetUrl,
  });
}
