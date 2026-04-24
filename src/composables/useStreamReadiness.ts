/**
 * useStreamReadiness — unified player stream state.
 *
 * Merges what used to be four separate composables (useBufferPoll,
 * useBufferingWatchdog, useStreamStats, useStreamStatus) — they all observed
 * the same refs (streamPhase, prepareProgress, stats, audio element) and
 * cross-wired through Player.vue (watchdog → stats polling).
 *
 * Responsibilities:
 *   - `bufferedPercent` polling via rAF while the stream is loading
 *   - vozduxan download stats polling while buffering/ready + rolling history
 *     for a sparkline
 *   - buffering watchdog: after BUFFERING_WATCHDOG_MS of `buffering`, either
 *     restore `ready` (playback advanced despite the stall) or flip to
 *     `error` with an explicit message
 *   - all the status-popup computeds (dot class, headline, body, sparkline)
 */

import { ref, computed, watch, onUnmounted, type Ref, type ComputedRef } from "vue";
import { fmtEtaHuman, fmtRate } from "../lib/fmt.js";
import { vozduxanStreamStats } from "../torrent/torrentSession.js";
import { appDebugLog } from "../appDebugLog.js";

export const BUFFERING_WATCHDOG_MS = 185_000;
const STATS_HISTORY_LIMIT = 40;
const STATS_FIRST_TICK_MS = 600;
const STATS_POLL_INTERVAL_MS = 1000;

interface PrepareProgress {
  state?: string;
  message?: string;
  downloadMbps?: number;
  peersLive?: number;
  peersConnecting?: number;
  peersQueued?: number;
  prebufferTarget?: number | null;
  prebufferFilled?: number;
  etaHuman?: string;
  [k: string]: unknown;
}

interface StreamStatsSample {
  download_rate?: number;
  num_peers?: number;
  [k: string]: unknown;
}

interface HistorySample { rate: number; peers: number }

interface TrackLike {
  fileName?: string;
  seeders?: number | string | null;
  [k: string]: unknown;
}

export interface UseStreamReadinessOptions {
  audioRef: Ref<HTMLMediaElement | null>;
  src: Ref<string>;
  streamPhase: Ref<string>;
  streamError: Ref<string>;
  duration: Ref<number>;
  isLoading: ComputedRef<boolean> | Ref<boolean>;
  track: ComputedRef<TrackLike | null> | Ref<TrackLike | null>;
  prepareProgress: Ref<PrepareProgress | null>;
  lastPrepareProgress: Ref<PrepareProgress | null>;
}

