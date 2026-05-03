<script setup>
import { ref, computed, onUnmounted, toRef } from "vue";
import {
  getSlskCoverDataUrl,
  peekSlskCover,
} from "../../soulseek/coverCache.js";
import { prefetchTorrentDetails } from "../../rutracker/search.js";
import { useEntityCover } from "../../composables/useEntityCover.js";

/**
 * Album card — the single display component for both RuTracker and
 * SoulSeek releases. Reads directly from an `Album` entity.
 */
const props = defineProps({
  /** @type {import("vue").PropType<import("../../types/entities.js").Album>} */
  album: { type: Object, required: true },
  selected: { type: Boolean, default: false },
});

const emit = defineEmits(["select"]);

const source = computed(() => props.album.sources?.[0]?.kind ?? null);
const isSoulseek = computed(() => source.value === "soulseek");
const isRutracker = computed(() => source.value === "rutracker");

const topicId = computed(() =>
  isRutracker.value ? props.album.sources[0]?.refs?.topicId ?? null : null,
);

const slskCover = computed(() =>
  isSoulseek.value ? props.album.sources[0]?.raw?.cover ?? null : null,
);

const seeders = computed(() => props.album.seeders ?? 0);
const peers = computed(() => props.album.peers ?? 0);
const trackCount = computed(() => props.album.trackIds?.length ?? 0);
const title = computed(() =>
  props.album.artist ? `${props.album.artist} — ${props.album.title}` : props.album.title,
);

const formatLabel = computed(() => {
  const fmt = props.album.format;
  const br = props.album.bitrate;
  if (fmt && br) return `${fmt} ${br}`;
  return fmt ?? null;
});

function seedsLabel(n) {
  return `${n} сид${n === 1 ? "" : n < 5 ? "а" : "ов"}`;
}

function tracksLabel(n) {
  return `${n} ${n === 1 ? "трек" : n < 5 ? "трека" : "треков"}`;
}

const cardRef = ref(null);
const { coverUrl, coverErr } = useEntityCover(toRef(props, "album"), cardRef);

// ── Hover prefetch (RT details warm-up / SLSK cover eager fetch) ─────────────
let hoverTimer = null;

function onMouseenter() {
  if (!isRutracker.value || !topicId.value) return;
  hoverTimer = setTimeout(() => prefetchTorrentDetails(String(topicId.value)), 300);
}

function onMouseenterSlsk() {
  const u = slskCover.value?.slsk_username;
  const p = slskCover.value?.slsk_filepath;
  const sz = slskCover.value?.size ?? 0;
  if (!u || !p) return;
  if (peekSlskCover(u, p) !== undefined) return;
  void getSlskCoverDataUrl(u, p, sz).catch(() => {});
}

function onMouseleave() {
  clearTimeout(hoverTimer);
  hoverTimer = null;
}

onUnmounted(() => clearTimeout(hoverTimer));
</script>

<template src="./AlbumCard.html"></template>
