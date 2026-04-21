<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import {
  getSlskCoverDataUrl,
  peekSlskCover,
  getSlskCoverReactive,
} from "../../soulseek/coverCache.js";
import TrackContextMenu from "../shared/TrackContextMenu.vue";

const props = defineProps({
  track:    { type: Object, required: true },
  enriched: { type: Object, default: null }, // { artist, title, coverUrl? }
});

const emit = defineEmits(["play", "download", "like", "open-source"]);

// ── Context menu ─────────────────────────────────────────────────────────────
const ctxOpen = ref(false);
const ctxX    = ref(0);
const ctxY    = ref(0);

const SLSK_CTX_ACTIONS = [
  { id: "source",   label: "Источник (SoulSeek)", icon: "source" },
  { id: "divider" },
  { id: "play",     label: "Слушать",     icon: "play"     },
  { id: "download", label: "Скачать",     icon: "download", disabled: true },
  { id: "divider" },
  { id: "like",     label: "В избранное", icon: "heart"    },
];

function onContextMenu(e) {
  ctxX.value = e.clientX;
  ctxY.value = e.clientY;
  ctxOpen.value = true;
}

function onCtxAction(id) {
  if (id === "source")   emit("open-source", props.track);
  if (id === "play")     emit("play",     props.track);
  if (id === "download") emit("download", props.track);
  if (id === "like")     emit("like",     props.track);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
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
const rowRef   = ref(null);
const coverErr = ref(false);

const folderCoverUrl = computed(() => {
  const u = props.track?.slsk_cover_username;
  const p = props.track?.slsk_cover_filepath;
  if (!u || !p) return null;
  return getSlskCoverReactive(u, p);
});

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
//
// Two-line layout is always used once animation starts (or enriched is set).
// The artist row starts collapsed (max-height:0, opacity:0) and expands when
// animPhase becomes 'fading', so the row height never jumps at 'done'.

const animPhase   = ref("waiting");
const displayText = ref("");         // title slot text during animation
let animTimer = null;

const BASE_MS = 18;
const MAX_MS  = 650;

// Artist row is visible in fading+done phases (if artist exists)
const artistVisible = computed(
  () => (animPhase.value === "fading" || animPhase.value === "done") && !!props.enriched?.artist,
);

function clearAnim() { clearTimeout(animTimer); animTimer = null; }

function initAnim() {
  clearAnim();
  if (props.enriched) {
    displayText.value = props.enriched.title ?? props.track?.name ?? "";
    animPhase.value   = "done";
  } else {
    displayText.value = props.track?.name ?? "";
    animPhase.value   = "waiting";
  }
}

onMounted(() => {
  initAnim();
  nextTick(setupCoverObserver);
});

watch(() => props.track?.id, initAnim);

watch(() => props.enriched, (val) => {
  if (!val || animPhase.value === "done") return;
  startEraseType(val);
});

function startEraseType(enriched) {
  clearAnim();
  // Only animate the title; artist will fade in separately at 'fading' phase
  const target  = enriched.title ?? "";
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
          // Start fading cursor + reveal artist row simultaneously
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
    @contextmenu.prevent="onContextMenu"
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

    <!-- Name area:
         - During 'waiting' (no enriched yet): single-line span
         - Once animating or enriched: two-line div with artist row starting collapsed.
           The artist row expands smoothly when animPhase hits 'fading',
           so row height never jumps at the 'done' transition. -->
    <div class="slsk-track-name-area">
      <!-- Plain single line while waiting for first enrichment -->
      <span v-if="animPhase === 'waiting'" class="slsk-track-name-block">
        {{ displayText }}<span class="slsk-cursor slsk-cursor--waiting" aria-hidden="true"></span>
      </span>
      <!-- Two-line layout: used from erasing phase onward -->
      <div v-else class="slsk-track-name-block slsk-track-name-block--enriched">
        <span
          class="slsk-track-enriched-artist"
          :class="{ 'slsk-track-enriched-artist--show': artistVisible }"
          aria-hidden="!artistVisible"
        >{{ enriched?.artist ?? '' }}</span>
        <span class="slsk-track-enriched-title">
          {{ displayText }}<span
            v-if="animPhase !== 'done'"
            class="slsk-cursor"
            :class="`slsk-cursor--${animPhase}`"
            aria-hidden="true"
          ></span>
        </span>
      </div>
    </div>

    <TrackContextMenu
      v-model:open="ctxOpen"
      :x="ctxX"
      :y="ctxY"
      :actions="SLSK_CTX_ACTIONS"
      @action="onCtxAction"
    />

    <span class="slsk-track-meta">
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
