<script setup>
import { ref, computed, watch, watchEffect, onMounted, onUnmounted, nextTick } from "vue";
import { listen } from "@tauri-apps/api/event";
import CoverThumb from "../shared/CoverThumb.vue";
import { prefetchNextInQueue, streamUrl } from "../../torrent/api.js";
import { trackDisplayBasename, extractTrackArtist } from "../../lib/utils.js";
import {
  releaseTorrentStreamUrl,
  torrentPrepareCancel,
  vozduxanStreamStats,
} from "../../torrent/torrentSession.js";
import {
  ensureEqualizer,
  destroyEqualizer,
  resumeEqualizerContext,
  isEqualizerActive,
  setEqualizerOutputGain,
} from "../../audio/equalizerGraph.js";
import { eqBandsDb } from "../../audio/equalizerState.js";
import {
  setMediaSessionApi,
  installMediaSessionHandlers,
  clearMediaSessionHandlers,
  syncMediaSessionMetadata,
  syncMediaSessionPlaybackState,
  syncMediaSessionPositionState,
  clearMediaSessionPresentation,
  reaffirmTrackSkipHandlers,
} from "../../audio/mediaSession.js";
import { appDebugLog } from "../../appDebugLog.js";
import { syncDiscordPresence, clearDiscordPresence } from "../../discordPresence.js";
import { enrichTrackMeta } from "../../audio/metadataEnrich.js";

function fmtTime(secs) {
  if (!secs || isNaN(secs) || !isFinite(secs)) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const props = defineProps({
  track: { type: Object, default: null },
  /** Следующий трек в очереди — для фоновой предзагрузки. */
  nextTrack: { type: Object, default: null },
  /** Трек через один — для упреждающей предзагрузки после завершения prefetch nextTrack. */
  secondNextTrack: { type: Object, default: null },
  hasPrev: Boolean,
  hasNext: Boolean,
  /** После восстановления сессии: не использовать HTML autoplay при появлении src. */
  suppressAutoplay: Boolean,
  /** Словарь лайков из App.vue — для отображения состояния лайка текущего трека. */
  likes: { type: Object, default: null },
  /** Текущая очередь воспроизведения (копия из App). */
  playbackQueue: { type: Array, default: () => [] },
  /** Индекс текущего трека в очереди. */
  queueIndex: { type: Number, default: 0 },
  /** `off` | `all` | `one` — циклическое переключение из App. */
  repeatMode: { type: String, default: "off" },
  shuffleOn: Boolean,
});

const emit = defineEmits([
  "prev",
  "next",
  "ended",
  "playing-change",
  "request-stream",
  "toggle-like",
  "search-artist",
  "open-torrent",
  "queue-jump",
  "queue-remove",
  "cycle-repeat",
  "toggle-shuffle",
]);

const currentArtist = computed(() =>
  enrichedMeta.value?.artist ||
  extractTrackArtist(props.track?.torrentName, props.track?.albumDirPath, props.track?.artist, props.track?.magnet) ||
  ""
);

const displayTitle = computed(
  () => enrichedMeta.value?.title || trackDisplayBasename(props.track?.fileName ?? "")
);

function onArtistClick() {
  const a = currentArtist.value;
  if (a) emit("search-artist", a);
}

function onTrackClick() {
  const t = props.track;
  if (!t) return;
  emit("open-torrent", {
    torrentId: t.torrentId,
    torrentName: t.torrentName,
    source: t.source,
    magnet: t.magnet,
    artist: t.artist,
    seeders: t.seeders ?? null,
    fileIdx: t.fileIdx,
    albumDirPath: t.albumDirPath ?? null,
  });
}

function loadSavedVolume() {
  try {
    const raw = localStorage.getItem("playerVolume");
    if (raw == null) return 1;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(0, n));
  } catch {
    return 1;
  }
}

const hasTrack = computed(() => Boolean(props.track?.magnet));

const currentLikeId = computed(() => {
  const t = props.track;
  if (!t?.torrentId || t.fileIdx == null) return null;
  return `track:${t.source}:${t.torrentId}:${t.fileIdx}`;
});

const isCurrentTrackLiked = computed(() => {
  const id = currentLikeId.value;
  return id ? Boolean(props.likes?.[id]) : false;
});

function toggleCurrentLike() {
  const t = props.track;
  const id = currentLikeId.value;
  if (!t || !id) return;
  emit("toggle-like", {
    id,
    type: "track",
    torrentId: t.torrentId,
    torrentName: t.torrentName,
    source: t.source,
    magnet: t.magnet,
    fileIdx: t.fileIdx,
    fileName: t.fileName,
    coverFileIdx: t.coverFileIdx ?? null,
    coverFile: null,
  });
}

const audioRef = ref(null);
const volume = ref(loadSavedVolume());
/** Уровень до mute по клику на динамик — для восстановления. */
const volumeBeforeMute = ref(null);

function toggleMute() {
  if (volume.value > 0) {
    volumeBeforeMute.value = volume.value;
    volume.value = 0;
  } else {
    const prev = volumeBeforeMute.value;
    volume.value =
      prev != null && prev > 0 ? prev : Math.max(loadSavedVolume(), 0.25);
  }
}

function onVolumeWheel(e) {
  e.preventDefault();
  const step = 0.06;
  const next = volume.value + (e.deltaY < 0 ? step : -step);
  volume.value = Math.min(1, Math.max(0, next));
}
/** Enriched metadata from iTunes (artist/album/title/coverUrl). Null until resolved. */
const enrichedMeta = ref(null);

const playing = ref(false);
const current = ref(0);
const duration = ref(0);
const src = ref("");
const streamPhase = ref("idle"); // idle | preparing | buffering | ready | error
const streamError = ref("");
const bufferedPercent = ref(0);
/** Отмена загрузки без смены трека — не применять URL после await. */
const loadCancelledByUser = ref(false);
/** Watchdog: превращает бесконечный buffering после piece-timeout в явный error. */
let bufferingWatchdogTimer = null;
/** Чуть больше vozduxan PIECE_TIMEOUT_MS (180 000 мс) — не должен опережать таймаут C++. */
const BUFFERING_WATCHDOG_MS = 185_000;
/** Статистика скачивания во время buffering фазы: { download_rate, num_peers } или null. */
const streamDownloadStats = ref(null);
let statsPollingTimer = null;
/** История статистики для sparkline-графика: [{rate, peers}], макс. 40 точек */
const statsHistory = ref([]);
/** Счётчик повторной попытки открыть поток (тот же трек после отмены / ошибки). */
const prepareAttempt = ref(0);
/** Matches the in-flight / active prepare — suppresses duplicate watch runs for the same track. */
const activeStreamPrepareSig = ref("");

/** Последняя статистика BitTorrent из Tauri (событие torrent-prepare-progress). */
const prepareProgress = ref(null);
/** Сохраняем последнее значение, чтобы статус-меню показывало данные и в состоянии ready. */
const lastPrepareProgress = ref(null);
let unlistenPrepareProgress = () => {};

/** Открыто ли pop-up меню статуса стрима. */
const statusMenuOpen = ref(false);
/** Панель списка очереди. */
const queuePanelOpen = ref(false);

/** URL из `torrent_prefetch_next_track` (другой торрент), пока не переключились на этот трек. */
const prefetchedStream = ref({ url: "", forKey: "" });
/** Успешный prefetch для пары текущий→следующий (не повторять до смены трека). */
const prefetchOkFingerprint = ref("");
let prefetchInFlight = false;
/** Спекулятивный «тихий» прогрев track+2 (не нужен URL — важна только загрузка кусков). */
let secondPrefetchInFlight = false;
let secondPrefetchDoneFingerprint = "";

/** For cross-torrent next track, wait a bit longer to avoid wasted bandwidth on quick skips. */
const PREFETCH_MIN_SEC = 4;
const PREFETCH_MIN_RATIO = 0.08;
/**
 * Same-torrent next track: start prefetch almost immediately.
 * Adjusting piece priorities is virtually free since metadata is already loaded.
 */
const PREFETCH_MIN_SEC_SAME_TORRENT = 1.5;
const PREFETCH_MIN_RATIO_SAME_TORRENT = 0.04;

/**
 * Stable key for matching a queue item to a prepared stream URL.
 *
 * Args:
 *     t: Queue item with magnet and fileIdx.
 *
 * Returns:
 *     String key or empty when invalid.
 */
function queueTrackKey(t) {
  if (!t?.magnet || t.fileIdx == null || t.fileIdx === "") return "";
  const n = Number(t.fileIdx);
  if (!Number.isFinite(n)) return "";
  return `${t.magnet}\0${n}`;
}

/**
 * Fingerprint for current→next prefetch attempt.
 *
 * Args:
 *     cur: Current queue item.
 *     next: Next queue item.
 *
 * Returns:
 *     Non-empty string when both are valid, else empty.
 */
function prefetchFingerprint(cur, next) {
  if (!cur?.magnet || next?.magnet == null || next.fileIdx == null) return "";
  return `${cur.magnet}\0${cur.fileIdx}\0${next.magnet}\0${next.fileIdx}`;
}

