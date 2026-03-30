<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { getRutrackerCoverDataUrl, peekRutrackerCover, getCoverReactive, prefetchTorrentDetails } from "../../rutracker/search.js";

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
const coverErr = ref(false);
let observer = null;

/**
 * Reactive computed — auto-updates whenever coverCache is populated,
 * regardless of which code path stored the cover.
 */
const coverUrl = computed(() => {
  if (props.torrent?.source !== "rutracker" || !props.torrent?.id) return null;
  return getCoverReactive(String(props.torrent.id));
});

// Reset error state when torrent changes
watch(() => [props.torrent?.id, props.torrent?.source], () => { coverErr.value = false; });

function disconnectObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function setupCoverObserver() {
  disconnectObserver();
  coverErr.value = false;
  if (props.torrent?.source !== "rutracker" || !props.torrent?.id) return;

  const topicId = String(props.torrent.id);

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

  const el = cardRef.value;
  if (el) observer.observe(el);
}

onMounted(setupCoverObserver);
onUnmounted(() => {
  disconnectObserver();
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
