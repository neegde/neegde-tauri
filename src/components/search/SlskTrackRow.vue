<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import {
  getSlskCoverDataUrl,
  peekSlskCover,
  getSlskCoverReactive,
} from "../../soulseek/coverCache.js";
import SlskContextMenu from "./SlskContextMenu.vue";

const props = defineProps({
  track:    { type: Object, required: true },
  enriched: { type: Object, default: null }, // { artist, title, coverUrl?, albumUrl? }
});

const emit = defineEmits(["play", "download", "like"]);

// ── Context menu ─────────────────────────────────────────────────────────────
const ctxMenu = ref(null); // { x, y } or null

function onContextMenu(e) {
  e.preventDefault();
  ctxMenu.value = { x: e.clientX, y: e.clientY };
}
function closeCtxMenu() { ctxMenu.value = null; }

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

function enrichedText(e) {
  return e.artist ? `${e.artist} — ${e.title}` : (e.title ?? "");
}

function initAnim() {
  clearAnim();
  if (props.enriched) {
    displayText.value = enrichedText(props.enriched);
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

    <!-- Name area: single line throughout (no DOM switch = no flicker) -->
    <div class="slsk-track-name-area">
      <span class="slsk-track-name-block">
        {{ displayText }}<span
          v-if="animPhase !== 'done'"
          class="slsk-cursor"
          :class="`slsk-cursor--${animPhase}`"
          aria-hidden="true"
        ></span>
      </span>
    </div>

    <Teleport to="body">
      <SlskContextMenu
        v-if="ctxMenu"
        :x="ctxMenu.x"
        :y="ctxMenu.y"
        :track="track"
        @close="closeCtxMenu"
        @play="emit('play', $event)"
        @download="emit('download', $event)"
        @like="emit('like', $event)"
      />
    </Teleport>

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
