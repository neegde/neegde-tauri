<script setup>
import { ref, watch, onMounted, onUnmounted } from "vue";
import { getRutrackerCoverDataUrl, peekRutrackerCover } from "../rutracker/search.js";
import { getTorrentImageDataUrl, peekTorrentImage } from "../torrentImageCache.js";

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
});

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
</script>

<template>
  <div
    ref="rootRef"
    :class="['cover-thumb', fill ? 'cover-thumb--fill' : '']"
    :style="
      fill
        ? undefined
        : { width: size + 'px', height: size + 'px', borderRadius: radius + 'px' }
    "
  >
    <img
      v-if="coverUrl && !coverErr"
      :src="coverUrl"
      :class="fill ? 'album-art-img' : 'cover-thumb-img'"
      alt=""
      @error="coverErr = true"
    />
    <span v-else class="cover-thumb-fallback">{{ fallback }}</span>
  </div>
</template>
