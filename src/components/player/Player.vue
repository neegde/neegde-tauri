<script setup>
import { ref, computed, watch, watchEffect, onMounted, onUnmounted, nextTick } from "vue";
import { listen } from "@tauri-apps/api/event";
import CoverThumb from "../shared/CoverThumb.vue";
import { prefetchNextInQueue, streamUrl } from "../../torrent/api.js";
import { trackDisplayBasename } from "../../lib/utils.js";
import {
  releaseTorrentStreamUrl,
  torrentPrepareCancel,
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
  /** Hover-prefetch URL + ключ, переданные из App.vue (пользователь навёл на трек). */
  hoverPrefetchUrl: { type: String, default: "" },
  hoverPrefetchKey: { type: String, default: "" },
});

const emit = defineEmits(["prev", "next", "ended", "playing-change", "request-stream", "hover-prefetch-consumed"]);

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
const playing = ref(false);
const current = ref(0);
const duration = ref(0);
const src = ref("");
const streamPhase = ref("idle"); // idle | preparing | buffering | ready | error
const streamError = ref("");
const bufferedPercent = ref(0);
/** Отмена загрузки без смены трека — не применять URL после await. */
const loadCancelledByUser = ref(false);
/** Счётчик повторной попытки открыть поток (тот же трек после отмены / ошибки). */
const prepareAttempt = ref(0);

/** Последняя статистика BitTorrent с бэкенда (событие torrent-prepare-progress). */
const prepareProgress = ref(null);
let unlistenPrepareProgress = () => {};

/** URL из `torrent_prefetch_next_track` (другой торрент), пока не переключились на этот трек. */
const prefetchedStream = ref({ url: "", forKey: "" });
/** Успешный prefetch для пары текущий→следующий (не повторять до смены трека). */
const prefetchOkFingerprint = ref("");
let prefetchInFlight = false;
/** Спекулятивный «тихий» прогрев track+2 (не нужен URL — важна только загрузка кусков). */
let secondPrefetchInFlight = false;
let secondPrefetchDoneFingerprint = "";

const PREFETCH_MIN_SEC = 10;
const PREFETCH_MIN_RATIO = 0.12;

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
  if (!t?.magnet || t.fileIdx == null) return "";
  return `${t.magnet}\0${t.fileIdx}`;
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

