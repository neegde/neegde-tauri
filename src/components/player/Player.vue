<script setup>
import { ref, computed, watch, watchEffect, onMounted, onUnmounted, nextTick } from "vue";
import { listen } from "@tauri-apps/api/event";
import CoverThumb from "../shared/CoverThumb.vue";
import PlayerVisualizerModal from "./PlayerVisualizerModal.vue";
import { streamUrl } from "../../torrent/api.js";
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
import { getSlskCoverReactive, getSlskCoverDataUrl } from "../../soulseek/coverCache.js";
import TrackContextMenu from "../shared/TrackContextMenu.vue";
import { useVolume } from "../../composables/useVolume.js";
import { useQueueContextMenu } from "../../composables/useQueueContextMenu.js";
import { useDiscordPresence } from "../../composables/useDiscordPresence.js";
import { usePlayerEqualizer } from "../../composables/usePlayerEqualizer.js";
import { useStreamStats } from "../../composables/useStreamStats.js";
import { useMarquee } from "../../composables/useMarquee.js";
import { useStreamStatus } from "../../composables/useStreamStatus.js";
import { useBufferPoll } from "../../composables/useBufferPoll.js";
import { useBufferingWatchdog } from "../../composables/useBufferingWatchdog.js";
import { usePrefetch } from "../../composables/usePrefetch.js";
import { usePlayerDisplay } from "../../composables/usePlayerDisplay.js";
import {
  trackHasPlaybackIdentity,
  queueTrackKey,
  prefetchFingerprint,
} from "../../player/queueRowKey.js";

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
  playbackQueue: computed(() => props.playbackQueue ?? []),
  onDownload: (q) => emit("queue-download", q),
  onAddToPlaylist: (q) => emit("queue-add-to-playlist", q),
});

/** Enriched metadata from iTunes (artist/album/title/coverUrl). Null until resolved. */
const enrichedMeta = ref(null);

const { soulseekSearchMeta, currentArtist, displayTitle, playerCoverOverride } = usePlayerDisplay({
  track: computed(() => props.track),
  enrichedMeta,
});

function onArtistClick() {
  const a = currentArtist.value;
  if (a) emit("search-artist", a);
}

function onTrackClick() {
  const t = props.track;
  if (!t) return;
  const payload = {
    torrentId: t.torrentId,
    torrentName: t.torrentName,
    source: t.source,
    magnet: t.magnet,
    artist: t.artist,
    seeders: t.seeders ?? null,
    fileIdx: t.fileIdx,
    albumDirPath: t.albumDirPath ?? null,
  };
  if (t.source === "soulseek" && t.slskUsername) {
    payload.slskUsername = t.slskUsername;
    payload.slskFilepath = t.slskFilepath ?? null;
  }
  emit("open-torrent", payload);
}

const hasTrack = computed(() => trackHasPlaybackIdentity(props.track));

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
  const base = {
    id,
    type: "track",
    torrentId: t.torrentId,
    torrentName: t.torrentName,
    source: t.source,
    magnet: t.magnet ?? "",
    fileIdx: t.fileIdx,
    fileName: t.fileName,
    coverFileIdx: t.coverFileIdx ?? null,
    coverFile: null,
  };
  if (t.source === "soulseek" && t.slskUsername && t.slskFilepath) {
    emit("toggle-like", {
      ...base,
      slskUsername: t.slskUsername,
      slskFilepath: t.slskFilepath,
      slskFilesize: t.slskFilesize ?? 0,
    });
    return;
  }
  emit("toggle-like", base);
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

const {
  streamDownloadStats,
  statsHistory,
  startStatsPolling,
  stopStatsPolling,
} = useStreamStats({ src, streamPhase });
/** Отмена загрузки без смены трека — не применять URL после await. */
const loadCancelledByUser = ref(false);
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
/** Окно визуализации (Web Audio). */
const vizOpen = ref(false);

const { prefetchedStream, resetOnTrackChange: resetPrefetchOnTrackChange, releasePrefetchedStream } = usePrefetch({
  track: computed(() => props.track),
  nextTrack: computed(() => props.nextTrack),
  secondNextTrack: computed(() => props.secondNextTrack),
  playing,
  streamPhase,
  isLoading: computed(() => streamPhase.value === "preparing" || streamPhase.value === "buffering"),
  duration,
  current,
});

