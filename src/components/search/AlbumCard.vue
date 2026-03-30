<script setup>
import { ref, watch, onMounted, onUnmounted } from "vue";
import { getRutrackerCoverDataUrl, peekRutrackerCover, prefetchTorrentDetails } from "../../rutracker/search.js";

const props = defineProps({
  torrent: Object,
  selected: Boolean,
});

const emit = defineEmits(["select"]);

const seeds = Number(props.torrent.seeders) || 0;

function seedsLabel(n) {
  return `${n} сид${n === 1 ? "" : n < 5 ? "а" : "ов"}`;
}

const cardRef = ref(null);
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
    { rootMargin: "400px" }
  );

  const el = cardRef.value;
  if (el) observer.observe(el);
}

onMounted(setupCoverObserver);
onUnmounted(() => {
  resetCover();
  clearTimeout(hoverTimer);
});

// ── Hover-prefetch ────────────────────────────────────────────────────────────
let hoverTimer = null;

function onMouseenter() {
  if (props.torrent?.source !== "rutracker" || !props.torrent?.id) return;
  hoverTimer = setTimeout(() => prefetchTorrentDetails(String(props.torrent.id)), 300);
}

function onMouseleave() {
  clearTimeout(hoverTimer);
  hoverTimer = null;
}

watch(
  () => [props.torrent?.id, props.torrent?.source],
  () => setupCoverObserver()
);

</script>

<template>
  <div
    ref="cardRef"
    :class="['album-card', selected ? 'selected' : '']"
    :title="torrent.name"
    @click="emit('select', torrent)"
    @mouseenter="onMouseenter"
    @mouseleave="onMouseleave"
  >
    <div class="album-art">
      <img
        v-if="coverUrl && !coverErr"
        :src="coverUrl"
        class="album-art-img"
        alt=""
        @error="coverErr = true"
      />
      <svg v-else class="album-art-fallback" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M9 18V5l12-2v13"/>
        <circle cx="6" cy="18" r="3"/>
        <circle cx="18" cy="16" r="3"/>
      </svg>
      <button
        class="album-art-play"
        title="Открыть"
        @click.stop="emit('select', torrent)"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <polygon points="5,3 19,12 5,21"/>
        </svg>
      </button>
    </div>
    <div class="album-name">{{ torrent.name }}</div>
    <div class="album-meta">
      <span :class="['album-seeds', seeds > 0 ? 'seeds-ok' : 'seeds-dead']">
        {{ seedsLabel(seeds) }}
      </span>
    </div>
  </div>
</template>
