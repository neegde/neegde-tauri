<script setup>
import { ref, computed } from "vue";
import { parseImportText } from "../../import/parseFile.js";

const emit = defineEmits(["start-import"]);

const props = defineProps({
  /** True while import is running (to disable the start button). */
  importRunning: { type: Boolean, default: false },
});

const fileInputRef = ref(null);
const parsedTracks = ref([]);
const parseError   = ref("");
const fileName     = ref("");

const trackCount = computed(() => parsedTracks.value.length);
const canStart   = computed(() => trackCount.value > 0 && !props.importRunning);

function triggerPick() {
  fileInputRef.value?.click();
}

async function handleFileSelect(e) {
  const file = e.target?.files?.[0];
  if (!file) return;

  parseError.value = "";
  fileName.value   = file.name;

  try {
    const text = await file.text();
    const tracks = parseImportText(text);
    if (tracks.length === 0) {
      parseError.value = "Не найдено строк в формате «Исполнитель - Название». Проверьте файл.";
      parsedTracks.value = [];
    } else {
      parsedTracks.value = tracks;
    }
  } catch (err) {
    parseError.value = `Не удалось прочитать файл: ${err}`;
    parsedTracks.value = [];
  }

  // Reset so the same file can be re-picked if needed
  e.target.value = "";
}

function handleStart() {
  if (!canStart.value) return;
  emit("start-import", parsedTracks.value);
}
</script>

<template src="./ImportLikesPanel.html"></template>
<style scoped src="./ImportLikesPanel.scoped.css"></style>
