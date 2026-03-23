<script setup>
defineProps({
  canGoBack: { type: Boolean, default: false },
  canGoForward: { type: Boolean, default: false },
});
defineEmits(["back", "forward"]);
</script>

<template>
  <div class="nav-arrows" aria-label="Навигация">
    <button
      type="button"
      class="nav-arrow-btn"
      :disabled="!canGoBack"
      title="Назад"
      aria-label="Назад"
      @click="$emit('back')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
      </svg>
    </button>
    <button
      type="button"
      class="nav-arrow-btn"
      :disabled="!canGoForward"
      title="Вперёд"
      aria-label="Вперёд"
      @click="$emit('forward')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.nav-arrows {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  height: 44px;
}

/* Верхняя полоса сайдбара: светлее кружки на чёрном фоне */
.nav-arrows.sidebar-nav-arrows {
  height: auto;
  min-height: 32px;
}
.nav-arrows.sidebar-nav-arrows .nav-arrow-btn {
  background: rgba(255, 255, 255, 0.1);
}
.nav-arrows.sidebar-nav-arrows .nav-arrow-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.18);
}

.nav-arrow-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  transition: background 0.15s, transform 0.1s, opacity 0.15s;
  flex-shrink: 0;
}
.nav-arrow-btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.75);
  transform: scale(1.06);
}
.nav-arrow-btn:active:not(:disabled) {
  transform: scale(0.96);
}
.nav-arrow-btn:disabled {
  opacity: 0.28;
  cursor: default;
}

:global([data-theme="light"]) .nav-arrow-btn {
  color: #121212;
  background: rgba(0, 0, 0, 0.07);
}
:global([data-theme="light"]) .nav-arrow-btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.12);
}
:global([data-theme="light"]) .nav-arrows.sidebar-nav-arrows .nav-arrow-btn {
  background: rgba(0, 0, 0, 0.07);
}
:global([data-theme="light"]) .nav-arrows.sidebar-nav-arrows .nav-arrow-btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.12);
}
</style>
