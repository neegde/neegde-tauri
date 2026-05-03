import { invoke } from "@tauri-apps/api/core";
import { enrichMagnetWithOpenTrackers } from "../lib/utils.js";
import { getMirror } from "../rutracker/config.js";
import { appDebugLog } from "../appDebugLog.js";
import { soulseekPrepareStream } from "../soulseek/api.js";

export interface TorrentFile { path: string[]; size: number }

export async function magnetListFiles(magnet: string): Promise<TorrentFile[]> {
  return invoke<TorrentFile[]>("torrent_magnet_list_files", { magnet });
}

const _torrentFileCache = new Map<string, Promise<string | null>>();
const TORRENT_FILE_CACHE_MAX = 30;
const _TORRENT_LS_PREFIX = "torrent_file_b64_v1_";

function _loadPersistedTorrentFiles(): void {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(_TORRENT_LS_PREFIX));
    for (const key of keys) {
      const tid = key.slice(_TORRENT_LS_PREFIX.length);
      const b64 = localStorage.getItem(key);
      if (b64) _torrentFileCache.set(tid, Promise.resolve(b64));
    }
  } catch {
    /* localStorage unavailable */
  }
}

function _persistTorrentFile(tid: string, b64: string): void {
  try {
    localStorage.setItem(`${_TORRENT_LS_PREFIX}${tid}`, b64);
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(_TORRENT_LS_PREFIX));
    if (keys.length > TORRENT_FILE_CACHE_MAX) {
      keys.slice(0, keys.length - TORRENT_FILE_CACHE_MAX).forEach((k) => localStorage.removeItem(k));
    }
  } catch {
    /* localStorage full / unavailable */
  }
}

_loadPersistedTorrentFiles();

function _cachedTorrentFileB64(tid: string): Promise<string | null> {
  const existing = _torrentFileCache.get(tid);
  if (existing) {
    void appDebugLog("stream", `torrent file b64: cache hit — torrentId=${tid}`);
    _torrentFileCache.delete(tid);
    _torrentFileCache.set(tid, existing);
    return existing;
  }
  if (_torrentFileCache.size >= TORRENT_FILE_CACHE_MAX) {
    const first = _torrentFileCache.keys().next().value;
    if (first !== undefined) _torrentFileCache.delete(first);
  }
  void appDebugLog("stream", `torrent file b64: downloading from rutracker — torrentId=${tid} mirror=${getMirror()}`);
  const t0 = Date.now();
  const p = invoke<string | null>("rutracker_download_torrent_file_b64", {
    mirror: getMirror(),
    topicId: tid,
  })
    .then((b64) => {
      if (b64) {
        _persistTorrentFile(tid, b64);
        void appDebugLog("stream", `torrent file b64: download OK — torrentId=${tid} size=${b64.length}B took=${Date.now() - t0}ms`);
      } else {
        void appDebugLog("stream", `torrent file b64: download returned null — torrentId=${tid}`);
      }
      return b64 ?? null;
    })
    .catch((e: unknown) => {
      void appDebugLog("stream", `torrent file b64: download error — torrentId=${tid} err=${String(e)}`);
      return null;
    });
  _torrentFileCache.set(tid, p);
  return p;
}

export interface StreamUrlOpts {
  source?: string;
  torrentId?: string | number;
  slskUsername?: string;
  slskFilepath?: string;
  slskFilesize?: number;
}

