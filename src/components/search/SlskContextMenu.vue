<script setup>
import { ref, onMounted, onUnmounted } from "vue";

const props = defineProps({
  x:     { type: Number, required: true },
  y:     { type: Number, required: true },
  track: { type: Object, required: true },
});

const emit = defineEmits(["close", "play", "download", "like"]);

const menuRef = ref(null);

// Clamp position so menu doesn't go off-screen
const style = (() => {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const MENU_W = 210;
  const MENU_H = 160;
  const left = Math.min(props.x, W - MENU_W - 8);
  const top  = Math.min(props.y, H - MENU_H - 8);
  return { left: `${left}px`, top: `${top}px` };
})();

function close() { emit("close"); }

function onKeydown(e) {
  if (e.key === "Escape") close();
}

function onPointerdown(e) {
  if (menuRef.value && !menuRef.value.contains(e.target)) close();
}

onMounted(() => {
  document.addEventListener("pointerdown", onPointerdown, true);
  document.addEventListener("keydown", onKeydown, true);
});

onUnmounted(() => {
  document.removeEventListener("pointerdown", onPointerdown, true);
  document.removeEventListener("keydown", onKeydown, true);
});
</script>

<template>
  <div ref="menuRef" class="slsk-ctx-menu" :style="style" role="menu" @click.stop>
    <button class="slsk-ctx-item" role="menuitem" @click="emit('play', track); close()">
      <svg class="slsk-ctx-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <polygon points="5,3 19,12 5,21"/>
      </svg>
      Слушать
    </button>
    <button class="slsk-ctx-item" role="menuitem" @click="emit('download', track); close()">
      <svg class="slsk-ctx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M12 3v13M5 14l7 7 7-7"/><line x1="3" y1="21" x2="21" y2="21"/>
      </svg>
      Скачать
    </button>
    <div class="slsk-ctx-divider" role="separator" />
    <button class="slsk-ctx-item" role="menuitem" @click="emit('like', track); close()">
      <svg class="slsk-ctx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
      В избранное
    </button>
  </div>
</template>
