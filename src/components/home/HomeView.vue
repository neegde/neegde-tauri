<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import CoverThumb from "../shared/CoverThumb.vue";

const props = defineProps({
  recentHistory: { type: Array, default: () => [] },
});

const emit = defineEmits(["open-recent", "remove-recent", "go-to-search", "search-query"]);

// ── Monthly stats ─────────────────────────────────────────────────────────────
const thisMonthCount = computed(() => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  return props.recentHistory.filter((item) => {
    const d = new Date(item.openedAt);
    return d.getFullYear() === year && d.getMonth() === month;
  }).length;
});

const MONTH_NAMES = [
  "январе", "феврале", "марте", "апреле", "мае", "июне",
  "июле", "августе", "сентябре", "октябре", "ноябре", "декабре",
];
const currentMonthName = computed(() => MONTH_NAMES[new Date().getMonth()]);

// ── Artist pills ──────────────────────────────────────────────────────────────
const topArtists = computed(() => {
  const freq = {};
  for (const item of props.recentHistory) {
    const a = item.artist?.trim();
    if (a) freq[a] = (freq[a] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name]) => name);
});

// ── Recent history ────────────────────────────────────────────────────────────
const recentSlice = computed(() => props.recentHistory.slice(0, 10));

const isEmpty = computed(() => !recentSlice.value.length);

function torrentDisplayName(name = "") {
  return name.replace(/^\([^)]+\)\s*/, "");
}

const storySteps = [
  {
    title: "Нашли раздачу",
    caption: "Ищете альбом в каталоге Rutracker и открываете страницу раздачи.",
  },
  {
    title: "Выбираете трек",
    caption: "В списке файлов нажимаете нужный — приложение готовит поток.",
  },
  {
    title: "Пиры отдают куски",
    caption: "Клиент находит участников сети и получает фрагменты файла с разных машин.",
  },
  {
    title: "Буфер наполняется",
    caption: "Данные чуть забегают вперёд, чтобы звук шёл ровно, без пауз.",
  },
  {
    title: "Слушаете",
    caption: "Играет поток — целый альбом на диск качать не нужно.",
  },
];

const storyStep = ref(0);
const STORY_MS = 3200;
let storyTimerId = null;

onMounted(() => {
  if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  storyTimerId = window.setInterval(() => {
    storyStep.value = (storyStep.value + 1) % storySteps.length;
  }, STORY_MS);
});

onUnmounted(() => {
  if (storyTimerId != null) {
    window.clearInterval(storyTimerId);
    storyTimerId = null;
  }
});
</script>

<template src="./HomeView.html"></template>

<style scoped src="./HomeView.scoped.css"></style>