watch(
  () => [props.track?.magnet, props.track?.fileIdx],
  () => {
    prepareAttempt.value = 0;
    prefetchOkFingerprint.value = "";
    secondPrefetchDoneFingerprint = "";
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

function cancelLoad() {
  void appDebugLog("player", "cancelLoad", { source: "user" });
  loadCancelledByUser.value = true;
  void torrentPrepareCancel();
  void releaseTorrentStreamUrl(src.value);
  stopBufferPoll();
  src.value = "";
  current.value = 0;
  duration.value = 0;
  bufferedPercent.value = 0;
  streamError.value = "";
  streamPhase.value = "idle";
  playing.value = false;
}

function onPlayButtonClick() {
  if (isLoading.value) {
    cancelLoad();
    return;
  }
  togglePlay();
}

function togglePlay() {
  if (!hasTrack.value) return;
  if (props.suppressAutoplay && !src.value) {
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
    if (isLoading.value) cancelLoad();
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
}

watch(playing, (v) => {
  emit("playing-change", v);
  syncMediaSessionPlaybackState(v);
  if (v) reaffirmTrackSkipHandlers();
}, { immediate: true });

watch(streamPhase, (phase, prev) => {
  void appDebugLog("player", "streamPhase", {
    phase,
    from: prev,
    fileIdx: props.track?.fileIdx,
  });
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
    if (!t?.magnet) {
      clearMediaSessionPresentation();
      return;
    }
    void syncMediaSessionMetadata(t);
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

function onAudioPlaying() {
  streamPhase.value = "ready";
  void resumeEqualizerContext();
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
  if (!playing.value) return;
  if (streamPhase.value !== "ready") return;
  if (isLoading.value) return;
  const d = duration.value;
  const c = current.value;
  if (!Number.isFinite(d) || d <= 0) return;
  if (c < PREFETCH_MIN_SEC && c / d < PREFETCH_MIN_RATIO) return;

  const fp = prefetchFingerprint(props.track, props.nextTrack);
  if (!fp || fp === prefetchOkFingerprint.value) return;
  if (prefetchInFlight) return;

  prefetchInFlight = true;
  void appDebugLog("player", "prefetch next start", { fpPreview: fp.slice(0, 96) });
  try {
    const result = await prefetchNextInQueue(props.track, props.nextTrack);
    if (result?.kind === "streamReady" && result.url) {
      prefetchedStream.value = {
        url: result.url,
        forKey: queueTrackKey(props.nextTrack),
      };
    }
    // Mark done only on success so a transient error allows one retry.
    prefetchOkFingerprint.value = fp;
  } catch (e) {
    void appDebugLog("player", "prefetch next error", {
      message: e?.message ?? String(e ?? ""),
    });
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
    const result = await prefetchNextInQueue(props.nextTrack, props.secondNextTrack);
    // Release the URL immediately — we just want the torrent warmed in session
    if (result?.kind === "streamReady" && result.url) {
      void releaseTorrentStreamUrl(result.url);
    }
    secondPrefetchDoneFingerprint = fp;
    void appDebugLog("player", "second prefetch (track+2) done", { fpPreview: fp.slice(0, 64) });
  } catch {
    // Silently ignore
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
    props.track?.magnet,
    props.track?.fileIdx,
    prepareAttempt.value,
    props.suppressAutoplay,
  ],
  async ([magnet, fileIdx, , suppressed], _, onCleanup) => {
    if (!props.track || !magnet) {
      stopBufferPoll();
      prepareProgress.value = null;
      playing.value = false;
      void releaseTorrentStreamUrl(src.value);
      src.value = "";
      current.value = 0;
      duration.value = 0;
      bufferedPercent.value = 0;
      streamError.value = "";
      streamPhase.value = "idle";
      loadCancelledByUser.value = false;
      return;
    }

    if (suppressed) {
      stopBufferPoll();
      prepareProgress.value = null;
      playing.value = false;
      void releaseTorrentStreamUrl(src.value);
      src.value = "";
      current.value = 0;
      duration.value = 0;
      bufferedPercent.value = 0;
      streamError.value = "";
      streamPhase.value = "idle";
      loadCancelledByUser.value = false;
      return;
    }

    loadCancelledByUser.value = false;
    prepareProgress.value = null;
    playing.value = false;
    void releaseTorrentStreamUrl(src.value);
    src.value = "";
    current.value = 0;
    duration.value = 0;
    bufferedPercent.value = 0;
    streamError.value = "";
    streamPhase.value = "preparing";

    let cancelled = false;
    onCleanup(() => { cancelled = true; });
    void appDebugLog("player", "stream prepare started", {
      fileIdx,
      magnetLen: typeof magnet === "string" ? magnet.length : 0,
      suppressAutoplay: props.suppressAutoplay,
    });
    try {
      const preparedKey = queueTrackKey(props.track);
      let nextSrc = "";
      if (prefetchedStream.value.url && prefetchedStream.value.forKey === preparedKey) {
        // Next-track prefetch hit (pre-fetched while playing the previous track)
        nextSrc = prefetchedStream.value.url;
        prefetchedStream.value = { url: "", forKey: "" };
        void appDebugLog("player", "stream prepare used prefetched URL", { fileIdx });
      } else if (props.hoverPrefetchUrl && props.hoverPrefetchKey === preparedKey) {
        // Hover-prefetch hit (user hovered this track before clicking)
        nextSrc = props.hoverPrefetchUrl;
        emit("hover-prefetch-consumed");
        void appDebugLog("player", "stream prepare used hover-prefetch URL", { fileIdx });
      } else {
        nextSrc = await streamUrl(magnet, fileIdx, {
          source: props.track?.source,
          torrentId: props.track?.torrentId,
        });
      }
      void appDebugLog("player", "stream prepare await done", {
        fileIdx,
        hasUrl: Boolean(nextSrc),
        urlPreview: nextSrc ? nextSrc.slice(0, 120) : "",
        cancelled,
        loadCancelledByUser: loadCancelledByUser.value,
      });
      if (!cancelled && !loadCancelledByUser.value) {
        src.value = nextSrc;
        streamPhase.value = nextSrc ? "buffering" : "error";
        if (!nextSrc) {
          console.error("[player/stream] empty URL", { magnetLen: magnet?.length, fileIdx });
          streamError.value = "Пустой URL потока";
        }
      }
    } catch (e) {
      const msg = typeof e === "string" ? e : e?.message ?? String(e ?? "");
      const isUserCancel =
        loadCancelledByUser.value ||
        (typeof msg === "string" && msg.includes("отмен"));
      void appDebugLog("player", "stream prepare error", {
        fileIdx,
        message: msg,
        cancelled,
        loadCancelledByUser: loadCancelledByUser.value,
        isUserCancel,
      });
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

onMounted(async () => {
  installMediaSessionHandlers();
  window.addEventListener("keydown", onKey);
  try {
    unlistenPrepareProgress = await listen("torrent-prepare-progress", (e) => {
      prepareProgress.value = e.payload;
    });
  } catch {
    unlistenPrepareProgress = () => {};
  }
});
onUnmounted(() => {
  if (prefetchedStream.value.url) {
    void releaseTorrentStreamUrl(prefetchedStream.value.url);
    prefetchedStream.value = { url: "", forKey: "" };
  }
  stopBufferPoll();
  unlistenPrepareProgress();
  clearMediaSessionHandlers();
  clearMediaSessionPresentation();
  destroyEqualizer();
  window.removeEventListener("keydown", onKey);
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
        <div class="player-track-info">
          <span class="player-name">{{ trackDisplayBasename(track.fileName) }}</span>
          <span class="player-artist">{{ track.torrentName }}</span>
        </div>
      </div>

      <!-- Center: controls + progress -->
      <div class="player-center">
        <div class="player-controls">
          <div v-if="isLoading" class="prepare-hint">
            <button
              type="button"
              class="prepare-hint-trigger"
              aria-label="Статус загрузки BitTorrent"
            >
              <span class="prepare-hint-dot-wrap" aria-hidden="true">
                <span :class="['prepare-dot', prepareDotClass]" />
              </span>
            </button>
            <div class="prepare-hint-panel" role="tooltip">
              <pre class="prepare-hint-pre">{{ prepareHintDetail }}</pre>
            </div>
          </div>

          <button
            class="ctrl-btn"
            :disabled="!hasPrev"
            @click="emit('prev')"
          >⏮</button>

          <button
            class="ctrl-btn ctrl-btn-play"
            type="button"
            @click="onPlayButtonClick"
          >
            {{ (isLoading || playing) ? "⏸" : "▶" }}
          </button>

          <button
            class="ctrl-btn"
            :disabled="!hasNext"
            @click="emit('next')"
          >⏭</button>
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

      <!-- Right: volume -->
      <div class="player-right">
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
        @canplay="updateBufferStats"
        @loadedmetadata="duration = audioRef?.duration ?? 0; updateBufferStats()"
        @durationchange="duration = audioRef?.duration ?? 0; updateBufferStats()"
        @waiting="streamPhase = 'buffering'"
        @stalled="streamPhase = 'buffering'"
        @error="onAudioError"
        @timeupdate="current = audioRef?.currentTime ?? 0"
        @ended="emit('ended')"
      />
    </template>

    <template v-else>
      <div class="player-left">
        <div class="player-art player-art--idle" aria-hidden="true">♪</div>
        <div class="player-track-info">
          <span class="player-name">Ничего не играет</span>
          <span class="player-artist">Выберите трек в раздаче</span>
        </div>
      </div>
      <div class="player-center">
        <div class="player-controls">
          <button class="ctrl-btn" disabled>⏮</button>
          <button class="ctrl-btn ctrl-btn-play" disabled>▶</button>
          <button class="ctrl-btn" disabled>⏭</button>
        </div>
        <div class="player-progress">
          <span class="progress-time">0:00</span>
          <div class="progress-track progress-track--idle" />
          <span class="progress-time">0:00</span>
        </div>
      </div>
      <div class="player-right" />
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

/* Индикатор загрузки торрента (цвет + подсказка с пирами и скоростью) */
.player-controls {
  flex-wrap: wrap;
  justify-content: center;
}
.prepare-hint {
  position: relative;
  display: flex;
  align-items: center;
  margin-right: 4px;
}
.prepare-hint-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: help;
  line-height: 0;
}
.prepare-hint-trigger:hover {
  background: rgba(255, 255, 255, 0.08);
}
.prepare-hint-dot-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
}
.prepare-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
}
.prepare-dot--info {
  background: linear-gradient(145deg, #6ab0ff, #3d7ccc);
}
.prepare-dot--ok {
  background: linear-gradient(145deg, #5fd68a, #2fa85c);
}
.prepare-dot--warn {
  background: linear-gradient(145deg, #f0c860, #d4a017);
}
.prepare-dot--bad {
  background: linear-gradient(145deg, #ff7d7d, #c42e2e);
}
.prepare-hint-panel {
  display: none;
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  transform: translateX(-50%);
  z-index: 80;
  min-width: 240px;
  max-width: min(92vw, 400px);
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text);
  background: var(--bg-elevated, rgba(32, 32, 38, 0.98));
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  text-align: left;
}
.prepare-hint:hover .prepare-hint-panel {
  display: block;
}
.prepare-hint-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 11.5px;
}
</style>
