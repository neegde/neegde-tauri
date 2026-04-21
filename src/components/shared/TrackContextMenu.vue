<script setup>
import { computed, watch, onUnmounted } from "vue";

/**
 * Generic track context menu used by both Rutracker (TorrentView) and SoulSeek (SlskTrackRow).
 *
 * Props:
 *   open    — v-model boolean
 *   x, y    — screen coordinates (clientX / clientY)
 *   actions — array of { id, label, icon?, disabled? }
 *             icon: 'play' | 'download' | 'heart' | 'queue' | 'copy'
 *
 * Emits:
 *   update:open — to close (v-model)
 *   action(id)  — when a non-disabled item is clicked
 */

const props = defineProps({
  open:    { type: Boolean, default: false },
  x:       { type: Number, default: 0 },
  y:       { type: Number, default: 0 },
  actions: { type: Array, default: () => [] },
});

const emit = defineEmits(["update:open", "action"]);

const MENU_W = 220;
const MENU_H = 200;

const style = computed(() => {
  const pad  = 8;
  let left   = props.x;
  let top    = props.y;
  if (typeof window !== "undefined") {
    left = Math.min(left, window.innerWidth  - MENU_W - pad);
    top  = Math.min(top,  window.innerHeight - MENU_H - pad);
    left = Math.max(pad, left);
    top  = Math.max(pad, top);
  }
  return { left: `${left}px`, top: `${top}px` };
});

function close() {
  emit("update:open", false);
}

function onAction(id) {
  emit("action", id);
  close();
}

function onKeydown(e) {
  if (e.code === "Escape") close();
}

watch(
  () => props.open,
  (on) => {
    if (typeof document === "undefined") return;
    if (on) document.addEventListener("keydown", onKeydown);
    else    document.removeEventListener("keydown", onKeydown);
  },
);

onUnmounted(() => {
  if (typeof document !== "undefined") {
    document.removeEventListener("keydown", onKeydown);
  }
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="track-ctx-backdrop" aria-hidden="true" @click="close" />
    <div v-if="open" class="track-ctx-panel" :style="style" role="menu" @click.stop>
      <template v-for="action in actions" :key="action.id">
        <div v-if="action.id === 'divider'" class="track-ctx-divider" role="separator" />
        <button
          v-else
          type="button"
          class="track-ctx-item"
          :class="{ 'track-ctx-item--disabled': action.disabled }"
          :disabled="action.disabled"
          role="menuitem"
          @click="!action.disabled && onAction(action.id)"
        >
          <!-- play -->
          <svg v-if="action.icon === 'play'" class="track-ctx-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5,3 19,12 5,21"/></svg>
          <!-- download -->
          <svg v-else-if="action.icon === 'download'" class="track-ctx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v13M5 14l7 7 7-7"/><line x1="3" y1="21" x2="21" y2="21"/></svg>
          <!-- heart -->
          <svg v-else-if="action.icon === 'heart'" class="track-ctx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          <!-- queue -->
          <svg v-else-if="action.icon === 'queue'" class="track-ctx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
          <!-- copy -->
          <svg v-else-if="action.icon === 'copy'" class="track-ctx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <!-- playlist -->
          <svg v-else-if="action.icon === 'playlist'" class="track-ctx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          {{ action.label }}
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.track-ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 19990;
  background: transparent;
}
.track-ctx-panel {
  position: fixed;
  z-index: 19991;
  min-width: 210px;
  padding: 5px;
  border-radius: 10px;
  background: var(--surface, #1e1c1a);
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  box-shadow: 0 12px 40px rgba(0,0,0,0.6);
}
.track-ctx-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  margin: 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.1s;
  white-space: nowrap;
}
.track-ctx-item:hover:not(.track-ctx-item--disabled) {
  background: rgba(255,255,255,0.09);
}
.track-ctx-item--disabled {
  opacity: 0.35;
  cursor: default;
}
.track-ctx-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  color: var(--muted, #b3b3b3);
}
.track-ctx-divider {
  height: 1px;
  background: rgba(255,255,255,0.08);
  margin: 4px 2px;
}
</style>
