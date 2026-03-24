<script setup>
import { ref, computed, watch, watchEffect, onMounted, onUnmounted, nextTick } from "vue";
import CoverThumb from "../shared/CoverThumb.vue";
import { streamUrl } from "../../torrent/api.js";
import { trackDisplayBasename } from "../../lib/utils.js";
import {
  disposeTorrentPreview,
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

function fmtTime(secs) {
  if (!secs || isNaN(secs) || !isFinite(secs)) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const props = defineProps({
  track: { type: Object, default: null },
  hasPrev: Boolean,
  hasNext: Boolean,
});

const emit = defineEmits(["prev", "next", "ended", "playing-change"]);

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

watch(
  () => [props.track?.magnet, props.track?.fileIdx],
  () => {
    prepareAttempt.value = 0;
  }
);

const progress = computed(() => duration.value > 0 ? current.value / duration.value : 0);
const isLoading = computed(() => streamPhase.value === "preparing" || streamPhase.value === "buffering");
/** Без metadata duration неизвестна — не показываем «процент» (он залипает на 95%), только индетерминатный режим в шаблоне */
const loadingProgress = computed(() => {
  if (duration.value > 0) return bufferedPercent.value;
  return isLoading.value ? 0 : 100;
});

function cancelLoad() {
  loadCancelledByUser.value = true;
  void torrentPrepareCancel();
  void disposeTorrentPreview();
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
    void a.play().catch(() => {
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
  console.error("[player/audio element error]", {
    code: err?.code,
    message: err?.message,
    mediaError: err ? describeMediaError(err.code) : null,
    src: srcUrl?.slice?.(0, 120),
  });
  streamError.value = err
    ? `Ошибка воспроизведения: ${describeMediaError(err.code)}`
    : "Ошибка загрузки потока";
}

watch(playing, (v) => emit("playing-change", v), { immediate: true });

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

watch(
  () => [props.track?.magnet, props.track?.fileIdx, prepareAttempt.value],
  async ([magnet, fileIdx], _, onCleanup) => {
    if (!props.track || !magnet) {
      stopBufferPoll();
      playing.value = false;
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
    playing.value = false;
    src.value = "";
    current.value = 0;
    duration.value = 0;
    bufferedPercent.value = 0;
    streamError.value = "";
    streamPhase.value = "preparing";

    let cancelled = false;
    onCleanup(() => { cancelled = true; });
    try {
      const nextSrc = await streamUrl(magnet, fileIdx);
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
  },
  { immediate: true }
);

onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => {
  stopBufferPoll();
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
        :autoplay="Boolean(src)"
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
</style>
