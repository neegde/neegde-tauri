<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
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
  track: Object,
  hasPrev: Boolean,
  hasNext: Boolean,
});

const emit = defineEmits(["prev", "next", "ended", "close"]);

const audioRef = ref(null);
const playing = ref(true);
const current = ref(0);
const duration = ref(0);

const src = computed(() => streamUrl(props.track.magnet, props.track.fileIdx));
const progress = computed(() => duration.value > 0 ? current.value / duration.value : 0);

function togglePlay() {
  const a = audioRef.value;
  if (!a) return;
  if (a.paused) { a.play(); playing.value = true; }
  else { a.pause(); playing.value = false; }
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
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.code === "ArrowRight" && props.hasNext) { e.preventDefault(); emit("next"); }
  if (e.code === "ArrowLeft" && props.hasPrev) { e.preventDefault(); emit("prev"); }
}

onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="player">
    <!-- Left: track info -->
    <div class="player-left">
      <CoverThumb
        :torrent-id="track.torrentId"
        :source="track.source"
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
        <div class="progress-track" title="Перемотка" @click="seek">
          <div class="progress-fill" :style="{ width: `${progress * 100}%` }" />
        </div>
        <span class="progress-time">{{ fmtTime(duration) }}</span>
      </div>
    </div>

    <!-- Right: close -->
    <div class="player-right">
      <button class="player-close" title="Закрыть" @click="emit('close')">✕</button>
    </div>

    <audio
      ref="audioRef"
      :src="src"
      autoplay
      @play="playing = true"
      @pause="playing = false"
      @timeupdate="current = audioRef?.currentTime ?? 0"
      @durationchange="duration = audioRef?.duration ?? 0"
      @ended="emit('ended')"
    />
  </div>
</template>
