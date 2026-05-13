<script setup lang="ts">
import { computed, onUnmounted, watch } from "vue";
import {
  coverReloadToast,
  dismissCoverReload,
  type CoverReloadStepState,
} from "../../cover/coverReloadStatus.js";

let hideTimer: ReturnType<typeof window.setTimeout> | null = null;

const state = computed(() => coverReloadToast.value);

/**
 * Maps step state to a short marker shown in the floating card.
 *
 * @param stepState - Logical state for a cover reload step.
 * @returns User-visible marker.
 */
function stepMarker(stepState: CoverReloadStepState): string {
  if (stepState === "success") return "OK";
  if (stepState === "fail") return "!";
  if (stepState === "pending") return "...";
  return "-";
}

/**
 * Clears pending auto-hide timer.
 *
 * @returns void
 */
function clearHideTimer(): void {
  if (!hideTimer) return;
  window.clearTimeout(hideTimer);
  hideTimer = null;
}

/**
 * Schedules auto-dismiss after a completed run.
 *
 * @returns void
 */
function scheduleHide(): void {
  clearHideTimer();
  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    dismissCoverReload();
  }, 8000);
}

watch(
  () => [state.value.open, state.value.runId, state.value.done],
  ([open, , done]) => {
    if (open && done) scheduleHide();
    if (!open || !done) clearHideTimer();
  },
);

onUnmounted(clearHideTimer);
</script>

<template src="./CoverReloadToast.html"></template>

<style scoped src="./CoverReloadToast.scoped.css"></style>
