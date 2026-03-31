<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import AlbumCard from "./AlbumCard.vue";

const props = defineProps({
  results: Array,
  selectedId: { default: null },
  likes: { type: Object, default: () => ({}) },
});

const emit = defineEmits(["select", "toggle-like"]);

/**
 * Builds a torrent-level like object from a search result torrent.
 * @param {object} torrent
 * @returns {object}
 */
function makeTorrentLike(torrent) {
  return {
    id: `torrent:${torrent.source}:${torrent.id}`,
    type: "torrent",
    torrentId: torrent.id,
    torrentName: torrent.name,
    source: torrent.source,
    magnet: null,
    seeders: torrent.seeders,
  };
}

function isTorrentLiked(torrent) {
  return !!props.likes[`torrent:${torrent.source}:${torrent.id}`];
}

const INITIAL_BATCH = 40;
const BATCH_INCREMENT = 30;

const visibleCount = ref(INITIAL_BATCH);
const visibleResults = computed(() => props.results.slice(0, visibleCount.value));

watch(
  () => props.results,
  () => { visibleCount.value = INITIAL_BATCH; },
);

const sentinel = ref(null);
let observer = null;

function setupObserver() {
  if (!sentinel.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && visibleCount.value < props.results.length) {
        visibleCount.value = Math.min(visibleCount.value + BATCH_INCREMENT, props.results.length);
      }
    },
    { rootMargin: "200px" },
  );
  observer.observe(sentinel.value);
}

onMounted(setupObserver);
onUnmounted(() => observer?.disconnect());
</script>

<template>
  <div v-if="results.length">
    <div class="section-header">
      <h2 class="section-title">Результаты</h2>
      <span class="section-count">{{ results.length }} раздач</span>
    </div>
    <div class="results-grid">
      <AlbumCard
        v-for="(r, i) in visibleResults"
        :key="r.id ?? i"
        :torrent="r"
        :selected="selectedId === r.id"
        :liked="isTorrentLiked(r)"
        @select="emit('select', $event)"
        @toggle-like="emit('toggle-like', makeTorrentLike($event))"
      />
    </div>
    <div ref="sentinel" />
  </div>
</template>
