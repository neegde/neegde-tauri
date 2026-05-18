<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { parseImportText, type ParsedTrack } from "../../import/parseFile.js";
import { playlists } from "../../stores/library.js";
import type { ImportDestination } from "../../import/runImport.js";
import SystemIcon from "../shared/SystemIcon.vue";

export type ImportStartPayload = {
  tracks: ParsedTrack[];
  destination: ImportDestination | { kind: "playlist-new"; title: string };
};

const emit = defineEmits<{
  "start-import": [payload: ImportStartPayload];
}>();

const props = defineProps({
  importRunning: { type: Boolean, default: false },
});

const modalOpen = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const parsedTracks = ref<ParsedTrack[]>([]);
const parseError = ref("");
const fileName = ref("");

const destKind = ref<"likes" | "playlist">("likes");
const playlistMode = ref<"existing" | "new">("existing");
const selectedPlaylistId = ref("");
const newPlaylistTitle = ref("Импорт");

const trackCount = computed(() => parsedTracks.value.length);
const hasPlaylists = computed(() => playlists.value.length > 0);

const playlistOptions = computed(() =>
  playlists.value.map((pl) => ({ id: pl.id, title: pl.title })),
);

const destinationReady = computed(() => {
  if (destKind.value === "likes") return true;
  if (playlistMode.value === "new" || !hasPlaylists.value) {
    return newPlaylistTitle.value.trim().length > 0;
  }
  return Boolean(selectedPlaylistId.value);
});

const canStart = computed(
  () => trackCount.value > 0 && !props.importRunning && destinationReady.value,
);

const destinationPreview = computed(() => {
  if (destKind.value === "likes") return "в «Мне нравится»";
  if (playlistMode.value === "new" || !hasPlaylists.value) {
    const t = newPlaylistTitle.value.trim() || "Импорт";
    return `в новый плейлист «${t}»`;
  }
  const pl = playlists.value.find((p) => p.id === selectedPlaylistId.value);
  return pl ? `в «${pl.title}»` : "в плейлист";
});

watch(
  [hasPlaylists, destKind],
  () => {
    if (destKind.value !== "playlist") return;
    if (!hasPlaylists.value) {
      playlistMode.value = "new";
      return;
    }
    if (playlistMode.value === "existing" && !selectedPlaylistId.value) {
      selectedPlaylistId.value = playlists.value[0]?.id ?? "";
    }
  },
  { immediate: true },
);

watch(playlistMode, (mode) => {
  if (mode === "existing" && hasPlaylists.value && !selectedPlaylistId.value) {
    selectedPlaylistId.value = playlists.value[0]?.id ?? "";
  }
});

watch(
  () => props.importRunning,
  (running, wasRunning) => {
    if (running) modalOpen.value = false;
    if (wasRunning && !running) {
      parsedTracks.value = [];
      fileName.value = "";
      parseError.value = "";
    }
  },
);

function openModal() {
  if (props.importRunning) return;
  modalOpen.value = true;
}

defineExpose({ openModal });

function closeModal() {
  if (props.importRunning) return;
  modalOpen.value = false;
}

function triggerPick() {
  fileInputRef.value?.click();
}

async function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  parseError.value = "";
  fileName.value = file.name;

  const text = await file.text();
  const tracks = parseImportText(text);
  if (tracks.length === 0) {
    parseError.value =
      "Не найдено строк в формате «Исполнитель - Название». Проверьте файл.";
    parsedTracks.value = [];
  } else {
    parsedTracks.value = tracks;
  }

  input.value = "";
}

function buildDestination(): ImportStartPayload["destination"] {
  if (destKind.value === "likes") return { kind: "likes" };
  if (playlistMode.value === "new" || !hasPlaylists.value) {
    return { kind: "playlist-new", title: newPlaylistTitle.value.trim() || "Импорт" };
  }
  return { kind: "playlist", playlistId: selectedPlaylistId.value };
}

function handleStart() {
  if (!canStart.value) return;
  emit("start-import", {
    tracks: parsedTracks.value,
    destination: buildDestination(),
  });
}

function trackCountLabel(n: number): string {
  if (n === 1) return "трек";
  if (n >= 2 && n <= 4) return "трека";
  return "треков";
}
</script>

<template src="./ImportLikesPanel.html"></template>
<style scoped src="./ImportLikesPanel.scoped.css"></style>
