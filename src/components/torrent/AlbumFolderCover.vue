<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import {
  isImage,
  basename,
  MAX_TORRENT_COVER_BYTES,
} from "../../lib/utils.js";
import { getTorrentImageDataUrl, peekTorrentImage } from "../../torrent/torrentImageCache.js";
import { torrentFileB64ForTrack } from "../../torrent/api.js";
import CoverLightbox from "../shared/CoverLightbox.vue";

const props = defineProps({
  magnet:    { type: String, default: "" },
  coverFile: { type: Object, default: null },  // image file entry from the torrent
  label:     { type: String, default: "" },
  /** Torrent-level cover data: URL — fallback when torrent image is unavailable. */
  cover:     { type: String, default: null },
  /** Клик по обложке — просмотр крупно (в галерее останавливает всплытие к карточке). */
  enlargeable: { type: Boolean, default: true },
  /** torrentId + source — нужны для загрузки .torrent-файла (быстрый путь без DHT). */
  torrentId: { type: [String, Number], default: null },
  source:    { type: String, default: "rutracker" },
});

const lightboxOpen = ref(false);

const rootRef = ref(null);
const imgLoaded = ref(false);
const imgFailed = ref(false);
const fetching  = ref(false);

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

/**
 * Reactive — reads from the shared torrentImageCache so CoverThumb and AlbumFolderCover
 * share the same result without a second BitTorrent connection.
 */
const torrentCover = computed(() => {
  const f = props.coverFile;
  if (!needsTorrentFetch.value || !f) return null;
  return peekTorrentImage(props.magnet, f.origIdx) ?? null;
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
  const f = props.coverFile;
  if (!f || !props.magnet || !isImage(f.path) || f.size <= 0 || f.size > MAX_TORRENT_COVER_BYTES) return;

  fetching.value = true;
  try {
    // torrentFileB64ForTrack shares the same in-memory cache as streamUrl(), so no extra
    // network request if the .torrent was already downloaded for streaming or another cover.
    const b64 = await torrentFileB64ForTrack({ source: props.source, torrentId: props.torrentId });
    // getTorrentImageDataUrl deduplicates concurrent fetches for the same (magnet, fileIdx),
    // so AlbumFolderCover and CoverThumb never open two BitTorrent connections for one image.
    await getTorrentImageDataUrl(props.magnet, f.origIdx, b64);
  } catch (_) {
    // torrent unavailable / timeout — fall through to placeholder
  } finally {
    fetching.value = false;
  }
}

function scheduleCoverLoad() {
  disconnectObserver();
  imgFailed.value = false;
  fetching.value = false;

  if (needsTorrentFetch.value && !torrentCover.value) {
    nextTick(() => {
      const el = rootRef.value;
      if (!el) return;
      observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry?.isIntersecting) return;
          disconnectObserver();
          void loadCover();
        },
        { rootMargin: "600px" }
      );
      observer.observe(el);
    });
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

const canEnlarge = computed(
  () => props.enlargeable && showImg.value && Boolean(displaySrc.value)
);

function onCoverClick(e) {
  if (!canEnlarge.value) return;
  e.stopPropagation();
  lightboxOpen.value = true;
}
</script>

<template src="./AlbumFolderCover.html"></template>

<style scoped src="./AlbumFolderCover.scoped.css"></style>

