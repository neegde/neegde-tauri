<script setup>
import { computed, watch, onUnmounted } from "vue";

/**
 * Generic track context menu used by both Rutracker (TorrentView) and SoulSeek (SlskTrackRow).
 *
 * Props:
 *   open    — v-model boolean
 *   x, y    — screen coordinates (clientX / clientY)
 *   actions — array of { id, label, icon?, disabled? }
 *             icon: 'play' | 'download' | 'heart' | 'queue' | 'copy' | 'playlist' | 'source'
 *
 * Emits:
 *   update:open — to close (v-model)
 *   action(id)  — when a non-disabled item is clicked
 */

const props = defineProps({
  open:    { type: Boolean, default: false },
  x:       { type: Number, default: 0 },
  y:       { type: Number, default: 0 },
  actions: { type: Array, default: () => [] },
});

const emit = defineEmits(["update:open", "action"]);

const MENU_W = 220;
const MENU_H = 200;

const style = computed(() => {
  const pad  = 8;
  let left   = props.x;
  let top    = props.y;
  if (typeof window !== "undefined") {
    left = Math.min(left, window.innerWidth  - MENU_W - pad);
    top  = Math.min(top,  window.innerHeight - MENU_H - pad);
    left = Math.max(pad, left);
    top  = Math.max(pad, top);
  }
  return { left: `${left}px`, top: `${top}px` };
});

function close() {
  emit("update:open", false);
}

function onAction(id) {
  emit("action", id);
  close();
}

function onKeydown(e) {
  if (e.code === "Escape") close();
}

watch(
  () => props.open,
  (on) => {
    if (typeof document === "undefined") return;
    if (on) document.addEventListener("keydown", onKeydown);
    else    document.removeEventListener("keydown", onKeydown);
  },
);

onUnmounted(() => {
  if (typeof document !== "undefined") {
    document.removeEventListener("keydown", onKeydown);
  }
});
</script>

<template src="./TrackContextMenu.html"></template>

<style scoped src="./TrackContextMenu.scoped.css"></style>

