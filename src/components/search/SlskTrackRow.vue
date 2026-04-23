<script setup>
import { ref, computed, watch, onMounted, onUnmounted, toRef } from "vue";
import { getAlbum, entitiesVersion } from "../../stores/entities.js";
import { useEntityCover } from "../../composables/useEntityCover.js";
import TrackContextMenu from "../shared/TrackContextMenu.vue";

/**
 * Row for a SoulSeek Track entity. Reads Track directly; cover info is
 * resolved via the parent Album (through the entities registry) when the
 * Track is an album child, otherwise from `track.sources[0].raw.cover`
 * stored by the provider for orphan singles.
 */
const props = defineProps({
  /** @type {import("vue").PropType<import("../../types/entities.js").Track>} */
  track: { type: Object, required: true },
  /** Metadata enrichment from iTunes / filename parser: { artist, title, coverUrl? } */
  enriched: { type: Object, default: null },
});

const emit = defineEmits(["play", "download", "like", "open-source", "add-to-playlist"]);

// ── Derived fields ───────────────────────────────────────────────────────────

/** Peers count — from parent Album when track has albumId, else from orphan's raw. */
const peers = computed(() => {
  entitiesVersion.value; // react when parent registers/updates
  if (props.track.albumId) {
    const parent = getAlbum(props.track.albumId);
    if (parent?.peers) return parent.peers;
  }
  return props.track.sources?.[0]?.raw?.peers ?? 0;
});

const trackExt = computed(() => {
  const fn = props.track.fileName ?? "";
  const dot = fn.lastIndexOf(".");
  return dot >= 0 ? fn.slice(dot + 1).toUpperCase() : "";
});

// ── Context menu ─────────────────────────────────────────────────────────────
const ctxOpen = ref(false);
const ctxX = ref(0);
const ctxY = ref(0);

const SLSK_CTX_ACTIONS = [
  { id: "source",   label: "Источник (SoulSeek)", icon: "source" },
  { id: "divider" },
  { id: "play",     label: "Слушать",     icon: "play"     },
  { id: "download", label: "Скачать",     icon: "download" },
  { id: "divider" },
  { id: "like",     label: "В избранное", icon: "heart"    },
  { id: "playlist", label: "В плейлист",  icon: "playlist" },
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
  if (id === "playlist") emit("add-to-playlist", props.track);
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

// ── Cover art ────────────────────────────────────────────────────────────────
const rowRef = ref(null);
const entityCover = useEntityCover(toRef(props, "track"), rowRef);
// Fall back to iTunes/filename-parser enriched cover when the SoulSeek folder
// has none.
const coverUrl = computed(() => entityCover.coverUrl.value ?? props.enriched?.coverUrl ?? null);
const coverErr = entityCover.coverErr;

// ── Title animation (preserved from previous impl) ───────────────────────────
const animPhase = ref("waiting");
const displayText = ref("");
let animTimer = null;

const BASE_MS = 18;
const MAX_MS = 650;

const artistVisible = computed(
  () => (animPhase.value === "fading" || animPhase.value === "done") && !!props.enriched?.artist,
);

function clearAnim() { clearTimeout(animTimer); animTimer = null; }

function initAnim() {
  clearAnim();
  if (props.enriched) {
    displayText.value = props.enriched.title ?? props.track.fileName ?? "";
    animPhase.value = "done";
  } else {
    displayText.value = props.track.fileName ?? "";
    animPhase.value = "waiting";
  }
}

onMounted(initAnim);

watch(() => props.track?.id, initAnim);

watch(() => props.enriched, (val) => {
  if (!val || animPhase.value === "done") return;
  startEraseType(val);
});

function startEraseType(enriched) {
  clearAnim();
  const target = enriched.title ?? "";
  const source = displayText.value;
  const total = source.length + target.length;
  const msChar = Math.min(BASE_MS, MAX_MS / Math.max(total, 1));

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

onUnmounted(clearAnim);
</script>

<template src="./SlskTrackRow.html"></template>
