<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { fmtSize } from "../utils.js";

const props = defineProps({
  torrent: Object,
  selected: Boolean,
});

const emit = defineEmits(["select"]);

const EMOJIS = ["🎵", "🎶", "🎸", "🎹", "🥁", "🎤", "🎼", "🎷", "🎺", "🪗"];

function hashStr(s) {
  let h = 0;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++)
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const emoji = EMOJIS[hashStr(props.torrent.id ?? props.torrent.name) % EMOJIS.length];
const seeds = Number(props.torrent.seeders) || 0;

function seedsLabel(n) {
  return `${n} сид${n === 1 ? "" : n < 5 ? "а" : "ов"}`;
}

const cardRef = ref(null);
// No backend: cover images won't load
</script>

<template>
  <div
    ref="cardRef"
    :class="['album-card', selected ? 'selected' : '']"
    :title="torrent.name"
    @click="emit('select', torrent)"
  >
    <div class="album-art">
      <span>{{ emoji }}</span>
      <button
        class="album-art-play"
        title="Открыть"
        @click.stop="emit('select', torrent)"
      >▶</button>
    </div>
    <div class="album-name">{{ torrent.name }}</div>
    <div class="album-meta">
      <span :class="['album-seeds', seeds > 0 ? 'seeds-ok' : 'seeds-dead']">
        {{ seedsLabel(seeds) }}
      </span>
      <span>·</span>
      <span>{{ fmtSize(torrent.size) }}</span>
    </div>
  </div>
</template>
