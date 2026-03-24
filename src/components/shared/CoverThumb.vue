<script setup>
import { ref, watch, onMounted, onUnmounted } from "vue";
import CoverLightbox from "./CoverLightbox.vue";
import { getRutrackerCoverDataUrl, peekRutrackerCover } from "../../rutracker/search.js";
import { getTorrentImageDataUrl, peekTorrentImage } from "../../torrent/torrentImageCache.js";

const props = defineProps({
  torrentId: [String, Number],
  source: String,
  /** Magnet URI — нужен вместе с coverFileIdx для обложки из файла раздачи. */
  magnet: { type: String, default: "" },
  /** Индекс файла картинки в торренте (папка альбома), не обложка темы на форуме. */
  coverFileIdx: { type: [Number, null], default: null },
  size: { type: Number, default: 44 },
  radius: { type: Number, default: 4 },
  fallback: { type: String, default: "🎵" },
  /** Заполняет родителя (например `.album-art` в сетке лайков). */
  fill: { type: Boolean, default: false },
  /** Клик — полноэкранный просмотр обложки */
  enlargeable: { type: Boolean, default: false },
});

const lightboxOpen = ref(false);

const rootRef = ref(null);
const coverUrl = ref(null);
const coverErr = ref(false);
let observer = null;
let fetchGen = 0;

function resetCover() {
  fetchGen += 1;
  coverUrl.value = null;
  coverErr.value = false;
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function setupCover() {
  resetCover();

  const magnet = (props.magnet && props.magnet.trim()) || "";
  const idx =
    props.coverFileIdx != null && Number.isFinite(Number(props.coverFileIdx))
      ? Number(props.coverFileIdx)
      : null;
  const topicId =
    props.torrentId != null && props.torrentId !== ""
      ? String(props.torrentId)
      : null;

  const gen = fetchGen;

  const tryTorrentFirst = magnet && idx != null;

  if (tryTorrentFirst) {
    const hit = peekTorrentImage(magnet, idx);
    if (hit) {
      coverUrl.value = hit;
      return;
    }

    observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer?.disconnect();
        observer = null;
        getTorrentImageDataUrl(magnet, idx)
          .then((u) => {
            if (gen !== fetchGen) return;
            if (u) coverUrl.value = u;
            /* Не подставляем обложку темы форума — это другая картинка, чем файл из папки альбома. */
          })
          .catch(() => {});
      },
      { rootMargin: "200px" }
    );
    const el = rootRef.value;
    if (el) observer.observe(el);
    return;
  }

  if (props.source !== "rutracker" || !topicId) return;

  const cached = peekRutrackerCover(topicId);
  if (cached !== undefined) {
    if (cached) coverUrl.value = cached;
    return;
  }

  observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      observer?.disconnect();
      observer = null;
      getRutrackerCoverDataUrl(topicId)
        .then((u) => {
          if (gen !== fetchGen) return;
          if (u) coverUrl.value = u;
        })
        .catch(() => {});
    },
    { rootMargin: "200px" }
  );

  const el = rootRef.value;
  if (el) observer.observe(el);
}

onMounted(setupCover);
watch(
  () => [props.torrentId, props.source, props.magnet, props.coverFileIdx],
  () => setupCover()
);
onUnmounted(resetCover);

function canEnlarge() {
  return props.enlargeable && coverUrl.value && !coverErr.value;
}

function onThumbClick(e) {
  if (!canEnlarge()) return;
  e.stopPropagation();
  lightboxOpen.value = true;
}

function onThumbKeydown(e) {
  if (!canEnlarge()) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    e.stopPropagation();
    lightboxOpen.value = true;
  }
}
</script>

<template>
  <div
    ref="rootRef"
    :class="[
      'cover-thumb',
      fill ? 'cover-thumb--fill' : '',
      canEnlarge() ? 'cover-thumb--enlargeable' : '',
    ]"
    :style="
      fill
        ? undefined
        : { width: size + 'px', height: size + 'px', borderRadius: radius + 'px' }
    "
    :tabindex="canEnlarge() ? 0 : undefined"
    :role="canEnlarge() ? 'button' : undefined"
    :aria-label="canEnlarge() ? 'Показать обложку крупно' : undefined"
    @click="onThumbClick"
    @keydown="onThumbKeydown"
  >
    <img
      v-if="coverUrl && !coverErr"
      :src="coverUrl"
      :class="fill ? 'album-art-img' : 'cover-thumb-img'"
      alt=""
      @error="coverErr = true"
    />
    <span v-else class="cover-thumb-fallback">{{ fallback }}</span>
    <CoverLightbox v-model:open="lightboxOpen" :src="coverUrl || ''" alt="" />
  </div>
</template>

<style scoped>
.cover-thumb--enlargeable {
  cursor: zoom-in;
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}
.cover-thumb--enlargeable:hover {
  transform: scale(1.04);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
}
.cover-thumb--enlargeable:focus-visible {
  outline: 2px solid var(--accent, #1db954);
  outline-offset: 2px;
}
[data-theme="light"] .cover-thumb--enlargeable:hover {
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
}
</style>
