<script setup>
defineProps({
  /** true — идёт воспроизведение; false — пауза (столбики статичные). */
  live: { type: Boolean, default: true },
});
</script>

<template>
  <span
    class="playing-indicator"
    :class="live ? 'playing-indicator--live' : 'playing-indicator--paused'"
    aria-hidden="true"
  >
    <span class="playing-indicator__bar" />
    <span class="playing-indicator__bar" />
    <span class="playing-indicator__bar" />
  </span>
</template>

<style scoped>
.playing-indicator {
  display: inline-flex;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
  width: 16px;
  height: 14px;
  vertical-align: middle;
}
.playing-indicator__bar {
  width: 3px;
  height: 12px;
  border-radius: 1px;
  background: var(--accent);
  transform-origin: bottom center;
}
.playing-indicator--live .playing-indicator__bar {
  animation: playing-bar 0.5s ease-in-out infinite alternate;
}
.playing-indicator--live .playing-indicator__bar:nth-child(1) {
  animation-delay: 0s;
}
.playing-indicator--live .playing-indicator__bar:nth-child(2) {
  animation-delay: 0.14s;
}
.playing-indicator--live .playing-indicator__bar:nth-child(3) {
  animation-delay: 0.28s;
}
.playing-indicator--paused .playing-indicator__bar {
  animation: none;
  opacity: 0.55;
  transform: scaleY(0.42);
}
@keyframes playing-bar {
  from {
    transform: scaleY(0.28);
  }
  to {
    transform: scaleY(1);
  }
}
</style>
