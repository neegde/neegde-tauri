/**
 * useDownloadProgress — watches the shared downloadProgress ref and emits
 * a throttled debug log for every export / download event.
 *
 * `downloading`-phase events are noisy (fires every ~100ms per bytes-read
 * tick), so same-batch same-phase events are suppressed within a 2s window.
 * Other phases (`preparing`, `copying`, …) always log.
 *
 * Side effect: when `downloadProgress` clears to null (task finished / user
 * closed the overlay), flip `downloadOverlayExpanded` to true so the overlay
 * reopens on next download. (App.vue's historical behavior — preserved.)
 */

import { watch, type Ref } from "vue";
import { appDebugLog } from "../appDebugLog.js";

interface DownloadProgressPayload {
  phase?: string;
  message?: string;
  pct?: number;
  progressBytes?: number;
  totalBytes?: number;
  torrentState?: string;
  batchIndex?: number | null;
  batchTotal?: number;
  copyIndex?: number;
  copyTotal?: number;
  queueLabels?: unknown[];
  [k: string]: unknown;
}

export interface UseDownloadProgressOptions {
  downloadProgress: Ref<DownloadProgressPayload | null>;
  downloadOverlayExpanded: Ref<boolean>;
}

const DOWNLOADING_LOG_THROTTLE_MS = 2000;

export function useDownloadProgress(opts: UseDownloadProgressOptions): void {
  let lastAt = 0;
  let lastPhase = "";
  let lastBatch: number | null = null;

  watch(opts.downloadProgress, (v) => {
    if (v == null) {
      opts.downloadOverlayExpanded.value = true;
      lastPhase = "";
      lastBatch = null;
      return;
    }
    const phase = v.phase ?? "";
    const now = Date.now();
    const batch = v.batchIndex ?? null;
    let skip = false;
    if (phase === "downloading") {
      skip =
        phase === lastPhase &&
        batch === lastBatch &&
        now - lastAt < DOWNLOADING_LOG_THROTTLE_MS;
    }
    lastPhase = phase;
    lastBatch = batch;
    if (skip) return;

    lastAt = now;
    void appDebugLog(
      "export",
      `${phase}: ${String(v.message ?? "").slice(0, 220)}`,
      {
        pct: v.pct,
        progressBytes: v.progressBytes,
        totalBytes: v.totalBytes,
        torrentState: v.torrentState,
        batchIndex: v.batchIndex,
        batchTotal: v.batchTotal,
        copyIndex: v.copyIndex,
        copyTotal: v.copyTotal,
        queueLen: v.queueLabels?.length,
      },
    );
  });
}
