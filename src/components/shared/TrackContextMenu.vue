<script setup>
import { computed, watch, onUnmounted } from "vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  /** Подпись единственного пункта (добавить в очередь). */
  actionLabel: { type: String, default: "В очередь" },
});

const emit = defineEmits(["update:open", "action"]);

const style = computed(() => {
  const pad = 8;
  const w = 220;
  const h = 120;
  let left = props.x;
  let top = props.y;
  if (typeof window !== "undefined") {
    left = Math.min(left, window.innerWidth - w - pad);
    top = Math.min(top, window.innerHeight - h - pad);
    left = Math.max(pad, left);
    top = Math.max(pad, top);
  }
  return { left: `${left}px`, top: `${top}px` };
});

function close() {
  emit("update:open", false);
}

function onAction() {
  emit("action");
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
    else document.removeEventListener("keydown", onKeydown);
  }
);

onUnmounted(() => {
  if (typeof document !== "undefined") {
    document.removeEventListener("keydown", onKeydown);
  }
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="track-ctx-backdrop"
      aria-hidden="true"
      @click="close"
    />
    <div
      v-if="open"
      class="track-ctx-panel"
      :style="style"
      role="menu"
      @click.stop
    >
      <button type="button" class="track-ctx-item" @click="onAction">
        {{ actionLabel }}
      </button>
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
  min-width: 200px;
  padding: 6px;
  border-radius: 10px;
  background: var(--surface, #1e1c1a);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
}
.track-ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  margin: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s;
}
.track-ctx-item:hover {
  background: var(--surface-h, rgba(255, 255, 255, 0.08));
}
</style>
