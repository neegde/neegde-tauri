<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { getRutrackerCoverDataUrl, peekRutrackerCover, getCoverReactive } from "../../rutracker/search.js";
import { getTorrentImageDataUrl, peekTorrentImage } from "../../torrent/torrentImageCache.js";
import { torrentFileB64ForTrack } from "../../torrent/api.js";
import { appDebugLog } from "../../appDebugLog.js";

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
 * Prefers in-torrent image when coverFileIdx is set; falls back to RuTracker topic cover (same as AlbumFolderCover).
 */
const coverUrl = computed(() => {
  const magnet = (props.magnet && props.magnet.trim()) || "";
  const idx =
    props.coverFileIdx != null && Number.isFinite(Number(props.coverFileIdx))
      ? Number(props.coverFileIdx)
      : null;

  if (magnet && idx != null) {
    const fromTorrent = peekTorrentImage(magnet, idx);
    if (fromTorrent) return fromTorrent;
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

  const torrentReady = Boolean(magnet && idx != null && peekTorrentImage(magnet, idx));
  const needTorrentFetch = Boolean(magnet && idx != null && !torrentReady);

  const rutrackerPeek =
    props.source === "rutracker" && topicId ? peekRutrackerCover(topicId) : undefined;
  const needRutrackerFetch =
    props.source === "rutracker" &&
    topicId &&
    rutrackerPeek === undefined &&
    !torrentReady;

  if (!needTorrentFetch && !needRutrackerFetch) return;

  observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      disconnectObserver();
      if (needTorrentFetch && magnet && idx != null) {
        void appDebugLog("cover", `CoverThumb visible — starting torrent cover fetch fileIdx=${idx} torrentId=${props.torrentId}`);
        torrentFileB64ForTrack({ source: props.source, torrentId: props.torrentId })
          .then((b64) => getTorrentImageDataUrl(magnet, idx, b64))
          .catch((e) => void appDebugLog("cover", `CoverThumb torrent fetch failed — fileIdx=${idx} err=${String(e)}`));
      }
      if (needRutrackerFetch && topicId) {
        void appDebugLog("cover", `CoverThumb visible — starting rutracker cover fetch topicId=${topicId}`);
        getRutrackerCoverDataUrl(topicId).catch((e) => void appDebugLog("cover", `CoverThumb rutracker fetch failed — topicId=${topicId} err=${String(e)}`));
      }
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
      @error="coverErr = true; appDebugLog('cover', `CoverThumb <img> onerror — cover rendered but browser rejected it torrentId=${props.torrentId} coverFileIdx=${props.coverFileIdx}`)"
    />
    <svg v-else class="cover-thumb-fallback" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
  </div>
</template>
