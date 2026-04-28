<script setup>
defineProps({
  canGoBack: { type: Boolean, default: false },
  canGoForward: { type: Boolean, default: false },
});
defineEmits(["back", "forward"]);
</script>

<template src="./NavArrows.html"></template>

<style scoped src="./NavArrows.scoped.css"></style>

