import { invoke } from "@tauri-apps/api/core";
import { appDebugLog } from "../appDebugLog.js";
import { makeCoverCache } from "../lib/coverCacheCore.js";

/**
 * SoulSeek cover cache — keyed by `${username}\n${filepath}`.
 *
 * Concurrency-gated to 4 simultaneous peer fetches. Each fetch involves
 * a P2P handshake + queued transfer; firing dozens of them at once swamps
 * the SLSK client and the remote peers.
 *
 * Filesize is needed for the Rust command but not for the cache key, so it
 * is carried out-of-band via `setSlskCoverFilesize` before requesting.
 */

/** @type {Map<string, number>} */
const filesizeByKey = new Map();

export function slskCoverKey(username, filepath) {
  return `${String(username)}\n${String(filepath ?? "").replace(/\\/g, "/")}`;
}

const cache = makeCoverCache({
  async fetch(key) {
    const [username, filepath] = key.split("\n", 2);
    const filesize = filesizeByKey.get(key) ?? 0;
    void appDebugLog("cover", `slsk cover: fetching — user=${username} file=${filepath.slice(0, 80)}`);
    const r = await invoke("soulseek_cover_preview", { username, filepath, filesize });
    return r ? `data:${r.mime};base64,${r.base64}` : null;
  },
  log: (tag, msg) => void appDebugLog(tag, `slsk ${msg}`),
  maxEntries: 1024,
  maxBytes: 64 * 1024 * 1024,
  negativeTtlMs: 120_000,
  maxConcurrent: 4,
});

export function peekSlskCover(username, filepath) {
  return cache.peek(slskCoverKey(username, filepath));
}

export function getSlskCoverReactive(username, filepath) {
  return cache.getReactive(slskCoverKey(username, filepath));
}

export function rememberSlskCover(username, filepath, dataUrl) {
  cache.remember(slskCoverKey(username, filepath), dataUrl);
}

/**
 * Request a SoulSeek cover. Filesize is used by the Rust side to set up the
 * transfer; stash it on the key before kicking the fetch.
 */
export function getSlskCoverDataUrl(username, filepath, filesize) {
  const key = slskCoverKey(username, filepath);
  if (filesize) filesizeByKey.set(key, Number(filesize));
  return cache.getOrFetch(key);
}

export function clearSlskCoverCache() {
  cache.clear();
  filesizeByKey.clear();
}
