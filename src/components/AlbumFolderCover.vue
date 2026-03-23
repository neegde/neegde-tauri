<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { isImage, basename } from "../utils.js";

const props = defineProps({
  magnet:    { type: String, default: "" },
  coverFile: { type: Object, default: null },  // image file entry from the torrent
  label:     { type: String, default: "" },
  /** Torrent-level cover data: URL — fallback when torrent image is unavailable. */
  cover:     { type: String, default: null },
});

const MAX_COVER_BYTES = 3 * 1024 * 1024;

const resolvedCover = ref(null);
const imgLoaded     = ref(false);
const imgFailed     = ref(false);
const fetching      = ref(false);

async function loadCover() {
  resolvedCover.value = null;
  imgLoaded.value     = false;
  imgFailed.value     = false;

  const f = props.coverFile;

  // Primary: download the actual cover image file from the torrent (separate session,
  // no interference with audio playback)
  if (f && props.magnet && isImage(f.path) && f.size > 0 && f.size <= MAX_COVER_BYTES) {
    fetching.value = true;
    try {
      const url = await invoke("torrent_fetch_image", {
        magnet:  props.magnet,
        fileIdx: f.origIdx,
      });
      if (url) {
        resolvedCover.value = url;
        return;
      }
    } catch (_) {
      // torrent unavailable / timeout — fall through
    } finally {
      fetching.value = false;
    }
  }

  // Fallback: cover from Rutracker post (already loaded as data: URL, no extra request)
  resolvedCover.value = props.cover ?? null;
}

onMounted(loadCover);

watch(
  () => [props.magnet, props.coverFile?.origIdx],
  loadCover,
);

const showImg   = computed(() => !!resolvedCover.value && !imgFailed.value);
const isLoading = computed(() => fetching.value || (showImg.value && !imgLoaded.value));

const hue = computed(() => {
  const s = props.label || props.coverFile?.path || "x";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
});

const gradientStyle = computed(() => ({
  background: `linear-gradient(135deg, hsl(${hue.value}, 42%, 36%), hsl(${(hue.value + 44) % 360}, 48%, 22%))`,
}));

const initial = computed(() => {
  const s = props.label?.trim() || basename(props.coverFile?.path || "") || "?";
  const g = [...s].find((c) => /\S/u.test(c));
  return (g || "?").toUpperCase();
});
</script>

<template>
  <div class="album-folder-cover-root">
    <!-- Gradient placeholder — always underneath, pulses while loading -->
    <div
      class="album-folder-cover-placeholder"
      :class="{ shimmer: isLoading }"
      :style="gradientStyle"
    >
      <span v-if="!showImg || imgFailed" class="album-folder-cover-letter">{{ initial }}</span>
    </div>

    <!-- Cover image — on top, fades in after @load -->
    <img
      v-if="showImg"
      :src="resolvedCover"
      class="album-folder-cover-img"
      :class="{ visible: imgLoaded }"
      alt=""
      @load="imgLoaded = true"
      @error="imgFailed = true"
    />
  </div>
</template>

<style scoped>
.album-folder-cover-root {
  position: relative;
  width: 100%;
  height: 100%;
}
.album-folder-cover-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.album-folder-cover-placeholder.shimmer {
  animation: cover-pulse 1.2s ease-in-out infinite;
}
@keyframes cover-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
.album-folder-cover-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  opacity: 0;
  transition: opacity 0.3s ease;
}
.album-folder-cover-img.visible {
  opacity: 1;
}
.album-folder-cover-letter {
  font-size: 22px;
  font-weight: 800;
  color: rgba(255, 255, 255, 0.92);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
}
</style>
