/**
 * Polls `vozduxanStreamStats(src)` while the player is buffering or playing.
 */

import { ref, onUnmounted, type Ref } from "vue";
import { vozduxanStreamStats } from "../torrent/torrentSession.js";

const HISTORY_LIMIT = 40;
const FIRST_TICK_MS = 600;
const POLL_INTERVAL_MS = 1000;

interface StreamStatsSample {
  download_rate?: number;
  num_peers?: number;
  [k: string]: unknown;
}

interface HistorySample { rate: number; peers: number }

export interface UseStreamStatsOptions {
  src: Ref<string>;
  streamPhase: Ref<string>;
}

export function useStreamStats(ctx: UseStreamStatsOptions) {
  const streamDownloadStats = ref<StreamStatsSample | null>(null);
  const statsHistory = ref<HistorySample[]>([]);

  let pollingTimer: ReturnType<typeof setTimeout> | null = null;

  function isStreaming(): boolean {
    return ctx.streamPhase.value === "buffering" || ctx.streamPhase.value === "ready";
  }

  function start(): void {
    stop();
    async function poll(): Promise<void> {
      if (!isStreaming()) return;
      const stats = await vozduxanStreamStats(ctx.src.value) as StreamStatsSample | null;
      if (isStreaming()) {
        streamDownloadStats.value = stats;
        if (stats) {
          const h = statsHistory.value;
          h.push({ rate: stats.download_rate ?? 0, peers: stats.num_peers ?? 0 });
          if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
        }
      }
      pollingTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }
    pollingTimer = setTimeout(poll, FIRST_TICK_MS);
  }

  function stop(): void {
    if (pollingTimer !== null) {
      clearTimeout(pollingTimer);
      pollingTimer = null;
    }
    streamDownloadStats.value = null;
    statsHistory.value = [];
  }

  onUnmounted(stop);

  return { streamDownloadStats, statsHistory, startStatsPolling: start, stopStatsPolling: stop };
}
