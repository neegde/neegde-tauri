<script setup>
import { ref, computed, watch } from "vue";
import { isImage, basename } from "../utils.js";

const props = defineProps({
  magnet: { type: String, default: "" },
  coverFile: { type: Object, default: null },
  /** Folder / album title — used for fallback monogram and color. */
  label: { type: String, default: "" },
});

const MAX_COVER_BYTES = 3 * 1024 * 1024;

const imgFailed = ref(false);

/**
 * Cover preview streaming is intentionally disabled here.
 * `streamUrl` now performs heavy torrent prepare + prebuffer and is used by audio playback.
 * Using it for every visible album cover causes many parallel prepare calls and can race
 * with the player stream startup.
 */
const src = computed(() => {
  const f = props.coverFile;
  if (!f || !props.magnet || !isImage(f.path) || f.size > MAX_COVER_BYTES) return "";
  return "";
});

watch(src, () => {
  imgFailed.value = false;
});

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
  <img
    v-if="src && !imgFailed"
    :src="src"
    class="album-folder-cover-img"
    alt=""
    @error="imgFailed = true"
  />
  <div v-else class="album-folder-cover-placeholder" :style="gradientStyle">
    <span class="album-folder-cover-letter">{{ initial }}</span>
  </div>
</template>

<style scoped>
.album-folder-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.album-folder-cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: inherit;
}
.album-folder-cover-letter {
  font-size: 22px;
  font-weight: 800;
  color: rgba(255, 255, 255, 0.92);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
}
</style>