/**
 * Formats estimated wait time in seconds as a short Russian phrase.
 *
 * Args:
 *     sec: Duration in seconds.
 *
 * Returns:
 *     String like "~45 с" or "~3 мин", or null if not meaningful.
 */
function fmtEtaHuman(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  if (sec < 60) return `~${Math.max(1, Math.round(sec))} с`;
  if (sec < 3600) return `~${Math.round(sec / 60)} мин`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `~${h} ч ${m} мин` : `~${h} ч`;
}

const prepareDotClass = computed(() => {
  const p = prepareProgress.value;
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
  const p = prepareProgress.value;
  const track = props.track;
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
  const peersPart =
    live != null ? `Пиры: ${live}` : "Пиры: —";
  const seeds = track?.seeders;
  const seedsPart =
    seeds != null && Number.isFinite(Number(seeds))
      ? `Сиды: ${Number(seeds)}`
      : null;
  const second = seedsPart ? `${peersPart} · ${seedsPart}` : peersPart;
  return `${etaLine}\n${second}`;
});

/* ── Status menu computeds ─────────────────────────────────────────── */

/** Цвет точки для всех активных фаз, включая ready. */
const streamDotClass = computed(() => {
  if (streamPhase.value === "ready") return "prepare-dot--ok";
  return prepareDotClass.value;
});

