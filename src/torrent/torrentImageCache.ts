import { invoke } from "@tauri-apps/api/core";
import { reactive } from "vue";
import { enrichMagnetWithOpenTrackers } from "../lib/utils.js";
import { appDebugLog } from "../appDebugLog.js";

const pending = new Map<string, Promise<string | null>>();
const cache = reactive(new Map<string, string>());
const TORRENT_IMAGE_CACHE_MAX = 200;

function cacheKey(magnet: string, fileIdx: number): string {
  return `${magnet}\n${fileIdx}`;
}

export function peekTorrentImage(magnet: string, fileIdx: number): string | undefined {
  return cache.get(cacheKey(magnet, fileIdx));
}

export async function getTorrentImageDataUrl(
  magnet: string,
  fileIdx: number,
  torrentFileB64: string | null = null,
): Promise<string | null> {
  const key = cacheKey(magnet, fileIdx);
  if (cache.has(key)) return cache.get(key)!;

  let p = pending.get(key);
  if (!p) {
    const magnetFp = magnet.slice(0, 80);
    void appDebugLog(
      "cover",
      `torrent cover: invoke start — fileIdx=${fileIdx} hasTorrentData=${!!torrentFileB64} magnet=${magnetFp}…`,
    );
    p = invoke<string | null>("torrent_fetch_image", {
      magnet: enrichMagnetWithOpenTrackers(magnet),
      fileIdx,
      torrentFileB64: torrentFileB64 ?? null,
    })
      .then((u) => {
        const v = u ?? null;
        if (v) {
          void appDebugLog("cover", `torrent cover: invoke OK — fileIdx=${fileIdx} dataUrlLen=${v.length}`);
          cache.set(key, v);
          if (cache.size > TORRENT_IMAGE_CACHE_MAX) {
            const first = cache.keys().next().value;
            if (first !== undefined) cache.delete(first);
          }
        } else {
          void appDebugLog("cover", `torrent cover: invoke returned null — fileIdx=${fileIdx}`);
        }
        return v;
      })
      .catch((e: unknown) => {
        void appDebugLog("cover", `torrent cover: invoke error — fileIdx=${fileIdx} err=${String(e)}`);
        return null;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, p);
  }
  return p;
}
