<script setup>
import SystemIcon from "../shared/SystemIcon.vue";

const props = defineProps({
  /** Controlled visibility. */
  open: { type: Boolean, default: false },
  /** Rows: { id, title, description, unlocked }. */
  rows: { type: Array, default: () => [] },
});

const emit = defineEmits(["update:open"]);

/**
 * Closes the modal.
 *
 * Returns:
 *     void
 */
function close() {
  emit("update:open", false);
}
</script>

<template src="./AchievementsModal.html"></template>

<style scoped src="./AchievementsModal.scoped.css"></style>

