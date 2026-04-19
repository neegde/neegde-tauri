<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import AlbumCard from "./AlbumCard.vue";
import SlskTrackRow from "./SlskTrackRow.vue";
import { isLikelyPlayable } from "../../lib/utils.js";

const props = defineProps({
  results: Array,
  selectedId: { default: null },
});

const emit = defineEmits(["select", "play-slsk-track"]);

const INITIAL_BATCH = 40;
const BATCH_INCREMENT = 30;

const isSoulseek = computed(() => props.results[0]?.source === "soulseek");

const playableResults = computed(() =>
  isSoulseek.value
    ? props.results
    : props.results.filter((r) => isLikelyPlayable(r.name, r.category))
);
const hiddenCount = computed(() => props.results.length - playableResults.value.length);

const visibleCount = ref(INITIAL_BATCH);
const visibleResults = computed(() => playableResults.value.slice(0, visibleCount.value));

watch(() => props.results, () => { visibleCount.value = INITIAL_BATCH; });
watch(playableResults, () => { visibleCount.value = INITIAL_BATCH; });

const sentinel = ref(null);
let observer = null;

function setupObserver() {
  if (!sentinel.value) return;
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && visibleCount.value < playableResults.value.length) {
        visibleCount.value = Math.min(visibleCount.value + BATCH_INCREMENT, playableResults.value.length);
      }
    },
    { rootMargin: "200px" },
  );
  observer.observe(sentinel.value);
}

onMounted(() => {
  nextTick(setupObserver);
});
onUnmounted(() => observer?.disconnect());

watch(
  () => [props.results?.length, isSoulseek.value],
  () => nextTick(setupObserver),
);
</script>

<template>
  <div v-if="results.length">

    <!-- ── SoulSeek: flat track list + covers ─────────────────────────────── -->
    <template v-if="isSoulseek">
      <div class="section-header">
        <h2 class="section-title">Результаты</h2>
        <span class="section-count">{{ playableResults.length }} треков</span>
      </div>
      <div class="slsk-tracklist">
        <SlskTrackRow
          v-for="t in visibleResults"
          :key="t.id"
          :track="t"
          @play="emit('play-slsk-track', $event)"
        />
      </div>
      <div ref="sentinel" />
    </template>

    <!-- ── Rutracker ─────────────────────────────────────────────────────── -->
    <template v-else>
      <div class="section-header">
        <h2 class="section-title">Результаты</h2>
        <span class="section-count">
          {{ playableResults.length }} раздач
          <span v-if="hiddenCount > 0" class="section-count-hidden">(скрыто {{ hiddenCount }} видео)</span>
        </span>
      </div>
      <div class="results-grid">
        <AlbumCard
          v-for="(r, i) in visibleResults"
          :key="r.id ?? i"
          :torrent="r"
          :selected="selectedId === r.id"
          @select="emit('select', $event)"
        />
      </div>
      <div ref="sentinel" />
    </template>

  </div>
</template>
