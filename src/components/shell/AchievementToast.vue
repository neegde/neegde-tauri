<script setup>
import { watch, onUnmounted } from "vue";
import SystemIcon from "../shared/SystemIcon.vue";

const props = defineProps({
  /** Achievement title (Russian). */
  title: { type: String, default: "" },
  /** Short description line. */
  description: { type: String, default: "" },
  /** When true, toast is visible. */
  open: { type: Boolean, default: false },
});

const emit = defineEmits(["update:open"]);

let hideTimer = 0;

/**
 * Schedules auto-dismiss; clears previous timer.
 *
 * Returns:
 *     void
 */
function scheduleHide() {
  if (hideTimer) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    hideTimer = 0;
    emit("update:open", false);
  }, 5500);
}

watch(
  () => props.open,
  (v) => {
    if (v) scheduleHide();
    else if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
    }
  }
);

onUnmounted(() => {
  if (hideTimer) window.clearTimeout(hideTimer);
});

/**
 * User closed the toast manually.
 *
 * Returns:
 *     void
 */
function close() {
  emit("update:open", false);
}
</script>

<template src="./AchievementToast.html"></template>

<style scoped src="./AchievementToast.scoped.css"></style>

