<script setup>
import { computed } from "vue";

const props = defineProps({
  /** null = hidden */
  importState: { type: Object, default: null },
});

const emit = defineEmits(["cancel", "dismiss"]);

const visible    = computed(() => props.importState != null);
const state      = computed(() => props.importState);
const isRunning  = computed(() => state.value?.status === "running");
const isDone     = computed(() => state.value?.status === "done" || state.value?.status === "cancelled");

const pct = computed(() => {
  const s = state.value;
  if (!s || s.total === 0) return 0;
  return Math.round((s.done / s.total) * 100);
});

const statusLabel = computed(() => {
  const s = state.value;
  if (!s) return "";
  if (s.status === "cancelled") return "Импорт остановлен";
  if (s.status === "done")      return "Импорт завершён";
  return `Обрабатываем треки… ${s.done} / ${s.total}`;
});

const recentEntries = computed(() => {
  const entries = state.value?.entries ?? [];
  // Show last 5 entries that are not pending
  return entries
    .filter((e) => e.status !== "pending")
    .slice(-5)
    .reverse();
});

function statusIcon(status) {
  if (status === "matched")   return "✓";
  if (status === "unmatched") return "–";
  if (status === "error")     return "!";
  return "…";
}

function statusClass(status) {
  if (status === "matched")   return "entry--matched";
  if (status === "unmatched") return "entry--unmatched";
  if (status === "error")     return "entry--error";
  return "entry--searching";
}
</script>

<template src="./ImportProgressOverlay.html"></template>
<style scoped src="./ImportProgressOverlay.scoped.css"></style>
