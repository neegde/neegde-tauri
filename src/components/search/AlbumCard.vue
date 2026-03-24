<script setup>
import { ref, watch, onMounted, onUnmounted } from "vue";
import { fmtSize } from "../../lib/utils.js";
import { getRutrackerCoverDataUrl, peekRutrackerCover } from "../../rutracker/search.js";
import CoverLightbox from "../shared/CoverLightbox.vue";

const props = defineProps({
  torrent: Object,
  selected: Boolean,
});

const emit = defineEmits(["select"]);

const EMOJIS = ["🎵", "🎶", "🎸", "🎹", "🥁", "🎤", "🎼", "🎷", "🎺", "🪗"];

function hashStr(s) {
  let h = 0;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++)
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const emoji = EMOJIS[hashStr(props.torrent.id ?? props.torrent.name) % EMOJIS.length];
const seeds = Number(props.torrent.seeders) || 0;

function seedsLabel(n) {
  return `${n} сид${n === 1 ? "" : n < 5 ? "а" : "ов"}`;
}

const cardRef = ref(null);
const coverUrl = ref(null);
const coverErr = ref(false);
const coverLightboxOpen = ref(false);
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

function setupCoverObserver() {
  resetCover();
  if (props.torrent?.source !== "rutracker" || !props.torrent?.id) return;

  const topicId = String(props.torrent.id);
  const gen = fetchGen;

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

  const el = cardRef.value;
  if (el) observer.observe(el);
}

onMounted(setupCoverObserver);
onUnmounted(resetCover);

watch(
  () => [props.torrent?.id, props.torrent?.source],
  () => setupCoverObserver()
);

function onCoverImageClick(e) {
  if (!coverUrl.value || coverErr.value) return;
  e.stopPropagation();
  coverLightboxOpen.value = true;
}
</script>

<template>
  <div
    ref="cardRef"
    :class="['album-card', selected ? 'selected' : '']"
    :title="torrent.name"
    @click="emit('select', torrent)"
  >
    <div class="album-art">
      <img
        v-if="coverUrl && !coverErr"
        :src="coverUrl"
        class="album-art-img album-art-img--zoomable"
        alt=""
        @error="coverErr = true"
        @click="onCoverImageClick"
      />
      <span v-else>{{ emoji }}</span>
      <button
        class="album-art-play"
        title="Открыть"
        @click.stop="emit('select', torrent)"
      >▶</button>
      <CoverLightbox v-model:open="coverLightboxOpen" :src="coverUrl || ''" :alt="torrent.name || ''" />
    </div>
    <div class="album-name">{{ torrent.name }}</div>
    <div class="album-meta">
      <span :class="['album-seeds', seeds > 0 ? 'seeds-ok' : 'seeds-dead']">
        {{ seedsLabel(seeds) }}
      </span>
      <span>·</span>
      <span>{{ fmtSize(torrent.size) }}</span>
    </div>
  </div>
</template>

<style scoped>
.album-art-img--zoomable {
  cursor: zoom-in;
  transition: transform 0.16s ease;
}
.album-art-img--zoomable:hover {
  transform: scale(1.04);
}
</style>