const {
  prepareDotClass,
  prepareHintDetail,
  streamDotClass,
  currentPeers,
  currentRate,
  sparklineData,
  streamStatusHeadline,
  streamStatusBody,
} = useStreamStatus({
  streamPhase,
  prepareProgress,
  lastPrepareProgress,
  streamDownloadStats,
  statsHistory,
  track: computed(() => props.track),
});

watch(
  () => queueTrackKey(props.track),
  () => {
    activeStreamPrepareSig.value = "";
    prepareAttempt.value = 0;
    lastPrepareProgress.value = null;
    statusMenuOpen.value = false;
    resetPrefetchOnTrackChange();
  },
);

const progress = computed(() => duration.value > 0 ? current.value / duration.value : 0);
const isLoading = computed(() => streamPhase.value === "preparing" || streamPhase.value === "buffering");

const { bufferedPercent, updateBufferStats, stopBufferPoll } = useBufferPoll({
  audioRef, isLoading, streamPhase, duration,
});

const { startBufferingWatchdog, clearBufferingWatchdog } = useBufferingWatchdog({
  audioRef, streamPhase, streamError, src,
  track: computed(() => props.track),
  onStart: () => startStatsPolling(),
});

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

/**
 * Merges SoulSeek search metadata with MusicBrainz for Media Session / OS "now playing".
 *
 * Args:
 *     t: Current queue item or null.
 *
 * Returns:
 *     Object suitable as second arg to syncMediaSessionMetadata, or null.
 */
function buildSessionEnriched(t) {
  if (!t || t.source !== "soulseek" || t.slskMetaTrackId == null || t.slskMetaTrackId === "") {
    return null;
  }
  const sm = slskMeta.get(t.slskMetaTrackId);
  if (!sm) return null;
  return {
    artist: sm.artist,
    title: sm.title,
    album: sm.albumUrl ?? "",
    coverUrl: sm.coverUrl ?? null,
  };
}

watch(
  () => props.track,
  (t) => {
    enrichedMeta.value = null;
    if (!trackHasPlaybackIdentity(t)) {
      clearMediaSessionPresentation();
      return;
    }
    if (t.source === "soulseek") {
      const u = t.slskFolderCoverUsername;
      const p = t.slskFolderCoverFilepath;
      if (u && p && !getSlskCoverReactive(u, p)) {
        void getSlskCoverDataUrl(u, p, t.slskFolderCoverSize ?? 0);
      }
    }
    void syncMediaSessionMetadata(t, buildSessionEnriched(t));
    // MusicBrainz enrichment in background — does NOT block playback
    let artistLocal = extractTrackArtist(t.torrentName, t.albumDirPath, t.artist, t.magnet);
    let titleLocal = trackDisplayBasename(t.fileName);
    const sm0 = t.slskMetaTrackId ? slskMeta.get(t.slskMetaTrackId) : null;
    if (sm0?.artist && sm0?.title) {
      artistLocal = sm0.artist;
      titleLocal = sm0.title;
    } else {
      const parsed = parseArtistTitleFromTrackFilename(t.fileName || t.torrentName || "");
      if (parsed.artist) {
        artistLocal = parsed.artist;
        titleLocal = parsed.title;
      }
    }
    enrichTrackMeta(artistLocal, titleLocal, (meta) => {
      if (props.track !== t) return; // track changed while request was in flight
      enrichedMeta.value = meta;
      void syncMediaSessionMetadata(t, { ...buildSessionEnriched(t), ...meta });
    });
  },
  { immediate: true }
);

watch(
  () => [playing.value, duration.value, current.value, queueTrackKey(props.track)],
  () => {
    if (!trackHasPlaybackIdentity(props.track) || streamPhase.value === "error") return;
    const d = duration.value;
    const p = current.value;
    if (!Number.isFinite(d) || d <= 0) return;
    syncMediaSessionPositionState(d, p, 1);
  },
  { flush: "post" }
);

useDiscordPresence({
  track: computed(() => props.track),
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
    const isSoulseek = t?.source === "soulseek";
    if (!t || (!magnet && !isSoulseek)) {
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

watch(isLoading, (loading) => {
  if (!loading) prepareProgress.value = null;
});

function onDocClick() {
  statusMenuOpen.value = false;
  queuePanelOpen.value = false;
}

const queueLen = computed(() => props.playbackQueue?.length ?? 0);

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
  fileName: computed(() => props.track?.fileName ?? ""),
  currentArtist,
  hasTrack,
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
