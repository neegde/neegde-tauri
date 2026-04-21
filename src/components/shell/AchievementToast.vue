<script setup>
import { watch, onUnmounted } from "vue";
import SystemIcon from "../shared/SystemIcon.vue";

const props = defineProps({
  /** Achievement title (Russian). */
  title: { type: String, default: "" },
  /** Short description line. */
  description: { type: String, default: "" },
  /** When true, toast is visible. */
  open: { type: Boolean, default: false },
});

const emit = defineEmits(["update:open"]);

let hideTimer = 0;

/**
 * Schedules auto-dismiss; clears previous timer.
 *
 * Returns:
 *     void
 */
function scheduleHide() {
  if (hideTimer) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    hideTimer = 0;
    emit("update:open", false);
  }, 5500);
}

watch(
  () => props.open,
  (v) => {
    if (v) scheduleHide();
    else if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
    }
  }
);

onUnmounted(() => {
  if (hideTimer) window.clearTimeout(hideTimer);
});

/**
 * User closed the toast manually.
 *
 * Returns:
 *     void
 */
function close() {
  emit("update:open", false);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="ach-toast">
      <div v-if="open && title" class="ach-toast" role="status" aria-live="polite">
        <div class="ach-toast-inner">
          <div class="ach-toast-icon" aria-hidden="true">
            <SystemIcon name="sparkle" :size="18" />
          </div>
          <div class="ach-toast-text">
            <div class="ach-toast-kicker">Достижение</div>
            <div class="ach-toast-title">{{ title }}</div>
            <p v-if="description" class="ach-toast-desc">{{ description }}</p>
          </div>
          <button type="button" class="ach-toast-close" title="Закрыть" @click="close">
            <SystemIcon name="close" :size="18" />
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ach-toast {
  position: fixed;
  bottom: calc(var(--player-h, 72px) + 14px);
  right: 16px;
  z-index: 9500;
  max-width: min(340px, calc(100vw - 32px));
  pointer-events: auto;
}

.ach-toast-inner {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
}

.ach-toast-icon {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
  line-height: 0;
}

.ach-toast-text {
  min-width: 0;
  flex: 1;
}

.ach-toast-kicker {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted2);
  margin-bottom: 2px;
}

.ach-toast-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.25;
}

.ach-toast-desc {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.35;
  color: var(--muted);
}

.ach-toast-close {
  flex-shrink: 0;
  margin: -4px -6px 0 0;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--muted);
  line-height: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
}

.ach-toast-close:hover {
  color: var(--text);
  background: var(--surface-h);
}

.ach-toast-enter-active,
.ach-toast-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.ach-toast-enter-from,
.ach-toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
