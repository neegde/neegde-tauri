<script setup>
import { computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

const props = defineProps({
  /** null — скрыто */
  progress: { type: Object, default: null },
});

/** Развёрнутое модальное окно (false = компактная кнопка в углу). */
const expanded = defineModel("expanded", { type: Boolean, default: true });

const hasProgress = computed(() => props.progress != null);
const showModal = computed(() => hasProgress.value && expanded.value);
const showDock = computed(() => hasProgress.value && !expanded.value);

const phaseLabel = computed(() => {
  const p = props.progress?.phase;
  if (p === "preparing") return "Подготовка";
  if (p === "downloading") return "Загрузка";
  if (p === "copying") return "Сохранение";
  if (p === "done") return "Готово";
  if (p === "cancelled") return "Остановлено";
  return "Скачивание";
});

const isCancelled = computed(() => props.progress?.phase === "cancelled");

const canStop = computed(() => {
  const p = props.progress?.phase;
  return !!p && p !== "done" && p !== "cancelled";
});

/** Общий прогресс по очереди треков (последовательная загрузка). */
const overallPct = computed(() => {
  const p = props.progress;
  if (!p) return 0;
  const bt = p.batchTotal;
  if (!bt || bt < 2) {
    return Math.min(100, Math.max(0, p.pct ?? 0));
  }
  const bi = Math.max(0, (p.batchIndex ?? 1) - 1);
  const slice = (p.pct ?? 0) / 100 / bt;
  return Math.min(100, (bi / bt + slice) * 100);
});

const barPct = computed(() => {
  const p = props.progress;
  if (!p) return 0;
  if (p.phase === "copying" && p.copyTotal > 0 && p.copyIndex != null) {
    return Math.min(100, (p.copyIndex / p.copyTotal) * 100);
  }
  if (p.batchTotal > 1 && (p.phase === "downloading" || p.phase === "preparing")) {
    return overallPct.value;
  }
  return Math.min(100, Math.max(0, p.pct ?? 0));
});

const barIndeterminate = computed(() => props.progress?.phase === "preparing");

const fmtBytes = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} Б`;
  const u = ["КБ", "МБ", "ГБ", "ТБ"];
  let v = n;
  let i = -1;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

function minimize() {
  expanded.value = false;
}

function expand() {
  expanded.value = true;
}

async function requestStop() {
  if (!canStop.value) return;
  // IPC invoke can queue behind the long export call — emit reaches Rust immediately.
  await emit("torrent-export-cancel-request", {});
  try { await invoke("torrent_export_cancel"); } catch (_) {}
  try { await invoke("soulseek_export_cancel"); } catch (_) {}
}
</script>

<template src="./DownloadProgressOverlay.html"></template>

<style scoped src="./DownloadProgressOverlay.scoped.css"></style>

