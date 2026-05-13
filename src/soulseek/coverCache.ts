import { invoke } from "@tauri-apps/api/core";
import { appDebugLog } from "../appDebugLog.js";
import { makeCoverCache } from "../lib/coverCacheCore.js";

/**
 * SoulSeek cover cache — keyed by `${username}\n${filepath}`.
 *
 * Concurrency-gated to 4 simultaneous peer fetches. Each fetch involves
 * a P2P handshake + queued transfer; firing dozens at once swamps SLSK.
 *
 * Filesize is needed for the Rust command but not for the cache key, so it
 * is carried out-of-band via `getSlskCoverDataUrl(…, filesize)` which stashes
 * it on the key before kicking the fetch.
 */

const filesizeByKey = new Map<string, number>();

export function slskCoverKey(username: unknown, filepath: unknown): string {
  return `${String(username)}\n${String(filepath ?? "").replace(/\\/g, "/")}`;
}

interface CoverPreview { mime: string; base64: string }

const cache = makeCoverCache({
  async fetch(key) {
    const [usernameRaw, filepathRaw] = key.split("\n", 2);
    const username = usernameRaw ?? "";
    const filepath = filepathRaw ?? "";
    const filesize = filesizeByKey.get(key) ?? 0;
    void appDebugLog("cover", `slsk cover: fetching — user=${username} file=${filepath.slice(0, 80)}`);
    const r = await invoke<CoverPreview | null>("soulseek_cover_preview", { username, filepath, filesize });
    return r ? `data:${r.mime};base64,${r.base64}` : null;
  },
  log: (tag, msg) => void appDebugLog(tag, `slsk ${msg}`),
  maxEntries: 1024,
  maxBytes: 64 * 1024 * 1024,
  negativeTtlMs: 120_000,
  maxConcurrent: 4,
});

export function peekSlskCover(username: unknown, filepath: unknown): string | null | undefined {
  return cache.peek(slskCoverKey(username, filepath));
}

export function getSlskCoverReactive(username: unknown, filepath: unknown): string | null {
  return cache.getReactive(slskCoverKey(username, filepath));
}

export function rememberSlskCover(username: unknown, filepath: unknown, dataUrl: string | null): void {
  cache.remember(slskCoverKey(username, filepath), dataUrl);
}

/** Request a SoulSeek cover; filesize needed by Rust for the transfer setup. */
export function getSlskCoverDataUrl(
  username: unknown,
  filepath: unknown,
  filesize: number | null | undefined,
): Promise<string | null> {
  const key = slskCoverKey(username, filepath);
  if (filesize) filesizeByKey.set(key, Number(filesize));
  return cache.getOrFetch(key);
}

export function clearSlskCoverCache(): void {
  cache.clear();
  filesizeByKey.clear();
}

/** Clears negative-TTL misses only (successful data URLs kept). */
export function clearSlskCoverNegatives(): void {
  cache.clearNegatives();
}

/** Clears one peer filepath's cover so the next read hits the network again. */
export function invalidateSlskCover(username: unknown, filepath: unknown): void {
  const key = slskCoverKey(username, filepath);
  cache.invalidate(key);
  filesizeByKey.delete(key);
}
