<script setup>
defineProps({
  torrentId: [String, Number],
  source: String,
  size: { type: Number, default: 44 },
  radius: { type: Number, default: 4 },
  fallback: { type: String, default: "🎵" },
});
// No backend — always show fallback emoji
</script>

<template>
  <div
    class="cover-thumb"
    :style="{ width: size + 'px', height: size + 'px', borderRadius: radius + 'px' }"
  >
    <span class="cover-thumb-fallback">{{ fallback }}</span>
  </div>
</template>