function fmtRate(bytesPerSec) {
  if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} МБ/с`;
  if (bytesPerSec >= 1024)      return `${Math.round(bytesPerSec / 1024)} КБ/с`;
  return `${bytesPerSec} Б/с`;
}

/** Активный источников сейчас */
const currentPeers = computed(() => {
  const stats = streamDownloadStats.value;
  if (stats) return stats.num_peers ?? 0;
  const p = lastPrepareProgress.value;
  return (p?.peersLive ?? 0);
});

/** Текущая скорость потока в байт/с */
const currentRate = computed(() => {
  const stats = streamDownloadStats.value;
  if (stats?.download_rate > 0) return stats.download_rate;
  const p = lastPrepareProgress.value;
  return (p?.downloadMbps ?? 0) > 0 ? Math.round(p.downloadMbps * 1_000_000) : 0;
});

/** Sparkline: SVG polyline points из истории скорости */
const sparklineData = computed(() => {
  const h = statsHistory.value;
  if (h.length < 2) return { points: "", max: 0 };
  const W = 180, H = 36;
  const rates = h.map(x => x.rate);
  const maxR = Math.max(...rates, 1);
  const pts = rates.map((r, i) => {
    const x = (i / (rates.length - 1)) * W;
    const y = H - (r / maxR) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return { points: pts, max: maxR };
});

/** Одна фраза-заголовок для pop-up. */
const streamStatusHeadline = computed(() => {
  switch (streamPhase.value) {
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

/** Человекочитаемое предложение о том, что сейчас происходит. */
const streamStatusBody = computed(() => {
  const p = lastPrepareProgress.value;
  const msg = (p?.message ?? "").toLowerCase();

  if (streamPhase.value === "ready") {
    const peers = currentPeers.value;
    return peers > 0
      ? `Воспроизводится · ${peers} источн. в сети`
      : "Воспроизводится из торрент-сети";
  }
  if (streamPhase.value === "buffering") {
    const stats = streamDownloadStats.value;
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

watch(
  () => queueTrackKey(props.track),
  () => {
    activeStreamPrepareSig.value = "";
    prepareAttempt.value = 0;
    prefetchOkFingerprint.value = "";
    secondPrefetchDoneFingerprint = "";
    lastPrepareProgress.value = null;
    statusMenuOpen.value = false;
    const nk = props.track ? queueTrackKey(props.track) : "";
    if (prefetchedStream.value.url && prefetchedStream.value.forKey !== nk) {
      void releaseTorrentStreamUrl(prefetchedStream.value.url);
      prefetchedStream.value = { url: "", forKey: "" };
    }
    if (prefetchInFlight) {
      void torrentPrepareCancel();
    }
  }
);

const progress = computed(() => duration.value > 0 ? current.value / duration.value : 0);
const isLoading = computed(() => streamPhase.value === "preparing" || streamPhase.value === "buffering");
/** Без metadata duration неизвестна — не показываем «процент» (он залипает на 95%), только индетерминатный режим в шаблоне */
const loadingProgress = computed(() => {
  if (duration.value > 0) return bufferedPercent.value;
  return isLoading.value ? 0 : 100;
});

/**
 * Logs HTMLMediaElement.play() rejection to app debug (e.g. NotAllowedError).
 *
 * Args:
 *     context: Caller label (e.g. togglePlay, mediaSession).
 *     err: Rejection value from the play() promise.
 */
function logPlayRejected(context, err) {
  void appDebugLog("player", "audio.play() rejected", {
    context,
    name: err?.name,
    message: err?.message ?? String(err ?? ""),
  });
}

async function cancelLoad() {
  void appDebugLog("player", `stream prepare: user cancelled — "${props.track?.fileName?.slice?.(0,70)}" fileIdx=${props.track?.fileIdx} phase=${streamPhase.value}`);
  loadCancelledByUser.value = true;
  void torrentPrepareCancel();
  const prevUrl = src.value;
  stopBufferPoll();
  src.value = "";
  current.value = 0;
  duration.value = 0;
  bufferedPercent.value = 0;
  streamError.value = "";
  streamPhase.value = "idle";
  playing.value = false;
  await releaseTorrentStreamUrl(prevUrl);
}

function onPlayButtonClick() {
  if (streamPhase.value === "preparing") {
    void cancelLoad();
    return;
  }
  togglePlay();
}

function togglePlay() {
  if (!hasTrack.value) return;
  if (props.suppressAutoplay && !src.value) {
    void appDebugLog("player", `togglePlay: suppressed — emitting request-stream fileIdx=${props.track?.fileIdx}`);
    emit("request-stream");
    return;
  }
  const a = audioRef.value;
  if (!a) {
    if (!src.value && (streamPhase.value === "idle" || streamPhase.value === "error")) {
      streamError.value = "";
      loadCancelledByUser.value = false;
      prepareAttempt.value++;
    }
    return;
  }
  if (a.paused) {
    void a.play().catch((err) => {
      logPlayRejected("togglePlay", err);
      playing.value = !a.paused;
    });
  } else {
    a.pause();
  }
}

function seek(e) {
  const a = audioRef.value;
  if (!a || !duration.value) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  a.currentTime = ratio * duration.value;
}

function onKey(e) {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.code === "MediaTrackNext" && hasTrack.value) {
    e.preventDefault();
    emit("next");
    return;
  }
  if (e.code === "MediaTrackPrevious" && hasTrack.value) {
    e.preventDefault();
    emit("prev");
    return;
  }
  if (e.code === "Space" && hasTrack.value) {
    e.preventDefault();
    if (streamPhase.value === "preparing") void cancelLoad();
    else togglePlay();
  }
  if (e.code === "ArrowRight" && props.hasNext) { e.preventDefault(); emit("next"); }
  if (e.code === "ArrowLeft" && props.hasPrev) { e.preventDefault(); emit("prev"); }
}

function updateBufferStats() {
  const a = audioRef.value;
  if (!a) {
    bufferedPercent.value = 0;
    return;
  }
  const metaDur = a.duration;
  if (Number.isFinite(metaDur) && metaDur > 0) {
    duration.value = metaDur;
  }
  if (!a.buffered?.length) {
    bufferedPercent.value = 0;
    return;
  }
  const end = a.buffered.end(a.buffered.length - 1);
  const effectiveDur = Number.isFinite(duration.value) && duration.value > 0 ? duration.value : 0;
  if (effectiveDur > 0 && Number.isFinite(end)) {
    bufferedPercent.value = Math.max(0, Math.min(100, (end / effectiveDur) * 100));
  }
}

function describeMediaError(code) {
  const MEDIA_ERR = {
    1: "MEDIA_ERR_ABORTED",
    2: "MEDIA_ERR_NETWORK",
    3: "MEDIA_ERR_DECODE",
    4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
  };
  return MEDIA_ERR[code] ?? `UNKNOWN(${code})`;
}

function onAudioError() {
  streamPhase.value = "error";
  const err = audioRef.value?.error;
  const srcUrl = src.value;
  const mediaErr = err ? describeMediaError(err.code) : null;
  console.error("[player/audio element error]", {
    code: err?.code,
    message: err?.message,
    mediaError: mediaErr,
    src: srcUrl?.slice?.(0, 120),
  });
  void appDebugLog("player", "audio element error", {
    code: err?.code,
    mediaError: mediaErr,
    srcPreview: srcUrl?.slice?.(0, 160),
  });
  streamError.value = err
    ? `Ошибка воспроизведения: ${describeMediaError(err.code)}`
    : "Ошибка загрузки потока";

  // Auto-retry once: vozduxan wait_for_piece timeout drops the HTTP connection
  // which the browser reports as MEDIA_ERR_SRC_NOT_SUPPORTED (code 4). By then
  // the torrent has been downloading the first piece for ~28s total, so a
  // fresh prepare() almost always finds it available immediately.
  if (prepareAttempt.value === 0) {
    const trackKeyAtError = queueTrackKey(props.track);
    setTimeout(() => {
      if (
        streamPhase.value === "error" &&
        !loadCancelledByUser.value &&
        queueTrackKey(props.track) === trackKeyAtError
      ) {
        void appDebugLog("player", `stream prepare: auto-retry after audio error — "${props.track?.fileName?.slice?.(0, 60)}" fileIdx=${props.track?.fileIdx}`);
        streamError.value = "";
        prepareAttempt.value++;
      }
    }, 1500);
  }
}

watch(playing, (v) => {
  emit("playing-change", v);
  syncMediaSessionPlaybackState(v);
  if (v) reaffirmTrackSkipHandlers();
}, { immediate: true });

watch(streamPhase, (phase, prev) => {
  void appDebugLog("player", `streamPhase: ${prev} → ${phase} — "${props.track?.fileName?.slice?.(0,60)}" fileIdx=${props.track?.fileIdx}`);
  if (phase !== "buffering") {
    clearBufferingWatchdog();
    if (phase !== "ready") stopStatsPolling();
  }
  if (phase === "ready" && prev === "buffering") {
    // Continue polling after buffering so the chart stays alive during playback
    startStatsPolling();
  }
});

watchEffect(() => {
  void props.hasPrev;
  void props.hasNext;
  setMediaSessionApi({
    play: () => {
      if (props.suppressAutoplay && !src.value && hasTrack.value) {
        emit("request-stream");
        return;
      }
      const a = audioRef.value;
      if (a) {
        void a.play().catch((err) => {
          logPlayRejected("mediaSession", err);
        });
      }
    },
    pause: () => audioRef.value?.pause(),
    prev: () => {
      emit("prev");
    },
    next: () => {
      emit("next");
    },
    seek: (t) => {
      const a = audioRef.value;
      if (!a) return;
      const d = duration.value;
      if (Number.isFinite(d) && d > 0) {
        a.currentTime = Math.max(0, Math.min(t, d));
      } else if (Number.isFinite(t) && t >= 0) {
        a.currentTime = t;
      }
    },
    seekRelative: (delta) => {
      const a = audioRef.value;
      if (!a || !Number.isFinite(delta)) return;
      a.currentTime = Math.max(0, a.currentTime + delta);
    },
  });
});

watch(
  () => props.track,
  (t) => {
    enrichedMeta.value = null;
    if (!t?.magnet) {
      clearMediaSessionPresentation();
      return;
    }
    void syncMediaSessionMetadata(t);
    // Fire iTunes enrichment in background — does NOT block playback
    const artistLocal = extractTrackArtist(t.torrentName, t.albumDirPath, t.artist, t.magnet);
    const titleLocal = trackDisplayBasename(t.fileName);
    enrichTrackMeta(artistLocal, titleLocal, (meta) => {
      if (props.track !== t) return; // track changed while request was in flight
      enrichedMeta.value = meta;
      void syncMediaSessionMetadata(t, meta);
    });
  },
  { immediate: true }
);

watch(
  () => [playing.value, duration.value, current.value, props.track?.magnet],
  () => {
    if (!props.track?.magnet || streamPhase.value === "error") return;
    const d = duration.value;
    const p = current.value;
    if (!Number.isFinite(d) || d <= 0) return;
    syncMediaSessionPositionState(d, p, 1);
  },
  { flush: "post" }
);

function discordPresencePayload() {
  const t = props.track;
  if (!t?.magnet) return null;
  return {
    title: trackDisplayBasename(t.fileName) || "Трек",
    subtitle: extractTrackArtist(t.torrentName, t.albumDirPath, t.artist, t.magnet),
    playing: playing.value,
    positionSec: Number.isFinite(current.value) ? current.value : null,
    durationSec:
      Number.isFinite(duration.value) && duration.value > 0 ? duration.value : null,
  };
}

/** Last `syncDiscordPresence` from track/play/phase — used so progress-only updates do not starve. */
let discordPresenceLastSyncMs = 0;
const DISCORD_PRESENCE_PROGRESS_MIN_MS = 4500;

watch(
  () => [props.track, playing.value, streamPhase.value],
  () => {
    const t = props.track;
    if (!t?.magnet) {
      void clearDiscordPresence();
      return;
    }
    if (streamPhase.value === "error") {
      void clearDiscordPresence();
      return;
    }
    if (!playing.value) {
      void clearDiscordPresence();
      return;
    }
    const p = discordPresencePayload();
    if (!p) return;
    discordPresenceLastSyncMs = Date.now();
    void syncDiscordPresence(p, { immediate: true });
  },
  { flush: "post", immediate: true }
);

watch(
  () => [current.value, duration.value, playing.value, props.track?.magnet, streamPhase.value],
  () => {
    if (!props.track?.magnet || streamPhase.value === "error" || !playing.value) return;
    const now = Date.now();
    if (now - discordPresenceLastSyncMs < DISCORD_PRESENCE_PROGRESS_MIN_MS) return;
    const p = discordPresencePayload();
    if (!p) return;
    discordPresenceLastSyncMs = now;
    void syncDiscordPresence(p, { immediate: true });
  },
  { flush: "post" }
);

watch(volume, (v) => {
  try {
    localStorage.setItem("playerVolume", String(v));
  } catch {
    /* ignore */
  }
});

watchEffect(() => {
  const a = audioRef.value;
  if (!a) return;
  const v = volume.value;
  if (isEqualizerActive()) {
    a.volume = 1;
    setEqualizerOutputGain(v);
  } else {
    a.volume = v;
  }
});

/**
 * Web Audio: эквалайзер. Разрываем граф только когда элемент audio снят с DOM
 * (иначе повторный createMediaElementSource недопустим / возможна тишина).
 */
watch(
  () => [audioRef.value, src.value],
  async () => {
    await nextTick();
    const a = audioRef.value;
    const s = src.value;
    if (!a) {
      destroyEqualizer();
      return;
    }
    if (!s) return;
    const handle = ensureEqualizer(a, [...eqBandsDb.value]);
    if (handle) {
      a.volume = 1;
      setEqualizerOutputGain(volume.value);
    }
    await resumeEqualizerContext();
  },
  { flush: "post" }
);

function onAudioPlay() {
  playing.value = true;
  void resumeEqualizerContext();
}

/**
 * Marks the stream as ready for UI (spinner off). Uses `canplay`, not only `playing`,
 * because autoplay may be blocked (mobile / WebView) or `playing` may be delayed
 * while the element already reached HAVE_FUTURE_DATA.
 */
function bumpStreamPhaseReady() {
  if (streamPhase.value !== "error" && streamPhase.value !== "idle") {
    streamPhase.value = "ready";
  }
  void resumeEqualizerContext();
}

function onAudioCanPlay() {
  const a = audioRef.value;
  void appDebugLog("player", `audio: canplay — currentTime=${a?.currentTime?.toFixed(2)} buffered%=${bufferedPercent.value} "${props.track?.fileName?.slice?.(0,60)}"`);
  updateBufferStats();
  bumpStreamPhaseReady();
}

function onAudioPlaying() {
  void appDebugLog("player", `audio: playing — currentTime=${audioRef.value?.currentTime?.toFixed(2)} "${props.track?.fileName?.slice?.(0,60)}"`);
  bumpStreamPhaseReady();
}

/**
 * Browsers often fire `waiting` / `stalled` while paused; do not show buffering or
 * the play button will call cancelLoad instead of resume.
 */
function onAudioWaiting() {
  const a = audioRef.value;
  if (a && !a.paused) {
    void appDebugLog("player", `audio: waiting (rebuffering) — currentTime=${a.currentTime?.toFixed(2)} buffered%=${bufferedPercent.value} "${props.track?.fileName?.slice?.(0,60)}"`);
    streamPhase.value = "buffering";
    startBufferingWatchdog();
  }
}

function onAudioStalled() {
  const a = audioRef.value;
  if (a && !a.paused) {
    void appDebugLog("player", `audio: stalled — currentTime=${a.currentTime?.toFixed(2)} buffered%=${bufferedPercent.value} src=${src.value?.slice?.(0,80)}`);
    streamPhase.value = "buffering";
    startBufferingWatchdog();
  }
}

function startBufferingWatchdog() {
  clearBufferingWatchdog();
  startStatsPolling();
  const watchdogStartTime = audioRef.value?.currentTime ?? 0;
  void appDebugLog("player", `audio: buffering watchdog started (${BUFFERING_WATCHDOG_MS}ms) — "${props.track?.fileName?.slice?.(0,60)}"`);
  bufferingWatchdogTimer = setTimeout(() => {
    bufferingWatchdogTimer = null;
    if (streamPhase.value !== "buffering") return;
    const currentTime = audioRef.value?.currentTime ?? 0;
    if (currentTime > watchdogStartTime) {
      // Audio made progress despite the stalled/waiting event — the browser fired
      // a spurious stall but playback continued normally. Restore ready state.
      void appDebugLog("player", `audio: buffering watchdog: playback advanced (${watchdogStartTime.toFixed(2)}s → ${currentTime.toFixed(2)}s) — restoring ready`);
      streamPhase.value = "ready";
      return;
    }
    void appDebugLog("player", `audio: buffering watchdog FIRED — stream stalled for ${BUFFERING_WATCHDOG_MS}ms currentTime=${currentTime.toFixed(2)} src=${src.value?.slice?.(0,80)}`);
    streamError.value = "Поток прерван: не удалось получить данные от раздачи";
    streamPhase.value = "error";
  }, BUFFERING_WATCHDOG_MS);
}

function clearBufferingWatchdog() {
  if (bufferingWatchdogTimer !== null) {
    clearTimeout(bufferingWatchdogTimer);
    bufferingWatchdogTimer = null;
  }
}

function startStatsPolling() {
  stopStatsPolling();
  async function poll() {
    if (streamPhase.value !== "buffering" && streamPhase.value !== "ready") return;
    const stats = await vozduxanStreamStats(src.value);
    if (streamPhase.value === "buffering" || streamPhase.value === "ready") {
      streamDownloadStats.value = stats;
      if (stats) {
        const h = statsHistory.value;
        h.push({ rate: stats.download_rate ?? 0, peers: stats.num_peers ?? 0 });
        if (h.length > 40) h.splice(0, h.length - 40);
      }
    }
    statsPollingTimer = setTimeout(poll, 1000);
  }
  statsPollingTimer = setTimeout(poll, 600);
}

function stopStatsPolling() {
  if (statsPollingTimer !== null) {
    clearTimeout(statsPollingTimer);
    statsPollingTimer = null;
  }
  streamDownloadStats.value = null;
  statsHistory.value = [];
}

let bufferPollRaf = 0;
function stopBufferPoll() {
  if (bufferPollRaf) {
    cancelAnimationFrame(bufferPollRaf);
    bufferPollRaf = 0;
  }
}
function bufferPollTick() {
  bufferPollRaf = 0;
  updateBufferStats();
  if (
    isLoading.value &&
    streamPhase.value !== "error" &&
    streamPhase.value !== "idle" &&
    audioRef.value
  ) {
    bufferPollRaf = requestAnimationFrame(bufferPollTick);
  }
}

/**
 * Starts background prefetch of the next queue item after enough playback time.
 *
 * Triggers when playback is stable (`ready`), position is past ~30s or ~22% of duration,
 * and the current→next pair has not been prefetched yet this track.
 */
async function maybeTriggerPrefetch() {
  if (!props.nextTrack || !props.track) return;
  // SoulSeek tracks don't use torrent prefetch
  if (props.track?.source === "soulseek" || props.nextTrack?.source === "soulseek") return;
  if (!playing.value) return;
  if (streamPhase.value !== "ready") return;
  if (isLoading.value) return;
  const d = duration.value;
  const c = current.value;
  if (!Number.isFinite(d) || d <= 0) return;
  const sameTorrent = props.track?.magnet === props.nextTrack?.magnet;
  const minSec   = sameTorrent ? PREFETCH_MIN_SEC_SAME_TORRENT   : PREFETCH_MIN_SEC;
  const minRatio = sameTorrent ? PREFETCH_MIN_RATIO_SAME_TORRENT : PREFETCH_MIN_RATIO;
  if (c < minSec && c / d < minRatio) return;

  // Don't start a new prefetch if there's already a ready URL for the next track.
  // Starting a new prefetch would call torrent_prefetch_next_track, which releases the old
  // prefetch_token — killing the URL before prepareTrack() has a chance to use it.
  if (prefetchedStream.value.url) return;

  const fp = prefetchFingerprint(props.track, props.nextTrack);
  if (!fp || fp === prefetchOkFingerprint.value) return;
  if (prefetchInFlight) return;

  prefetchInFlight = true;
  void appDebugLog("player", `prefetch next: start — "${props.nextTrack?.fileName?.slice?.(0,60)}" fileIdx=${props.nextTrack?.fileIdx} torrentId=${props.nextTrack?.torrentId||"—"}`);
  try {
    const result = await prefetchNextInQueue(props.track, props.nextTrack);
    if (result?.kind === "streamReady" && result.url) {
      prefetchedStream.value = {
        url: result.url,
        forKey: queueTrackKey(props.nextTrack),
      };
      void appDebugLog("player", `prefetch next: OK — stream ready url=${result.url} fileIdx=${props.nextTrack?.fileIdx}`);
    } else {
      void appDebugLog("player", `prefetch next: done but no URL — kind=${result?.kind} fileIdx=${props.nextTrack?.fileIdx}`);
    }
    // Mark done only on success so a transient error allows one retry.
    prefetchOkFingerprint.value = fp;
  } catch (e) {
    void appDebugLog("player", `prefetch next: ERROR — "${props.nextTrack?.fileName?.slice?.(0,60)}" fileIdx=${props.nextTrack?.fileIdx} err=${e?.message ?? String(e ?? "")}`);
  } finally {
    prefetchInFlight = false;
  }
}

/**
 * Silent speculative warm-up for the track after next (track+2).
 * Runs only after the current→next prefetch succeeds.
 * Discards the URL immediately — the benefit is having pieces pre-downloaded
 * so when the user reaches track+2 it starts with filled cache.
 */
async function maybeTriggerSecondPrefetch() {
  if (!props.secondNextTrack || !props.nextTrack) return;
  const fp = prefetchFingerprint(props.nextTrack, props.secondNextTrack);
  if (!fp || fp === secondPrefetchDoneFingerprint) return;
  if (secondPrefetchInFlight) return;
  // Only start after the first prefetch (next track) has completed
  if (!prefetchOkFingerprint.value) return;

  secondPrefetchInFlight = true;
  try {
    const result = await prefetchNextInQueue(props.nextTrack, props.secondNextTrack, {
      warmOnly: true,
    });
    // Release the URL immediately — we just want the torrent warmed in session
    if (result?.kind === "streamReady" && result.url) {
      void releaseTorrentStreamUrl(result.url);
    }
    secondPrefetchDoneFingerprint = fp;
    void appDebugLog("player", `prefetch warm (track+2): OK — "${props.secondNextTrack?.fileName?.slice?.(0,60)}" fileIdx=${props.secondNextTrack?.fileIdx}`);
  } catch (e) {
    void appDebugLog("player", `prefetch warm (track+2): ERROR — "${props.secondNextTrack?.fileName?.slice?.(0,60)}" err=${e?.message ?? String(e ?? "")}`);
  } finally {
    secondPrefetchInFlight = false;
  }
}

watch(
  () => [
    playing.value,
    current.value,
    duration.value,
    streamPhase.value,
    isLoading.value,
    props.nextTrack,
    props.track?.magnet,
    props.track?.fileIdx,
  ],
  () => {
    void maybeTriggerPrefetch();
  }
);

watch(
  () => [prefetchOkFingerprint.value, props.secondNextTrack, props.nextTrack],
  () => {
    void maybeTriggerSecondPrefetch();
  }
);

watch(
  () => [
    queueTrackKey(props.track),
    prepareAttempt.value,
    props.suppressAutoplay,
  ],
  async ([, , suppressed], _, onCleanup) => {
    const t = props.track;
    const magnet = t?.magnet;
    const fileIdx = t?.fileIdx;
    void appDebugLog("player", `stream-watch: fired — fileIdx=${fileIdx ?? "—"} hasMagnet=${!!magnet} suppressed=${suppressed} phase=${streamPhase.value} activeSig="${activeStreamPrepareSig.value?.slice(0,30)}"`);
    if (!t || !magnet) {
      activeStreamPrepareSig.value = "";
      stopBufferPoll();
      prepareProgress.value = null;
      playing.value = false;
      const prevUrl = src.value;
      src.value = "";
      await releaseTorrentStreamUrl(prevUrl);
      current.value = 0;
      duration.value = 0;
      bufferedPercent.value = 0;
      streamError.value = "";
      streamPhase.value = "idle";
      loadCancelledByUser.value = false;
      return;
    }

    if (suppressed) {
      activeStreamPrepareSig.value = "";
      stopBufferPoll();
      prepareProgress.value = null;
      playing.value = false;
      const prevUrl = src.value;
      src.value = "";
      await releaseTorrentStreamUrl(prevUrl);
      current.value = 0;
      duration.value = 0;
      bufferedPercent.value = 0;
      streamError.value = "";
      streamPhase.value = "idle";
      loadCancelledByUser.value = false;
      return;
    }

    const prepareSig = `${queueTrackKey(t)}\0${prepareAttempt.value}`;
    if (
      prepareSig === activeStreamPrepareSig.value &&
      streamPhase.value !== "idle" &&
      streamPhase.value !== "error"
    ) {
      void appDebugLog("player", `stream-watch: skipped (dup) — sig="${prepareSig.slice(0,30)}" phase=${streamPhase.value}`);
      return;
    }
    activeStreamPrepareSig.value = prepareSig;

    loadCancelledByUser.value = false;
    prepareProgress.value = null;
    playing.value = false;
    const prevUrl = src.value;
    src.value = "";
    current.value = 0;
    duration.value = 0;
    bufferedPercent.value = 0;
    streamError.value = "";
    streamPhase.value = "preparing";
    await releaseTorrentStreamUrl(prevUrl);

    let cancelled = false;
    onCleanup(() => { cancelled = true; });
    void appDebugLog("player", `stream prepare: start — "${t?.fileName?.slice?.(0,70)}" fileIdx=${fileIdx} torrentId=${t?.torrentId||"—"} attempt=${prepareAttempt.value} suppressAutoplay=${props.suppressAutoplay}`);
    try {
      const preparedKey = queueTrackKey(props.track);
      let nextSrc = "";
      if (prefetchedStream.value.url && prefetchedStream.value.forKey === preparedKey) {
        // Next-track prefetch hit (pre-fetched while playing the previous track)
        nextSrc = prefetchedStream.value.url;
        prefetchedStream.value = { url: "", forKey: "" };
        void appDebugLog("player", `stream prepare: prefetch HIT — using pre-warmed URL fileIdx=${fileIdx} url=${nextSrc}`);
      } else {
        const fileIdxNorm =
          fileIdx != null && fileIdx !== "" && Number.isFinite(Number(fileIdx))
            ? Number(fileIdx)
            : fileIdx;
        nextSrc = await streamUrl(magnet, fileIdxNorm, {
          source: props.track?.source,
          torrentId: props.track?.torrentId,
          slskUsername: props.track?.slskUsername,
          slskFilepath: props.track?.slskFilepath,
          slskFilesize: props.track?.slskFilesize,
        });
      }
      void appDebugLog("player", nextSrc
        ? `stream prepare: done — assigning src fileIdx=${fileIdx} url=${nextSrc} cancelled=${cancelled}`
        : `stream prepare: done with EMPTY URL — fileIdx=${fileIdx} cancelled=${cancelled} loadCancelledByUser=${loadCancelledByUser.value}`);
      if (!cancelled && !loadCancelledByUser.value) {
        src.value = nextSrc;
        streamPhase.value = nextSrc ? "buffering" : "error";
        if (nextSrc) {
          // WKWebView does not fire `stalled` when the HTTP server holds the connection open
          // but sends no data (vozduxan waiting for a piece). Start watchdog immediately so
          // we don't spin in infinite buffering if the piece never arrives.
          startBufferingWatchdog();
        } else {
          console.error("[player/stream] empty URL", { magnetLen: magnet?.length, fileIdx });
          streamError.value = "Пустой URL потока";
        }
      }
    } catch (e) {
      const msg = typeof e === "string" ? e : e?.message ?? String(e ?? "");
      const isUserCancel =
        loadCancelledByUser.value ||
        (typeof msg === "string" && msg.includes("отмен"));
      void appDebugLog("player", `stream prepare: ERROR — "${t?.fileName?.slice?.(0,60)}" fileIdx=${fileIdx} err=${msg} cancelled=${cancelled} isUserCancel=${isUserCancel}`);
      if (!cancelled && !isUserCancel) {
        console.error("[player/stream] torrent_prepare_stream failed", {
          magnetLen: magnet?.length,
          fileIdx,
          error: e,
          message: msg,
        });
      }
      if (!cancelled && !isUserCancel) {
        src.value = "";
        streamPhase.value = "error";
        prepareProgress.value = null;
        activeStreamPrepareSig.value = "";
        const detail =
          typeof e === "string"
            ? e
            : e?.message ?? (e != null ? String(e) : "");
        streamError.value = detail
          ? `Не удалось открыть поток: ${detail}`
          : "Не удалось открыть поток";
      }
    }
  },
  { immediate: true }
);

watch(
  isLoading,
  (loading) => {
    stopBufferPoll();
    if (loading) bufferPollRaf = requestAnimationFrame(bufferPollTick);
    else prepareProgress.value = null;
  },
  { immediate: true }
);

function onDocClick() {
  statusMenuOpen.value = false;
  queuePanelOpen.value = false;
}

const queueLen = computed(() => props.playbackQueue?.length ?? 0);

const playerTrackInfoRef = ref(null);
const titleMarqueeWrapRef = ref(null);
const artistMarqueeWrapRef = ref(null);
const titleScroll = ref(false);
const artistScroll = ref(false);
const titleMarqueeStyle = ref({});
const artistMarqueeStyle = ref({});

const marqueeResizeObserver =
  typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => {
        void nextTick(() => {
          measureTitleMarquee();
          measureArtistMarquee();
        });
      })
    : null;

/**
 * Enables horizontal marquee when the title is wider than the player strip.
 */
function measureTitleMarquee() {
  const wrap = titleMarqueeWrapRef.value;
  if (!wrap) return;
  const first = wrap.querySelector(".player-marquee-chunk");
  if (!first) return;
  const overflow = first.scrollWidth > wrap.clientWidth + 1;
  if (overflow !== titleScroll.value) {
    titleScroll.value = overflow;
    void nextTick(() => measureTitleMarquee());
    return;
  }
  if (overflow) {
    const w = first.scrollWidth;
    const sec = Math.max(8, Math.min(48, w / 28));
    titleMarqueeStyle.value = { "--marquee-duration": `${sec}s` };
  } else {
    titleMarqueeStyle.value = {};
  }
}

/**
 * Enables horizontal marquee when the artist line overflows.
 */
function measureArtistMarquee() {
  const wrap = artistMarqueeWrapRef.value;
  if (!wrap) return;
  const first = wrap.querySelector(".player-marquee-chunk");
  if (!first) return;
  const overflow = first.scrollWidth > wrap.clientWidth + 1;
  if (overflow !== artistScroll.value) {
    artistScroll.value = overflow;
    void nextTick(() => measureArtistMarquee());
    return;
  }
  if (overflow) {
    const w = first.scrollWidth;
    const sec = Math.max(8, Math.min(48, w / 28));
    artistMarqueeStyle.value = { "--marquee-duration": `${sec}s` };
  } else {
    artistMarqueeStyle.value = {};
  }
}

watch(
  () => [displayTitle.value, props.track?.fileName],
  () => {
    titleScroll.value = false;
    void nextTick(() => measureTitleMarquee());
  }
);

watch(currentArtist, () => {
  artistScroll.value = false;
  void nextTick(() => measureArtistMarquee());
});

watch(hasTrack, (v) => {
  if (v) void nextTick(() => {
    measureTitleMarquee();
    measureArtistMarquee();
  });
});

watchEffect((onCleanup) => {
  const el = playerTrackInfoRef.value;
  const ro = marqueeResizeObserver;
  if (el && ro) {
    ro.observe(el);
    onCleanup(() => {
      ro.unobserve(el);
    });
  }
});

const repeatCycleTitle = computed(() => {
  if (props.repeatMode === "all") return "Повтор: вся очередь";
  if (props.repeatMode === "one") return "Повтор: один трек";
  return "Повтор выключен";
});

/**
 * On natural end: repeat-one (or repeat-all with a single track) restarts the same
 * clip; otherwise App advances the queue.
 */
function onAudioEnded() {
  const qLen = props.playbackQueue?.length ?? 0;
  const loopSameTrack =
    props.repeatMode === "one" || (props.repeatMode === "all" && qLen === 1);
  if (loopSameTrack) {
    const a = audioRef.value;
    if (!a) return;
    a.currentTime = 0;
    void a.play().catch((err) => {
      logPlayRejected("repeatLoop", err);
    });
    return;
  }
  emit("ended");
}

onMounted(async () => {
  installMediaSessionHandlers();
  window.addEventListener("keydown", onKey);
  document.addEventListener("click", onDocClick);
  try {
    unlistenPrepareProgress = await listen("torrent-prepare-progress", (e) => {
      prepareProgress.value = e.payload;
      if (e.payload) lastPrepareProgress.value = e.payload;
    });
  } catch {
    unlistenPrepareProgress = () => {};
  }
});
onUnmounted(() => {
  marqueeResizeObserver?.disconnect();
  if (prefetchedStream.value.url) {
    void releaseTorrentStreamUrl(prefetchedStream.value.url);
    prefetchedStream.value = { url: "", forKey: "" };
  }
  stopBufferPoll();
  unlistenPrepareProgress();
  clearMediaSessionHandlers();
  clearMediaSessionPresentation();
  void clearDiscordPresence();
  destroyEqualizer();
  window.removeEventListener("keydown", onKey);
  document.removeEventListener("click", onDocClick);
});
</script>

<template>
  <div class="player">
    <template v-if="hasTrack">
      <!-- Left: track info -->
      <div class="player-left">
        <CoverThumb
          :torrent-id="track.torrentId"
          :source="track.source"
          :magnet="track.magnet"
          :cover-file-idx="track.coverFileIdx ?? null"
          :size="56"
          :radius="4"
          fallback="♪"
        />
        <div ref="playerTrackInfoRef" class="player-track-info">
          <button
            type="button"
            class="player-name player-name--link"
            :title="`Открыть альбом`"
            @click="onTrackClick"
          >
            <span ref="titleMarqueeWrapRef" class="player-marquee">
              <span
                class="player-marquee-track"
                :class="{ 'player-marquee-track--active': titleScroll }"
                :style="titleMarqueeStyle"
              >
                <span class="player-marquee-chunk">{{ displayTitle }}</span><span
                  v-if="titleScroll"
                  class="player-marquee-chunk"
                  aria-hidden="true"
                >{{ displayTitle }}</span>
              </span>
            </span>
          </button>
          <button
            v-if="currentArtist"
            type="button"
            class="player-artist player-artist--link"
            :title="`Найти: ${currentArtist}`"
            @click="onArtistClick"
          >
            <span ref="artistMarqueeWrapRef" class="player-marquee">
              <span
                class="player-marquee-track"
                :class="{ 'player-marquee-track--active': artistScroll }"
                :style="artistMarqueeStyle"
              >
                <span class="player-marquee-chunk">{{ currentArtist }}</span><span
                  v-if="artistScroll"
                  class="player-marquee-chunk"
                  aria-hidden="true"
                >{{ currentArtist }}</span>
              </span>
            </span>
          </button>
          <span v-else class="player-artist" />
        </div>
        <button
          type="button"
          :class="['player-like-btn', isCurrentTrackLiked ? 'player-like-btn--liked' : '']"
          :title="isCurrentTrackLiked ? 'Убрать из любимых' : 'В любимые'"
          :aria-label="isCurrentTrackLiked ? 'Убрать из любимых' : 'В любимые'"
          @click="toggleCurrentLike"
        >
          <svg v-if="isCurrentTrackLiked" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </button>
      </div>

      <!-- Center: controls + progress -->
      <div class="player-center">
        <div class="player-controls">
          <div
            v-if="streamPhase !== 'idle' && streamPhase !== 'error'"
            class="stream-status"
            @click.stop
          >
            <button
              type="button"
              class="stream-status-btn"
              :aria-expanded="statusMenuOpen"
              aria-label="Статус потока"
              @click="statusMenuOpen = !statusMenuOpen"
            >
              <span class="stream-status-dot-wrap" aria-hidden="true">
                <span :class="['prepare-dot', streamDotClass, isLoading ? 'prepare-dot--pulse' : '']" />
              </span>
            </button>

            <Transition name="status-menu">
              <div v-if="statusMenuOpen" class="stream-status-panel" role="dialog" aria-label="Статус стрима">
                <!-- Верхняя строка: фаза + скорость -->
                <div class="sp-top">
                  <span class="sp-phase-dot" :class="`sp-phase-dot--${streamPhase}`" />
                  <span class="sp-headline">{{ streamStatusHeadline }}</span>
                  <span v-if="currentPeers > 0" class="sp-peers-badge">
                    {{ currentPeers }} <span class="sp-peers-label">источн.</span>
                  </span>
                </div>

                <!-- Тело: краткое описание -->
                <div class="sp-body">{{ streamStatusBody }}</div>

                <!-- Sparkline: история скорости -->
                <div v-if="sparklineData.points" class="sp-chart">
                  <svg viewBox="0 0 180 36" preserveAspectRatio="none" class="sp-svg">
                    <!-- Заливка под линией -->
                    <defs>
                      <linearGradient id="sp-grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35"/>
                        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
                      </linearGradient>
                    </defs>
                    <polygon
                      :points="`0,36 ${sparklineData.points} 180,36`"
                      fill="url(#sp-grad)"
                    />
                    <polyline
                      :points="sparklineData.points"
                      fill="none"
                      stroke="var(--accent)"
                      stroke-width="1.5"
                      stroke-linejoin="round"
                      stroke-linecap="round"
                    />
                  </svg>
                  <div class="sp-chart-peak">{{ fmtRate(sparklineData.max) }}</div>
                </div>

                <!-- Пиры: анимированные точки -->
                <div v-if="currentPeers > 0 || isLoading" class="sp-peer-row">
                  <span
                    v-for="i in Math.min(currentPeers, 12)"
                    :key="i"
                    class="sp-peer-dot"
                    :style="{ animationDelay: `${((i * 137) % 1000) / 1000}s` }"
                  />
                  <span v-if="currentPeers > 12" class="sp-peers-more">+{{ currentPeers - 12 }}</span>
                  <span v-else-if="currentPeers === 0 && isLoading" class="sp-searching-dots">
                    <span /><span /><span />
                  </span>
                </div>
              </div>
            </Transition>
          </div>

          <button
            type="button"
            class="ctrl-btn ctrl-btn-shuffle"
            :class="{ 'ctrl-btn--shuffle-on': shuffleOn }"
            :disabled="queueLen < 2"
            :title="shuffleOn ? 'Случайный порядок: вкл' : 'Случайный порядок: выкл'"
            :aria-label="shuffleOn ? 'Выключить перемешивание' : 'Включить перемешивание'"
            @click="emit('toggle-shuffle')"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l9 9"/>
            </svg>
          </button>

          <button
            class="ctrl-btn"
            :disabled="!hasPrev"
            @click="emit('prev')"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <polygon points="19,5 9,12 19,19"/>
              <rect x="5" y="5" width="3" height="14" rx="1.5"/>
            </svg>
          </button>

          <button
            class="ctrl-btn ctrl-btn-play"
            type="button"
            @click="onPlayButtonClick"
          >
            <template v-if="isLoading || playing">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="4.5" y="4" width="5" height="16" rx="1.5"/>
                <rect x="14.5" y="4" width="5" height="16" rx="1.5"/>
              </svg>
            </template>
            <template v-else>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <polygon points="7.5,3 21,12 7.5,21"/>
              </svg>
            </template>
          </button>

          <button
            class="ctrl-btn"
            :disabled="!hasNext"
            @click="emit('next')"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <polygon points="5,5 15,12 5,19"/>
              <rect x="16" y="5" width="3" height="14" rx="1.5"/>
            </svg>
          </button>

          <button
            type="button"
            class="ctrl-btn ctrl-btn-repeat"
            :class="{
              'ctrl-btn--repeat-all': repeatMode === 'all',
              'ctrl-btn--repeat-one': repeatMode === 'one',
            }"
            :title="repeatCycleTitle"
            :aria-label="repeatCycleTitle"
            @click="emit('cycle-repeat')"
          >
            <span class="ctrl-repeat-wrap" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="17 1 21 5 17 9"/>
                <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                <polyline points="7 23 3 19 7 15"/>
                <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
              </svg>
              <span v-if="repeatMode === 'one'" class="ctrl-repeat-one-mark">1</span>
            </span>
          </button>
        </div>

        <div class="player-progress">
          <span class="progress-time">{{ fmtTime(current) }}</span>
          <div :class="['progress-track', isLoading ? 'progress-track-loading' : '']" @click="seek">
            <div
              v-if="streamPhase !== 'error'"
              :class="[
                'progress-buffer',
                isLoading && duration <= 0 ? 'progress-buffer-indeterminate' : '',
              ]"
              :style="
                isLoading && duration <= 0
                  ? {}
                  : { width: `${loadingProgress}%` }
              "
            />
            <div class="progress-fill" :style="{ width: `${progress * 100}%` }" />
          </div>
          <span class="progress-time">{{ fmtTime(duration) }}</span>
        </div>
        <div v-if="streamPhase === 'error' && streamError" class="stream-inline-error">{{ streamError }}</div>
      </div>

      <!-- Right: queue + volume -->
      <div class="player-right">
        <div v-if="queueLen > 0" class="player-queue-wrap" @click.stop>
          <button
            type="button"
            class="player-queue-btn"
            :class="{ 'player-queue-btn--open': queuePanelOpen }"
            :aria-expanded="queuePanelOpen"
            aria-label="Очередь воспроизведения"
            :title="'Очередь: ' + queueLen + ' ' + (queueLen === 1 ? 'трек' : queueLen < 5 ? 'трека' : 'треков')"
            @click="queuePanelOpen = !queuePanelOpen"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
            <span class="player-queue-badge">{{ queueLen }}</span>
          </button>
          <Transition name="queue-panel">
            <div
              v-if="queuePanelOpen"
              class="player-queue-panel"
              role="dialog"
              aria-label="Очередь"
            >
              <div class="player-queue-head">Очередь</div>
              <ul class="player-queue-list">
                <li
                  v-for="(q, idx) in playbackQueue"
                  :key="idx + '-' + q.magnet + '-' + q.fileIdx"
                  :class="['player-queue-item', idx === queueIndex ? 'player-queue-item--current' : '']"
                >
                  <button
                    type="button"
                    class="player-queue-item-main"
                    @click="emit('queue-jump', idx); queuePanelOpen = false"
                  >
                    <span class="player-queue-item-title">{{ trackDisplayBasename(q.fileName) }}</span>
                    <span class="player-queue-item-sub">{{ q.artist || q.torrentName || '' }}</span>
                  </button>
                  <button
                    type="button"
                    class="player-queue-item-remove"
                    aria-label="Убрать из очереди"
                    title="Убрать"
                    @click="emit('queue-remove', idx)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </li>
              </ul>
            </div>
          </Transition>
        </div>
        <div class="player-volume" @wheel.prevent="onVolumeWheel">
          <button
            type="button"
            class="volume-icon-btn"
            @click="toggleMute"
          >
            <span class="volume-icon" aria-hidden="true">
              <svg v-if="volume > 0" width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
              <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="16" y1="9" x2="23" y2="16" />
                <line x1="23" y1="9" x2="16" y2="16" />
              </svg>
            </span>
          </button>
          <input
            type="range"
            class="volume-slider"
            min="0"
            max="100"
            step="1"
            :value="Math.round(volume * 100)"
            :style="{ '--vol': Math.round(volume * 100) + '%' }"
            @input="volume = Number($event.target.value) / 100"
          />
        </div>
      </div>

      <audio
        v-if="src"
        ref="audioRef"
        class="player-audio"
        crossorigin="anonymous"
        :src="src"
        :autoplay="Boolean(src) && !props.suppressAutoplay"
        @loadstart="streamPhase = 'buffering'"
        @play="onAudioPlay"
        @playing="onAudioPlaying"
        @pause="playing = false"
        @progress="updateBufferStats"
        @canplay="onAudioCanPlay"
        @loadedmetadata="duration = audioRef?.duration ?? 0; updateBufferStats()"
        @durationchange="duration = audioRef?.duration ?? 0; updateBufferStats()"
        @waiting="onAudioWaiting"
        @stalled="onAudioStalled"
        @error="onAudioError"
        @timeupdate="current = audioRef?.currentTime ?? 0"
        @ended="onAudioEnded"
      />
    </template>

    <template v-else>
      <div class="player-left">
        <div class="player-art player-art--idle" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.5" aria-hidden="true">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="16" r="3"/>
          </svg>
        </div>
        <div class="player-track-info">
          <span class="player-name">Ничего не играет</span>
          <span class="player-artist">Выберите трек в раздаче</span>
        </div>
      </div>
      <div class="player-center">
        <div class="player-controls">
          <button
            type="button"
            class="ctrl-btn ctrl-btn-shuffle"
            :class="{ 'ctrl-btn--shuffle-on': shuffleOn }"
            :disabled="queueLen < 2"
            :title="shuffleOn ? 'Случайный порядок: вкл' : 'Случайный порядок: выкл'"
            :aria-label="shuffleOn ? 'Выключить перемешивание' : 'Включить перемешивание'"
            @click="emit('toggle-shuffle')"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l9 9"/>
            </svg>
          </button>
          <button class="ctrl-btn" disabled>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <polygon points="19,5 9,12 19,19"/>
              <rect x="5" y="5" width="3" height="14" rx="1.5"/>
            </svg>
          </button>
          <button class="ctrl-btn ctrl-btn-play" disabled>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <polygon points="7.5,3 21,12 7.5,21"/>
            </svg>
          </button>
          <button class="ctrl-btn" disabled>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <polygon points="5,5 15,12 5,19"/>
              <rect x="16" y="5" width="3" height="14" rx="1.5"/>
            </svg>
          </button>
          <button
            type="button"
            class="ctrl-btn ctrl-btn-repeat"
            :class="{
              'ctrl-btn--repeat-all': repeatMode === 'all',
              'ctrl-btn--repeat-one': repeatMode === 'one',
            }"
            :title="repeatCycleTitle"
            :aria-label="repeatCycleTitle"
            @click="emit('cycle-repeat')"
          >
            <span class="ctrl-repeat-wrap" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="17 1 21 5 17 9"/>
                <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                <polyline points="7 23 3 19 7 15"/>
                <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
              </svg>
              <span v-if="repeatMode === 'one'" class="ctrl-repeat-one-mark">1</span>
            </span>
          </button>
        </div>
        <div class="player-progress">
          <span class="progress-time">0:00</span>
          <div class="progress-track progress-track--idle" />
          <span class="progress-time">0:00</span>
        </div>
      </div>
      <div class="player-right">
        <div v-if="queueLen > 0" class="player-queue-wrap" @click.stop>
          <button
            type="button"
            class="player-queue-btn"
            :class="{ 'player-queue-btn--open': queuePanelOpen }"
            :aria-expanded="queuePanelOpen"
            aria-label="Очередь воспроизведения"
            :title="'Очередь: ' + queueLen + ' ' + (queueLen === 1 ? 'трек' : queueLen < 5 ? 'трека' : 'треков')"
            @click="queuePanelOpen = !queuePanelOpen"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
            <span class="player-queue-badge">{{ queueLen }}</span>
          </button>
          <Transition name="queue-panel">
            <div
              v-if="queuePanelOpen"
              class="player-queue-panel"
              role="dialog"
              aria-label="Очередь"
            >
              <div class="player-queue-head">Очередь</div>
              <ul class="player-queue-list">
                <li
                  v-for="(q, idx) in playbackQueue"
                  :key="idx + '-' + q.magnet + '-' + q.fileIdx"
                  :class="['player-queue-item', idx === queueIndex ? 'player-queue-item--current' : '']"
                >
                  <button
                    type="button"
                    class="player-queue-item-main"
                    @click="emit('queue-jump', idx); queuePanelOpen = false"
                  >
                    <span class="player-queue-item-title">{{ trackDisplayBasename(q.fileName) }}</span>
                    <span class="player-queue-item-sub">{{ q.artist || q.torrentName || '' }}</span>
                  </button>
                  <button
                    type="button"
                    class="player-queue-item-remove"
                    aria-label="Убрать из очереди"
                    title="Убрать"
                    @click="emit('queue-remove', idx)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </li>
              </ul>
            </div>
          </Transition>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Без controls у <audio> часто остаётся большая интрисическая ширина (~300px) и второй ряд в grid —
   невидимый прямоугольник перекрывает центр плеера и съедает клики по ⏮ / перемотке. */
.player {
  position: relative;
}
.player-audio {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 0;
  height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  opacity: 0;
  pointer-events: none;
}

.progress-track {
  position: relative;
  overflow: hidden;
}
.progress-track-loading::after {
  content: "";
  position: absolute;
  top: 0;
  left: -35%;
  width: 35%;
  height: 100%;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.42) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  animation: stream-shimmer 1.05s ease-in-out infinite;
  pointer-events: none;
}
.progress-buffer {
  position: absolute;
  inset: 0 auto 0 0;
  height: 100%;
  width: 0%;
  background: rgba(255, 255, 255, 0.28);
  /* transition на width даёт ощущение «подвисания» — буфер обновляется рывками */
  will-change: width;
}
.progress-buffer-indeterminate {
  width: 100%;
  opacity: 0.38;
  animation: buffer-breathe 1.1s ease-in-out infinite;
}
.stream-inline-error {
  margin-top: 4px;
  margin-bottom: 14px;
  font-size: 12px;
  line-height: 1.35;
  color: #ff7d7d;
  text-align: center;
  max-width: 100%;
  overflow-wrap: anywhere;
}
@keyframes stream-shimmer {
  0%   { left: -35%; opacity: 0.35; }
  35%  { opacity: 0.85; }
  100% { left: 110%; opacity: 0.2; }
}
@keyframes buffer-breathe {
  0%,
  100% {
    opacity: 0.28;
  }
  50% {
    opacity: 0.48;
  }
}
.volume-icon-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  margin: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  line-height: 0;
  transition: background 0.12s, color 0.12s;
}
.volume-icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}
.volume-icon-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.player-art--idle {
  flex-shrink: 0;
}
.progress-track--idle {
  cursor: default;
  opacity: 0.45;
  pointer-events: none;
}
.progress-track--idle:hover {
  height: 4px;
}

/* ── Индикатор + pop-up статуса стрима ─────────────────────────────── */
.player-controls {
  flex-wrap: wrap;
  justify-content: center;
  position: relative;
  gap: 14px;
}

.ctrl-btn--shuffle-on,
.ctrl-btn--repeat-all,
.ctrl-btn--repeat-one {
  color: var(--accent);
}

/*
 * Global `style.css` uses `.ctrl-btn:hover { color: var(--text) }`, which beats the
 * accent color above — toggles looked unchanged until pointer leave. Override hover
 * and add a clear :active press state for transport controls.
 */
.player .player-controls .ctrl-btn.ctrl-btn--shuffle-on:hover:not(:disabled),
.player .player-controls .ctrl-btn.ctrl-btn--repeat-all:hover:not(:disabled),
.player .player-controls .ctrl-btn.ctrl-btn--repeat-one:hover:not(:disabled) {
  color: var(--accent-h);
  transform: scale(1.1);
}

.player .player-controls .ctrl-btn:not(.ctrl-btn-play):active:not(:disabled) {
  transform: scale(0.88);
  transition: transform 0.06s ease, color 0.06s ease, background 0.06s ease;
}

.player .player-controls .ctrl-btn.ctrl-btn--shuffle-on:active:not(:disabled),
.player .player-controls .ctrl-btn.ctrl-btn--repeat-all:active:not(:disabled),
.player .player-controls .ctrl-btn.ctrl-btn--repeat-one:active:not(:disabled) {
  color: var(--accent);
}

.player .player-controls .ctrl-btn:not(.ctrl-btn-play):not(.ctrl-btn--shuffle-on):not(
    .ctrl-btn--repeat-all
  ):not(.ctrl-btn--repeat-one):active:not(:disabled) {
  color: var(--accent);
}

.player .player-controls .ctrl-btn.ctrl-btn-play:active:not(:disabled) {
  transform: scale(0.96) !important;
  background: var(--accent-h);
  filter: brightness(0.95);
}

.ctrl-repeat-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.ctrl-repeat-one-mark {
  position: absolute;
  right: -3px;
  bottom: -2px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}

.stream-status {
  position: absolute;
  left: -82px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
}

.stream-status-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  line-height: 0;
  transition: background 0.15s;
}
.stream-status-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.stream-status-dot-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
}

/* ── Точка состояния ─────────────────── */
.prepare-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
  transition: background 0.3s;
}
.prepare-dot--info { background: linear-gradient(145deg, #6ab0ff, #3d7ccc); }
.prepare-dot--ok   { background: linear-gradient(145deg, #5fd68a, #2fa85c); }
.prepare-dot--warn { background: linear-gradient(145deg, #f0c860, #d4a017); }
.prepare-dot--bad  { background: linear-gradient(145deg, #ff7d7d, #c42e2e); }

@keyframes dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.55; transform: scale(0.78); }
}
.prepare-dot--pulse {
  animation: dot-pulse 1.4s ease-in-out infinite;
}

/* ══════════════════════════════════════════
   Stream status pop-up — redesigned
   ══════════════════════════════════════════ */
.stream-status-panel {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  transform: translateX(-50%);
  z-index: 80;
  width: 220px;
  padding: 11px 13px 12px;
  border-radius: 12px;
  background: rgba(18, 16, 14, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.55), 0 0 0 0.5px rgba(255,255,255,0.04);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  text-align: left;
  pointer-events: auto;
}

/* Top row: dot + headline + peers badge */
.sp-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.sp-phase-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255,255,255,0.3);
}
.sp-phase-dot--buffering,
.sp-phase-dot--preparing {
  background: var(--accent);
  animation: sp-dot-pulse 1.6s ease-in-out infinite;
}
.sp-phase-dot--ready { background: var(--accent); animation: none; }
@keyframes sp-dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.4; transform: scale(0.7); }
}

.sp-headline {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: #f0ece8;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-peers-badge {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--accent);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.sp-peers-label { color: rgba(255,255,255,0.4); }

/* Body text */
.sp-body {
  font-size: 11.5px;
  color: rgba(240, 236, 232, 0.5);
  line-height: 1.35;
  margin-bottom: 9px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Sparkline chart */
.sp-chart {
  position: relative;
  margin-bottom: 10px;
}
.sp-svg {
  display: block;
  width: 100%;
  height: 36px;
  overflow: visible;
}
.sp-chart-peak {
  position: absolute;
  top: 0;
  right: 0;
  font-size: 9px;
  color: rgba(255,255,255,0.25);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

/* Peer dots row */
.sp-peer-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 10px;
}
.sp-peer-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.75;
  animation: sp-peer-blink 2.4s ease-in-out infinite;
}
@keyframes sp-peer-blink {
  0%, 100% { opacity: 0.7; transform: scale(1); }
  50%       { opacity: 0.25; transform: scale(0.6); }
}
.sp-peers-more {
  font-size: 10px;
  color: rgba(255,255,255,0.35);
}

/* Searching animation (no peers yet) */
.sp-searching-dots {
  display: flex;
  align-items: center;
  gap: 4px;
}
.sp-searching-dots span {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(255,255,255,0.25);
  animation: sp-search 1.2s ease-in-out infinite;
}
.sp-searching-dots span:nth-child(2) { animation-delay: 0.2s; }
.sp-searching-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes sp-search {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.3; }
  40%            { transform: scale(1); opacity: 0.8; }
}

/* ── Анимация появления pop-up ─────────── */
.status-menu-enter-active { transition: opacity 0.14s ease, transform 0.14s ease; }
.status-menu-leave-active { transition: opacity 0.1s ease, transform 0.1s ease; }
.status-menu-enter-from  { opacity: 0; transform: translateX(-50%) translateY(5px); }
.status-menu-leave-to    { opacity: 0; transform: translateX(-50%) translateY(5px); }

/* ── Light theme overrides ─────────────── */
[data-theme="light"] .stream-status-panel {
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(0, 0, 0, 0.1);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.15), 0 0 0 0.5px rgba(0,0,0,0.05);
}
[data-theme="light"] .sp-headline {
  color: #1a1814;
}
[data-theme="light"] .sp-peers-label {
  color: rgba(0, 0, 0, 0.4);
}
[data-theme="light"] .sp-body {
  color: rgba(30, 25, 20, 0.5);
}
[data-theme="light"] .sp-phase-dot {
  background: rgba(0, 0, 0, 0.25);
}
[data-theme="light"] .sp-chart-peak {
  color: rgba(0, 0, 0, 0.3);
}
[data-theme="light"] .sp-peers-more {
  color: rgba(0, 0, 0, 0.35);
}
[data-theme="light"] .sp-searching-dots span {
  background: rgba(0, 0, 0, 0.25);
}

.player-like-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s, transform 0.12s;
  line-height: 0;
}
.player-like-btn:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.08);
}
.player-like-btn:active {
  transform: scale(0.88);
}
.player-like-btn--liked {
  color: var(--accent);
}
.player-like-btn--liked:hover {
  color: var(--accent);
  background: rgba(255, 255, 255, 0.08);
}
.player-like-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.player-marquee {
  display: block;
  overflow: hidden;
  min-width: 0;
  width: 100%;
  max-width: 100%;
}

.player-marquee-track {
  display: inline-flex;
  width: max-content;
  max-width: none;
  white-space: nowrap;
}

.player-marquee-chunk {
  flex-shrink: 0;
  white-space: nowrap;
}

.player-marquee-track--active {
  animation: player-marquee-scroll var(--marquee-duration, 14s) linear infinite;
}

.player-marquee:hover .player-marquee-track--active {
  animation-play-state: paused;
}

@keyframes player-marquee-scroll {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .player-marquee-track--active {
    animation: none !important;
  }
  .player-marquee-chunk {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .player-marquee-track {
    max-width: 100%;
  }
}

.player-name--link {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  white-space: normal;
  overflow: hidden;
  display: block;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  transition: color 0.12s;
}
.player-name--link:hover {
  color: var(--text);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.player-name--link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 2px;
}
.player-artist--link {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  font-size: 11px;
  color: var(--muted);
  white-space: normal;
  overflow: hidden;
  display: block;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  transition: color 0.12s;
}
.player-artist--link:hover {
  color: var(--text);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.player-artist--link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 2px;
}

/* ── Очередь воспроизведения ───────────────────────────────────────── */
.player-queue-wrap {
  position: relative;
  flex-shrink: 0;
}
.player-queue-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.player-queue-btn:hover {
  background: var(--player-queue-btn-hover-bg, rgba(255, 255, 255, 0.08));
  color: var(--text);
}
.player-queue-btn--open {
  color: var(--accent);
  background: rgba(var(--accent-rgb), 0.12);
}
.player-queue-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent);
  color: #141210;
  font-size: 10px;
  font-weight: 800;
  line-height: 16px;
  text-align: center;
}
.player-queue-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  width: min(360px, calc(100vw - 24px));
  max-height: min(48vh, 320px);
  display: flex;
  flex-direction: column;
  z-index: 90;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--player-queue-shadow, 0 -8px 32px rgba(0, 0, 0, 0.45));
  overflow: hidden;
}
.player-queue-head {
  flex-shrink: 0;
  padding: 10px 14px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted2);
  border-bottom: 1px solid var(--border);
}
.player-queue-list {
  margin: 0;
  padding: 6px;
  list-style: none;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.player-queue-item {
  display: flex;
  align-items: stretch;
  gap: 4px;
  border-radius: 8px;
  margin-bottom: 2px;
}
.player-queue-item:last-child {
  margin-bottom: 0;
}
.player-queue-item--current {
  background: rgba(var(--accent-rgb), 0.12);
  outline: 1px solid rgba(var(--accent-rgb), 0.35);
}
.player-queue-item-main {
  flex: 1;
  min-width: 0;
  text-align: left;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background 0.1s;
}
.player-queue-item-main:hover {
  background: var(--surface-h);
}
.player-queue-item-title {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.player-queue-item-sub {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.player-queue-item-remove {
  flex-shrink: 0;
  width: 36px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.1s, color 0.1s;
}
.player-queue-item-remove:hover {
  background: rgba(233, 53, 68, 0.14);
  color: var(--red);
}
.queue-panel-enter-active,
.queue-panel-leave-active {
  transition: opacity 0.14s ease, transform 0.14s ease;
}
.queue-panel-enter-from,
.queue-panel-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
