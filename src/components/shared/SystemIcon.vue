<script setup>
/**
 * Consistent vector icons for all platforms (replaces emoji / system-dependent glyphs).
 */
defineProps({
  /** Icon key. */
  name: { type: String, required: true },
  /** Square icon size in px. */
  size: { type: Number, default: 22 },
});
</script>

<template src="./SystemIcon.html"></template>
