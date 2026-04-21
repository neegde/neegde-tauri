<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import {
  getSlskCoverDataUrl,
  peekSlskCover,
  getSlskCoverReactive,
} from "../../soulseek/coverCache.js";

const props = defineProps({
  track:    { type: Object, required: true },
  enriched: { type: Object, default: null }, // { artist, title, coverUrl?, albumUrl? }
});

const emit = defineEmits(["play"]);

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

// ── Cover art ────────────────────────────────────────────────────────────────

const rowRef  = ref(null);
const coverErr = ref(false);

const folderCoverUrl = computed(() => {
  const u = props.track?.slsk_cover_username;
  const p = props.track?.slsk_cover_filepath;
  if (!u || !p) return null;
  return getSlskCoverReactive(u, p);
});

// Folder cover takes priority; iTunes cover is a fallback for tracks without folder art
const coverUrl = computed(() => folderCoverUrl.value ?? props.enriched?.coverUrl ?? null);

watch(
  () => [props.track?.id, props.track?.slsk_cover_filepath, props.enriched?.coverUrl],
  () => { coverErr.value = false; },
);

let coverObserver = null;

function disconnectObserver() {
  if (coverObserver) { coverObserver.disconnect(); coverObserver = null; }
}

function setupCoverObserver() {
  disconnectObserver();
  coverErr.value = false;
  const u  = props.track?.slsk_cover_username;
  const p  = props.track?.slsk_cover_filepath;
  const sz = props.track?.slsk_cover_size ?? 0;
  if (!u || !p) return;
  if (peekSlskCover(u, p) !== undefined) return;
  coverObserver = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      disconnectObserver();
      void getSlskCoverDataUrl(u, p, sz).catch(() => {});
    },
    { rootMargin: "400px" },
  );
  const el = rowRef.value;
  if (el) coverObserver.observe(el);
}

watch(
  () => [props.track?.slsk_cover_filepath, props.track?.slsk_cover_username],
  () => nextTick(setupCoverObserver),
);

// ── Terminal cursor animation ─────────────────────────────────────────────────
// States: 'waiting' → 'erasing' → 'typing' → 'fading' → 'done'

const animPhase  = ref("waiting");
const displayText = ref("");
let animTimer = null;

const BASE_MS = 18;   // ms per character at default speed
const MAX_MS  = 650;  // cap on total erase+type duration

function clearAnim() { clearTimeout(animTimer); animTimer = null; }

function initAnim() {
  clearAnim();
  if (props.enriched) {
    animPhase.value  = "done";
  } else {
    displayText.value = props.track?.name ?? "";
    animPhase.value  = "waiting";
  }
}

onMounted(() => {
  initAnim();
  nextTick(setupCoverObserver);
});

// Reset when a different track is rendered in this row slot
watch(() => props.track?.id, initAnim);

watch(() => props.enriched, (val) => {
  if (!val || animPhase.value === "done") return;
  startEraseType(val);
});

function startEraseType(enriched) {
  clearAnim();
  const target  = enriched.artist
    ? `${enriched.artist} — ${enriched.title}`
    : (enriched.title ?? "");
  const source  = displayText.value;
  const total   = source.length + target.length;
  const msChar  = Math.min(BASE_MS, MAX_MS / Math.max(total, 1));

  animPhase.value = "erasing";
  let pos = source.length;

  (function eraseStep() {
    if (pos > 0) {
      displayText.value = source.slice(0, --pos);
      animTimer = setTimeout(eraseStep, msChar);
    } else {
      animPhase.value = "typing";
      pos = 0;
      (function typeStep() {
        if (pos < target.length) {
          displayText.value = target.slice(0, ++pos);
          animTimer = setTimeout(typeStep, msChar);
        } else {
          animPhase.value = "fading";
          animTimer = setTimeout(() => { animPhase.value = "done"; }, 380);
        }
      })();
    }
  })();
}

onUnmounted(() => {
  clearAnim();
  disconnectObserver();
});
</script>

<template>
  <div
    ref="rowRef"
    class="slsk-track-row"
    @click="emit('play', track)"
  >
    <div class="slsk-track-thumb-wrap" aria-hidden="true">
      <img
        v-if="coverUrl && !coverErr"
        class="slsk-track-thumb"
        :src="coverUrl"
        alt=""
        @error="coverErr = true"
      >
      <div v-else class="slsk-track-thumb slsk-track-thumb--placeholder" />
    </div>

    <button class="slsk-track-play" title="Слушать" @click.stop="emit('play', track)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <polygon points="5,3 19,12 5,21"/>
      </svg>
    </button>

    <!-- Name area: animated single-line → two-line enriched layout -->
    <div class="slsk-track-name-area">
      <!-- Final two-line layout after animation completes -->
      <div
        v-if="animPhase === 'done' && enriched"
        class="slsk-track-name-block slsk-track-name-block--enriched"
      >
        <span class="slsk-track-enriched-artist">{{ enriched.artist }}</span>
        <span class="slsk-track-enriched-title">{{ enriched.title }}</span>
      </div>
      <!-- Animated / static single line -->
      <span v-else class="slsk-track-name-block">
        {{ animPhase === 'done' ? (track.name ?? '') : displayText
        }}<span
          v-if="animPhase !== 'done'"
          class="slsk-cursor"
          :class="`slsk-cursor--${animPhase}`"
          aria-hidden="true"
        ></span>
      </span>
    </div>

    <span class="slsk-track-meta">
      <a
        v-if="enriched?.albumUrl"
        class="slsk-track-ext-link"
        :href="enriched.albumUrl"
        target="_blank"
        rel="noopener"
        title="Открыть в Apple Music"
        @click.stop
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/>
          <line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
      </a>
      <span
        v-if="Number(track.seeders) > 1"
        class="slsk-track-chip"
        title="Число пиров в выдаче с тем же релизом или файлом (чем больше, тем выше строка в списке)"
      >{{ track.seeders }}×</span>
      <span v-if="track.bitrate" class="slsk-track-chip">{{ track.bitrate }} kbps</span>
      <span v-else-if="trackExt(track)" class="slsk-track-chip">{{ trackExt(track) }}</span>
      <span v-if="track.duration" class="slsk-track-dur">{{ fmtDuration(track.duration) }}</span>
      <span v-else-if="track.size" class="slsk-track-dur">{{ fmtSize(track.size) }}</span>
    </span>
  </div>
</template>
