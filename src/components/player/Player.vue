<script setup>
import { ref, computed, watch, watchEffect, onMounted, onUnmounted, nextTick } from "vue";
import { listen } from "@tauri-apps/api/event";
import TrackCover from "../shared/TrackCover.vue";
import PlayerVisualizerModal from "./PlayerVisualizerModal.vue";
import { Track } from "../../track/Track.js";
import {
  trackDisplayBasename,
  extractTrackArtist,
  parseArtistTitleFromTrackFilename,
} from "../../lib/utils.js";
import { releaseTorrentStreamUrl, torrentPrepareCancel } from "../../torrent/torrentSession.js";
import { resumeEqualizerContext } from "../../audio/equalizerGraph.js";
import { fmtRate, describeMediaError } from "../../lib/fmt.js";
import { setVisualizerBroadcastPlaying } from "../../audio/visualizerBroadcast.js";
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
import { clearDiscordPresence } from "../../discordPresence.js";
import { enrichTrackMeta } from "../../audio/metadataEnrich.js";
import { slskMeta } from "../../soulseek/slskMetaStore.js";
import TrackContextMenu from "../shared/TrackContextMenu.vue";
import { useVolume } from "../../composables/useVolume.js";
import { useQueueContextMenu } from "../../composables/useQueueContextMenu.js";
import { useDiscordPresence } from "../../composables/useDiscordPresence.js";
import { usePlayerEqualizer } from "../../composables/usePlayerEqualizer.js";
import { useMarquee } from "../../composables/useMarquee.js";
import { useStreamReadiness } from "../../composables/useStreamReadiness.js";
import { usePrefetch } from "../../composables/usePrefetch.js";
import { usePlayerDisplay } from "../../composables/usePlayerDisplay.js";
import {
  trackHasPlaybackIdentity,
  queueTrackKey,
  prefetchFingerprint,
} from "../../player/queueRowKey.js";
import {
  nowPlayingTrack,
  nextTrack as queueNextTrack,
  secondNextTrack as queueSecondNextTrack,
  hasPrev as queueHasPrev,
  hasNext as queueHasNext,
  queueTracks,
  queuePos,
  repeatMode as queueRepeatMode,
  shuffleOn as queueShuffleOn,
  suppressAutoplay as queueSuppressAutoplay,
} from "../../stores/queue.js";
import { likedTrackIds } from "../../stores/library.js";

function fmtTime(secs) {
  if (!secs || isNaN(secs) || !isFinite(secs)) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Player reads its playback state directly from `stores/queue` + `stores/library`
 * — no props. Parent (App.vue) only listens to emits for handlers that still
 * live there (search-artist, open-torrent, download, etc.).
 *
 * Top-level ref aliases below are exposed to the template (Vue auto-unwraps).
 */
const track             = nowPlayingTrack;
const nextTrack         = queueNextTrack;
const secondNextTrack   = queueSecondNextTrack;
const hasPrev           = queueHasPrev;
const hasNext           = queueHasNext;
const suppressAutoplay  = queueSuppressAutoplay;
const likedIds          = likedTrackIds;
const playbackQueue     = queueTracks;
const queueIndex        = queuePos;
const repeatMode        = queueRepeatMode;
const shuffleOn         = queueShuffleOn;

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
  "queue-add-to-playlist",
  "queue-download",
  "cycle-repeat",
  "toggle-shuffle",
]);

const {
  queueCtxOpen,
  queueCtxX,
  queueCtxY,
  queueCtxActions,
  openQueueCtx,
  onQueueCtxAction,
} = useQueueContextMenu({
  playbackQueue: computed(() => playbackQueue.value ?? []),
  onDownload: (q) => emit("queue-download", q),
  onAddToPlaylist: (q) => emit("queue-add-to-playlist", q),
});

/** Enriched metadata from iTunes (artist/album/title/coverUrl). Null until resolved. */
const enrichedMeta = ref(null);

const { soulseekSearchMeta, currentArtist, displayTitle, playerCoverOverride } = usePlayerDisplay({
  track: track,
  enrichedMeta,
});

function onArtistClick() {
  const a = currentArtist.value;
  if (a) emit("search-artist", a);
}