export function useStreamReadiness(ctx: UseStreamReadinessOptions) {
  // ── Buffered-percent polling ───────────────────────────────────────────────

  const bufferedPercent = ref<number>(0);
  let rafId = 0;

  function updateBufferStats(): void {
    const a = ctx.audioRef.value;
    if (!a) {
      bufferedPercent.value = 0;
      return;
    }
    const metaDur = a.duration;
    if (Number.isFinite(metaDur) && metaDur > 0) {
      ctx.duration.value = metaDur;
    }
    if (!a.buffered?.length) {
      bufferedPercent.value = 0;
      return;
    }
    const end = a.buffered.end(a.buffered.length - 1);
    const dur = Number.isFinite(ctx.duration.value) && ctx.duration.value > 0 ? ctx.duration.value : 0;
    if (dur > 0 && Number.isFinite(end)) {
      bufferedPercent.value = Math.max(0, Math.min(100, (end / dur) * 100));
    }
  }

  function stopBufferPoll(): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function tickBuffer(): void {
    rafId = 0;
    updateBufferStats();
    if (
      ctx.isLoading.value &&
      ctx.streamPhase.value !== "error" &&
      ctx.streamPhase.value !== "idle" &&
      ctx.audioRef.value
    ) {
      rafId = requestAnimationFrame(tickBuffer);
    }
  }

  function startBufferPoll(): void {
    stopBufferPoll();
    rafId = requestAnimationFrame(tickBuffer);
  }

  watch(
    () => ctx.isLoading.value,
    (loading) => {
      stopBufferPoll();
      if (loading) startBufferPoll();
    },
    { immediate: true },
  );

  // ── Stats polling ──────────────────────────────────────────────────────────

  const streamDownloadStats = ref<StreamStatsSample | null>(null);
  const statsHistory = ref<HistorySample[]>([]);
  let pollingTimer: ReturnType<typeof setTimeout> | null = null;

  function isStreaming(): boolean {
    return ctx.streamPhase.value === "buffering" || ctx.streamPhase.value === "ready";
  }

  function stopStatsPolling(): void {
    if (pollingTimer !== null) {
      clearTimeout(pollingTimer);
      pollingTimer = null;
    }
    streamDownloadStats.value = null;
    statsHistory.value = [];
  }

  function startStatsPolling(): void {
    stopStatsPolling();
    async function poll(): Promise<void> {
      if (!isStreaming()) return;
      const stats = await vozduxanStreamStats(ctx.src.value) as StreamStatsSample | null;
      if (isStreaming()) {
        streamDownloadStats.value = stats;
        if (stats) {
          const h = statsHistory.value;
          h.push({ rate: stats.download_rate ?? 0, peers: stats.num_peers ?? 0 });
          if (h.length > STATS_HISTORY_LIMIT) h.splice(0, h.length - STATS_HISTORY_LIMIT);
        }
      }
      pollingTimer = setTimeout(poll, STATS_POLL_INTERVAL_MS);
    }
    pollingTimer = setTimeout(poll, STATS_FIRST_TICK_MS);
  }

  // ── Buffering watchdog ─────────────────────────────────────────────────────

  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  function clearBufferingWatchdog(): void {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function startBufferingWatchdog(): void {
    clearBufferingWatchdog();
    startStatsPolling();
    const startTime = ctx.audioRef.value?.currentTime ?? 0;
    void appDebugLog(
      "player",
      `audio: buffering watchdog started (${BUFFERING_WATCHDOG_MS}ms) — "${ctx.track.value?.fileName?.slice?.(0, 60)}"`,
    );
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (ctx.streamPhase.value !== "buffering") return;
      const curTime = ctx.audioRef.value?.currentTime ?? 0;
      if (curTime > startTime) {
        void appDebugLog(
          "player",
          `audio: buffering watchdog: playback advanced (${startTime.toFixed(2)}s → ${curTime.toFixed(2)}s) — restoring ready`,
        );
        ctx.streamPhase.value = "ready";
        return;
      }
      void appDebugLog(
        "player",
        `audio: buffering watchdog FIRED — stream stalled for ${BUFFERING_WATCHDOG_MS}ms currentTime=${curTime.toFixed(2)} src=${ctx.src.value?.slice?.(0, 80)}`,
      );
      ctx.streamError.value = "Поток прерван: не удалось получить данные от раздачи";
      ctx.streamPhase.value = "error";
    }, BUFFERING_WATCHDOG_MS);
  }

  // ── Status popup computeds ─────────────────────────────────────────────────

  const prepareDotClass = computed<string>(() => {
    const p = ctx.prepareProgress.value;
    if (!p) return "prepare-dot--info";
    if (p.state === "error") return "prepare-dot--bad";
    if (p.state === "initializing") return "prepare-dot--info";
    const dl = p.downloadMbps ?? 0;
    const live = p.peersLive ?? 0;
    if (live >= 1 && dl >= 0.02) return "prepare-dot--ok";
    if (live >= 1 || dl >= 0.015) return "prepare-dot--ok";
    if ((p.peersConnecting ?? 0) > 0 || (p.peersQueued ?? 0) > 0) return "prepare-dot--warn";
    return "prepare-dot--warn";
  });

  const prepareHintDetail = computed<string>(() => {
    const p = ctx.prepareProgress.value;
    const track = ctx.track.value;
    let etaLine = "До старта: —";
    if (p) {
      const pt = p.prebufferTarget;
      const pf = p.prebufferFilled ?? 0;
      const dl = p.downloadMbps ?? 0;
      if (pt != null && pt > 0 && pf < pt && dl > 1e-6) {
        const remaining = pt - pf;
        const bytesPerSec = dl * 1024 * 1024;
        const sec = remaining / bytesPerSec;
        const h = fmtEtaHuman(sec);
        if (h) etaLine = `До старта: ${h}`;
      } else if (p.etaHuman) {
        etaLine = `До старта: ~${p.etaHuman}`;
      }
    }
    const live = p?.peersLive ?? null;
    const peersPart = live != null ? `Пиры: ${live}` : "Пиры: —";
    const seeds = track?.seeders;
    const seedsPart =
      seeds != null && Number.isFinite(Number(seeds)) ? `Сиды: ${Number(seeds)}` : null;
    const second = seedsPart ? `${peersPart} · ${seedsPart}` : peersPart;
    return `${etaLine}\n${second}`;
  });

  const streamDotClass = computed<string>(() => {
    if (ctx.streamPhase.value === "ready") return "prepare-dot--ok";
    return prepareDotClass.value;
  });

  const currentPeers = computed<number>(() => {
    const stats = streamDownloadStats.value;
    if (stats) return stats.num_peers ?? 0;
    const p = ctx.lastPrepareProgress.value;
    return p?.peersLive ?? 0;
  });

  const currentRate = computed<number>(() => {
    const stats = streamDownloadStats.value;
    if ((stats?.download_rate ?? 0) > 0) return stats!.download_rate!;
    const p = ctx.lastPrepareProgress.value;
    return (p?.downloadMbps ?? 0) > 0 ? Math.round((p!.downloadMbps ?? 0) * 1_000_000) : 0;
  });

  const sparklineData = computed<{ points: string; max: number }>(() => {
    const h = statsHistory.value;
    if (h.length < 2) return { points: "", max: 0 };
    const W = 180, H = 36;
    const rates = h.map((x) => x.rate);
    const maxR = Math.max(...rates, 1);
    const pts = rates.map((r, i) => {
      const x = (i / (rates.length - 1)) * W;
      const y = H - (r / maxR) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return { points: pts, max: maxR };
  });

  const streamStatusHeadline = computed<string>(() => {
    switch (ctx.streamPhase.value) {
      case "preparing": return "Поиск источников";
      case "buffering": {
        const r = currentRate.value;
        if (r > 0) return fmtRate(r);
        return currentPeers.value > 0 ? "Синхронизация" : "Поиск источников";
      }
      case "ready": {
        const r = currentRate.value;
        return r > 0 ? fmtRate(r) : "Прямой эфир";
      }
      default: return "";
    }
  });

  const streamStatusBody = computed<string>(() => {
    const p = ctx.lastPrepareProgress.value;
    const msg = (p?.message ?? "").toLowerCase();

    if (ctx.streamPhase.value === "ready") {
      const peers = currentPeers.value;
      return peers > 0
        ? `Воспроизводится · ${peers} источн. в сети`
        : "Воспроизводится из торрент-сети";
    }
    if (ctx.streamPhase.value === "buffering") {
      const stats = streamDownloadStats.value;
      if (!stats) return "Ожидание от источников…";
      if (stats.num_peers === 0) return "Ищем источники в сети…";
      const rate = stats.download_rate ?? 0;
      return rate > 0
        ? `${stats.num_peers} источн. · ${fmtRate(rate)}`
        : `Подключено ${stats.num_peers} источн.`;
    }
    if (msg.includes("metadata") || msg.includes("resolv")) return "Получаем информацию о треке…";
    if (msg.includes("buffer"))  return "Синхронизация с источниками…";
    if (msg.includes("ready"))   return "Источник готов";
    return "Ищем источники в сети…";
  });

  onUnmounted(() => {
    stopBufferPoll();
    stopStatsPolling();
    clearBufferingWatchdog();
  });

  return {
    // Buffer poll
    bufferedPercent,
    updateBufferStats,
    stopBufferPoll,
    // Stats poll
    streamDownloadStats,
    statsHistory,
    startStatsPolling,
    stopStatsPolling,
    // Watchdog
    startBufferingWatchdog,
    clearBufferingWatchdog,
    // Status computeds
    prepareDotClass,
    prepareHintDetail,
    streamDotClass,
    currentPeers,
    currentRate,
    sparklineData,
    streamStatusHeadline,
    streamStatusBody,
  };
}