export async function streamUrl(
  magnet: string,
  fileIdx: number,
  opts: StreamUrlOpts = {},
): Promise<string> {
  const src = opts.source != null ? String(opts.source) : "";

  if (src === "soulseek") {
    const { slskUsername, slskFilepath, slskFilesize } = opts;
    if (!slskUsername || !slskFilepath) {
      void appDebugLog("stream", `streamUrl: soulseek missing slskUsername/slskFilepath`);
      return "";
    }
    void appDebugLog("stream", `streamUrl: soulseek — user=${slskUsername} file=${slskFilepath}`);
    const t0 = Date.now();
    try {
      const ready = await soulseekPrepareStream(slskUsername, slskFilepath, slskFilesize ?? 0);
      void appDebugLog("stream", `streamUrl: soulseek OK — url=${ready?.url} took=${Date.now() - t0}ms`);
      return ready?.url ?? "";
    } catch (e) {
      void appDebugLog("stream", `streamUrl: soulseek FAILED — ${String(e)} took=${Date.now() - t0}ms`);
      throw e;
    }
  }

  if (!magnet || fileIdx == null || fileIdx < 0) return "";
  const m = enrichMagnetWithOpenTrackers(magnet);
  let torrentFileB64: string | null = null;
  const tid = opts.torrentId != null ? String(opts.torrentId) : "";
  if (src === "rutracker" && tid !== "") {
    torrentFileB64 = await _cachedTorrentFileB64(tid);
  }
  void appDebugLog("stream", `streamUrl: invoking prepare — fileIdx=${fileIdx} torrentId=${tid || "—"} hasTorrentFile=${!!torrentFileB64}`);
  const t0 = Date.now();
  let ready: { url?: string } | undefined;
  try {
    ready = await invoke<{ url?: string }>("torrent_prepare_stream", { magnet: m, fileIdx, torrentFileB64 });
  } catch (e) {
    void appDebugLog("stream", `streamUrl: prepare FAILED — fileIdx=${fileIdx} torrentId=${tid || "—"} err=${String(e)} took=${Date.now() - t0}ms`);
    throw e;
  }
  const url = ready?.url ?? "";
  void appDebugLog(
    "stream",
    url
      ? `streamUrl: prepare OK — fileIdx=${fileIdx} url=${url} took=${Date.now() - t0}ms`
      : `streamUrl: prepare returned empty URL — fileIdx=${fileIdx} torrentId=${tid || "—"}`,
  );
  return url;
}

export interface TrackForB64 {
  source?: string;
  torrentId?: string | number;
  [k: string]: unknown;
}

export async function torrentFileB64ForTrack(track: TrackForB64 | null | undefined): Promise<string | null> {
  if (!track) return null;
  const src = track.source != null ? String(track.source) : "";
  const tid = track.torrentId != null ? String(track.torrentId) : "";
  if (src !== "rutracker" || tid === "") return null;
  return _cachedTorrentFileB64(tid);
}

export interface PrefetchQueueItem extends TrackForB64 {
  magnet?: string;
  fileIdx?: number;
}

export interface PrefetchResult {
  kind?: string;
  url?: string;
  [k: string]: unknown;
}

export async function prefetchNextInQueue(
  current: PrefetchQueueItem | null | undefined,
  next: PrefetchQueueItem | null | undefined,
  opts: { warmOnly?: boolean } = {},
): Promise<PrefetchResult | null> {
  if (!current?.magnet || next?.magnet == null || next.fileIdx == null || next.fileIdx < 0) {
    return null;
  }
  const m0 = enrichMagnetWithOpenTrackers(current.magnet);
  const m1 = enrichMagnetWithOpenTrackers(next.magnet);
  const nextTorrentFileB64 = await torrentFileB64ForTrack(next);
  const warmOnly = opts.warmOnly === true;
  void appDebugLog(
    "stream",
    `prefetchNextInQueue: start — ${warmOnly ? "warm(track+2)" : "next(track+1)"} nextFileIdx=${next.fileIdx} nextTorrentId=${next.torrentId || "—"} hasTorrentFile=${!!nextTorrentFileB64}`,
  );
  const t0 = Date.now();
  try {
    const result = await invoke<PrefetchResult>("torrent_prefetch_next_track", {
      currentMagnet: m0,
      currentFileIdx: current.fileIdx,
      nextMagnet: m1,
      nextFileIdx: next.fileIdx,
      nextTorrentFileB64,
      warmOnly,
    });
    void appDebugLog(
      "stream",
      `prefetchNextInQueue: OK — ${warmOnly ? "warm" : "next"} kind=${result?.kind} hasUrl=${!!(result?.url)} took=${Date.now() - t0}ms`,
    );
    return result;
  } catch (e) {
    void appDebugLog(
      "stream",
      `prefetchNextInQueue: FAILED — ${warmOnly ? "warm" : "next"} nextFileIdx=${next.fileIdx} err=${String(e)} took=${Date.now() - t0}ms`,
    );
    throw e;
  }
}