function onTrackClick() {
  const t = track.value;
  if (!t) return;
  const target = t.navigationTarget();
  if (target) emit("open-torrent", target);
}

const hasTrack = computed(() => trackHasPlaybackIdentity(track.value));

const isCurrentTrackLiked = computed(() => {
  const t = track.value;
  return t ? Boolean(likedIds.value?.has(t.id)) : false;
});

function toggleCurrentLike() {
  const t = track.value;
  if (!t) return;
  emit("toggle-like", t);
}

const audioRef = ref(null);
const { volume, toggleMute, onVolumeWheel } = useVolume();

const playing = ref(false);

watch(
  playing,
  (v) => {
    setVisualizerBroadcastPlaying(v);
  },
  { immediate: true },
);

const current = ref(0);
const duration = ref(0);
const src = ref("");
const streamPhase = ref("idle"); // idle | preparing | buffering | ready | error
const streamError = ref("");

/** Последняя статистика BitTorrent из Tauri (событие torrent-prepare-progress). */
const prepareProgress = ref(null);
/** Сохраняем последнее значение, чтобы статус-меню показывало данные и в состоянии ready. */
const lastPrepareProgress = ref(null);

const isLoading = computed(() => streamPhase.value === "preparing" || streamPhase.value === "buffering");

const {
  // Buffer poll
  bufferedPercent, updateBufferStats, stopBufferPoll,
  // Stats poll
  streamDownloadStats, statsHistory, startStatsPolling, stopStatsPolling,
  // Watchdog
  startBufferingWatchdog, clearBufferingWatchdog,
  // Status popup
  prepareDotClass, prepareHintDetail, streamDotClass,
  currentPeers, currentRate, sparklineData,
  streamStatusHeadline, streamStatusBody,
} = useStreamReadiness({
  audioRef, src, streamPhase, streamError, duration, isLoading,
  track, prepareProgress, lastPrepareProgress,
});

/** Отмена загрузки без смены трека — не применять URL после await. */
const loadCancelledByUser = ref(false);
/** Счётчик повторной попытки открыть поток (тот же трек после отмены / ошибки). */
const prepareAttempt = ref(0);
/** Matches the in-flight / active prepare — suppresses duplicate watch runs for the same track. */
const activeStreamPrepareSig = ref("");

let unlistenPrepareProgress = () => {};

/** Открыто ли pop-up меню статуса стрима. */
const statusMenuOpen = ref(false);
/** Панель списка очереди. */
const queuePanelOpen = ref(false);
/** Окно визуализации (Web Audio). */
const vizOpen = ref(false);

const { prefetchedStream, resetOnTrackChange: resetPrefetchOnTrackChange, releasePrefetchedStream } = usePrefetch({
  track: track,
  nextTrack: nextTrack,
  secondNextTrack: secondNextTrack,
  playing,
  streamPhase,
  isLoading,
  duration,
  current,
});

watch(
  () => queueTrackKey(track.value),
  () => {
    activeStreamPrepareSig.value = "";
    prepareAttempt.value = 0;
    lastPrepareProgress.value = null;
    statusMenuOpen.value = false;
    resetPrefetchOnTrackChange();
  },
);

