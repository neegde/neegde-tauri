<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { getRutrackerCoverDataUrl, peekRutrackerCover, getCoverReactive } from "../../rutracker/search.js";
import { getTorrentImageDataUrl, peekTorrentImage } from "../../torrent/torrentImageCache.js";
import { torrentFileB64ForTrack } from "../../torrent/api.js";

const props = defineProps({
  torrentId: [String, Number],
  source: String,
  /** Magnet URI — нужен вместе с coverFileIdx для обложки из файла раздачи. */
  magnet: { type: String, default: "" },
  /** Индекс файла картинки в торренте (папка альбома), не обложка темы на форуме. */
  coverFileIdx: { type: [Number, null], default: null },
  size: { type: Number, default: 44 },
  radius: { type: Number, default: 4 },
  /** Заполняет родителя (например `.album-art` в сетке лайков). */
  fill: { type: Boolean, default: false },
});

const rootRef = ref(null);
const coverErr = ref(false);
let observer = null;

/**
 * Reactive computed — auto-updates whenever either cover cache is populated,
 * regardless of which code path stored the cover (own fetch, hover-prefetch, torrent details, etc.).
 */
const coverUrl = computed(() => {
  const magnet = (props.magnet && props.magnet.trim()) || "";
  const idx =
    props.coverFileIdx != null && Number.isFinite(Number(props.coverFileIdx))
      ? Number(props.coverFileIdx)
      : null;

  if (magnet && idx != null) {
    return peekTorrentImage(magnet, idx) || null;
  }

  if (props.source !== "rutracker" || props.torrentId == null || props.torrentId === "") return null;
  return getCoverReactive(props.torrentId);
});

// Reset error state when the cover source changes
watch(
  () => [props.torrentId, props.source, props.magnet, props.coverFileIdx],
  () => { coverErr.value = false; }
);

function disconnectObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function setupCover() {
  disconnectObserver();
  coverErr.value = false;

  const magnet = (props.magnet && props.magnet.trim()) || "";
  const idx =
    props.coverFileIdx != null && Number.isFinite(Number(props.coverFileIdx))
      ? Number(props.coverFileIdx)
      : null;
  const topicId =
    props.torrentId != null && props.torrentId !== ""
      ? String(props.torrentId)
      : null;

  if (magnet && idx != null) {
    // Already cached → computed shows it immediately, no fetch needed
    if (peekTorrentImage(magnet, idx)) return;

    observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        disconnectObserver();
        // Fire-and-forget: result stored in reactive torrentImageCache → computed auto-updates
        torrentFileB64ForTrack({ source: props.source, torrentId: props.torrentId })
          .then((b64) => getTorrentImageDataUrl(magnet, idx, b64))
          .catch(() => {});
      },
      { rootMargin: "400px" }
    );
    const el = rootRef.value;
    if (el) observer.observe(el);
    return;
  }

  if (props.source !== "rutracker" || !topicId) return;

  // Skip observer if cover already fetched (hit) or confirmed absent (null in LRU)
  const cached = peekRutrackerCover(topicId);
  if (cached !== undefined) return;

  observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      disconnectObserver();
      // Fire-and-forget: result stored in reactive coverCache → computed auto-updates
      getRutrackerCoverDataUrl(topicId).catch(() => {});
    },
    { rootMargin: "400px" }
  );

  const el = rootRef.value;
  if (el) observer.observe(el);
}

onMounted(setupCover);
watch(
  () => [props.torrentId, props.source, props.magnet, props.coverFileIdx],
  () => setupCover()
);
onUnmounted(disconnectObserver);
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
    <svg v-else class="cover-thumb-fallback" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
  </div>
</template>
