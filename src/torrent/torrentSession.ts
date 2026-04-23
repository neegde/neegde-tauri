/**
 * Torrent HTTP stream tokens (local player URL). Prefer `releaseTorrentStreamUrl`
 * when clearing `src` — do not call `torrent_dispose_preview` from navigation.
 */

import { invoke } from "@tauri-apps/api/core";
import { appDebugLog } from "../appDebugLog.js";

export function disposeTorrentPreview(): Promise<void> {
  return invoke<void>("torrent_dispose_preview").catch(() => {});
}

export function releaseTorrentStreamUrl(url: string | null | undefined): Promise<void> {
  if (!url || typeof url !== "string") return Promise.resolve();
  const slsk = "/slsk/";
  const si = url.indexOf(slsk);
  if (si >= 0) {
    const rest = url.slice(si + slsk.length);
    const token = rest.split(/[/?#]/)[0];
    if (!token) return Promise.resolve();
    void appDebugLog("stream", `release: soulseek token=${token}`);
    return invoke<void>("soulseek_release_stream", { token }).catch((e: unknown) => {
      void appDebugLog("stream", `release: soulseek error — token=${token} err=${String(e)}`);
    });
  }
  const marker = "/stream/";
  const i = url.indexOf(marker);
  if (i < 0) return Promise.resolve();
  const rest = url.slice(i + marker.length);
  const token = rest.split(/[/?#]/)[0];
  if (!token) return Promise.resolve();
  void appDebugLog("stream", `release: token=${token}`);
  return invoke<void>("torrent_release_stream", { token }).catch((e: unknown) => {
    void appDebugLog("stream", `release: invoke error — token=${token} err=${String(e)}`);
  });
}

export function torrentPrepareCancel(): Promise<void> {
  void appDebugLog("stream", "prepare: cancel requested by user");
  return invoke<void>("torrent_prepare_cancel").catch(() => {});
}

function tokenFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const marker = "/stream/";
  const i = url.indexOf(marker);
  if (i < 0) return null;
  const rest = url.slice(i + marker.length);
  return rest.split(/[/?#]/)[0] || null;
}

export interface StreamStats { download_rate: number; num_peers: number }

export function vozduxanStreamStats(url: string | null | undefined): Promise<StreamStats | null> {
  const token = tokenFromUrl(url);
  if (!token) return Promise.resolve(null);
  return invoke<StreamStats>("vozduxan_stream_stats", { token }).catch(() => null);
}

export function vozduxanNotifyPosition(url: string | null | undefined, byteOffset: number): Promise<void> {
  if (!url || typeof url !== "string") return Promise.resolve();
  const marker = "/stream/";
  const i = url.indexOf(marker);
  if (i < 0) return Promise.resolve();
  const rest = url.slice(i + marker.length);
  const token = rest.split(/[/?#]/)[0];
  if (!token) return Promise.resolve();
  return invoke<void>("vozduxan_notify_position", {
    token,
    byteOffset: Math.floor(byteOffset),
  }).catch(() => {});
}