const progress = computed(() => duration.value > 0 ? current.value / duration.value : 0);

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
  void appDebugLog("player", `stream prepare: user cancelled — "${track.value?.fileName?.slice?.(0,70)}" fileIdx=${track.value?.fileIdx} phase=${streamPhase.value}`);
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
  if (suppressAutoplay.value && !src.value) {
    void appDebugLog("player", `togglePlay: suppressed — emitting request-stream fileIdx=${track.value?.fileIdx}`);
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
  if (e.code === "ArrowRight" && hasNext.value) { e.preventDefault(); emit("next"); }
  if (e.code === "ArrowLeft" && hasPrev.value) { e.preventDefault(); emit("prev"); }
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
    const trackKeyAtError = queueTrackKey(track.value);
    setTimeout(() => {
      if (
        streamPhase.value === "error" &&
        !loadCancelledByUser.value &&
        queueTrackKey(track.value) === trackKeyAtError
      ) {
        void appDebugLog("player", `stream prepare: auto-retry after audio error — "${track.value?.fileName?.slice?.(0, 60)}" fileIdx=${track.value?.fileIdx}`);
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
  void appDebugLog("player", `streamPhase: ${prev} → ${phase} — "${track.value?.fileName?.slice?.(0,60)}" fileIdx=${track.value?.fileIdx}`);
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
  void hasPrev.value;
  void hasNext.value;
  setMediaSessionApi({
    play: () => {
      if (suppressAutoplay.value && !src.value && hasTrack.value) {
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

/**
 * Merges SoulSeek search metadata with MusicBrainz for Media Session / OS "now playing".
 *
 * Args:
 *     t: Current queue item or null.
 *
 * Returns:
 *     Object suitable as second arg to syncMediaSessionMetadata, or null.
 */
/**
 * Metadata for the OS MediaSession presentation. Track ids for SoulSeek
 * match exactly what the search provider stored in `slskMeta`, so we look
 * up by `t.id` directly (no separate `slskMetaTrackId`).
 */
function buildSessionEnriched(t) {
  if (!t || t.kind !== "soulseek") return null;
  const sm = slskMeta.get(t.id);
  if (!sm) return null;
  return {
    artist: sm.artist,
    title: sm.title,
    album: sm.albumUrl ?? "",
    coverUrl: sm.coverUrl ?? null,
  };
}

watch(
  () => track.value,
  (t) => {
    enrichedMeta.value = null;
    if (!trackHasPlaybackIdentity(t)) {
      clearMediaSessionPresentation();
      return;
    }
    // Warm the folder cover cache — `track.startCoverFetch()` dispatches by
    // source. For SoulSeek it fires the peer-fetch; RT looks up by topicId.
    t.startCoverFetch();

    void syncMediaSessionMetadata(t, buildSessionEnriched(t));
    // MusicBrainz enrichment — does NOT block playback.
    let artistLocal = t.artist || extractTrackArtist(t.albumTitle, null, null, null) || "";
    let titleLocal = trackDisplayBasename(t.fileName);
    const sm0 = slskMeta.get(t.id);
    if (sm0?.artist && sm0?.title) {
      artistLocal = sm0.artist;
      titleLocal = sm0.title;
    } else {
      const parsed = parseArtistTitleFromTrackFilename(t.fileName || t.albumTitle || "");
      if (parsed.artist) {
        artistLocal = parsed.artist;
        titleLocal = parsed.title;
      }
    }
    enrichTrackMeta(artistLocal, titleLocal, (meta) => {
      if (track.value !== t) return;  // track changed while request was in flight
      enrichedMeta.value = meta;
      void syncMediaSessionMetadata(t, { ...buildSessionEnriched(t), ...meta });
    });
  },
  { immediate: true }
);

watch(
  () => [playing.value, duration.value, current.value, queueTrackKey(track.value)],
  () => {
    if (!trackHasPlaybackIdentity(track.value) || streamPhase.value === "error") return;
    const d = duration.value;
    const p = current.value;
    if (!Number.isFinite(d) || d <= 0) return;
    syncMediaSessionPositionState(d, p, 1);
  },
  { flush: "post" }
);

useDiscordPresence({
  track: track,
  playing,
  streamPhase,
  current,
  duration,
  hasIdentity: trackHasPlaybackIdentity,
  queueTrackKey,
  displayTitle,
  currentArtist,
});

usePlayerEqualizer({ audioRef, src, volume });

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
  void appDebugLog("player", `audio: canplay — currentTime=${a?.currentTime?.toFixed(2)} buffered%=${bufferedPercent.value} "${track.value?.fileName?.slice?.(0,60)}"`);
  updateBufferStats();
  bumpStreamPhaseReady();
}

function onAudioPlaying() {
  void appDebugLog("player", `audio: playing — currentTime=${audioRef.value?.currentTime?.toFixed(2)} "${track.value?.fileName?.slice?.(0,60)}"`);
  bumpStreamPhaseReady();
}

/**
 * Browsers often fire `waiting` / `stalled` while paused; do not show buffering or
 * the play button will call cancelLoad instead of resume.
 */
function onAudioWaiting() {
  const a = audioRef.value;
  if (a && !a.paused) {
    void appDebugLog("player", `audio: waiting (rebuffering) — currentTime=${a.currentTime?.toFixed(2)} buffered%=${bufferedPercent.value} "${track.value?.fileName?.slice?.(0,60)}"`);
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

watch(
  () => [
    queueTrackKey(track.value),
    prepareAttempt.value,
    suppressAutoplay.value,
  ],
  async ([, , suppressed], _, onCleanup) => {
    const t = track.value;
    void appDebugLog("player", `stream-watch: fired — id=${t?.id ?? "—"} kind=${t?.kind ?? "—"} suppressed=${suppressed} phase=${streamPhase.value} activeSig="${activeStreamPrepareSig.value?.slice(0,30)}"`);
    if (!t || !t.hasPlaybackIdentity()) {
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
    void appDebugLog("player", `stream prepare: start — "${t.fileName?.slice?.(0,70)}" id=${t.id} kind=${t.kind} attempt=${prepareAttempt.value} suppressAutoplay=${suppressAutoplay.value}`);
    try {
      const preparedKey = queueTrackKey(track.value);
      let nextSrc = "";
      if (prefetchedStream.value.url && prefetchedStream.value.forKey === preparedKey) {
        nextSrc = prefetchedStream.value.url;
        prefetchedStream.value = { url: "", forKey: "" };
        void appDebugLog("player", `stream prepare: prefetch HIT — using pre-warmed URL id=${t.id} url=${nextSrc}`);
      } else {
        nextSrc = await t.prepareStream();
      }
      void appDebugLog("player", nextSrc
        ? `stream prepare: done — assigning src id=${t.id} url=${nextSrc} cancelled=${cancelled}`
        : `stream prepare: done with EMPTY URL — id=${t.id} cancelled=${cancelled} loadCancelledByUser=${loadCancelledByUser.value}`);
      if (!cancelled && !loadCancelledByUser.value) {
        src.value = nextSrc;
        streamPhase.value = nextSrc ? "buffering" : "error";
        if (nextSrc) {
          // WKWebView does not fire `stalled` when the HTTP server holds the connection open
          // but sends no data (vozduxan waiting for a piece). Start watchdog immediately so
          // we don't spin in infinite buffering if the piece never arrives.
          startBufferingWatchdog();
        } else {
          console.error("[player/stream] empty URL", { id: t.id });
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

watch(isLoading, (loading) => {
  if (!loading) prepareProgress.value = null;
});

function onDocClick() {
  statusMenuOpen.value = false;
  queuePanelOpen.value = false;
}

const queueLen = computed(() => playbackQueue.value?.length ?? 0);

const playerTrackInfoRef = ref(null);
const titleMarqueeWrapRef = ref(null);
const artistMarqueeWrapRef = ref(null);

const {
  titleScroll,
  artistScroll,
  titleMarqueeStyle,
  artistMarqueeStyle,
} = useMarquee({
  outer: playerTrackInfoRef,
  titleWrap: titleMarqueeWrapRef,
  artistWrap: artistMarqueeWrapRef,
  displayTitle,
  fileName: computed(() => track.value?.fileName ?? ""),
  currentArtist,
  hasTrack,
});

const repeatCycleTitle = computed(() => {
  if (repeatMode.value === "all") return "Повтор: вся очередь";
  if (repeatMode.value === "one") return "Повтор: один трек";
  return "Повтор выключен";
});

/**
 * On natural end: repeat-one (or repeat-all with a single track) restarts the same
 * clip; otherwise App advances the queue.
 */
function onAudioEnded() {
  const qLen = playbackQueue.value?.length ?? 0;
  const loopSameTrack =
    repeatMode.value === "one" || (repeatMode.value === "all" && qLen === 1);
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
  releasePrefetchedStream();
  stopBufferPoll();
  unlistenPrepareProgress();
  clearMediaSessionHandlers();
  clearMediaSessionPresentation();
  void clearDiscordPresence();
  window.removeEventListener("keydown", onKey);
  document.removeEventListener("click", onDocClick);
});
</script>

<template src="./Player.html"></template>

<style scoped src="./Player.scoped.css"></style>
