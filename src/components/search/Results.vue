<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import AlbumCard from "./AlbumCard.vue";
import { isLikelyPlayable } from "../../lib/utils.js";

const props = defineProps({
  results: Array,
  selectedId: { default: null },
});

const emit = defineEmits(["select", "play-slsk-track"]);

const INITIAL_BATCH = 40;
const BATCH_INCREMENT = 30;

const isSoulseek = computed(() => props.results[0]?.source === "soulseek");

// ── Rutracker path (unchanged) ─────────────────────────────────────────────
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

onMounted(setupObserver);
onUnmounted(() => observer?.disconnect());

// ── SoulSeek path ──────────────────────────────────────────────────────────
const slskAlbums = computed(() =>
  isSoulseek.value ? props.results.filter((r) => r.slsk_type === "album") : []
);
const slskTracks = computed(() =>
  isSoulseek.value ? props.results.filter((r) => r.slsk_type === "track") : []
);

const slskView = ref("albums"); // "albums" | "tracks"
// Auto-switch if one section is empty
watch([slskAlbums, slskTracks], ([albums, tracks]) => {
  if (slskView.value === "albums" && !albums.length && tracks.length) slskView.value = "tracks";
  if (slskView.value === "tracks" && !tracks.length && albums.length) slskView.value = "albums";
});
watch(() => props.results, () => { slskView.value = "albums"; });

function fmtDuration(secs) {
  if (!secs) return "";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtSize(bytes) {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function trackExt(track) {
  const fp = track.slsk_filepath ?? track.name ?? "";
  const dot = fp.lastIndexOf(".");
  return dot >= 0 ? fp.slice(dot + 1).toUpperCase() : "";
}
</script>

<template>
  <div v-if="results.length">

    <!-- ── SoulSeek layout ──────────────────────────────────────────────────── -->
    <template v-if="isSoulseek">

      <div class="section-header">
        <h2 class="section-title">Результаты</h2>
        <div class="slsk-view-tabs">
          <button
            :class="['slsk-tab', slskView === 'albums' ? 'active' : '']"
            :disabled="!slskAlbums.length"
            @click="slskView = 'albums'"
          >
            Альбомы
            <span class="slsk-tab-count">{{ slskAlbums.length }}</span>
          </button>
          <button
            :class="['slsk-tab', slskView === 'tracks' ? 'active' : '']"
            :disabled="!slskTracks.length"
            @click="slskView = 'tracks'"
          >
            Треки
            <span class="slsk-tab-count">{{ slskTracks.length }}</span>
          </button>
        </div>
      </div>

      <!-- Albums section -->
      <div v-if="slskView === 'albums'" class="results-grid">
        <AlbumCard
          v-for="r in slskAlbums"
          :key="r.id"
          :torrent="r"
          :selected="selectedId === r.id"
          @select="emit('select', $event)"
        />
      </div>

      <!-- Tracks section -->
      <div v-if="slskView === 'tracks'" class="slsk-tracklist">
        <div
          v-for="t in slskTracks"
          :key="t.id"
          class="slsk-track-row"
          @click="emit('play-slsk-track', t)"
        >
          <button class="slsk-track-play" title="Слушать" @click.stop="emit('play-slsk-track', t)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <polygon points="5,3 19,12 5,21"/>
            </svg>
          </button>
          <span class="slsk-track-name">{{ t.name }}</span>
          <span class="slsk-track-meta">
            <span v-if="t.bitrate" class="slsk-track-chip">{{ t.bitrate }} kbps</span>
            <span v-else-if="trackExt(t)" class="slsk-track-chip">{{ trackExt(t) }}</span>
            <span v-if="t.duration" class="slsk-track-dur">{{ fmtDuration(t.duration) }}</span>
            <span v-else-if="t.size" class="slsk-track-dur">{{ fmtSize(t.size) }}</span>
          </span>
        </div>
      </div>

    </template>

    <!-- ── Rutracker layout (unchanged) ────────────────────────────────────── -->
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
