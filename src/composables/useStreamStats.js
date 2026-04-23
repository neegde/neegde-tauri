/**
 * Polls `vozduxanStreamStats(src)` while the player is buffering or playing.
 *
 * Exposes the latest sample and a rolling history for the sparkline chart.
 * Polling only runs while `streamPhase` is "buffering" or "ready"; it stops
 * automatically on teardown and when the caller explicitly calls `stop()`.
 */

import { ref, onUnmounted } from "vue";
import { vozduxanStreamStats } from "../torrent/torrentSession.js";

const HISTORY_LIMIT = 40;
const FIRST_TICK_MS = 600;
const POLL_INTERVAL_MS = 1000;

/**
 * @param {{
 *   src: import("vue").Ref<string>,
 *   streamPhase: import("vue").Ref<string>,
 * }} ctx
 */
export function useStreamStats(ctx) {
  /** Last stats sample (or null). */
  const streamDownloadStats = ref(null);
  /** Rolling [{ rate, peers }] window for sparkline. */
  const statsHistory = ref([]);

  let pollingTimer = null;

  function isStreaming() {
    return ctx.streamPhase.value === "buffering" || ctx.streamPhase.value === "ready";
  }

  function start() {
    stop();
    async function poll() {
      if (!isStreaming()) return;
      const stats = await vozduxanStreamStats(ctx.src.value);
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

  function stop() {
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
