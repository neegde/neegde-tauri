<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { isImage, basename, MAX_TORRENT_COVER_BYTES } from "../../lib/utils.js";

const props = defineProps({
  magnet:    { type: String, default: "" },
  coverFile: { type: Object, default: null },  // image file entry from the torrent
  label:     { type: String, default: "" },
  /** Torrent-level cover data: URL — fallback when torrent image is unavailable. */
  cover:     { type: String, default: null },
});

const rootRef = ref(null);
/** From BitTorrent fetch — when set, replaces post cover preview. */
const torrentCover = ref(null);
const imgLoaded     = ref(false);
const imgFailed     = ref(false);
const fetching      = ref(false);

let loadGen = 0;
let observer = null;

function disconnectObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

/** Torrent file fetch is expensive — only when this is true do we defer to IntersectionObserver. */
const needsTorrentFetch = computed(() => {
  const f = props.coverFile;
  return !!(
    f &&
    props.magnet &&
    isImage(f.path) &&
    f.size > 0 &&
    f.size <= MAX_TORRENT_COVER_BYTES
  );
});

const displaySrc = computed(() => {
  if (torrentCover.value) return torrentCover.value;
  if (needsTorrentFetch.value && props.cover) return props.cover;
  if (!needsTorrentFetch.value) return props.cover ?? null;
  return null;
});

const placeholderShimmer = computed(
  () =>
    fetching.value &&
    !torrentCover.value &&
    !(needsTorrentFetch.value && props.cover),
);

watch(displaySrc, () => {
  imgLoaded.value = false;
  imgFailed.value = false;
});

async function loadCover() {
  const gen = loadGen;
  torrentCover.value = null;
  imgLoaded.value     = false;
  imgFailed.value     = false;

  const f = props.coverFile;

  if (f && props.magnet && isImage(f.path) && f.size > 0 && f.size <= MAX_TORRENT_COVER_BYTES) {
    fetching.value = true;
    try {
      const url = await invoke("torrent_fetch_image", {
        magnet:  props.magnet,
        fileIdx: f.origIdx,
      });
      if (gen !== loadGen) return;
      if (url) {
        torrentCover.value = url;
        return;
      }
    } catch (_) {
      // torrent unavailable / timeout — fall through
    } finally {
      if (gen === loadGen) fetching.value = false;
    }
  }

  if (gen !== loadGen) return;
}

function scheduleCoverLoad() {
  disconnectObserver();
  loadGen += 1;
  torrentCover.value = null;
  imgLoaded.value = false;
  imgFailed.value = false;
  fetching.value = false;

  if (needsTorrentFetch.value) {
    nextTick(() => {
      const el = rootRef.value;
      if (!el) return;
      observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry?.isIntersecting) return;
          disconnectObserver();
          loadCover();
        },
        { rootMargin: "600px" }
      );
      observer.observe(el);
    });
  } else {
    loadCover();
  }
}

onMounted(() => {
  scheduleCoverLoad();
});

onUnmounted(() => {
  disconnectObserver();
});

watch(
  () => [props.magnet, props.coverFile?.origIdx, props.cover],
  scheduleCoverLoad,
);

const showImg   = computed(() => !!displaySrc.value && !imgFailed.value);
const isLoading = computed(() => showImg.value && !imgLoaded.value);

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
  <div ref="rootRef" class="album-folder-cover-root">
    <!-- Gradient placeholder — underneath; pulses while waiting for BT with no post preview -->
    <div
      class="album-folder-cover-placeholder"
      :class="{ shimmer: placeholderShimmer }"
      :style="gradientStyle"
    >
      <span v-if="!showImg || imgFailed" class="album-folder-cover-letter">{{ initial }}</span>
    </div>

    <!-- Post preview or torrent image -->
    <img
      v-if="showImg"
      :src="displaySrc"
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
