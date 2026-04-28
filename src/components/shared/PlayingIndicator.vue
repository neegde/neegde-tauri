<script setup>
defineProps({
  /** true — идёт воспроизведение; false — пауза (столбики статичные). */
  live: { type: Boolean, default: true },
});
</script>

<template src="./PlayingIndicator.html"></template>

<style scoped src="./PlayingIndicator.scoped.css"></style>

