<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import CoverThumb from "./CoverThumb.vue";
import { streamUrl } from "../api.js";

function basename(path) {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

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

const emit = defineEmits(["prev", "next", "ended", "close", "playing-change"]);

const hasTrack = computed(() => Boolean(props.track?.magnet));

const audioRef = ref(null);
const playing = ref(false);
const current = ref(0);
const duration = ref(0);
const src = ref("");
const streamPhase = ref("idle"); // idle | preparing | buffering | ready | error
const streamError = ref("");
const bufferedPercent = ref(0);

const progress = computed(() => duration.value > 0 ? current.value / duration.value : 0);
const isLoading = computed(() => streamPhase.value === "preparing" || streamPhase.value === "buffering");
/** Без metadata duration неизвестна — не показываем «процент» (он залипает на 95%), только индетерминатный режим в шаблоне */
const loadingProgress = computed(() => {
  if (duration.value > 0) return bufferedPercent.value;
  return isLoading.value ? 0 : 100;
});

function togglePlay() {
  if (!hasTrack.value) return;
  const a = audioRef.value;
  if (!a) return;
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
  if (e.code === "Space" && hasTrack.value) { e.preventDefault(); togglePlay(); }
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
  () => [props.track?.magnet, props.track?.fileIdx],
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
      return;
    }

    playing.value = true;
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
      if (!cancelled) {
        src.value = nextSrc;
        streamPhase.value = nextSrc ? "buffering" : "error";
        if (!nextSrc) {
          console.error("[player/stream] empty URL", { magnetLen: magnet?.length, fileIdx });
          streamError.value = "Пустой URL потока";
        }
      }
    } catch (e) {
      console.error("[player/stream] torrent_prepare_stream failed", {
        magnetLen: magnet?.length,
        fileIdx,
        error: e,
        message: typeof e === "string" ? e : e?.message ?? String(e),
      });
      if (!cancelled) {
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
          <span class="player-name">{{ basename(track.fileName) }}</span>
          <span class="player-artist">{{ track.torrentName }}</span>
        </div>
      </div>

      <!-- Center: controls + progress -->
      <div class="player-center">
        <div class="player-controls">
          <button
            class="ctrl-btn"
            :disabled="!hasPrev"
            title="Предыдущий (←)"
            @click="emit('prev')"
          >⏮</button>

          <button
            class="ctrl-btn ctrl-btn-play"
            :title="playing ? 'Пауза (Пробел)' : 'Играть (Пробел)'"
            @click="togglePlay"
          >
            {{ playing ? "⏸" : "▶" }}
          </button>

          <button
            class="ctrl-btn"
            :disabled="!hasNext"
            title="Следующий (→)"
            @click="emit('next')"
          >⏭</button>
        </div>

        <div class="player-progress">
          <span class="progress-time">{{ fmtTime(current) }}</span>
          <div :class="['progress-track', isLoading ? 'progress-track-loading' : '']" title="Перемотка" @click="seek">
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

      <!-- Right: close -->
      <div class="player-right">
        <button class="player-close" title="Закрыть" @click="emit('close')">✕</button>
      </div>

      <audio
        v-if="src"
        ref="audioRef"
        :src="src"
        :autoplay="Boolean(src)"
        @loadstart="streamPhase = 'buffering'"
        @play="playing = true"
        @playing="streamPhase = 'ready'"
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
          <button class="ctrl-btn" disabled title="Предыдущий">⏮</button>
          <button class="ctrl-btn ctrl-btn-play" disabled title="Воспроизведение">▶</button>
          <button class="ctrl-btn" disabled title="Следующий">⏭</button>
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
