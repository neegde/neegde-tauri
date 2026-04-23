/**
 * Computeds for the player stream-status pop-up.
 *
 * Produces:
 *   - `prepareDotClass` / `streamDotClass` — colour of the status indicator.
 *   - `prepareHintDetail` — multi-line tooltip ("ETA / Peers / Seeds").
 *   - `currentPeers` / `currentRate` — unified view over live vozduxan stats
 *     and the last prepare-progress sample.
 *   - `sparklineData` — SVG polyline points for the mini chart.
 *   - `streamStatusHeadline` / `streamStatusBody` — headline + body copy.
 */

import { computed } from "vue";
import { fmtEtaHuman, fmtRate } from "../lib/fmt.js";

/**
 * @param {{
 *   streamPhase: import("vue").Ref<string>,
 *   prepareProgress: import("vue").Ref<object | null>,
 *   lastPrepareProgress: import("vue").Ref<object | null>,
 *   streamDownloadStats: import("vue").Ref<object | null>,
 *   statsHistory: import("vue").Ref<Array<{ rate: number, peers: number }>>,
 *   track: import("vue").ComputedRef<object | null>,
 * }} ctx
 */
export function useStreamStatus(ctx) {
  const prepareDotClass = computed(() => {
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

  const prepareHintDetail = computed(() => {
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

  const streamDotClass = computed(() => {
    if (ctx.streamPhase.value === "ready") return "prepare-dot--ok";
    return prepareDotClass.value;
  });

  const currentPeers = computed(() => {
    const stats = ctx.streamDownloadStats.value;
    if (stats) return stats.num_peers ?? 0;
    const p = ctx.lastPrepareProgress.value;
    return p?.peersLive ?? 0;
  });

  const currentRate = computed(() => {
    const stats = ctx.streamDownloadStats.value;
    if (stats?.download_rate > 0) return stats.download_rate;
    const p = ctx.lastPrepareProgress.value;
    return (p?.downloadMbps ?? 0) > 0 ? Math.round(p.downloadMbps * 1_000_000) : 0;
  });

  /** SVG polyline points for the download-rate sparkline. */
  const sparklineData = computed(() => {
    const h = ctx.statsHistory.value;
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

  const streamStatusHeadline = computed(() => {
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

  const streamStatusBody = computed(() => {
    const p = ctx.lastPrepareProgress.value;
    const msg = (p?.message ?? "").toLowerCase();

    if (ctx.streamPhase.value === "ready") {
      const peers = currentPeers.value;
      return peers > 0
        ? `Воспроизводится · ${peers} источн. в сети`
        : "Воспроизводится из торрент-сети";
    }
    if (ctx.streamPhase.value === "buffering") {
      const stats = ctx.streamDownloadStats.value;
      if (!stats) return "Ожидание от источников…";
      if (stats.num_peers === 0) return "Ищем источники в сети…";
      const rate = stats.download_rate;
      return rate > 0
        ? `${stats.num_peers} источн. · ${fmtRate(rate)}`
        : `Подключено ${stats.num_peers} источн.`;
    }
    if (msg.includes("metadata") || msg.includes("resolv")) return "Получаем информацию о треке…";
    if (msg.includes("buffer"))  return "Синхронизация с источниками…";
    if (msg.includes("ready"))   return "Источник готов";
    return "Ищем источники в сети…";
  });

  return {
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
