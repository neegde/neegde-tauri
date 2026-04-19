<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import {
  getSlskCoverDataUrl,
  peekSlskCover,
  getSlskCoverReactive,
} from "../../soulseek/coverCache.js";

const props = defineProps({
  track: { type: Object, required: true },
});

const emit = defineEmits(["play"]);

/**
 * Formats duration in seconds as `m:ss`.
 *
 * Args:
 *     secs: Duration in seconds.
 *
 * Returns:
 *     Label string, or empty if missing.
 */
function fmtDuration(secs) {
  if (!secs) return "";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Formats byte size for display.
 *
 * Args:
 *     bytes: Size in bytes.
 *
 * Returns:
 *     Human-readable string, or empty if missing.
 */
function fmtSize(bytes) {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Returns uppercased file extension from a SoulSeek track row.
 *
 * Args:
 *     track: Result row with `slsk_filepath` / `name`.
 *
 * Returns:
 *     Extension without dot, or empty string.
 */
function trackExt(track) {
  const fp = track.slsk_filepath ?? track.name ?? "";
  const dot = fp.lastIndexOf(".");
  return dot >= 0 ? fp.slice(dot + 1).toUpperCase() : "";
}

const rowRef = ref(null);
const coverErr = ref(false);

const coverUrl = computed(() => {
  const u = props.track?.slsk_cover_username;
  const p = props.track?.slsk_cover_filepath;
  if (!u || !p) return null;
  return getSlskCoverReactive(u, p);
});

watch(
  () => [props.track?.id, props.track?.slsk_cover_filepath],
  () => {
    coverErr.value = false;
  },
);

let observer = null;

/** Detaches the lazy-load IntersectionObserver for the row cover. */
function disconnectObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

/**
 * Lazily fetches the folder cover when the row scrolls near the viewport.
 */
function setupCoverObserver() {
  disconnectObserver();
  coverErr.value = false;
  const u = props.track?.slsk_cover_username;
  const p = props.track?.slsk_cover_filepath;
  const sz = props.track?.slsk_cover_size ?? 0;
  if (!u || !p) return;
  if (peekSlskCover(u, p) !== undefined) return;
  observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      disconnectObserver();
      void getSlskCoverDataUrl(u, p, sz).catch(() => {});
    },
    { rootMargin: "400px" },
  );
  const el = rowRef.value;
  if (el) observer.observe(el);
}

onMounted(() => {
  nextTick(setupCoverObserver);
});
onUnmounted(() => {
  disconnectObserver();
});

watch(
  () => [props.track?.slsk_cover_filepath, props.track?.slsk_cover_username],
  () => nextTick(setupCoverObserver),
);
</script>

<template>
  <div
    ref="rowRef"
    class="slsk-track-row"
    @click="emit('play', track)"
  >
    <div class="slsk-track-thumb-wrap" aria-hidden="true">
      <img
        v-if="coverUrl && !coverErr"
        class="slsk-track-thumb"
        :src="coverUrl"
        alt=""
        @error="coverErr = true"
      >
      <div v-else class="slsk-track-thumb slsk-track-thumb--placeholder" />
    </div>
    <button class="slsk-track-play" title="Слушать" @click.stop="emit('play', track)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <polygon points="5,3 19,12 5,21"/>
      </svg>
    </button>
    <span class="slsk-track-name">{{ track.name }}</span>
    <span class="slsk-track-meta">
      <span
        v-if="Number(track.seeders) > 1"
        class="slsk-track-chip"
        title="Число пиров в выдаче с тем же релизом или файлом (чем больше, тем выше строка в списке)"
      >{{ track.seeders }}×</span>
      <span v-if="track.bitrate" class="slsk-track-chip">{{ track.bitrate }} kbps</span>
      <span v-else-if="trackExt(track)" class="slsk-track-chip">{{ trackExt(track) }}</span>
      <span v-if="track.duration" class="slsk-track-dur">{{ fmtDuration(track.duration) }}</span>
      <span v-else-if="track.size" class="slsk-track-dur">{{ fmtSize(track.size) }}</span>
    </span>
  </div>
</template>
