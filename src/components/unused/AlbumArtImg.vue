<script setup>
defineProps({
  torrentId: [String, Number],
  source: String,
  fallback: { type: String, default: "💿" },
});
// Stub: always show fallback emoji

</script>

<template>
  <span>{{ fallback }}</span>
</template>
